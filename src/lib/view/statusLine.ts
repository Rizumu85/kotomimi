/**
 * The status line (spec 2026-10-05 §3): why the user cannot start, or what is
 * wrong right now. Not a record — the condition's presence is the line's. One
 * line at a time, the highest of: cannot start › still getting ready (fork) › reconnecting › waiting for a
 * microphone › muted in VRChat (fork) › the subtitle layer unavailable › echo. Pure: the inputs come
 * from `useStatusLine`, so this is testable without React.
 */
import type { EchoCause, EchoNoticeState } from '../modern-audio/EchoMonitor';
import { BALANCE_BELOW_FLOOR, NO_MICROPHONE, QUOTA_PENDING, QUOTA_UNKNOWN } from '../session/shape';
import type { RunEnd, RunState } from '../session/types';
import type { SubtitleIdleModel } from '../subtitle/session';
import { actionForCode, type NoticeActionSpec } from './noticeActions';

export type StatusIcon = 'mic-off' | 'key-round' | 'wallet' | 'refresh-cw' | 'triangle-alert' | 'captions' | 'circle-alert';

export type StatusWords =
  /** Worded by `noticeText` (a notice code, or the diagnostic message for an uncoded one). */
  | { kind: 'notice'; code: string; params?: Record<string, string | number>; message: string }
  /** One catalog key. */
  | { kind: 'key'; key: string; fallback: string }
  /** An echo cause: its message and its advice, from `ECHO_WORDS`. */
  | { kind: 'echo'; cause: EchoCause };

export interface StatusEntry {
  /** Stable per condition: the same line across renders, another line when the condition changes. */
  key: string;
  icon: StatusIcon;
  words: StatusWords;
  action: NoticeActionSpec | null;
  /** What a dismiss means, when the line offers one. */
  dismiss: 'echo' | 'subtitle-entry' | 'lag' | null;
}

export interface StatusLineInput {
  run: RunState;
  /** The subtitle session's idle model (`idleOf`), the gate both surfaces read. */
  idle: SubtitleIdleModel;
  canStart: boolean;
  /** The end Clear hid (MainPanel's `dismissedEnd`): compared by identity, so a later end draws again. */
  dismissedEnd: RunEnd | null;
  /** Running with a speaker leg and no usable input selected (`audioStore.selectedInputDevice === null`). */
  waitingForMicrophone: boolean;
  /**
   * Fork: idle, nothing refuses the start, and the start is still off — the stages are being checked, or the
   * provider's entry is loading — for long enough to be noticed (`useStatusLine`). The start button was grey with
   * nothing said, and read as broken (the user, 2026-10-29).
   */
  gettingReady?: boolean;
  /** Fork: running with a speaker leg while muted in VRChat holds the microphone (`vrchatHolds`): nothing said is heard. */
  mutedInVRChat?: boolean;
  /** The extension's content script was missing on the last attempt to enter subtitle mode (`subtitleStore.entryHint`). */
  subtitleEntryHint: boolean;
  /** `useEchoNotice`'s visible notice: already null while its cause is dismissed. */
  echo: EchoNoticeState | null;
  /**
   * Fork: a stage of this run keeps falling behind (`sessionLags`' notice, once a run, not yet dismissed): the line
   * offers the plans, where a lighter one is a press away. Never a switch by itself.
   */
  fallingBehind?: 'speaker' | 'participant' | 'translation' | null;
}

const KEY_CODES: ReadonlySet<string> = new Set(['credentials_missing', 'sign_in_required', 'sign_in_pending', 'auth']);
const WALLET_CODES: ReadonlySet<string> = new Set([BALANCE_BELOW_FLOOR, 'insufficient_balance', QUOTA_PENDING, QUOTA_UNKNOWN, 'wallet_frozen']);

function iconFor(code: string | undefined): StatusIcon {
  if (code === NO_MICROPHONE) return 'mic-off';
  if (code !== undefined && KEY_CODES.has(code)) return 'key-round';
  if (code !== undefined && WALLET_CODES.has(code)) return 'wallet';
  return 'circle-alert';
}

function blocker(key: string, code: string | undefined, message: string, params?: Record<string, string | number>): StatusEntry {
  return {
    key,
    icon: iconFor(code),
    words: { kind: 'notice', code: code ?? '', message, ...(params ? { params } : {}) },
    action: actionForCode(code),
    dismiss: null,
  };
}

export function statusLine(input: StatusLineInput): StatusEntry | null {
  const { run, idle, canStart, dismissedEnd, waitingForMicrophone, mutedInVRChat, gettingReady, subtitleEntryHint, echo, fallingBehind } = input;
  if (run.phase === 'idle') {
    // 1a. The live gate: what the stores refuse now (a stale failure never outranks it).
    // Fork: an answer that could not find out is said though the start stays offered (it asks again).
    if (idle.kind === 'unready' && (!canStart || idle.unsure)) return blocker(`unready:${idle.code ?? 'message'}`, idle.code, idle.message, idle.params);
    // 1b. The last start, refused or failed, until the next start or Clear. A run that
    // ended on its own already carries its notice on a leg (spec §2); this is not it.
    const end = run.lastEnd;
    if (end && (end.reason === 'refused' || end.reason === 'start-failed') && end.notice && end !== dismissedEnd) {
      return blocker(`last-end:${end.notice.code}`, end.notice.code, end.notice.message, end.notice.params);
    }
    // 1c. Fork: nothing refuses it, and it is not on yet.
    if (gettingReady && !canStart && (idle.kind === 'ready' || idle.kind === 'ended')) {
      return { key: 'getting-ready', icon: 'refresh-cw', words: { kind: 'key', key: 'fork.statusLine.checking', fallback: 'Getting ready. You can start in a moment.' }, action: null, dismiss: null };
    }
  }
  if (run.phase === 'running') {
    // 2. Reconnecting: the footer's dot pulses; the line carries the words in both modes.
    if (Object.values(run.legs).includes('reconnecting')) {
      return { key: 'reconnecting', icon: 'refresh-cw', words: { kind: 'key', key: 'connectionStatus.reconnecting', fallback: 'Reconnecting...' }, action: null, dismiss: null };
    }
    // 3. Waiting for a microphone (#596): the moment it went away was an event row; this is the wait.
    if (waitingForMicrophone) {
      return { key: 'mic-waiting', icon: 'mic-off', words: { kind: 'notice', code: 'mic_lost_waiting', message: 'The microphone went away; waiting for one to be connected.' }, action: null, dismiss: null };
    }
    // 3b. Fork: muted in VRChat, the user's own leg hears silence; unmuting there is the fix.
    if (mutedInVRChat) {
      return { key: 'vrchat-muted', icon: 'mic-off', words: { kind: 'key', key: 'fork.vrchat.mutedNotHeard', fallback: 'Muted in VRChat: what you say is not recognized.' }, action: null, dismiss: null };
    }
  }
  // 4. The subtitle layer could not be entered (the extension): the user just pressed the button, so this outranks the ambient echo.
  // Only while running: the overlay opens only then (Ruling 11), and an ended run leaves nothing to enter.
  if (run.phase === 'running' && subtitleEntryHint) {
    return { key: 'subtitle-entry', icon: 'captions', words: { kind: 'key', key: 'subtitle.enterButton.refreshPageHint', fallback: 'Refresh the meeting tab and try again' }, action: null, dismiss: 'subtitle-entry' };
  }
  // Fork: a stage falling behind, while running: the plans, one press away.
  if (run.phase === 'running' && fallingBehind) {
    const translation = fallingBehind === 'translation';
    return {
      key: `lag:${fallingBehind}`,
      icon: 'triangle-alert',
      words: { kind: 'key', key: translation ? 'fork.lag.translate' : 'fork.lag.hear', fallback: translation ? 'Translation cannot keep up. Try a lighter plan?' : 'Recognition cannot keep up with the speech. Try a lighter plan?' },
      action: { kind: 'settings', target: 'plans', label: { key: 'fork.lag.open', fallback: 'See plans' } },
      dismiss: 'lag',
    };
  }
  // 5. Echo: per-cause dismissal and the all-clear reset stay on `useEchoNotice`.
  if (echo) return { key: `echo:${echo.cause}`, icon: 'triangle-alert', words: { kind: 'echo', cause: echo.cause }, action: null, dismiss: 'echo' };
  return null;
}
