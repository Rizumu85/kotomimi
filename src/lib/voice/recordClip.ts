/**
 * Fork: a recording of the user's voice, from the microphone or from a file of theirs, as the samples `clip.ts` makes
 * a voice of. The microphone is opened plain — no echo cancellation, noise suppression or automatic gain — so that
 * what is cloned is the voice as it is.
 */
import { decodeToContract } from './liveVoice';

export interface ClipRecording {
  /** How loud the microphone is now, 0 to 1: for a meter while it records. */
  level(): number;
  /** Ends it: the recording, at `CLIP_RATE`. */
  stop(): Promise<Int16Array>;
  /** Ends it and keeps nothing. */
  cancel(): void;
}

/** Begins recording from the microphone chosen (`deviceId`), or the system's own. Rejects where it cannot be opened. */
export async function recordClip(deviceId?: string): Promise<ClipRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
  });
  let context: AudioContext | null = null;
  let over = false;
  const release = () => {
    if (over) return;
    over = true;
    for (const track of stream.getTracks()) track.stop();
    void context?.close().catch(() => undefined);
  };
  let analyser: AnalyserNode;
  let recorder: MediaRecorder;
  const parts: Blob[] = [];
  try {
    context = new AudioContext();
    analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    recorder = new MediaRecorder(stream);
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size > 0) parts.push(event.data); });
    // A recorder that fails holds the microphone no longer; what it had is still what `stop` gives.
    recorder.addEventListener('error', release);
    recorder.start();
  } catch (error) {
    // Open, and nothing to record it with: not left open.
    release();
    throw error;
  }
  const window = new Float32Array(analyser.fftSize);
  return {
    level() {
      if (over) return 0;
      analyser.getFloatTimeDomainData(window);
      let peak = 0;
      for (let i = 0; i < window.length; i += 1) { const a = Math.abs(window[i]); if (a > peak) peak = a; }
      return Math.min(1, peak);
    },
    stop() {
      return new Promise<Int16Array>((resolve, reject) => {
        recorder.addEventListener('stop', () => {
          release();
          new Blob(parts, { type: recorder.mimeType }).arrayBuffer().then(decodeToContract).then(resolve, reject);
        }, { once: true });
        try {
          recorder.stop();
        } catch (error) {
          release();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    cancel() {
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* it had ended */ }
      release();
    },
  };
}

/** The largest file of sound looked at: a recording of a voice is far under it, and all of it is decoded into memory. */
export const FILE_MOST_BYTES = 30 * 1024 * 1024;

/** The largest voice handed over as a file: one with every recording a voice can have is under it (`MOST_PACK_BYTES`). */
export const PACK_MOST_BYTES = 48 * 1024 * 1024;

/** A file of sound the browser can read (WAV, MP3, M4A, OGG…), at `CLIP_RATE`. Rejects one too large to be a recording. */
export async function fileClip(file: Blob): Promise<Int16Array> {
  if (file.size > FILE_MOST_BYTES) throw new Error('The file is too large to be a recording of a voice.');
  return decodeToContract(await file.arrayBuffer());
}
