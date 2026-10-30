import { BaseAudioRecorder } from './BaseAudioRecorder';
import { MicrophoneCaptureError } from './microphoneCaptureError';
import type { NoiseSuppressionMode, NoiseSuppressionState } from './noiseSuppression';
import { DEBUG_CONFIG, AUDIO_CONSTRAINT_PROFILES } from '../config/performance.js';

// Vite ?url imports for AudioWorklet and WASM assets
import rnnoiseWorkletPath from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url';
import rnnoiseWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url';
import rnnoiseSimdWasmPath from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url';

type PerformanceMode = 'high_quality' | 'performance' | 'minimal';

interface ModernAudioRecorderOptions {
  sampleRate?: number;
  enablePassthrough?: boolean;
  enableWarmup?: boolean;
  warmupDuration?: number;
  skipStartupFrames?: number;
  performanceMode?: PerformanceMode;
}

interface AudioDataWithMeta {
  mono: Int16Array;
  raw: Int16Array;
  isRecording: boolean;
  isPassthrough: boolean;
  passthroughVolume: number;
}

/**
 * Modern Audio Recorder using standard browser APIs
 * Extends BaseAudioRecorder with MediaRecorder, frequency analysis, and warmup support
 *
 * Unique features (not in base class):
 * - MediaRecorder integration for file saving
 * - Frequency analysis (getFrequencies)
 * - Warmup mechanism for first recording
 * - Passthrough functionality
 * - Device management (listDevices, listenForDeviceChange)
 * - Performance mode configuration
 */
export class ModernAudioRecorder extends BaseAudioRecorder {
  /**
   * Kept for its lifecycle state, not for its output.
   *
   * Every method here gates on it ("Session ended: please call .begin() first")
   * and pause() drives it, but the encoded chunks it produces have no consumer:
   * the one `recorder.end()` call site left, in `capture/mic.ts`, discards the
   * returned blob -- as all five of the old ModernBrowserAudioService's call
   * sites did before it (deleted in plan 1e-3c). They used to be accumulated
   * for the whole session -- see setupMediaRecorderEvents, and #531.
   */
  private mediaRecorder: MediaRecorder | null = null;

  // Frequency analysis
  private analyser: AnalyserNode | null = null;

  // Passthrough
  private _passthroughEnabled: boolean = false;
  private _passthroughVolume: number = 0.3;

  // Warmup
  private _isFirstRecording: boolean = true;
  private _enableWarmup: boolean;
  private _warmupDuration: number;
  private _skipStartupFrames: number;
  private _lastValidAudioChunk: Int16Array | null = null;

  // Performance
  private performanceMode: PerformanceMode;
  /** What echo cancellation removes: what this app plays (`true`) or every sound the system plays ('all'). */
  private _echoCancellation: 'app' | 'all' = 'all';

  // Device management
  private _deviceChangeCallback: (() => void) | null = null;

  // Noise suppression (AudioWorklet-based via @sapphi-red/web-noise-suppressor)
  private rnnoiseNode: (AudioWorkletNode & { destroy(): void }) | null = null;
  private rnnoiseWasmBinary: ArrayBuffer | null = null;
  private rnnoiseModuleLoaded: boolean = false;
  private _noiseSuppressOpId: number = 0;
  /** Null while closed or reconfiguring; never changes the user's preference. */
  public onNoiseSuppressionChange: ((state: NoiseSuppressionState | null) => void) | null = null;

  // GTCRN worker-based noise suppression
  private gtcrnWorker: Worker | null = null;
  private gtcrnReady: boolean = false;
  private gtcrnFailure: Error | null = null;
  private gtcrnInitialization: Promise<void> | null = null;
  private cancelGtcrnInitialization: (() => void) | null = null;
  private gtcrnConnected = false;
  private gtcrnGeneration = 0;
  private _noiseSuppressionMode: NoiseSuppressionMode = 'off';

  // Internal sample rate for AudioContext (48kHz for RNNoise compatibility)
  private internalSampleRate: number;

  constructor(options: ModernAudioRecorderOptions = {}) {
    super(options.sampleRate ?? 24000);
    this.internalSampleRate = 48000;

    this._enableWarmup = options.enableWarmup ?? true;
    this._warmupDuration = options.warmupDuration ?? 200;
    this._skipStartupFrames = options.skipStartupFrames ?? 5;
    this.performanceMode = options.performanceMode ?? 'high_quality';
  }

  protected getLogPrefix(): string {
    return '[Sokuji] [ModernAudioRecorder]';
  }

  protected shouldConnectToDestination(): boolean {
    return false; // Speaker audio is muted (not played back)
  }

  /**
   * Get audio constraints based on performance mode
   */
  private getAudioConstraints(deviceId?: string): MediaTrackConstraints {
    const baseConstraints: MediaTrackConstraints = {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      sampleRate: this.internalSampleRate,
      channelCount: 1,
    };

    const profileName = this.performanceMode.toUpperCase().replace(' ', '_') as keyof typeof AUDIO_CONSTRAINT_PROFILES;
    const profile = AUDIO_CONSTRAINT_PROFILES[profileName] || AUDIO_CONSTRAINT_PROFILES.HIGH_QUALITY;

    // 'all' cancels every sound the system plays, which silences a loopback
    // input such as BlackHole: its signal is that sound (-20 → -63 dBFS on macOS,
    // Chromium 152). Choosing 'app' asks for `true`, which cancels only what this
    // app plays.
    const echoCancellation = profile.echoCancellation === 'all' && this._echoCancellation === 'app' ? true : profile.echoCancellation;

    // lib.dom (TS 5.9) still types echoCancellation as a boolean constraint;
    // the profiles use the 'all' mode of Media Capture and Streams (Chrome 141).
    return { ...baseConstraints, ...profile, echoCancellation } as unknown as MediaTrackConstraints;
  }

  /**
   * Get supported MIME type for MediaRecorder
   */
  private getSupportedMimeType(): string {
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/wav'];
    return types.find(type => MediaRecorder.isTypeSupported(type)) || 'audio/webm';
  }

  // ==================== Device Management (Unique) ====================

  /**
   * Sets device change callback
   */
  listenForDeviceChange(callback: ((devices: MediaDeviceInfo[]) => void) | null): boolean {
    if (callback === null && this._deviceChangeCallback) {
      navigator.mediaDevices.removeEventListener('devicechange', this._deviceChangeCallback);
      this._deviceChangeCallback = null;
    } else if (callback !== null) {
      let lastId = 0;
      let lastDevices: MediaDeviceInfo[] = [];
      const serializeDevices = (devices: MediaDeviceInfo[]) =>
        devices.map(d => d.deviceId).sort().join(',');

      const cb = async () => {
        const id = ++lastId;
        const devices = await this.listDevices();
        if (id === lastId && serializeDevices(lastDevices) !== serializeDevices(devices)) {
          lastDevices = devices;
          callback(devices.slice());
        }
      };

      navigator.mediaDevices.addEventListener('devicechange', cb);
      cb();
      this._deviceChangeCallback = cb;
    }
    return true;
  }

  /**
   * Request microphone permission
   */
  async requestPermission(): Promise<boolean> {
    const permissionStatus = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    if (permissionStatus.state === 'denied') {
      window.alert('You must grant microphone access to use this feature.');
    } else if (permissionStatus.state === 'prompt') {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        stream.getTracks().forEach(track => track.stop());
      } catch {
        window.alert('You must grant microphone access to use this feature.');
      }
    }
    return true;
  }

  /**
   * List all eligible audio input devices
   */
  async listDevices(): Promise<MediaDeviceInfo[]> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      throw new Error('Could not request user devices');
    }
    await this.requestPermission();
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioDevices = devices.filter(device => device.kind === 'audioinput');

    const defaultIndex = audioDevices.findIndex(d => d.deviceId === 'default');
    if (defaultIndex !== -1) {
      const defaultDevice = audioDevices.splice(defaultIndex, 1)[0];
      const existingIndex = audioDevices.findIndex(d => d.groupId === defaultDevice.groupId);
      if (existingIndex !== -1) {
        const existing = audioDevices.splice(existingIndex, 1)[0];
        return [existing, ...audioDevices];
      }
      return [defaultDevice, ...audioDevices];
    }
    return audioDevices;
  }

  // ==================== Passthrough (Unique) ====================

  /**
   * Setup passthrough functionality
   */
  setupPassthrough(enabled = false, volume = 0.3): boolean {
    this._passthroughEnabled = enabled;
    this._passthroughVolume = Math.max(0, Math.min(1, volume));
    return true;
  }

  // ==================== Recording Lifecycle ====================

  /**
   * Begin recording session
   */
  async begin(deviceId?: string): Promise<boolean> {
    if (this.mediaRecorder) {
      throw new Error(`${this.getLogPrefix()}: Already connected: please call .end() to start over`);
    }

    try {
      // Acquire stream with echo cancellation
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: this.getAudioConstraints(deviceId)
      });

      const track = this.stream.getAudioTracks()[0];
      const settings = track.getSettings();
      console.info(`${this.getLogPrefix()} Echo cancellation:`, settings.echoCancellation);

      // Create AudioContext at 48kHz for RNNoise compatibility
      this.audioContext = new AudioContext({ sampleRate: this.internalSampleRate });

      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }

      // Setup audio processing with warmup support
      await this.setupRealtimeAudioProcessingWithWarmup();

      // Setup MediaRecorder
      const mimeType = this.getSupportedMimeType();
      this.mediaRecorder = new MediaRecorder(this.stream, {
        mimeType,
        audioBitsPerSecond: 128000
      });
      this.setupMediaRecorderEvents();

      return true;
    } catch (err) {
      // Whatever was acquired before the failure -- a live capture stream, an
      // AudioContext, half a processing graph -- is released so the next
      // attempt starts clean, and the failure is THROWN. Returning `false` here
      // left the caller to trip over record()'s "please call .begin() first",
      // which is what a user whose microphone macOS had silently denied got to
      // read (#458). No console line of its own: the session-start path reports
      // the error once, with this `cause` attached.
      await this.abortBegin();
      throw new MicrophoneCaptureError(err);
    }
  }

  /**
   * Undo a `begin()` that failed part-way. Mirrors the teardown in `end()`,
   * minus the save: nothing was recorded. Best effort -- the failure that got
   * us here is the one worth surfacing, not a hiccup while cleaning up.
   */
  private async abortBegin(): Promise<void> {
    ++this._noiseSuppressOpId;
    this.onNoiseSuppressionChange?.(null);
    try {
      this.mediaRecorder = null;
      if (this.rnnoiseNode) {
        this.rnnoiseNode.disconnect();
        this.rnnoiseNode.destroy();
        this.rnnoiseNode = null;
      }
      this.rnnoiseModuleLoaded = false;
      this._disconnectGtcrnWorker();
      if (this.analyser) {
        this.analyser.disconnect();
        this.analyser = null;
      }
      await this.cleanup();
    } catch {
      // See above.
    }
  }

  /**
   * Setup real-time audio processing with warmup support
   * Override base class to add warmup functionality
   */
  private async setupRealtimeAudioProcessingWithWarmup(): Promise<void> {
    if (!this.audioContext || !this.stream) {
      throw new Error('AudioContext and stream required');
    }

    this.mediaStreamSource = this.audioContext.createMediaStreamSource(this.stream);
    this.useAudioWorklet = this.isAudioWorkletSupported();

    if (this.useAudioWorklet) {
      try {
        console.info(`${this.getLogPrefix()} Using AudioWorklet`);
        const workletUrl = this.getAudioWorkletProcessorUrl();
        await this.audioContext.audioWorklet.addModule(workletUrl);

        // Warmup on first use
        if (this._isFirstRecording && this._enableWarmup) {
          console.info(`${this.getLogPrefix()} Warming up AudioWorklet...`);
          await this._warmupAudioWorklet();
        }

        this.audioWorkletNode = new AudioWorkletNode(this.audioContext, 'audio-recorder-processor');

        // Configure skip frames
        this.audioWorkletNode.port.postMessage({
          type: 'config',
          config: { skipStartupFrames: this._skipStartupFrames }
        });

        // Handle messages with noise suppression and downsampling
        this.audioWorkletNode.port.onmessage = (event) => {
          if (event.data.type === 'audioData') {
            const { pcmData } = event.data;

            if (DEBUG_CONFIG.ENABLE_AUDIO_CHUNK_LOGGING) {
              this._audioChunkCount++;
              if (this._audioChunkCount % DEBUG_CONFIG.AUDIO_CHUNK_LOG_INTERVAL === 0) {
                console.debug(`${this.getLogPrefix()} AudioWorklet chunk ${this._audioChunkCount}`);
              }
            }

            // Handle silence detection on first recording
            let processedPcm: Int16Array = pcmData;
            if (this._isFirstRecording && this._detectSilence(pcmData)) {
              if (this._lastValidAudioChunk) {
                processedPcm = this._interpolateAudio(this._lastValidAudioChunk, pcmData);
              }
            } else {
              this._lastValidAudioChunk = pcmData;
            }

            this._processAudioData(processedPcm);
          }
        };

        this.mediaStreamSource.connect(this.audioWorkletNode);
        this.dummyGain = this.audioContext.createGain();
        this.dummyGain.gain.value = 0;
        this.audioWorkletNode.connect(this.dummyGain);
        this.dummyGain.connect(this.audioContext.destination);

      } catch (error) {
        console.warn(`${this.getLogPrefix()} AudioWorklet failed, using ScriptProcessor:`, error);
        this.useAudioWorklet = false;
        // A failed graph must not keep emitting beside the fallback.
        this.mediaStreamSource.disconnect();
        this.audioWorkletNode?.disconnect();
        this.audioWorkletNode?.port.close();
        this.audioWorkletNode = null;
        this.dummyGain?.disconnect();
        this.dummyGain = null;
        await this.setupScriptProcessorFallback();
      }
    } else {
      console.info(`${this.getLogPrefix()} Using ScriptProcessor fallback`);
      await this.setupScriptProcessorFallback();
    }
    await this.applyNoiseSuppression(++this._noiseSuppressOpId);
  }

  /** Both capture backends enter here at 48 kHz. Only the delivery boundary resamples. */
  protected _processAudioData(pcm: Int16Array): void {
    if (!this.recording) return;
    if (this.gtcrnConnected && this.gtcrnReady && this.gtcrnWorker) {
      this.gtcrnWorker.postMessage(
        { type: 'process', audio: pcm, generation: this.gtcrnGeneration },
        [pcm.buffer],
      );
    } else {
      this.deliverCapturedPcm(pcm);
    }
  }

  private deliverCapturedPcm(pcm: Int16Array): void {
    super._processAudioData(this.downsample48to24(pcm));
  }

  /**
   * Start recording
   */
  async record(chunkProcessor: (data: AudioDataWithMeta) => void = () => {}, chunkSize = 100): Promise<boolean> {
    if (!this.mediaRecorder) {
      throw new Error('Session ended: please call .begin() first');
    }
    if (this.recording) {
      throw new Error('Already recording: please call .pause() first');
    }

    this.onAudioData = (data) => {
      chunkProcessor({
        ...data,
        isRecording: this.recording,
        isPassthrough: this._passthroughEnabled,
        passthroughVolume: this._passthroughVolume
      });
    };
    console.info(`${this.getLogPrefix()} Recording started`);

    if (this._isFirstRecording && this.useAudioWorklet) {
      this.mediaRecorder.start(chunkSize);
      this.recording = true;
      await new Promise(resolve => setTimeout(resolve, 100));
      this.audioWorkletNode?.port.postMessage({ type: 'start' });
      this._isFirstRecording = false;
    } else {
      this.mediaRecorder.start(chunkSize);
      this.recording = true;
      this.audioWorkletNode?.port.postMessage({ type: 'start' });
    }

    return true;
  }

  /**
   * Pause recording
   */
  async pause(): Promise<boolean> {
    if (!this.mediaRecorder) {
      throw new Error('Session ended: please call .begin() first');
    }
    if (!this.recording) {
      throw new Error('Already paused: please call .record() first');
    }

    console.info(`${this.getLogPrefix()} Pausing recording`);
    this.resetGtcrnStream();
    this.audioWorkletNode?.port.postMessage({ type: 'stop' });

    if (this.mediaRecorder.state === 'recording') {
      this.mediaRecorder.stop();
      setTimeout(() => {
        if (this.mediaRecorder?.state === 'inactive') {
          this.setupMediaRecorderEvents();
        }
      }, 100);
    }

    this.recording = false;
    return true;
  }

  /**
   * End recording session
   */
  async end(): Promise<{ blob: Blob; url: string }> {
    if (!this.mediaRecorder) {
      throw new Error('Session ended: please call .begin() first');
    }

    console.info(`${this.getLogPrefix()} Stopping recording session`);
    ++this._noiseSuppressOpId;
    this.onNoiseSuppressionChange?.(null);

    if (this.recording) {
      await this.pause();
    }

    // Cleanup RNNoise node
    if (this.rnnoiseNode) {
      this.rnnoiseNode.disconnect();
      this.rnnoiseNode.destroy();
      this.rnnoiseNode = null;
    }
    this.rnnoiseModuleLoaded = false; // AudioContext will be closed

    // Cleanup GTCRN worker connection (keep worker alive for reuse)
    this._disconnectGtcrnWorker();

    // Cleanup analyser
    if (this.analyser) {
      this.analyser.disconnect();
      this.analyser = null;
    }

    // Base cleanup
    await this.cleanup();

    this.mediaRecorder = null;

    // Always empty: nothing accumulates the session's audio any more, and no
    // caller reads this. The shape is kept so the five call sites don't churn.
    return { blob: new Blob([], { type: 'audio/webm' }), url: '' };
  }

  /**
   * Perform cleanup
   */
  async quit(): Promise<boolean> {
    ++this._noiseSuppressOpId;
    this.onNoiseSuppressionChange?.(null);
    this.listenForDeviceChange(null);
    this._disposeGtcrnWorker();
    if (this.mediaRecorder) {
      await this.end();
    }
    return true;
  }

  // ==================== MediaRecorder (Unique) ====================

  private setupMediaRecorderEvents(): void {
    if (!this.mediaRecorder) return;

    // Handled and dropped. This used to push every chunk onto a session-long
    // array, which nothing ever read: a 40-minute session left 19,937 Blob
    // objects alive (~86MB, in native memory rather than the JS heap, which is
    // why it showed up as renderer private bytes and not as heap growth), and
    // they outlived the session because only the next record() cleared the
    // array. The handler stays so the chunk is released here, explicitly,
    // rather than looking like an oversight. See #531.
    this.mediaRecorder.ondataavailable = () => {};
    this.mediaRecorder.onstart = () => console.debug(`${this.getLogPrefix()} MediaRecorder started`);
    this.mediaRecorder.onstop = () => console.debug(`${this.getLogPrefix()} MediaRecorder stopped`);
    this.mediaRecorder.onerror = (event) => console.error(`${this.getLogPrefix()} MediaRecorder error:`, event);
  }

  async read(): Promise<{ meanValues: Float32Array; channels: Float32Array[] }> {
    console.warn(`${this.getLogPrefix()} Read operation not supported`);
    return { meanValues: new Float32Array(0), channels: [] };
  }

  // ==================== Frequency Analysis (Unique) ====================

  getFrequencies(
    analysisType: 'frequency' | 'music' | 'voice' = 'frequency',
    minDecibels = -100,
    maxDecibels = -30
  ): { values: Float32Array; peaks: number[] } {
    if (!this.audioContext || !this.mediaStreamSource || !this.recording) {
      return { values: new Float32Array(1024), peaks: [] };
    }

    if (!this.analyser) {
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      this.analyser.minDecibels = minDecibels;
      this.analyser.maxDecibels = maxDecibels;
      // Connect analyser to post-suppression audio if available, otherwise raw
      if (this.rnnoiseNode) {
        this.rnnoiseNode.connect(this.analyser);
      } else {
        this.mediaStreamSource.connect(this.analyser);
      }
    }

    const bufferLength = this.analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    this.analyser.getByteFrequencyData(dataArray);

    const result = new Float32Array(bufferLength);
    for (let i = 0; i < bufferLength; i++) {
      result[i] = dataArray[i] / 255.0;
    }

    // Filter by analysis type
    const binWidth = this.internalSampleRate / 2048;
    if (analysisType === 'voice') {
      return { values: result.slice(Math.floor(85 / binWidth), Math.floor(2000 / binWidth)), peaks: [] };
    } else if (analysisType === 'music') {
      return { values: result.slice(Math.floor(20 / binWidth), Math.floor(4000 / binWidth)), peaks: [] };
    }
    return { values: result, peaks: [] };
  }

  // ==================== Warmup & Silence Detection (Unique) ====================

  private async _warmupAudioWorklet(): Promise<void> {
    if (!this.audioContext || !this.stream) return;

    const tempSource = this.audioContext.createMediaStreamSource(this.stream);
    const tempWorklet = new AudioWorkletNode(this.audioContext, 'audio-recorder-processor');
    const tempGain = this.audioContext.createGain();
    tempGain.gain.value = 0;

    tempSource.connect(tempWorklet);
    tempWorklet.connect(tempGain);
    tempGain.connect(this.audioContext.destination);
    tempWorklet.port.onmessage = () => {}; // Discard warmup data

    await new Promise(resolve => setTimeout(resolve, this._warmupDuration));

    tempSource.disconnect();
    tempWorklet.disconnect();
    tempGain.disconnect();
    tempWorklet.port.close();

    console.info(`${this.getLogPrefix()} AudioWorklet warmup complete`);
  }

  private _detectSilence(audioData: Int16Array, threshold = 0.001): boolean {
    if (!audioData?.length) return true;
    let sum = 0;
    for (let i = 0; i < audioData.length; i++) {
      sum += Math.abs(audioData[i] / 32768);
    }
    return sum / audioData.length < threshold;
  }

  private _interpolateAudio(lastChunk: Int16Array, currentChunk: Int16Array): Int16Array {
    const result = new Int16Array(currentChunk.length);
    const fadeLength = Math.min(32, currentChunk.length);

    for (let i = 0; i < currentChunk.length; i++) {
      if (i < fadeLength && lastChunk.length > fadeLength) {
        const ratio = i / fadeLength;
        const lastIndex = lastChunk.length - fadeLength + i;
        result[i] = Math.round(lastChunk[lastIndex] * (1 - ratio));
      } else {
        result[i] = 0;
      }
    }
    return result;
  }

  // ==================== Echo Cancellation ====================

  /** Recorded now and applied at the next `begin()`: the browser fixes echo cancellation when it opens the device. */
  setEchoCancellation(mode: 'app' | 'all'): void {
    this._echoCancellation = mode;
  }

  // ==================== Noise Suppression ====================

  /**
   * Enable or disable AudioWorklet-based noise suppression.
   * Dynamically inserts/removes RnnoiseWorkletNode in the audio graph.
   */
  async setNoiseSuppressionEnabled(enabled: boolean): Promise<void> {
    await this.setNoiseSuppressionMode(enabled ? 'standard' : 'off');
  }

  /** Select a preference; a fallback changes only the reported effective mode. */
  async setNoiseSuppressionMode(mode: NoiseSuppressionMode): Promise<void> {
    if (this._noiseSuppressionMode === mode) return;
    this._noiseSuppressionMode = mode;
    const opId = ++this._noiseSuppressOpId;
    if (!this.audioContext || !this.mediaStreamSource) return;
    await this.applyNoiseSuppression(opId);
  }

  private isCurrentNoiseOperation(opId: number): boolean {
    return opId === this._noiseSuppressOpId && this.audioContext !== null && this.mediaStreamSource !== null;
  }

  private reportNoiseSuppression(effective: NoiseSuppressionMode, reason?: string): void {
    this.onNoiseSuppressionChange?.({ requested: this._noiseSuppressionMode, effective, ...(reason ? { reason } : {}) });
  }

  /** Every path settles on one working level, and keeps raw capture available while loading. */
  private async applyNoiseSuppression(opId: number): Promise<void> {
    this._disconnectGtcrnWorker();
    this._removeRnnoiseNode();
    this.onNoiseSuppressionChange?.(null);
    const requested = this._noiseSuppressionMode;
    if (requested === 'off') {
      this.reportNoiseSuppression('off');
      return;
    }
    if (!this.audioWorkletNode) {
      this.reportNoiseSuppression('off', 'AudioWorklet is unavailable.');
      return;
    }

    let reason: string | undefined;
    if (requested === 'enhanced') {
      try {
        await this._connectGtcrnWorker(opId);
        if (this.isCurrentNoiseOperation(opId)) this.reportNoiseSuppression('enhanced');
        return;
      } catch (error) {
        if (!this.isCurrentNoiseOperation(opId)) return;
        this.gtcrnFailure = error instanceof Error ? error : new Error(String(error));
        reason = this.gtcrnFailure.message;
        this._disposeGtcrnWorker();
        console.warn(`${this.getLogPrefix()} GTCRN unavailable; trying RNNoise:`, reason);
      }
    }

    try {
      await this._insertRnnoiseNode(opId);
      if (this.isCurrentNoiseOperation(opId)) this.reportNoiseSuppression('standard', reason);
    } catch (error) {
      if (!this.isCurrentNoiseOperation(opId)) return;
      const failure = error instanceof Error ? error.message : String(error);
      console.warn(`${this.getLogPrefix()} RNNoise unavailable; using raw capture:`, failure);
      this.reportNoiseSuppression('off', reason ? `${reason}; ${failure}` : failure);
    }
  }

  /**
   * Lazy-load the RNNoise WASM binary via dynamic import.
   */
  private async _loadRnnoiseResources(): Promise<ArrayBuffer> {
    if (this.rnnoiseWasmBinary) return this.rnnoiseWasmBinary;

    const { loadRnnoise } = await import('@sapphi-red/web-noise-suppressor');
    this.rnnoiseWasmBinary = await loadRnnoise({
      url: rnnoiseWasmPath,
      simdUrl: rnnoiseSimdWasmPath,
    });
    return this.rnnoiseWasmBinary;
  }

  /**
   * Lazy-register the RNNoise AudioWorklet processor module.
   */
  private async _ensureRnnoiseModule(): Promise<void> {
    if (this.rnnoiseModuleLoaded) return;
    const context = this.audioContext;
    if (!context) throw new Error('AudioContext required');
    await context.audioWorklet.addModule(rnnoiseWorkletPath);
    if (context === this.audioContext) this.rnnoiseModuleLoaded = true;
  }

  /** Load before touching the graph; stale operations cannot rewire a newer capture. */
  private async _insertRnnoiseNode(opId: number): Promise<void> {
    const context = this.audioContext;
    const source = this.mediaStreamSource;
    const capture = this.audioWorkletNode;
    if (!context || !source || !capture) throw new Error('AudioWorklet required');
    const [wasmBinary, , { RnnoiseWorkletNode }] = await Promise.all([
      this._loadRnnoiseResources(),
      this._ensureRnnoiseModule(),
      import('@sapphi-red/web-noise-suppressor'),
    ]);
    if (!this.isCurrentNoiseOperation(opId) || this.audioContext !== context || this.audioWorkletNode !== capture) return;

    const node = new RnnoiseWorkletNode(context, { wasmBinary, maxChannels: 1 });
    try {
      source.disconnect();
      source.connect(node);
      node.connect(capture);
      if (this.analyser) node.connect(this.analyser);
      this.rnnoiseNode = node;
    } catch (error) {
      node.disconnect();
      node.destroy();
      source.disconnect();
      source.connect(capture);
      if (this.analyser) source.connect(this.analyser);
      throw error;
    }
  }

  /**
   * Remove RnnoiseWorkletNode and restore direct connection.
   */
  private _removeRnnoiseNode(): void {
    if (!this.rnnoiseNode || !this.mediaStreamSource || !this.audioWorkletNode) return;

    try {
      this.mediaStreamSource.disconnect();
      this.rnnoiseNode.disconnect();
      this.rnnoiseNode.destroy();
      this.rnnoiseNode = null;

      // Restore: mediaStreamSource → audioWorkletNode
      this.mediaStreamSource.connect(this.audioWorkletNode);

      // Reconnect analyser to raw audio if it exists
      if (this.analyser) {
        try { this.analyser.disconnect(); } catch { /* ignore */ }
        this.mediaStreamSource.connect(this.analyser);
      }

      console.info(`${this.getLogPrefix()} RNNoise worklet node removed`);
    } catch (error) {
      console.error(`${this.getLogPrefix()} Failed to remove RNNoise node:`, error);
      // Ensure direct connection is restored so mic audio is not lost
      try {
        if (this.mediaStreamSource && this.audioWorkletNode) {
          this.mediaStreamSource.connect(this.audioWorkletNode);
          if (this.analyser) {
            this.mediaStreamSource.connect(this.analyser);
          }
        }
      } catch { /* best effort */ }
    }
  }

  /** Initializes once per worker, even if the selected mode changes while it loads. */
  private async ensureGtcrnWorker(): Promise<void> {
    if (this.gtcrnFailure) throw this.gtcrnFailure;
    if (this.gtcrnReady) return;
    if (this.gtcrnInitialization) return this.gtcrnInitialization;

    const worker = new Worker(new URL('./gtcrn/gtcrn-worker.ts', import.meta.url), { type: 'module' });
    this.gtcrnWorker = worker;
    const initialization = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (this.gtcrnWorker === worker) this.cancelGtcrnInitialization = null;
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('GTCRN worker init timeout')), 10000);
      this.cancelGtcrnInitialization = () => finish(new Error('GTCRN worker disposed'));
      worker.onmessage = (event) => {
        if (settled || this.gtcrnWorker !== worker) return;
        if (event.data.type === 'ready') {
          this.gtcrnReady = true;
          finish();
        } else if (event.data.type === 'error') {
          finish(new Error(event.data.message));
        }
      };
      worker.onerror = () => {
        if (!settled) finish(new Error('GTCRN worker failed to load'));
        else this.failGtcrnWorker(worker, 'GTCRN worker stopped unexpectedly.');
      };
      worker.postMessage({
        type: 'init',
        ortWasmBaseUrl: new URL('./wasm/ort/', window.location.href).href,
        modelUrl: new URL('./wasm/gtcrn/gtcrn_simple.onnx', window.location.href).href,
      });
    });
    this.gtcrnInitialization = initialization;
    try {
      await initialization;
    } catch (error) {
      // The request may have changed while loading. Retire this failed worker
      // regardless, without disposing a replacement installed by another operation.
      if (this.gtcrnWorker === worker) {
        this.gtcrnFailure = error instanceof Error ? error : new Error(String(error));
        this._disposeGtcrnWorker();
      }
      throw error;
    } finally {
      if (this.gtcrnInitialization === initialization) this.gtcrnInitialization = null;
    }
  }

  private async _connectGtcrnWorker(opId: number): Promise<void> {
    await this.ensureGtcrnWorker();
    if (!this.isCurrentNoiseOperation(opId) || !this.audioWorkletNode) return;
    const worker = this.gtcrnWorker!;
    const current = () => this.gtcrnWorker === worker && this.gtcrnConnected && this.isCurrentNoiseOperation(opId);
    worker.onmessage = (event: MessageEvent) => {
      if (!current() || event.data.generation !== this.gtcrnGeneration) return;
      if (event.data.type === 'audio') this.deliverCapturedPcm(event.data.audio);
      else if (event.data.type === 'error') this.failGtcrnWorker(worker, event.data.message);
    };
    worker.onerror = () => this.failGtcrnWorker(worker, 'GTCRN worker stopped unexpectedly.');
    this.resetGtcrnStream();
    this.gtcrnConnected = true;
  }

  private failGtcrnWorker(worker: Worker, message: string): void {
    if (worker !== this.gtcrnWorker) return;
    const connected = this.gtcrnConnected;
    this.gtcrnFailure = new Error(message);
    this._disposeGtcrnWorker();
    // A dormant worker also has to be retired, but only an active failure changes the graph.
    if (connected) void this.applyNoiseSuppression(++this._noiseSuppressOpId);
  }

  /** Invalidates queued output, including output from before a pause or a device reopen. */
  private resetGtcrnStream(): void {
    ++this.gtcrnGeneration;
    this.gtcrnWorker?.postMessage({ type: 'reset', generation: this.gtcrnGeneration });
  }

  private _disconnectGtcrnWorker(): void {
    this.gtcrnConnected = false;
    this.resetGtcrnStream();
  }

  private _disposeGtcrnWorker(): void {
    this._disconnectGtcrnWorker();
    const worker = this.gtcrnWorker;
    this.cancelGtcrnInitialization?.();
    this.cancelGtcrnInitialization = null;
    this.gtcrnInitialization = null;
    this.gtcrnWorker = null;
    this.gtcrnReady = false;
    if (worker) {
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
    }
  }

  /**
   * Resample Int16 PCM captured at 48kHz down to the recorder's target sample rate.
   *
   * - If target sample rate is 24kHz (default), uses simple averaging of adjacent
   *   sample pairs (factor of 2) for basic low-pass anti-aliasing.
   * - If target sample rate is 48kHz, returns the input unchanged.
   * - For other target rates below 48kHz, uses linear interpolation with a
   *   fixed-ratio resampling from 48kHz to the configured rate.
   *
   * NOTE: This helper is intended only for downsampling from 48kHz. If a higher
   * target sample rate than 48kHz is configured, the input is returned unchanged.
   */
  private downsample48to24(input: Int16Array): Int16Array {
    const sourceSampleRate = 48000;
    const targetSampleRate = this.sampleRate ?? 24000;

    // Guard against invalid or unsupported target sample rates
    if (!targetSampleRate || targetSampleRate <= 0) {
      // Fallback: return input unchanged
      return input;
    }

    // No resampling needed: target matches source
    if (targetSampleRate === sourceSampleRate) {
      // Return a copy to avoid accidental mutation of the original buffer
      return input.slice();
    }

    // Optimized path for the original 48kHz -> 24kHz behavior (factor of 2)
    if (targetSampleRate === 24000) {
      const outputLength = Math.floor(input.length / 2);
      const output = new Int16Array(outputLength);
      for (let i = 0; i < outputLength; i++) {
        // Average adjacent samples for basic anti-aliasing
        output[i] = (input[i * 2] + input[i * 2 + 1]) >> 1;
      }
      return output;
    }

    // Do not attempt to upsample beyond the capture rate; return input as-is.
    if (targetSampleRate > sourceSampleRate) {
      return input;
    }

    // Generic 48kHz -> targetSampleRate downsampling using linear interpolation
    const ratio = sourceSampleRate / targetSampleRate;
    const outputLength = Math.floor(input.length / ratio);
    const output = new Int16Array(outputLength);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const indexInt = Math.floor(srcIndex);
      const indexFrac = srcIndex - indexInt;

      const i0 = indexInt;
      const i1 = Math.min(i0 + 1, input.length - 1);

      const s0 = input[i0];
      const s1 = input[i1];

      // Linear interpolation between s0 and s1
      const interpolated = s0 + (s1 - s0) * indexFrac;
      output[i] = interpolated < 0
        ? Math.max(interpolated, -32768) | 0
        : Math.min(interpolated, 32767) | 0;
    }
    return output;
  }

  // ==================== Override getStatus ====================

  getStatus(): 'ended' | 'paused' | 'recording' {
    if (!this.mediaRecorder) {
      return 'ended';
    } else if (!this.recording) {
      return 'paused';
    } else {
      return 'recording';
    }
  }
}

// Global compatibility - use type alias to avoid circular reference
type ModernAudioRecorderClass = typeof import('./ModernAudioRecorder').ModernAudioRecorder;
declare global {
  var ModernAudioRecorder: ModernAudioRecorderClass;
}
(globalThis as Record<string, unknown>).ModernAudioRecorder = ModernAudioRecorder;
