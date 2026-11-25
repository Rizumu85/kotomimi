import { describe, expect, it, vi } from 'vitest';
import { SAMPLE_RATE } from '../../lib/contract/adapter';
import { trackedClock } from '../../lib/contract/testing/trackedClock';
import { atServer, warmVoice, VOICE_WARM_MS, speakText, speaksLanguage, speechUrl, spokenText, voiceFor, VOICE_MOST_CHARS, VOICE_PATIENT_MS, VOICE_TIMEOUT_MS, type VoiceDeps, type VoiceStage } from './voice';

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
    const clone: VoiceStage = { ...NATIVE, model: 'qwen3-tts-1.7b-base-q8', voices: { ja: 'aaa111' }, patient: true };
    const spoken = await speakText(clone, { text: 'こんにちは', language: 'ja', tone: 'gentle' }, undefined, d, never, (pcm) => heard.push(pcm));
    expect(d.native).toHaveBeenCalledWith({ model: clone.model, text: 'こんにちは', voice: 'aaa111', language: 'ja', tone: 'gentle' }, expect.any(Function), expect.any(AbortSignal));
    const total = heard.reduce((sum, pcm) => sum + pcm.length, 0);
    expect(Math.abs(total - SAMPLE_RATE)).toBeLessThan(200);
    expect(spoken.samples).toBe(total);
    expect(spoken.firstMs).toBeDefined();
  });

  it('by an API: the speech endpoint under its address, with its key and one voice, never a language field', async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(new ArrayBuffer(44)));
    const d = deps({ fetch: fetch as unknown as typeof globalThis.fetch });
    const heard: Int16Array[] = [];
    await speakText(API, { text: 'Hello there.', language: 'en', tone: 'gentle' }, 'sk-voice', d, never, (pcm) => heard.push(pcm));
    expect(String(fetch.mock.calls[0][0])).toBe('https://api.example.com/v1/audio/speech');
    const init = fetch.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-voice');
    expect(JSON.parse(init.body as string)).toEqual({ model: 'tts-1', input: 'Hello there.', voice: 'alloy', response_format: 'wav' });
    expect(heard).toHaveLength(1);
    expect(speechUrl('http://host:1/v1')).toBe('http://host:1/v1/audio/speech');
  });

  describe('by another Kotomimi', () => {
    const LENT: VoiceStage = { via: 'speech', baseUrl: '', server: true, model: 'qwen3-tts-1.7b-customvoice-q8', key: 'serverKey', voices: { ja: 'ono_anna' }, streams: true, tellsLanguage: true };
    /** Raw 16-bit sound in pieces of any size, as a door sends it. */
    const raw = (pieces: number[][], type = 'audio/pcm;rate=24000') => new Response(new ReadableStream<Uint8Array>({ start(controller) { for (const piece of pieces) controller.enqueue(Uint8Array.from(piece)); controller.close(); } }), { headers: { 'Content-Type': type } });
    const bytesOf = (samples: number[]) => [...new Uint8Array(Int16Array.from(samples).buffer)];

    it('is asked at the device\'s address for the sound raw, told the language, and keyed with the device\'s key', async () => {
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => raw([bytesOf([1, 2, 3])]));
      const d = deps({ fetch: fetch as unknown as typeof globalThis.fetch });
      await speakText(atServer(LENT, 'http://192.168.1.20:8790/v1'), { text: 'こんにちは', language: 'ja-JP' }, 'door-key', d, never, () => undefined);
      expect(String(fetch.mock.calls[0][0])).toBe('http://192.168.1.20:8790/v1/audio/speech');
      const init = fetch.mock.calls[0][1] as RequestInit;
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer door-key');
      expect(JSON.parse(init.body as string)).toEqual({ model: LENT.model, input: 'こんにちは', voice: 'ono_anna', response_format: 'pcm', language: 'ja-JP' });
      // A stage of an API's own is left where it is.
      expect(atServer(API, 'http://192.168.1.20:8790/v1')).toBe(API);
    });

    it('with voices of the user\'s own: names the recording with every sentence, and hands it over once where the device does not hold it', async () => {
      const OWN: VoiceStage = { ...LENT, model: 'qwen3-tts-1.7b-base-q8', voices: { ja: 'aaa111' }, ownVoices: true, patient: true };
      const held = new Set<string>();
      const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
        if (String(input).endsWith('/audio/voices')) { held.add('sha-ja'); return new Response(JSON.stringify({ id: 'sha-ja' }), { status: 200 }); }
        return held.has(String(body.voice_ref)) ? raw([bytesOf([1, 2, 3])]) : new Response(JSON.stringify({ error: { code: 'voice_ref_unknown' } }), { status: 409 });
      });
      const recording = vi.fn(async (_voice: string, _language: string, bytes: boolean) => ({ id: 'sha-ja', text: '今日はいい天気ですね。', language: 'ja', ...(bytes ? { wav: 'UklGRg==' } : {}) }));
      const d = deps({ fetch: fetch as unknown as typeof globalThis.fetch, recording });
      const stage = atServer(OWN, 'http://192.168.1.20:8790/v1');
      await speakText(stage, { text: 'こんにちは', language: 'ja', tone: 'gentle' }, 'door-key', d, never, () => undefined);
      // Asked, refused, handed over, asked again: the sentence names the recording, never the voice's own id.
      expect(fetch.mock.calls.map((call) => String(call[0]).replace('http://192.168.1.20:8790/v1', ''))).toEqual(['/audio/speech', '/audio/voices', '/audio/speech']);
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: OWN.model, input: 'こんにちは', voice_ref: 'sha-ja', response_format: 'pcm', language: 'ja' });
      expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({ wav: 'UklGRg==', text: '今日はいい天気ですね。', language: 'ja' });
      expect((fetch.mock.calls[1][1]!.headers as Record<string, string>).Authorization).toBe('Bearer door-key');
      expect(recording.mock.calls).toEqual([['aaa111', 'ja', false, 'gentle'], ['aaa111', 'ja', true, 'gentle']]);
      // The next sentence finds it held: one request, and the recording itself is not read again.
      fetch.mockClear();
      recording.mockClear();
      await speakText(stage, { text: 'ありがとう', language: 'ja', tone: 'gentle' }, 'door-key', d, never, () => undefined);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(recording.mock.calls.map((call) => call[2])).toEqual([false]);
      // Refused for another reason, the recording is not handed over: only "I do not hold it" asks for it.
      const other = vi.fn(async () => new Response(JSON.stringify({ error: { code: 'voice_busy' } }), { status: 409 }));
      await expect(speakText(stage, { text: 'こんにちは', language: 'ja' }, 'door-key', deps({ fetch: other as unknown as typeof globalThis.fetch, recording }), never, () => undefined)).rejects.toThrow(/HTTP 409/);
      expect(other).toHaveBeenCalledTimes(1);
      // A language with no voice of the user's chosen is not asked for at all.
      fetch.mockClear();
      await expect(speakText(atServer({ ...OWN, voices: {} }, 'http://192.168.1.20:8790/v1'), { text: 'Hello', language: 'en' }, 'door-key', d, never, () => undefined)).rejects.toThrow(/No voice of your own/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('hands the sound on in whole samples, whatever the pieces\' sizes', async () => {
      const samples = Array.from({ length: 9000 }, (_one, at) => (at % 200) - 100);
      const bytes = bytesOf(samples);
      // Pieces that end in the middle of a sample, and one of a single byte.
      const d = deps({ fetch: (async () => raw([bytes.slice(0, 3), bytes.slice(3, 4), bytes.slice(4, 9001), bytes.slice(9001)])) as unknown as typeof fetch, decode: vi.fn() });
      const heard: number[] = [];
      const spoken = await speakText(atServer(LENT, 'http://h/v1'), { text: 'こんにちは', language: 'ja' }, undefined, d, never, (pcm) => heard.push(...pcm));
      expect(heard).toEqual(samples);
      expect(spoken.samples).toBe(samples.length);
      expect(d.decode).not.toHaveBeenCalled();
    });

    it('brings a rate that is not the contract\'s to it', async () => {
      const d = deps({ fetch: (async () => raw([bytesOf(new Array(48000).fill(1000))], 'audio/pcm;rate=48000')) as unknown as typeof fetch });
      const spoken = await speakText(atServer(LENT, 'http://h/v1'), { text: 'こんにちは', language: 'ja' }, undefined, d, never, () => undefined);
      expect(Math.abs(spoken.samples - SAMPLE_RATE)).toBeLessThan(200);
    });

    it('is brought up as a run begins: one short word asked for in a voice of the run\'s, and dropped unheard', async () => {
      let cancelled = false;
      const answer = new Response(new ReadableStream<Uint8Array>({ pull() { /* never ends by itself */ }, cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'audio/pcm;rate=24000' } });
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => answer);
      const d = deps({ fetch: fetch as unknown as typeof globalThis.fetch });
      await warmVoice(atServer(LENT, 'http://192.168.1.20:8790/v1'), 'door-key', d, never);
      expect(String(fetch.mock.calls[0][0])).toBe('http://192.168.1.20:8790/v1/audio/speech');
      expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({ model: LENT.model, input: 'こんにちは。', voice: 'ono_anna', response_format: 'pcm', language: 'ja' });
      expect(cancelled).toBe(true);
      // Only another Kotomimi is warmed: an API, this computer's engine and Edge are not asked.
      for (const other of [API, NATIVE, EDGE]) await warmVoice(other, 'k', d, never);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('never fails a start, and gives up on a device that does not answer', async () => {
      const refused = deps({ fetch: (async () => { throw new Error('unreachable'); }) as unknown as typeof fetch });
      await expect(warmVoice(atServer(LENT, 'http://h/v1'), undefined, refused, never)).resolves.toBeUndefined();
      const hang = deps({ fetch: ((_input: RequestInfo | URL, init?: RequestInit) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch });
      const warming = warmVoice(atServer(LENT, 'http://h/v1'), undefined, hang, never);
      hang.clock.advance(VOICE_WARM_MS);
      await expect(warming).resolves.toBeUndefined();
    });

    it('warms the four prompts chosen by the recording library on the lender in order', async () => {
      const stage = { ...LENT, ownVoices: true as const, voices: { en: 'a', ja: 'b' } };
      const plain = [{ voice: 'a', language: 'en' }, { voice: 'b', language: 'ja' }];
      const reads = [...plain, { ...plain[1], tone: 'lively' }, { ...plain[0], tone: 'laugh' }];
      const recording = vi.fn(async (voice: string, language: string, _bytes: boolean, tone?: string) =>
        ({ id: voice + (tone ?? ''), text: 'Words.', language }));
      const fetch = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => raw([bytesOf([1])]));
      const warmReads = vi.fn(async () => reads);
      const d = deps({ fetch, recording, warmReads });
      await warmVoice(stage, 'k', d, never);
      expect(warmReads).toHaveBeenCalledWith(plain);
      expect(fetch.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).voice_ref))
        .toEqual(['a', 'b', 'blively', 'alaugh']);
    });

    it('decodes a file where the answer is one after all, and says what the device refused', async () => {
      const filed = deps({ fetch: (async () => new Response(new ArrayBuffer(44), { headers: { 'Content-Type': 'audio/wav' } })) as unknown as typeof fetch });
      await speakText(atServer(LENT, 'http://h/v1'), { text: 'こんにちは', language: 'ja' }, undefined, filed, never, () => undefined);
      expect(filed.decode).toHaveBeenCalledOnce();
      const busy = deps({ fetch: (async () => new Response('{"error":{"code":"voice_busy","message":"in use"}}', { status: 503 })) as unknown as typeof fetch });
      await expect(speakText(atServer(LENT, 'http://h/v1'), { text: 'こんにちは', language: 'ja' }, undefined, busy, never, () => undefined)).rejects.toThrow(/HTTP 503.*voice_busy/);
    });
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

    // One that speaks in the user's own voice reads a recording first: given the time for it, and no more.
    const p = deps({ native: hang });
    let ended: unknown = null;
    const patient = speakText({ ...NATIVE, patient: true }, { text: 'こんにちは', language: 'ja' }, undefined, p, never, () => undefined).catch((error) => { ended = error; });
    p.clock.advance(VOICE_TIMEOUT_MS * 2);
    await Promise.resolve();
    expect(ended).toBeNull();
    p.clock.advance(VOICE_PATIENT_MS);
    await patient;
    expect(String(ended)).toMatch(/in time/);
  });
});
