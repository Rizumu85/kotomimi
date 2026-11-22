import { SAMPLE_RATE } from '../../contract/adapter';
import { reportWarning } from '../../diagnostics/report';
import { LoopbackRecorder } from '../../modern-audio/LoopbackRecorder';
import type { EchoFollower } from './echoFollow';

/** The Windows loopback recorder uses the display-media handler directly. Connecting or
 * disconnecting a second participant source over IPC would stop the application helper. */
/** A chunk of the system's playout; both channels when the capture is stereo. */
export type PlayoutChunk = { mono: Int16Array; left?: Int16Array; right?: Int16Array };

export function createPlayoutReference(follower: EchoFollower, heard?: (chunk: PlayoutChunk) => void) {
  let wanted = false;
  let active = false;
  let recorder: LoopbackRecorder | null = null;
  let pending = Promise.resolve();

  const close = async () => {
    active = false;
    const previous = recorder;
    recorder = null;
    try {
      await previous?.end();
    } catch (cause) {
      reportWarning('EchoFollow', 'Stopping the system playout reference failed.', { cause, dedupeKey: 'echo:playout-stop' });
    }
  };

  return {
    get active() { return wanted && active; },
    setNeeded(needed: boolean) {
      if (needed === wanted) return pending;
      wanted = needed;
      // A participant claiming whole-system audio waits for this handoff: enable/disable
      // installs one display-media handler for the session, even across overlapping opens.
      pending = pending.then(async () => {
        if (!needed) return close();
        if (!wanted) return;
        try {
          recorder = new LoopbackRecorder(SAMPLE_RATE);
          if (!(await recorder.begin())) throw new Error('Loopback capture did not start.');
          if (!wanted) return;
          await recorder.record((chunk) => {
            if (!wanted || !active) return;
            follower.played(chunk.mono);
            heard?.(chunk);
          });
          follower.reset();
          active = true;
        } catch (cause) {
          await close();
          if (wanted) {
            reportWarning('EchoFollow', 'System playout is unavailable to the microphone gate. Using participant audio when available.', {
              cause, dedupeKey: 'echo:playout-reference',
            });
          }
        }
      });
      return pending;
    },
  };
}
