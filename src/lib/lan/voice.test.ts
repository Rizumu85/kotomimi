import { describe, expect, it, vi } from 'vitest';
import { createVirtualClock } from '../contract/clock';
import { createLanHost, type LanBridge } from './host';
import { capabilityList } from './protocol';
import { LanVoice, VOICE_IDLE_MS, type LanVoiceDeps } from './voice';

const QWEN = 'qwen3-tts-1.7b-customvoice-q8';

/** A voice engine as the door's page side drives it: what it was asked, and the holds on it. */
function voice(over: Partial<LanVoiceDeps> = {}) {
  const clock = createVirtualClock(0);
  const said: Array<{ id: string; said: unknown }> = [];
  const ups: string[] = [];
  const holds = { held: 0, released: 0 };
  const v = new LanVoice({
    resolve: (wanted) => (wanted === QWEN ? QWEN : null),
    busy: () => false,
    up: async (model) => { ups.push(model); },
    speak: async (id, one) => { said.push({ id, said: one }); return { ok: true }; },
    hold: () => { holds.held += 1; return () => { holds.released += 1; }; },
    clock,
    ...over,
  });
  return { v, clock, said, ups, holds };
}

describe('a sharing Kotomimi\u2019s voice', () => {
  it('says what it is for: a voice, with the languages it speaks', () => {
    expect(capabilityList([{ id: QWEN, kind: 'voice', languages: ['zh', 'en', 'ja'] }]).data.slice(1)).toEqual([{ id: QWEN, capabilities: ['tts'], languages: ['zh', 'en', 'ja'] }]);
  });

  it('brings the engine up with the model named and has the sentence sent, in its voice and language', async () => {
    const x = voice();
    expect(await x.v.speak('r1', { model: QWEN, input: '  こんにちは。 ', voice: 'ono_anna', language: 'ja-JP', response_format: 'pcm' })).toBeNull();
    expect(x.ups).toEqual([QWEN]);
    expect(x.said).toEqual([{ id: 'r1', said: { model: QWEN, text: 'こんにちは。', voice: 'ono_anna', language: 'ja-JP' } }]);
  });

  it('leaves out a voice or a language that was not given, or is none', async () => {
    const x = voice();
    await x.v.speak('r1', { model: QWEN, input: 'Hello.', language: '<b>' });
    expect(x.said[0].said).toEqual({ model: QWEN, text: 'Hello.' });
  });

  it('speaks no more of a text than the asking side would send', async () => {
    const x = voice();
    await x.v.speak('r1', { model: QWEN, input: 'あ'.repeat(900) });
    expect((x.said[0].said as { text: string }).text).toHaveLength(400);
  });

  it('refuses nothing to say, a model it does not lend, and an engine that is someone\u2019s with another model', async () => {
    const x = voice({ busy: () => true });
    expect(await x.v.speak('r1', { model: QWEN, input: '  ' })).toMatchObject({ status: 400, body: { error: { code: 'no_text' } } });
    expect(await x.v.speak('r2', { model: 'kotomimi', input: 'Hello.' })).toMatchObject({ status: 404, body: { error: { code: 'model_not_found' } } });
    expect(await x.v.speak('r3', { input: 'Hello.' })).toMatchObject({ status: 404 });
    expect(await x.v.speak('r4', { model: QWEN, input: 'Hello.' })).toMatchObject({ status: 503, body: { error: { code: 'voice_busy' } } });
    // None of them touched the engine.
    expect(x.ups).toEqual([]);
    expect(x.holds.held).toBe(0);
  });

  it('answers with the failure when nothing went out, and with nothing more when some of the sound did', async () => {
    const failed = voice({ speak: async () => ({ error: 'The voice engine answered 500.', sent: false }) });
    expect(await failed.v.speak('r1', { model: QWEN, input: 'Hello.' })).toMatchObject({ status: 500, body: { error: { code: 'server_error' } } });
    const cut = voice({ speak: async () => ({ error: 'The voice was stopped.', sent: true }) });
    expect(await cut.v.speak('r1', { model: QWEN, input: 'Hello.' })).toBeNull();
    const down = voice({ up: async () => { throw new Error('C:\\Users\\someone\\model.gguf is missing'); } });
    const answer = await down.v.speak('r1', { model: QWEN, input: 'Hello.' });
    expect(answer).toMatchObject({ status: 500 });
    // A path of this computer is not told to the device.
    expect(JSON.stringify(answer)).not.toContain('someone');
  });

  it('holds the engine while devices ask, and lets it go a while after the last', async () => {
    const x = voice();
    await x.v.speak('r1', { model: QWEN, input: 'Hello.' });
    await x.v.speak('r2', { model: QWEN, input: 'Hello.' });
    expect(x.holds).toEqual({ held: 1, released: 0 });
    x.clock.advance(VOICE_IDLE_MS - 1);
    expect(x.holds.released).toBe(0);
    x.clock.advance(1);
    expect(x.holds.released).toBe(1);
    // Asked again, it is held again; and let go at once when sharing stops.
    await x.v.speak('r3', { model: QWEN, input: 'Hello.' });
    expect(x.holds.held).toBe(2);
    x.v.dispose();
    expect(x.holds.released).toBe(2);
  });

  it('gives the engine to the first of two devices that ask for two models at once, before its status says so', async () => {
    const IRODORI = 'irodori-tts-v4.1-small-mf-q8';
    const loading: Array<() => void> = [];
    const x = voice({
      resolve: (wanted) => (wanted === QWEN || wanted === IRODORI ? wanted : null),
      // The engine's own status knows nothing yet: the model is still coming up.
      busy: () => false,
      up: (model) => new Promise<void>((resolve) => { x.ups.push(model); loading.push(resolve); }),
    });
    const first = x.v.speak('r1', { model: QWEN, input: 'Hello.' });
    expect(await x.v.speak('r2', { model: IRODORI, input: 'こんにちは。' })).toMatchObject({ status: 503, body: { error: { code: 'voice_busy' } } });
    // The same model is no rival: it waits its turn at the engine.
    const same = x.v.speak('r3', { model: QWEN, input: 'Hello again.' });
    expect(loading).toHaveLength(2);
    for (const loaded of loading) loaded();
    expect(await first).toBeNull();
    expect(await same).toBeNull();
    expect(x.ups).toEqual([QWEN, QWEN]);
  });

  it('lets its own hold go before asking whether the engine is someone\u2019s, when a device asks for another model', async () => {
    const IRODORI = 'irodori-tts-v4.1-small-mf-q8';
    // The engine counts as someone's while anything holds it: here, only this door's own hold does.
    let holds = 0;
    const x = voice({
      resolve: (wanted) => (wanted === QWEN || wanted === IRODORI ? wanted : null),
      hold: () => { holds += 1; return () => { holds -= 1; }; },
      busy: () => holds > 0,
    });
    expect(await x.v.speak('r1', { model: QWEN, input: 'Hello.' })).toBeNull();
    expect(holds).toBe(1);
    // Kept for a while after the sentence, and no obstacle to the next one in another model.
    expect(await x.v.speak('r2', { model: IRODORI, input: 'こんにちは。' })).toBeNull();
    expect(x.ups).toEqual([QWEN, IRODORI]);
    expect(holds).toBe(1);
  });
});

describe('the sharing host, asked for a sentence', () => {
  function door() {
    const calls: Array<{ channel: string; data: Record<string, unknown> }> = [];
    const listeners = new Map<string, (payload: never) => void>();
    const b: LanBridge = {
      invoke: async (channel, data) => {
        calls.push({ channel, data: data as Record<string, unknown> });
        if (channel === 'lan:start') return { ok: true, port: 8790, addresses: ['192.168.1.20'] };
        return channel === 'lan:reply-voice' ? { ok: true } : true;
      },
      on: (channel, listener) => { listeners.set(channel, listener); return () => listeners.delete(channel); },
    };
    return { b, of: (channel: string) => calls.filter((c) => c.channel === channel).map((c) => c.data), deliver: (channel: string, payload: unknown) => (listeners.get(channel) as ((p: unknown) => void) | undefined)?.(payload) };
  }
  const engines = { recognizer: () => { throw new Error('none'); }, translator: () => { throw new Error('none'); } };
  const models = { shared: () => [], recognizer: () => null, translator: () => null };

  it('has the main process send the sound, and replies itself only to what it refuses', async () => {
    const d = door();
    const ups: string[] = [];
    const h = createLanHost({
      bridge: d.b,
      models: { ...models, voice: (wanted) => (wanted === QWEN ? QWEN : null) },
      engines: { ...engines, voice: { busy: () => false, up: async (model) => { ups.push(model); }, hold: () => () => {} } },
      clock: createVirtualClock(0),
    });
    await h.start({ port: 8790, key: '' });
    d.deliver('lan:request', { id: 'v1', method: 'POST', path: '/v1/audio/speech', body: { model: QWEN, input: 'Hello.', voice: 'ryan', language: 'en' } });
    await vi.waitFor(() => expect(d.of('lan:reply-voice')).toHaveLength(1));
    expect(d.of('lan:reply-voice')[0]).toEqual({ id: 'v1', model: QWEN, text: 'Hello.', voice: 'ryan', language: 'en' });
    expect(ups).toEqual([QWEN]);
    d.deliver('lan:request', { id: 'v2', method: 'POST', path: '/v1/audio/speech', body: { model: 'another', input: 'Hello.' } });
    await vi.waitFor(() => expect(d.of('lan:reply')).toHaveLength(1));
    expect(d.of('lan:reply')[0]).toMatchObject({ id: 'v2', status: 404 });
    // The sentence that went out was never replied to a second time.
    expect(d.of('lan:reply').some((reply) => reply.id === 'v1')).toBe(false);
  });

  it('shares no such thing where no voice engine is lent', async () => {
    const d = door();
    const h = createLanHost({ bridge: d.b, models, engines, clock: createVirtualClock(0) });
    await h.start({ port: 8790, key: '' });
    d.deliver('lan:request', { id: 'v1', method: 'POST', path: '/v1/audio/speech', body: { model: QWEN, input: 'Hello.' } });
    await vi.waitFor(() => expect(d.of('lan:reply')).toHaveLength(1));
    expect(d.of('lan:reply')[0]).toMatchObject({ id: 'v1', status: 404 });
  });
});
