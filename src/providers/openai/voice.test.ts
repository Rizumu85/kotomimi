import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE } from '../../lib/contract/adapter';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { speakText, speaksLanguage, speechUrl, spokenText, voiceFor, VOICE_MOST_CHARS, VOICE_TIMEOUT_MS, type VoiceDeps, type VoiceStage } from './voice';

const tone = (samples: number, value = 1000) => new Int16Array(samples).fill(value);

function deps(over: Partial<Omit<VoiceDeps, 'clock'>> = {}): Omit<VoiceDeps, 'clock'> & { clock: ReturnType<typeof trackedClock>['clock'] } {
  const { clock } = trackedClock();
  return {
    clock,
    fetch: vi.fn(() => Promise.reject(new Error('no fetch scripted'))),
    decode: vi.fn(async () => tone(SAMPLE_RATE)),
    native: vi.fn(async () => undefined),
    edge: vi.fn(async () => new ArrayBuffer(8)),
    ...over,
  };
}

const NATIVE: VoiceStage = { via: 'speech', baseUrl: '', engine: true, model: 'qwen3-tts-1.7b-customvoice-q8', voices: { ja: 'ono_anna', zh: 'vivian' }, languages: ['ja', 'zh', 'en'], tellsLanguage: true };
const API: VoiceStage = { via: 'speech', baseUrl: 'https://api.example.com/v1/', model: 'tts-1', key: 'speakKey', voices: { '*': 'alloy' } };
const EDGE: VoiceStage = { via: 'edge', baseUrl: '', model: 'edge', voices: { ja: 'ja-JP-NanamiNeural' } };
const never = new AbortController().signal;

describe('what is read out of a line', () => {
  it('leaves out emoji and marks, and says nothing of a line with no words', () => {
    expect(spokenText('  こんにちは 😀  ')).toBe('こんにちは');
    expect(spokenText('✓')).toBe('');
    expect(spokenText('。。。')).toBe('');
  });

  it('stops a text that ran on, after a sentence where one ends late enough', () => {
    const long = `${'あ'.repeat(VOICE_MOST_CHARS - 100)}。${'い'.repeat(300)}`;
    expect(spokenText(long)).toBe(`${'あ'.repeat(VOICE_MOST_CHARS - 100)}。`);
    expect(spokenText('う'.repeat(VOICE_MOST_CHARS + 50))).toHaveLength(VOICE_MOST_CHARS);
  });
});

describe('a stage\'s voices and languages', () => {
  it('speaks a language in its own voice, its base language\'s, or the one voice for all', () => {
    expect(voiceFor(NATIVE, 'ja')).toBe('ono_anna');
    expect(voiceFor(NATIVE, 'zh-CN')).toBe('vivian');
    expect(voiceFor(NATIVE, 'en')).toBeUndefined();
    expect(voiceFor(API, 'ko')).toBe('alloy');
  });

  it('speaks only the languages it names, and any where it names none', () => {
    expect(speaksLanguage(NATIVE, 'zh-TW')).toBe(true);
    expect(speaksLanguage(NATIVE, 'ko')).toBe(false);
    expect(speaksLanguage(API, 'ko')).toBe(true);
  });
});

describe('a sentence spoken', () => {
  it('by this computer\'s engine: asked through the main process, its sound handed on in order at the contract\'s rate', async () => {
    const d = deps({
      native: vi.fn(async (_request, onPcm) => {
        // 48 kHz: twice the contract's rate, so half as many samples come out.
        onPcm(tone(48000 * 0.5), 48000);
        onPcm(tone(48000 * 0.5), 48000);
      }),
    });
    const heard: Int16Array[] = [];
    const spoken = await speakText(NATIVE, { text: 'こんにちは', language: 'ja' }, undefined, d, never, (pcm) => heard.push(pcm));
    expect(d.native).toHaveBeenCalledWith({ model: NATIVE.model, text: 'こんにちは', voice: 'ono_anna', language: 'ja' }, expect.any(Function), expect.any(AbortSignal));
    const total = heard.reduce((sum, pcm) => sum + pcm.length, 0);
    expect(Math.abs(total - SAMPLE_RATE)).toBeLessThan(200);
    expect(spoken.samples).toBe(total);
    expect(spoken.firstMs).toBeDefined();
  });

  it('by an API: the speech endpoint under its address, with its key and one voice, never a language field', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ArrayBuffer(44)));
    const d = deps({ fetch: fetch as unknown as typeof globalThis.fetch });
    const heard: Int16Array[] = [];
    await speakText(API, { text: 'Hello there.', language: 'en' }, 'sk-voice', d, never, (pcm) => heard.push(pcm));
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.example.com/v1/audio/speech');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-voice');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'tts-1', input: 'Hello there.', voice: 'alloy', response_format: 'wav' });
    expect(heard).toHaveLength(1);
    expect(speechUrl('http://host:1/v1')).toBe('http://host:1/v1/audio/speech');
  });

  it('by Edge: in the voice chosen for the language, and not at all where none is', async () => {
    const d = deps();
    await speakText(EDGE, { text: 'こんにちは', language: 'ja' }, undefined, d, never, () => undefined);
    expect(d.edge).toHaveBeenCalledWith({ text: 'こんにちは', voice: 'ja-JP-NanamiNeural' }, expect.any(AbortSignal));
    await expect(speakText(EDGE, { text: '你好', language: 'zh' }, undefined, d, never, () => undefined)).rejects.toThrow(/No voice/);
  });

  it('says what an API refused, and that a place answered with no sound', async () => {
    const refused = deps({ fetch: (async () => new Response('{"error":"no such voice"}', { status: 400 })) as unknown as typeof fetch });
    await expect(speakText(API, { text: 'Hello', language: 'en' }, 'k', refused, never, () => undefined)).rejects.toThrow(/HTTP 400.*no such voice/);
    const silent = deps({ native: vi.fn(async () => undefined) });
    await expect(speakText(NATIVE, { text: 'こんにちは', language: 'ja' }, undefined, silent, never, () => undefined)).rejects.toThrow(/no sound/);
  });

  it('asks for nothing where there is nothing to say', async () => {
    const d = deps();
    expect(await speakText(NATIVE, { text: ' 😀 ', language: 'ja' }, undefined, d, never, () => undefined)).toEqual({ totalMs: 0, samples: 0 });
    expect(d.native).not.toHaveBeenCalled();
  });

  it('is stopped by its signal, and by a place that does not answer in time', async () => {
    const hang: VoiceDeps['native'] = (_request, _onPcm, signal) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
    const stopped = new AbortController();
    const first = speakText(NATIVE, { text: 'こんにちは', language: 'ja' }, undefined, deps({ native: hang }), stopped.signal, () => undefined);
    stopped.abort(new Error('the session ended'));
    await expect(first).rejects.toThrow('the session ended');

    const d = deps({ native: hang });
    const late = speakText(NATIVE, { text: 'こんにちは', language: 'ja' }, undefined, d, never, () => undefined);
    d.clock.advance(VOICE_TIMEOUT_MS);
    await expect(late).rejects.toThrow(/in time/);
  });
});
