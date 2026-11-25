/**
 * Fork: a sentence, spoken. What speaks is a stage like the others, in one of
 * three places: this computer's voice engine (audio.cpp's server, asked
 * through the main process), an API, or the other device (another Kotomimi
 * that lends its voice, `src/lib/lan/voice.ts`). All three are asked over
 * OpenAI's `/audio/speech` wire; Microsoft Edge's online voices, which need
 * no key and no download, are asked in their own way beside it.
 *
 * Whatever answers, the sound comes out as the contract's own: 24 kHz mono
 * Int16, in pieces as they are made where the place makes them so, so that a
 * sentence begins to be heard before all of it is ready.
 */
import { SAMPLE_RATE } from '../../lib/contract/adapter';
import type { Clock } from '../../lib/contract/clock';
import { createResampler } from '../../lib/native/resample';
import { NO_KEY } from './textModel';

/** The credential a voice is asked with, by its field: a voice API's own key, or the other device's access key. */
export type VoiceKey = 'speakKey' | 'serverKey';

export interface VoiceStage {
  /** `speech`: OpenAI's `/audio/speech`. `edge`: Microsoft Edge's online voices. */
  via: 'speech' | 'edge';
  /** `speech` at an address: the OpenAI-style base URL (`https://api.openai.com/v1`). Blank with `engine` and `server`, and for `edge`. */
  baseUrl: string;
  /** Present: the device the stages share. Its address is the run's credential, so whoever asks gives `baseUrl` (`atServer`). */
  server?: true;
  /** A Kotomimi's door: asked for the sound raw, which it sends as it is made (`audio/pcm;rate=…`), where an API answers with a file. */
  streams?: true;
  /** Present: this computer's voice engine. It answers no page (it sends no CORS headers), so the main process asks it. */
  engine?: true;
  model: string;
  /** Absent: the place takes no key. */
  key?: VoiceKey;
  /** The voice each language is spoken in, by the language's base code; `*`: one voice for every language. One with none is spoken in the place's own. */
  voices: Readonly<Record<string, string>>;
  /** The languages it speaks, by base code. Absent: any. */
  languages?: readonly string[];
  /** The place is a Kotomimi's engine: told the language too, which a hosted API may refuse as a field it does not know. */
  tellsLanguage?: true;
  /** It speaks in the user's own voice, read from a recording before the first sentence in it: given longer to answer. */
  patient?: true;
}

/** The longest text spoken in one request: a translation that ran on is not read out to its end. */
export const VOICE_MOST_CHARS = 400;
/** How long one sentence may take to be made, from the request to its last sound. */
export const VOICE_TIMEOUT_MS = 30_000;
/** And for a `patient` one: the engine's own limit for a recording read (`CLONE_TIMEOUT_MS`, native-engine.js). */
export const VOICE_PATIENT_MS = 180_000;
/** How long another device's engine is given to come up when it is warmed (`warmVoice`): a model's load from a cold disk. */
export const VOICE_WARM_MS = 120_000;
/** Sound is handed on in pieces of at least this long: shorter ones, played back to back, leave gaps. */
const PIECE_MS = 240;

const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** The voice a language is spoken in: its own, else the one for the language without its region, else the place's one voice for every language (`*`). */
export function voiceFor(stage: Pick<VoiceStage, 'voices'>, language: string): string | undefined {
  return stage.voices[language] || stage.voices[baseOf(language)] || stage.voices['*'] || undefined;
}

/** Whether the stage speaks a language. */
export function speaksLanguage(stage: Pick<VoiceStage, 'languages'>, language: string): boolean {
  return !stage.languages || stage.languages.some((one) => baseOf(one) === baseOf(language));
}

/**
 * What is read out of a line as it is shown: no emoji or marks a voice would spell out, no more than
 * `VOICE_MOST_CHARS`. Blank: there is nothing to say.
 */
export function spokenText(text: string): string {
  const plain = text.replace(/[\p{Extended_Pictographic}‍️✓✔☑]/gu, '').replace(/\s+/g, ' ').trim();
  if (!/[\p{L}\p{N}]/u.test(plain)) return '';
  if (plain.length <= VOICE_MOST_CHARS) return plain;
  // Cut after a sentence where one ends in the second half of what fits; else where it must be.
  const head = plain.slice(0, VOICE_MOST_CHARS);
  const end = Math.max(...['。', '！', '？', '. ', '! ', '? '].map((mark) => head.lastIndexOf(mark)));
  return end >= VOICE_MOST_CHARS / 2 ? head.slice(0, end + 1).trim() : head;
}

export interface VoiceRequest { text: string; language: string }

export interface VoiceDeps {
  fetch: typeof fetch;
  clock: Clock;
  /** Any container the browser decodes (WAV, MP3), as the contract's 24 kHz mono. */
  decode(bytes: ArrayBuffer): Promise<Int16Array>;
  /** This computer's voice engine: the sound as it is made, at the engine's own rate. */
  native(request: { model: string; text: string; voice?: string; language: string }, onPcm: (pcm: Int16Array, sampleRate: number) => void, signal: AbortSignal): Promise<void>;
  /** Edge's online voice: one sentence, as the MP3 it answers with. */
  edge(request: { text: string; voice: string }, signal: AbortSignal): Promise<ArrayBuffer>;
}

export interface Spoken {
  /** From the request to the first sound handed on; absent when none came. */
  firstMs?: number;
  totalMs: number;
  /** The sound's length, at the contract's rate. */
  samples: number;
}

/** A stage on the shared device, at the address that device has now. */
export const atServer = (stage: VoiceStage, baseUrl: string): VoiceStage => (stage.server ? { ...stage, baseUrl } : stage);

/** The `/audio/speech` URL under a base URL. */
export const speechUrl = (baseUrl: string): string => `${baseUrl.trim().replace(/\/+$/, '')}/audio/speech`;

/** Sound at any rate, brought to the contract's as it comes: filtered where the rate is a small ratio above it, else between samples. */
function toContractRate(rate: number): (pcm: Int16Array) => Int16Array {
  if (rate === SAMPLE_RATE) return (pcm) => pcm;
  const resampler = createResampler(rate, SAMPLE_RATE);
  if (resampler) return (pcm) => resampler.process(pcm);
  // A rate below the contract's, or no simple ratio of it (22.05 and 44.1 kHz): between its samples, piece by piece.
  // `at`: where the next sample out stands, counted from this piece's first; -1 is the last sample of the piece before.
  let at = 0;
  let last = 0;
  const step = rate / SAMPLE_RATE;
  return (pcm) => {
    if (pcm.length === 0) return pcm;
    const out: number[] = [];
    // A place between this piece's last sample and the next piece's first waits for that piece.
    for (; at <= pcm.length - 1; at += step) {
      const floor = Math.floor(at);
      const before = floor < 0 ? last : pcm[floor];
      const after = floor + 1 < pcm.length ? pcm[floor + 1] : before;
      out.push(Math.round(before + (after - before) * (at - floor)));
    }
    last = pcm[pcm.length - 1];
    at -= pcm.length;
    return Int16Array.from(out);
  };
}

/** One short word in a language, for a warm-up: English where there is none of the language's own. */
const WARM_WORDS: Readonly<Record<string, string>> = { en: 'Hello.', ja: 'こんにちは。', zh: '你好。' };

/**
 * The other Kotomimi's voice engine, brought up as a run begins: it loads its model at the first sentence asked of
 * it, which this computer's own engine does before the run starts. One short word is asked for and dropped as soon
 * as the device answers, so nothing is heard; the first real sentence then waits for no load. Never rejects: a device
 * that cannot be reached is found out by the first sentence.
 */
export async function warmVoice(stage: VoiceStage, key: string | undefined, deps: Pick<VoiceDeps, 'fetch' | 'clock'>, signal: AbortSignal): Promise<void> {
  if (!stage.server || !stage.streams || signal.aborted) return;
  const language = Object.keys(stage.voices).find((code) => code !== '*') ?? stage.languages?.[0] ?? 'en';
  const voice = voiceFor(stage, language);
  const control = new AbortController();
  const abort = () => control.abort();
  signal.addEventListener('abort', abort, { once: true });
  const cancel = deps.clock.setTimeout(abort, VOICE_WARM_MS);
  try {
    const response = await deps.fetch(speechUrl(stage.baseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key || NO_KEY}` },
      body: JSON.stringify({ model: stage.model, input: WARM_WORDS[baseOf(language)] ?? WARM_WORDS.en, ...(voice ? { voice } : {}), response_format: 'pcm', language }),
      signal: control.signal,
    });
    // It answered: the model is up. The word itself is not wanted.
    await response.body?.cancel();
  } catch {
    // Nothing to say of it here.
  } finally {
    cancel();
    signal.removeEventListener('abort', abort);
  }
}

/** Raw 16-bit sound as it arrives, handed on in whole samples: a piece may end in the middle of one. */
async function readPcm(body: ReadableStream<Uint8Array>, convert: (pcm: Int16Array) => Int16Array, take: (pcm: Int16Array) => void): Promise<void> {
  const reader = body.getReader();
  let odd: Uint8Array | null = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    let bytes = value;
    if (odd) {
      bytes = new Uint8Array(1 + value.length);
      bytes.set(odd);
      bytes.set(value, 1);
    }
    const even = bytes.length - (bytes.length % 2);
    odd = even < bytes.length ? bytes.slice(even) : null;
    // A copy on its own buffer: the piece's bytes may start anywhere in theirs.
    if (even > 0) take(convert(new Int16Array(bytes.slice(0, even).buffer)));
  }
}

/**
 * One sentence, spoken by the stage: `onPcm` is handed its sound in order. Rejects when the place does not answer,
 * answers with no sound, or `signal` aborts; what was handed on before that has been heard.
 */
export async function speakText(stage: VoiceStage, said: VoiceRequest, key: string | undefined, deps: VoiceDeps, signal: AbortSignal, onPcm: (pcm: Int16Array) => void): Promise<Spoken> {
  const { clock } = deps;
  const started = clock.now();
  const text = spokenText(said.text);
  if (!text) return { totalMs: 0, samples: 0 };
  const voice = voiceFor(stage, said.language);

  const control = new AbortController();
  const abort = () => control.abort(signal.reason);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  const cancel = clock.setTimeout(() => control.abort(new Error('The voice did not answer in time.')), stage.patient ? VOICE_PATIENT_MS : VOICE_TIMEOUT_MS);

  let firstMs: number | undefined;
  let samples = 0;
  let held: Int16Array[] = [];
  let heldSamples = 0;
  const flush = () => {
    if (heldSamples === 0) return;
    const piece = new Int16Array(heldSamples);
    let at = 0;
    for (const part of held) { piece.set(part, at); at += part.length; }
    held = [];
    heldSamples = 0;
    firstMs ??= clock.now() - started;
    samples += piece.length;
    onPcm(piece);
  };
  const take = (pcm: Int16Array) => {
    if (control.signal.aborted || pcm.length === 0) return;
    held.push(pcm);
    heldSamples += pcm.length;
    if (heldSamples >= (SAMPLE_RATE * PIECE_MS) / 1000) flush();
  };

  try {
    if (stage.via === 'edge') {
      if (!voice) throw new Error(`No voice is chosen for ${said.language}.`);
      take(await deps.decode(await deps.edge({ text, voice }, control.signal)));
    } else if (stage.engine) {
      let convert: ((pcm: Int16Array) => Int16Array) | null = null;
      let rateNow = 0;
      await deps.native({ model: stage.model, text, ...(voice ? { voice } : {}), language: said.language }, (pcm, sampleRate) => {
        if (!convert || sampleRate !== rateNow) { convert = toContractRate(sampleRate); rateNow = sampleRate; }
        take(convert(pcm));
      }, control.signal);
    } else {
      const response = await deps.fetch(speechUrl(stage.baseUrl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key || NO_KEY}` },
        body: JSON.stringify({ model: stage.model, input: text, ...(voice ? { voice } : {}), response_format: stage.streams ? 'pcm' : 'wav', ...(stage.tellsLanguage ? { language: said.language } : {}) }),
        signal: control.signal,
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
        throw new Error(`HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }
      // Raw sound names its rate; anything else is a file to decode.
      const rate = Number(/^audio\/pcm\b.*\brate=(\d+)/i.exec(response.headers.get('content-type') ?? '')?.[1]);
      if (stage.streams && response.body && rate >= 8000 && rate <= 96000) await readPcm(response.body, toContractRate(rate), take);
      else take(await deps.decode(await response.arrayBuffer()));
    }
    if (control.signal.aborted) throw control.signal.reason instanceof Error ? control.signal.reason : new Error('The voice was stopped.');
    flush();
    if (samples === 0) throw new Error('The voice answered with no sound.');
    return { ...(firstMs !== undefined ? { firstMs } : {}), totalMs: clock.now() - started, samples };
  } finally {
    cancel();
    signal.removeEventListener('abort', abort);
  }
}
