import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { NO_NATIVE_ENGINE } from '../../lib/native/nativeEngine';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { LOCALAI_DEFAULTS, localaiLanguages, type LocalAISettings } from './localai';
import { useHearingGaps } from './usePlans';

const PAIR = { source: 'zh-CN', target: 'ja' };
const downloaded = (ids: string[]) => useNativeEngineStore.setState({
  status: { ...NO_NATIVE_ENGINE, supported: true, engine: 'ready', models: Object.fromEntries(ids.map((id) => [id, { state: 'downloaded' as const, received: 1, total: 1 }])) },
});
const settings = (patch: Partial<LocalAISettings>): LocalAISettings => ({ ...LOCALAI_DEFAULTS, asrVia: 'device', translateAt: 'device', ...patch });

describe('the languages a side’s recognizer on this computer does not hear (fork)', () => {
  it('says nothing of a side no model was chosen for, where the run hears it by another that does', () => {
    downloaded(['x-asr-zh-en', 'sensevoice-small-q8']);
    // X-ASR chosen for the user's Chinese; nothing chosen for Japanese, which SenseVoice hears.
    const { result } = renderHook(() => useHearingGaps(settings({ asrNativeModel: 'x-asr-zh-en', asrNativeByLanguage: { zh: 'x-asr-zh-en' } }), PAIR));
    expect(result.current.participant).toBeNull();
  });

  it('says nothing of a language the user also speaks that their own recognizer leaves out: it is not asked of it', () => {
    downloaded(['x-asr-zh-en', 'sensevoice-small-q8']);
    // The user speaks Japanese too, the other side's language; X-ASR, chosen for their Chinese, does not hear it.
    const chosen = settings({ asrNativeModel: 'x-asr-zh-en', asrNativeByLanguage: { zh: 'x-asr-zh-en' }, speakAlso: ['ja'] });
    const { result } = renderHook(() => useHearingGaps(chosen, PAIR));
    expect(result.current.speaker).toBeNull();
    expect(result.current.participant).toBeNull();
    // The row says so on the chip instead.
    expect(localaiLanguages.more!(chosen, [], PAIR).mine).toMatchObject({ using: [], quiet: { codes: ['ja'], by: 'X-ASR-zh-en' } });
  });

  it('says so where the recognizer chosen for the user’s own language does not hear it', () => {
    downloaded(['x-asr-zh-en']);
    const { result } = renderHook(() => useHearingGaps(settings({ asrNativeModel: 'x-asr-zh-en', asrNativeByLanguage: { ja: 'x-asr-zh-en' } }), { source: 'ja', target: 'en' }));
    expect(result.current.speaker).toMatchObject({ codes: ['ja'], by: 'x-asr-zh-en' });
  });
});
