import { afterEach, describe, expect, it, vi } from 'vitest';
import { registerSubtitleCapture, saveSubtitleCapture } from './subtitleCapture';
import fixture from '../lib/subtitle/__fixtures__/capture.json';
import { readSubtitleCapture } from '../lib/subtitle/capture';

vi.mock('../lib/diagnostics/report', () => ({ reportError: vi.fn(), describeCause: (cause: Error) => cause.message }));
let off: (() => void) | undefined;
afterEach(() => { off?.(); vi.unstubAllGlobals(); });
const loadedFixture = readSubtitleCapture(JSON.stringify(fixture), fixture.appVersion);
if (!loadedFixture.ok) throw new Error(loadedFixture.error);
const { startedAt, durationMs, truncated, frames } = loadedFixture.capture;
const recording = { startedAt, durationMs, truncated, frames };

describe('saveSubtitleCapture', () => {
  it('does nothing when closed', async () => {
    expect(await saveSubtitleCapture()).toMatchObject({ ok: false, error: expect.stringContaining('closed') });
  });
  it('hands only the recording and current UI language to main, returns its path, and disconnects', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true, path: 'capture.json' });
    vi.stubGlobal('electron', { invoke });
    off = registerSubtitleCapture({ snapshot: () => recording, language: () => 'ja' });
    expect(await saveSubtitleCapture()).toEqual({ ok: true, path: 'capture.json' });
    expect(invoke).toHaveBeenCalledWith('subtitle:save-capture', { ...recording, language: 'ja' });
    off();
    expect(await saveSubtitleCapture()).toMatchObject({ ok: false });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('returns IPC and transport failures', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ ok: false, error: 'Disk full' }).mockRejectedValueOnce(new Error('Disconnected'));
    vi.stubGlobal('electron', { invoke });
    off = registerSubtitleCapture({ snapshot: () => recording, language: () => 'en' });
    expect(await saveSubtitleCapture()).toEqual({ ok: false, error: 'Disk full' });
    expect(await saveSubtitleCapture()).toEqual({ ok: false, error: 'Disconnected' });
  });
});
