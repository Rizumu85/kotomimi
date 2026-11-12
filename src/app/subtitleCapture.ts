import type { SubtitleCaptureRecording } from '../lib/subtitle/capture';
import { describeCause, reportError } from '../lib/diagnostics/report';

export type SaveSubtitleCaptureResult = { ok: true; path: string } | { ok: false; error: string };

let active: { snapshot(): SubtitleCaptureRecording | null; language(): string } | null = null;

/** The mounted subtitle surface owns this registration and releases it on close. */
export function registerSubtitleCapture(source: NonNullable<typeof active>): () => void {
  active = source;
  return () => { if (active === source) active = null; };
}

/** Main chooses the destination and supplies the app version/platform. Never rejects. */
export async function saveSubtitleCapture(): Promise<SaveSubtitleCaptureResult> {
  if (!active) return { ok: false, error: 'The subtitle surface is closed.' };
  if (!window.electron) return { ok: false, error: 'Saving subtitle captures requires the desktop app.' };
  const recording = active.snapshot();
  if (!recording) return { ok: false, error: 'No subtitle state fits the capture memory limit.' };
  try {
    const result: SaveSubtitleCaptureResult = await window.electron.invoke('subtitle:save-capture', { ...recording, language: active.language() });
    if (!result.ok) reportError('SubtitleCapture', `Saving the subtitle capture failed: ${result.error}`);
    return result;
  } catch (cause) {
    const error = describeCause(cause);
    reportError('SubtitleCapture', `Saving the subtitle capture failed: ${error}`, { cause });
    return { ok: false, error };
  }
}
