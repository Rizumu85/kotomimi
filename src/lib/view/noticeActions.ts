/**
 * What a notice offers the user to do about it, in one place (spec
 * 2026-10-05 §6). A code resolves to an action here; MainPanel owns the
 * handlers; rows and the status line only draw the label.
 */
import { MIC_BLOCKED } from '../audio/capture/micFailure';
import { LOOPBACK_DENIED } from '../audio/capture/systemAudio';
import { BALANCE_BELOW_FLOOR } from '../session/shape';
import { settingsTargetForCode } from './noticeTargets';

export type NoticeActionSpec =
  // `label`: what the button says, where it is more than opening the settings.
  | { kind: 'settings'; target: string; label?: { key: string; fallback: string } }
  | { kind: 'top-up' }
  | { kind: 'sign-in' }
  | { kind: 'system-settings'; pane: 'screen-recording' | 'audio-capture' }
  | { kind: 'show-in-folder'; dir: string }
  // Windows' own settings, opened directly (spec 2026-10-13 §3).
  | { kind: 'windows-settings'; page: 'microphone-privacy' };

/**
 * Fork: a model of this computer's not downloaded yet: the button says what is to be done there. A first run that
 * met one used to be told where to go in words, with nothing to press (a friend, 2026-11-04).
 */
const DOWNLOAD_CODES: ReadonlySet<string> = new Set(['native_missing', 'native_translator_missing', 'native_coach_missing']);

/** The managed provider's lease refused a start, or the gate did, on the balance: both are fixed by topping up. */
const TOP_UP_CODES: ReadonlySet<string> = new Set([BALANCE_BELOW_FLOOR, 'insufficient_balance']);

export function actionForCode(code: string | undefined): NoticeActionSpec | null {
  if (code === undefined) return null;
  if (code === LOOPBACK_DENIED) return { kind: 'system-settings', pane: 'screen-recording' };
  if (code === MIC_BLOCKED) return { kind: 'windows-settings', page: 'microphone-privacy' };
  if (TOP_UP_CODES.has(code)) return { kind: 'top-up' };
  if (code === 'sign_in_required') return { kind: 'sign-in' };
  const target = settingsTargetForCode(code);
  if (target && DOWNLOAD_CODES.has(code)) return { kind: 'settings', target, label: { key: 'models.download', fallback: 'Download' } };
  return target ? { kind: 'settings', target } : null;
}

/** The action's label: a key every catalog has, and the English `defaultValue`. */
export function actionLabel(action: NoticeActionSpec): { key: string; fallback: string } {
  switch (action.kind) {
    case 'settings': return action.label ?? { key: 'settings.title', fallback: 'Settings' };
    case 'top-up': return { key: 'common.topUp', fallback: 'Top up' };
    case 'sign-in': return { key: 'common.signIn', fallback: 'Sign In' };
    case 'system-settings': return { key: 'audioPanel.openSystemSettings', fallback: 'Open System Settings' };
    case 'show-in-folder': return { key: 'mainPanel.export.autoSave.showInFolder', fallback: 'Show in folder' };
    case 'windows-settings': return { key: 'audioPanel.openSystemSettings', fallback: 'Open System Settings' };
  }
}
