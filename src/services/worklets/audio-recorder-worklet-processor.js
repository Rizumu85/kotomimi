/**
 * AudioWorklet processor for real-time audio recording and conversion to PCM16
 * Replaces the deprecated ScriptProcessor API
 * Enhanced with internal buffering and startup frame skipping for stability
 */
class AudioRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    
    // Track processing statistics
    this._processCallCount = 0;
    this._lastLogTime = 0;
    
    // Recording state
    this._isRecording = true; // Start in recording mode for passthrough support
    this._startupFrameCount = 0;
    this._skipStartupFrames = 5; // Default: skip first 5 frames
    
    // Internal buffering for smoother output
    this._internalBuffer = [];
    // Fork: with `stereo` set (the participant's capture), a two-channel input is heard as the average of the two, and
    // each channel is also sent as it is (`left`, `right`): what tells a sound with a direction from one without
    // (`stereoSplit.ts`). Off, the first channel alone is heard, as before.
    this._stereo = false;
    this._leftBuffer = [];
    this._rightBuffer = [];
    // The chunk being gathered had a stretch of one channel: its left and right are not sent.
    this._mixedChunk = false;
    // Performance: Larger buffer size reduces callback frequency and CPU usage
    this._bufferSize = 4096; // Send data in chunks of 4096 samples (reduces frequency from 47Hz to 6Hz)
    
    // Listen for control messages from the main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'config') {
        // Handle configuration updates
        const config = event.data.config;
        if (config.skipStartupFrames !== undefined) {
          this._skipStartupFrames = config.skipStartupFrames;
        }
        if (config.stereo !== undefined) {
          this._stereo = config.stereo === true;
          // What is gathered already has no channels of its own: they start in step, and this chunk sends neither.
          this._leftBuffer = this._internalBuffer.map(() => 0);
          this._rightBuffer = this._internalBuffer.map(() => 0);
          this._mixedChunk = this._internalBuffer.length > 0;
        }
        console.debug('[AudioRecorderProcessor] Received config:', config);
      } else if (event.data.type === 'start') {
        this._isRecording = true;
        this._startupFrameCount = 0;
        console.debug('[AudioRecorderProcessor] Recording started');
      } else if (event.data.type === 'stop') {
        this._isRecording = false;
        // Flush any remaining buffered data
        this._flushBuffer();
        console.debug('[AudioRecorderProcessor] Recording stopped');
      }
    };
  }

  /**
   * Flush any remaining data in the internal buffer
   */
  _flushBuffer() {
    // Fork: the channels go with the mix, as they were gathered in step with it.
    this._leftBuffer = [];
    this._rightBuffer = [];
    this._mixedChunk = false;
    if (this._internalBuffer.length > 0) {
      const pcmData = new Int16Array(this._internalBuffer);
      this._internalBuffer = [];
      
      this.port.postMessage({
        type: 'audioData',
        pcmData: pcmData,
        sampleRate: sampleRate,
        channelCount: 1,
        timestamp: currentTime,
        frameCount: pcmData.length
      }, [pcmData.buffer]);
    }
  }

  /**
   * Process audio input and convert to PCM16
   * @param {Float32Array[][]} inputs - Array of inputs, each with channels
   * @param {Float32Array[][]} outputs - Array of outputs (unused)
   * @param {Object} parameters - Audio parameters (unused)
   * @returns {boolean} - True to keep processor alive
   */
  process(inputs, outputs, parameters) {
    // Get the first input's first channel (mono)
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) {
      return true; // Keep processor alive even with no input
    }
    
    // Only process if recording is active
    if (!this._isRecording) {
      return true;
    }
    
    // Skip initial frames to avoid startup instability
    if (this._startupFrameCount < this._skipStartupFrames) {
      this._startupFrameCount++;
      if (this._startupFrameCount === this._skipStartupFrames) {
        console.debug(`[AudioRecorderProcessor] Skipped ${this._skipStartupFrames} startup frames`);
      }
      return true;
    }
    
    const inputData = input[0];
    const toPcm = (value) => {
      // Clamp to [-1, 1] range and convert to 16-bit integer
      const sample = Math.max(-1, Math.min(1, value));
      return sample < 0 ? sample * 32768 : sample * 32767;
    };

    if (this._stereo && input.length >= 2) {
      const rightData = input[1];
      for (let i = 0; i < inputData.length; i++) {
        this._internalBuffer.push(toPcm((inputData[i] + rightData[i]) / 2));
        this._leftBuffer.push(toPcm(inputData[i]));
        this._rightBuffer.push(toPcm(rightData[i]));
      }
    } else {
      // Convert Float32Array to Int16Array (PCM16) and add to buffer
      for (let i = 0; i < inputData.length; i++) {
        this._internalBuffer.push(toPcm(inputData[i]));
      }
      // Fork: one channel only, while both are wanted: the channels keep in step, and this chunk sends neither.
      if (this._stereo) {
        for (let i = 0; i < inputData.length; i++) {
          this._leftBuffer.push(0);
          this._rightBuffer.push(0);
        }
        this._mixedChunk = true;
      }
    }
    
    // Send buffered data when buffer size is reached
    if (this._internalBuffer.length >= this._bufferSize) {
      const pcmData = new Int16Array(this._internalBuffer.slice(0, this._bufferSize));
      this._internalBuffer = this._internalBuffer.slice(this._bufferSize);
      
      // Log periodically to verify processing
      this._processCallCount++;
      const now = currentTime;
      if (this._processCallCount % 100 === 0 || now - this._lastLogTime > 10) {
        console.debug(`[AudioRecorderProcessor] Sent buffer ${this._processCallCount}, size: ${pcmData.length}, time: ${now.toFixed(2)}s`);
        this._lastLogTime = now;
      }
      
      // Fork: the two channels of the same samples, where they were kept: gathered in step with the mix.
      let left = null;
      let right = null;
      if (this._stereo && this._leftBuffer.length >= this._bufferSize) {
        if (!this._mixedChunk) {
          left = new Int16Array(this._leftBuffer.slice(0, this._bufferSize));
          right = new Int16Array(this._rightBuffer.slice(0, this._bufferSize));
        }
        this._leftBuffer = this._leftBuffer.slice(this._bufferSize);
        this._rightBuffer = this._rightBuffer.slice(this._bufferSize);
      }
      this._mixedChunk = false;

      // Send PCM data to main thread
      this.port.postMessage({
        type: 'audioData',
        pcmData: pcmData,
        left,
        right,
        sampleRate: sampleRate,
        channelCount: 1,
        timestamp: currentTime,
        frameCount: pcmData.length
      }, left && right ? [pcmData.buffer, left.buffer, right.buffer] : [pcmData.buffer]);
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor
registerProcessor('audio-recorder-processor', AudioRecorderProcessor);