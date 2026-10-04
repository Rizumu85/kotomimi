import { describe, expect, it, vi } from 'vitest';
import { createVirtualClock } from '../../lib/contract/clock';
import { apiLanguage, createApiAsr, transcriptionsUrl, UPLOAD_TIMEOUT_MS, wavOf, type VadWorker } from './apiAsr';

const RATE = 24000;
const VAD = { threshold: 0.5, minSilenceDuration: 1.4, minSpeechDuration: 0.4, maxSpeechDuration: 20 };

/** The detector as a recorder: what it was sent, and a way to say what it "heard". */
function fakeVad() {
  const sent: Array<{ type: string; pcm?: Int16Array }> = [];
  const worker: VadWorker & { say(type: string, message?: string): void; terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage: (message) => { sent.push(message as { type: string }); },
    terminate: () => { worker.terminated = true; },
    say: (type, message) => worker.onmessage?.({ data: { type, message } }),
  };
  return { worker, sent };
}

/** An API that answers each upload in turn, and keeps what it was sent. */
function fakeApi(...answers: Array<{ status?: number; body: unknown } | Error>) {
  const calls: Array<{ url: string; headers?: Record<string, string>; form: FormData }> = [];
  const fetch = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), headers: init?.headers as Record<string, string> | undefined, form: init?.body as FormData });
    const next = answers.shift() ?? { body: { text: '' } };
    if (next instanceof Error) throw next;
    return new Response(typeof next.body === 'string' ? next.body : JSON.stringify(next.body), { status: next.status ?? 200 });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** A recognizer over the two, started, with what it reported. */
async function started(api: ReturnType<typeof fakeApi>, options: { key?: string; language?: string } = {}) {
  const vad = fakeVad();
  let clock = 1000;
  const asr = createApiAsr({ baseUrl: 'https://api.example.com/v1/', model: 'whisper-large-v3', key: options.key, fetch: api.fetch, vad: () => vad.worker, now: () => (clock += 250) });
  const seen = { results: [] as Array<{ text: string; durationMs: number; recognitionTimeMs: number }>, starts: 0, errors: [] as string[], fatal: [] as string[] };
  asr.onResult = (result) => seen.results.push(result);
  asr.onSpeechStart = () => { seen.starts += 1; };
  asr.onError = (error) => seen.errors.push(error);
  asr.onFatal = (error) => seen.fatal.push(error);
  const ready = asr.init('whisper-large-v3', { vadConfig: VAD, language: options.language ?? 'ja' });
  vad.worker.say('ready');
  await ready;
  return { asr, vad, seen };
}

const seconds = (s: number, value = 1) => new Int16Array(Math.round(s * RATE)).fill(value);
const settled = () => new Promise((r) => setTimeout(r, 0));

describe('the pieces of a transcription request', () => {
  it('goes to the base URL\'s own transcriptions path, however the base was typed', () => {
    expect(transcriptionsUrl('https://api.groq.com/openai/v1')).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(transcriptionsUrl(' http://192.168.1.10:8080/v1/ ')).toBe('http://192.168.1.10:8080/v1/audio/transcriptions');
  });

  it('names the language by its two letters, and not at all when it is to be detected', () => {
    expect(apiLanguage('ja')).toBe('ja');
    expect(apiLanguage('zh-CN')).toBe('zh');
    expect(apiLanguage('auto')).toBeUndefined();
    expect(apiLanguage('')).toBeUndefined();
  });

  it('is a WAV file: 16-bit mono at the rate it was heard', () => {
    const wav = wavOf(Int16Array.from([1, -2, 3]), RATE);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4), ...wav.slice(8, 12))).toBe('RIFFWAVE');
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(RATE);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(6);
    expect([view.getInt16(44, true), view.getInt16(46, true), view.getInt16(48, true)]).toEqual([1, -2, 3]);
  });
});

describe('a recognizer that is an API', () => {
  it('starts the detector with this computer\'s own settings, and feeds it everything it hears', async () => {
    const { asr, vad } = await started(fakeApi());
    expect(vad.sent[0]).toMatchObject({ type: 'init', vadConfig: VAD });
    asr.feedAudio(seconds(0.1), RATE);
    expect(vad.sent[1]).toMatchObject({ type: 'audio', sampleRate: RATE });
    expect(vad.sent[1].pcm).toHaveLength(2400);
  });

  it('uploads a stretch of speech when it ends — with the moments before it — and reports its text', async () => {
    const api = fakeApi({ body: { text: ' こんにちは。 ' } });
    const { asr, vad, seen } = await started(api, { key: 'k-1' });
    // Two seconds of quiet, of which only the last moments are kept; then speech.
    asr.feedAudio(seconds(1), RATE);
    asr.feedAudio(seconds(1), RATE);
    asr.feedAudio(seconds(0.5, 7), RATE);
    vad.worker.say('speech_start');
    expect(seen.starts).toBe(1);
    asr.feedAudio(seconds(2, 9), RATE);
    asr.feedAudio(seconds(1.4, 0), RATE);
    vad.worker.say('speech_end');
    await settled();
    await settled();
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0].url).toBe('https://api.example.com/v1/audio/transcriptions');
    expect(api.calls[0].headers).toEqual({ Authorization: 'Bearer k-1' });
    const { form } = api.calls[0];
    expect(form.get('model')).toBe('whisper-large-v3');
    expect(form.get('language')).toBe('ja');
    expect(form.get('response_format')).toBe('json');
    // 0.5 s before + 1 s kept of the quiet (the chunk that holds the last 0.8 s) + 2 s spoken + 0.3 s of the silence that ended it.
    const file = form.get('file') as File;
    expect(file.size).toBe(44 + Math.round((1 + 0.5 + 2 + 0.3) * RATE) * 2);
    expect(seen.results).toEqual([{ text: 'こんにちは。', durationMs: 3800, recognitionTimeMs: 250 }]);
  });

  it('sends no key to a server that takes none, and names no language when it is to be detected', async () => {
    const api = fakeApi({ body: { text: 'hello' } });
    const { asr, vad } = await started(api, { language: 'auto' });
    vad.worker.say('speech_start');
    asr.feedAudio(seconds(1), RATE);
    vad.worker.say('speech_end');
    await settled();
    await settled();
    expect(api.calls[0].headers).toBeUndefined();
    expect(api.calls[0].form.get('language')).toBeNull();
  });

  it('keeps the texts in the order they were spoken, and uploads nothing for a sound too short to be speech', async () => {
    const api = fakeApi({ body: { text: 'one' } }, { body: { text: 'two' } });
    const { asr, vad, seen } = await started(api);
    for (const _ of [1, 2]) {
      vad.worker.say('speech_start');
      asr.feedAudio(seconds(1), RATE);
      vad.worker.say('speech_end');
    }
    vad.worker.say('speech_start');
    asr.feedAudio(seconds(0.1), RATE);
    vad.worker.say('speech_cancel');
    await settled();
    await settled();
    await settled();
    expect(seen.results.map((r) => r.text)).toEqual(['one', 'two']);
    expect(api.calls).toHaveLength(2);
  });

  it('reports one failed stretch and goes on: the API\'s own words for a refusal, and an unreachable server', async () => {
    const api = fakeApi({ status: 401, body: '{"error":{"message":"Invalid API Key"}}' }, new Error('getaddrinfo ENOTFOUND'), { body: { text: 'after' } });
    const { asr, vad, seen } = await started(api);
    for (const _ of [1, 2, 3]) {
      vad.worker.say('speech_start');
      asr.feedAudio(seconds(1), RATE);
      vad.worker.say('speech_end');
    }
    for (const _ of [1, 2, 3, 4]) await settled();
    expect(seen.errors[0]).toContain('HTTP 401');
    expect(seen.errors[0]).toContain('Invalid API Key');
    expect(seen.errors[1]).toContain('could not be reached');
    expect(seen.results.map((r) => r.text)).toEqual(['after']);
    expect(seen.fatal).toEqual([]);
  });

  it('writes nothing for a stretch the API hears nothing in', async () => {
    const api = fakeApi({ body: { text: '  ' } });
    const { asr, vad, seen } = await started(api);
    vad.worker.say('speech_start');
    asr.feedAudio(seconds(1), RATE);
    vad.worker.say('speech_end');
    await settled();
    await settled();
    expect(seen.results).toEqual([]);
    expect(seen.errors).toEqual([]);
  });

  it('ends a stretch on a flush, and stops everything when disposed', async () => {
    const api = fakeApi({ body: { text: 'late' } });
    const { asr, vad, seen } = await started(api);
    asr.flush();
    expect(vad.sent[vad.sent.length - 1]).toEqual({ type: 'flush' });
    vad.worker.say('speech_start');
    asr.feedAudio(seconds(1), RATE);
    asr.dispose();
    expect(vad.worker.terminated).toBe(true);
    vad.worker.say('speech_end');
    await settled();
    expect(api.calls).toEqual([]);
    expect(seen.results).toEqual([]);
  });

  it('fails to start when the detector cannot, and says the session is over when it dies later', async () => {
    const vad = fakeVad();
    const asr = createApiAsr({ baseUrl: 'http://x/v1', model: 'm', fetch: fakeApi().fetch, vad: () => vad.worker });
    const starting = asr.init('m', { vadConfig: VAD, language: 'ja' });
    vad.worker.say('error', 'no model');
    await expect(starting).rejects.toThrow('no model');

    const { vad: live, seen } = await started(fakeApi());
    live.worker.onerror?.({ message: 'worker crashed' });
    expect(seen.fatal).toEqual(['worker crashed']);
  });

  it('gives up on an upload that never answers, says so, and sends the next stretch', async () => {
    // The first upload hangs (a server stuck loading a model, a computer gone to sleep); the second is answered.
    const calls: Array<{ signal?: AbortSignal | null }> = [];
    const fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ signal: init?.signal });
      if (calls.length > 1) return Promise.resolve(new Response(JSON.stringify({ text: 'second' }), { status: 200 }));
      return new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const clock = createVirtualClock();
    const vad = fakeVad();
    const asr = createApiAsr({ baseUrl: 'http://x/v1', model: 'm', fetch: fetch as unknown as typeof globalThis.fetch, vad: () => vad.worker, clock });
    const errors: string[] = [];
    const results: string[] = [];
    asr.onError = (error) => errors.push(error);
    asr.onResult = (result) => results.push(result.text);
    const ready = asr.init('m', { vadConfig: VAD, language: 'ja' });
    vad.worker.say('ready');
    await ready;
    for (let i = 0; i < 2; i += 1) {
      vad.worker.say('speech_start');
      asr.feedAudio(seconds(1), RATE);
      vad.worker.say('speech_end');
    }
    await settled();
    expect(calls).toHaveLength(1);
    clock.advance(UPLOAD_TIMEOUT_MS);
    await settled();
    await settled();
    expect(errors).toEqual([`The speech recognition API did not answer within ${UPLOAD_TIMEOUT_MS / 1000} s.`]);
    expect(calls).toHaveLength(2);
    expect(results).toEqual(['second']);
    // Nothing is left armed once the answers are in.
    expect(clock.pending()).toBe(0);
  });
});
