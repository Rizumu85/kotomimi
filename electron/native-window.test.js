// @vitest-environment node
// electron/native-window.test.js
//
// Fork: a recognition by a model that reads a whole stretch at once, kept
// live by reading the stretch again as it grows (`openWindow`). The readings
// are answers the test gives, the timers its own; one test talks to a real
// socket on this computer for the shape of a reading.
import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openWindow, wavOf, loopAt, unloop, quietMiddle, MODELS } = require('./native-engine.js');

const RATE = 16000;
/** A stretch of sound, this long and this loud. */
const sound = (seconds, size = 8000) => {
  const pcm = Buffer.alloc(Math.round(seconds * RATE) * 2);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(size, i);
  return pcm;
};

/** A recognition with the test's own readings and timers. */
function recognition() {
  const world = { events: [], readings: [], timers: [], now: 0 };
  const read = ({ pcm, language, model }) => {
    const reading = { seconds: pcm.length / 2 / RATE, language, model, aborted: false };
    reading.done = new Promise((resolve) => { reading.answer = (text, took = 100) => { world.now += took; resolve(typeof text === 'string' ? { ok: true, text } : text); return new Promise((r) => setTimeout(r, 0)); }; });
    reading.abort = () => { reading.aborted = true; };
    world.readings.push(reading);
    return reading;
  };
  const setTimer = (run, ms) => { const timer = { run, ms }; world.timers.push(timer); return timer; };
  const clearTimer = (timer) => { world.timers = world.timers.filter((one) => one !== timer); };
  /** The timer that is waiting fires. */
  world.tick = () => { const [timer] = world.timers.splice(0, 1); timer?.run(); return timer?.ms; };
  const stream = openWindow({ port: 1, model: 'q', sampleRate: RATE, language: 'ja', read, now: () => world.now, setTimer, clearTimer }, (event) => world.events.push(event));
  return { world, stream };
}

describe('a recognition by a model that reads a stretch at once', () => {
  it('reads the stretch again as it grows — each reading is what shows meanwhile — and once more when it is over', async () => {
    const { world, stream } = recognition();
    stream.write(sound(1));
    // Nothing is read the moment sound comes: a reading waits its turn.
    expect(world.readings).toHaveLength(0);
    world.tick();
    expect(world.readings[0]).toMatchObject({ seconds: 1, language: 'ja', model: 'q' });
    stream.write(sound(1));
    // One reading at a time.
    expect(world.timers).toHaveLength(0);
    await world.readings[0].answer('こん');
    expect(world.events).toEqual([{ type: 'partial', text: 'こん' }]);
    world.tick();
    expect(world.readings[1].seconds).toBe(2);
    await world.readings[1].answer('こんにちは');
    stream.write(sound(0.5));
    stream.end();
    // The voice went on after the last reading: the whole is read once more.
    expect(world.readings[2].seconds).toBe(2.5);
    await world.readings[2].answer('こんにちは。');
    expect(world.events).toEqual([{ type: 'partial', text: 'こん' }, { type: 'partial', text: 'こんにちは' }, { type: 'done', text: 'こんにちは。' }]);
  });

  it('is over at once when the last reading left out only the silence that ended it', async () => {
    const { world, stream } = recognition();
    stream.write(sound(2));
    world.tick();
    await world.readings[0].answer('そうだね');
    // The pause, and the silence a close adds.
    stream.write(sound(1.4, 40));
    stream.write(sound(1, 0));
    stream.end();
    expect(world.readings).toHaveLength(1);
    expect(world.events).toEqual([{ type: 'partial', text: 'そうだね' }, { type: 'done', text: 'そうだね' }]);
  });

  it('is read once more when what the last reading left out is long, however quiet', async () => {
    const { world, stream } = recognition();
    stream.write(sound(2));
    world.tick();
    await world.readings[0].answer('そうだね');
    stream.write(sound(4, 40));
    stream.end();
    expect(world.readings).toHaveLength(2);
  });

  it('lets a reading under way decide: the last one if it had all the voice, else one more', async () => {
    const quiet = recognition();
    quiet.stream.write(sound(2));
    quiet.world.tick();
    quiet.stream.write(sound(1, 0));
    quiet.stream.end();
    await quiet.world.readings[0].answer('はい');
    expect(quiet.world.readings).toHaveLength(1);
    expect(quiet.world.events).toEqual([{ type: 'done', text: 'はい' }]);

    const loud = recognition();
    loud.stream.write(sound(2));
    loud.world.tick();
    loud.stream.write(sound(1));
    loud.stream.end();
    await loud.world.readings[0].answer('はい');
    // Not shown: it is already out of date, and the last reading follows.
    expect(loud.world.events).toEqual([]);
    expect(loud.world.readings[1].seconds).toBe(3);
    await loud.world.readings[1].answer('はい、そうです');
    expect(loud.world.events).toEqual([{ type: 'done', text: 'はい、そうです' }]);
  });

  it('rests as long as the last reading took: a slow computer reads less often, and is not behind for it', async () => {
    const { world, stream } = recognition();
    stream.write(sound(1));
    expect(world.tick()).toBe(600);
    stream.write(sound(1));
    await world.readings[0].answer('あ', 2500);
    expect(world.tick()).toBe(2500);
    await world.readings[1].answer('あい', 200);
    stream.write(sound(1));
    expect(world.tick()).toBe(600);
  });

  it('does not read again for a moment of new sound', async () => {
    const { world, stream } = recognition();
    stream.write(sound(1));
    world.tick();
    await world.readings[0].answer('あ');
    stream.write(sound(0.1));
    world.tick();
    expect(world.readings).toHaveLength(1);
    stream.write(sound(0.4));
    world.tick();
    expect(world.readings).toHaveLength(2);
  });

  it('keeps what it showed when a reading on the way fails, and says so when the last one does', async () => {
    const { world, stream } = recognition();
    stream.write(sound(1));
    world.tick();
    await world.readings[0].answer({ ok: false, message: 'busy' });
    expect(world.events).toEqual([]);
    stream.write(sound(1));
    stream.end();
    await world.readings[1].answer({ ok: false, message: 'The engine answered HTTP 503: busy' });
    expect(world.events).toEqual([{ type: 'error', message: 'The engine answered HTTP 503: busy' }]);
  });

  it('writes nothing for no sound, and nothing more once it is dropped', async () => {
    const empty = recognition();
    empty.stream.end();
    expect(empty.world.events).toEqual([{ type: 'done', text: '' }]);

    const { world, stream } = recognition();
    stream.write(sound(1));
    world.tick();
    stream.abort();
    expect(world.readings[0].aborted).toBe(true);
    await world.readings[0].answer('あ');
    stream.write(sound(1));
    stream.end();
    expect(world.events).toEqual([]);
    expect(world.timers).toHaveLength(0);
  });
});

describe('a reading in which the model lost its way', () => {
  const LOST = `飲んだ方がいいかもしれない。${'波で'.repeat(200)}`;

  it('is told from speech that merely repeats itself', () => {
    expect(loopAt(LOST)).toBe(14);
    expect(unloop(LOST)).toBe('飲んだ方がいいかもしれない。波で');
    for (const said of ['そうそうそうそう。それだったら大丈夫だ。', 'ありがとう、ありがとう、ありがとうございます。ありがとうございます。', 'はははははは', '一回だけ、一回だけ。一回なの。']) {
      expect(loopAt(said)).toBe(-1);
      expect(unloop(said)).toBe(said);
    }
  });

  it('shows what came before, and is not the reading a recognition ends on', async () => {
    const { world, stream } = recognition();
    stream.write(sound(8));
    world.tick();
    await world.readings[0].answer(LOST, 3000);
    expect(world.events).toEqual([{ type: 'partial', text: '飲んだ方がいいかもしれない。波で' }]);
    // The stretch ends with nothing but silence since: it is read again all the same.
    stream.write(sound(1, 0));
    stream.end();
    expect(world.readings).toHaveLength(2);
    await world.readings[1].answer('飲んだ方がいいかもしれない。波の上下なんで結構酔います。');
    expect(world.events.at(-1)).toEqual({ type: 'done', text: '飲んだ方がいいかもしれない。波の上下なんで結構酔います。' });
  });

  it('is read again, as the last one, with half a second of silence before the stretch', async () => {
    const { world, stream } = recognition();
    stream.write(sound(8));
    stream.end();
    await world.readings[0].answer(LOST, 3000);
    expect(world.events).toEqual([]);
    expect(world.readings[1].seconds).toBe(8.5);
    await world.readings[1].answer('飲んだ方がいいかもしれない。波の上下なんで結構酔います。');
    expect(world.events).toEqual([{ type: 'done', text: '飲んだ方がいいかもしれない。波の上下なんで結構酔います。' }]);
    expect(world.readings).toHaveLength(2);
  });

  it('is read in two halves when that does not help: a half that still repeats is cut where it begins to', async () => {
    const { world, stream } = recognition();
    // Loud, a quiet moment a little after the middle, loud again.
    stream.write(sound(4.4));
    stream.write(sound(0.3, 20));
    stream.write(sound(3.3));
    stream.end();
    await world.readings[0].answer(LOST, 3000);
    await world.readings[1].answer(LOST, 3000);
    // The halves meet in the quiet moment.
    expect(world.readings[2].seconds).toBeGreaterThan(4.4);
    expect(world.readings[2].seconds).toBeLessThan(4.7);
    await world.readings[2].answer(LOST, 3000);
    expect(world.readings[2].seconds + world.readings[3].seconds).toBeCloseTo(8, 5);
    await world.readings[3].answer('結構酔うか。じゃあ明日薬を飲もうかな。');
    expect(world.events).toEqual([{ type: 'done', text: '飲んだ方がいいかもしれない。波で結構酔うか。じゃあ明日薬を飲もうかな。' }]);
    // …with no space where the halves meet: Japanese has none between its words.
  });

  it('leaves what came before when the stretch is too short to cut, or a half cannot be read', async () => {
    const short = recognition();
    short.stream.write(sound(2));
    short.stream.end();
    await short.world.readings[0].answer(LOST);
    await short.world.readings[1].answer(LOST);
    expect(short.world.readings).toHaveLength(2);
    expect(short.world.events).toEqual([{ type: 'done', text: '飲んだ方がいいかもしれない。波で' }]);

    const { world, stream } = recognition();
    stream.write(sound(8));
    stream.end();
    await world.readings[0].answer(LOST);
    await world.readings[1].answer({ ok: false, message: 'busy' });
    await world.readings[2].answer({ ok: false, message: 'busy' });
    expect(world.events).toEqual([{ type: 'done', text: '飲んだ方がいいかもしれない。波で' }]);
  });

  it('finds the quietest moment of the middle third to cut at', () => {
    const pcm = Buffer.concat([sound(1, 20), sound(3), sound(0.3, 20), sound(4.7)]);
    const at = quietMiddle(pcm, RATE) / 2 / RATE;
    expect(at).toBeGreaterThan(4);
    expect(at).toBeLessThan(4.3);
  });
});

describe('a reading (a real socket on this computer)', () => {
  it('sends the stretch as a WAV file in a form, with the model and the language, and takes the text of the answer', async () => {
    const seen = { url: '', type: '', body: Buffer.alloc(0) };
    const server = http.createServer((request, response) => {
      seen.url = request.url;
      seen.type = request.headers['content-type'];
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => { seen.body = Buffer.concat(chunks); response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ text: ' こんにちは。 ' })); });
    });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const pcm = sound(0.5);
    const event = await new Promise((resolve) => {
      const stream = openWindow({ port, model: 'qwen3-asr-1.7b-q8', sampleRate: RATE, language: 'ja' }, resolve);
      stream.write(pcm);
      stream.end();
    });
    server.close();
    expect(event).toEqual({ type: 'done', text: 'こんにちは。' });
    expect(seen.url).toBe('/v1/audio/transcriptions');
    const boundary = /boundary=(.+)$/.exec(seen.type)[1];
    const text = seen.body.toString('latin1');
    expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nqwen3-asr-1.7b-q8\r\n`);
    expect(text).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\nja\r\n`);
    expect(text).toContain('name="file"; filename="stretch.wav"\r\nContent-Type: audio/wav\r\n\r\nRIFF');
    expect(text.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    // The file is the sound, whole, under a header that says what it is.
    const wav = wavOf(pcm, RATE);
    expect(seen.body.includes(wav)).toBe(true);
    expect(wav.readUInt32LE(24)).toBe(RATE);
    expect(wav.readUInt32LE(40)).toBe(pcm.length);
  });

  it('says what the runtime refused with, and when nothing listens there', async () => {
    const server = http.createServer((request, response) => { request.resume(); response.writeHead(503); response.end('{"error":"model busy"}'); });
    const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
    const ask = (at) => new Promise((resolve) => { const stream = openWindow({ port: at, model: 'q', sampleRate: RATE, language: null }, resolve); stream.write(sound(0.2)); stream.end(); });
    expect(await ask(port)).toEqual({ type: 'error', message: 'The engine answered HTTP 503: {"error":"model busy"}' });
    server.close();
    expect((await ask(1)).type).toBe('error');
  });
});

describe('the model read that way', () => {
  it('is Qwen3-ASR, for every system the runtime is published for, told the language by its code', () => {
    expect(MODELS['qwen3-asr-1.7b-q8']).toMatchObject({ family: 'qwen3_asr', mode: 'offline', languageAs: 'code' });
    expect(MODELS['qwen3-asr-1.7b-q8'].platforms).toBeUndefined();
  });
});

// Review (REVIEW-native-engine.md): defects found by reading the code, each pinned by a test that fails until it is
// put right. Production code is unchanged.
describe('review: what the code should do and does not yet', () => {
  it('does not take speech that repeats a character eight times for a model that lost its way', () => {
    // A model that loses its way writes the same thing until it is stopped: to the end of the reading. These are
    // followed by more speech, and are what people say (or what a recognizer writes for a number).
    for (const said of [
      '人口は1400000000人です。',
      '予算は100000000円です。',
      '哈哈哈哈哈哈哈哈，太好笑了。',
      'ははははははははは、面白い。',
      '对对对对对对对对，就是这样。',
      'はいはいはいはいはいはいはいはい、わかりました。',
      '네네네네네네네네, 알겠어요.',
    ]) {
      expect(loopAt(said), said).toBe(-1);
      expect(unloop(said), said).toBe(said);
    }
  });

  it('reads once more when the voice went on after the last reading, though more softly than its loudest moment', async () => {
    const { world, stream } = recognition();
    // A laugh or a plosive near full scale, then speech at an ordinary level.
    stream.write(sound(0.2, 30000));
    stream.write(sound(1.8, 6000));
    world.tick();
    await world.readings[0].answer('そうなんだ');
    // The last word, said softly (about -22 dBFS, a tenth of the peak is 3000), then the pause.
    stream.write(sound(0.6, 2500));
    stream.write(sound(1.4, 0));
    stream.end();
    // Ended on the reading that never heard the last word.
    expect(world.readings).toHaveLength(2);
  });
});

describe('what the review changed besides', () => {
  it('still takes for lost a reading that repeats to its end, however it began', () => {
    const lost = `今日は天気がいいですね。${'波で'.repeat(250)}`;
    expect(loopAt(lost)).toBe(12);
    expect(unloop(lost)).toBe('今日は天気がいいですね。波で');
    // Cut off in the middle of the thing repeated: the token limit does not end on a whole one.
    expect(loopAt(`${'ありがとう、'.repeat(40)}ありが`)).toBe(0);
    // A long repeating that the speech then leaves is what was said: a chant, a song.
    const sung = `${'ラ'.repeat(60)}って歌ってたんだよね、あの人がずっと、ほんとうに長いあいだ。`;
    expect(loopAt(sung)).toBe(-1);
  });

  it('ends a stretch that is never ended, rather than keep its sound for ever', () => {
    const { world, stream } = recognition();
    for (let i = 0; i < 13; i += 1) stream.write(sound(10));
    expect(world.events).toEqual([{ type: 'error', message: expect.stringContaining('too long') }]);
    // Over: nothing more is taken or read.
    stream.write(sound(1));
    stream.end();
    expect(world.events).toHaveLength(1);
  });

  it('does not wait as long as a reading that never came back took, before the next', async () => {
    const { world, stream } = recognition();
    stream.write(sound(1));
    world.tick();
    await world.readings[0].answer('こん', 200);
    stream.write(sound(1));
    expect(world.tick()).toBe(600);
    // This one times out, thirty seconds later.
    await world.readings[1].answer({ ok: false, message: 'The engine did not answer in time.' }, 30000);
    stream.write(sound(1));
    // The next is asked as soon as after any other: the stretch is not left without its words for half a minute.
    expect(world.tick()).toBe(600);
  });
});
