/**
 * Fork: the microphone outside a run — the user's own voice for the virtual microphone while no session carries it
 * (`Playback.standing`). Opened as a run's passthrough is (`mic.ts`): unprocessed, on the device chosen. It follows
 * that choice and the microphone's mute while it is listened to, and lets the device go when it is not.
 */
import { describeCause, reportWarning } from '../../diagnostics/report';
import type { Source } from '../../session/source';

export interface StandingMicSettings {
  /** The device chosen; undefined is the system's own. */
  deviceId(): string | undefined;
  muted(): boolean;
  subscribe(listener: () => void): () => void;
}

export function standingMic(settings: StandingMicSettings): NonNullable<Source['onStream']> {
  return (listener) => {
    /** What was last asked for: its stream once open, none where the device would not open (asked again on another choice). */
    let asked: { id: string | undefined; stream?: MediaStream } | undefined;
    const release = () => {
      const stream = asked?.stream;
      asked = undefined;
      for (const track of stream?.getTracks() ?? []) track.stop();
      if (stream) listener(null);
    };
    const sync = async () => {
      if (settings.muted()) {
        release();
        return;
      }
      const id = settings.deviceId();
      if (asked && asked.id === id) return;
      release();
      const request = asked = { id } as NonNullable<typeof asked>;
      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(id ? { deviceId: { exact: id } } : {}),
            echoCancellation: { exact: false },
            noiseSuppression: { exact: false },
            autoGainControl: { exact: false },
          },
        });
      } catch (cause) {
        if (asked === request) reportWarning('Microphone', `The microphone could not be opened outside a session: ${describeCause(cause)}`, { cause, dedupeKey: 'mic:standing' });
        return;
      }
      // getUserMedia cannot be cancelled: one that lands after another choice, or after the listening ended, is let go.
      if (asked !== request) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      request.stream = stream;
      // A device that goes away: nothing is carried until another is chosen.
      stream.getAudioTracks()[0]?.addEventListener('ended', () => {
        if (asked?.stream !== stream) return;
        asked = { id };
        listener(null);
      });
      listener(stream);
    };
    // A device plugged back in is asked for again.
    const again = () => {
      if (asked && !asked.stream) asked = undefined;
      void sync();
    };
    const unsubscribe = settings.subscribe(() => { void sync(); });
    navigator.mediaDevices.addEventListener('devicechange', again);
    void sync();
    return () => {
      unsubscribe();
      navigator.mediaDevices.removeEventListener('devicechange', again);
      release();
    };
  };
}
