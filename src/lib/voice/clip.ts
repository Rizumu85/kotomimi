/**
 * Fork: a recording of the user's own voice, made ready for a cloning voice model to speak from
 * (`electron/voice-library.js`): its quiet ends taken off, brought to a level the model hears well, held to a length
 * the engine reads quickly, and written as the WAV the engine is handed. Pure: the microphone and the file are
 * `recordClip.ts`'s.
 */

/** The rate recordings are kept at: the voice models' own. */
export const CLIP_RATE = 24000;
/*
 * How long a recording should be, measured 2026-11-24 (`.dev/tts/clone-sweep.mjs`: four known speakers, recordings of
 * 3 to 19 s, 9 sentences cloned from each, likeness by two speaker-verification models; the same speaker on two
 * sentences scores 0.71, another speaker 0.33):
 * - spoken on from, in its own language (with its words): as like at 3 s as at 19 s (0.72-0.77);
 * - only its sound taken, as every other language is read: 0.58 at 3 s, 0.64 at 5 s, 0.67 at 8-11 s, 0.70 at 19 s.
 * About ten seconds is where the second has nearly all it will get, and the first still waits little: a recording with
 * its words is read through before the first sentence in it, about 2.7 s for each second; its sound alone in 4-6 s.
 */
/** Shorter than this carries too little of a voice for the languages read from its sound alone. */
export const CLIP_LEAST_S = 5;
/** A voice's recording more, in another language: only ever spoken on from, which three seconds do as well as nineteen. */
export const CLIP_LEAST_MORE_S = 3;
/** With its words: past this the first sentence of a run in the recording's language would wait too long (40 s). */
export const CLIP_MOST_WITH_WORDS_S = 15;
/** Without its words only its sound is taken, quickly: this much of it is plenty, and the rest is left off. */
export const CLIP_MOST_S = 20;

/** A recording whose loudest moment is under this (about -36 dB) holds a room, not a voice. */
const QUIET = 500;

export type ClipProblem = 'too_short' | 'too_long' | 'silent';

export const secondsOf = (pcm: Int16Array, rate = CLIP_RATE): number => pcm.length / rate;

const peakOf = (pcm: Int16Array): number => {
  let peak = 0;
  for (let i = 0; i < pcm.length; i += 1) { const a = Math.abs(pcm[i]); if (a > peak) peak = a; }
  return peak;
};

/** The recording without the quiet before the first word and after the last, a breath of it kept at each end. */
export function trimmed(pcm: Int16Array, rate = CLIP_RATE): Int16Array {
  const peak = peakOf(pcm);
  if (peak === 0) return pcm;
  const floor = Math.max(200, peak * 0.04);
  const keep = Math.round(rate * 0.15);
  let first = 0;
  while (first < pcm.length && Math.abs(pcm[first]) < floor) first += 1;
  let last = pcm.length - 1;
  while (last > first && Math.abs(pcm[last]) < floor) last -= 1;
  return pcm.slice(Math.max(0, first - keep), Math.min(pcm.length, last + 1 + keep));
}

/** At a level a quiet microphone's recording is cloned as well as a loud one's. One with no voice in it is left as it is. */
export function levelled(pcm: Int16Array): Int16Array {
  const peak = peakOf(pcm);
  if (peak < QUIET) return pcm;
  const gain = (0.9 * 32767) / peak;
  const out = new Int16Array(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = Math.round(pcm[i] * gain);
  return out;
}

/**
 * A recording as it is kept: trimmed and levelled, and — where its words are not known — no longer than is of use.
 * With its words it is kept whole or not at all (`clipProblem`): a part of it would no longer be what the words say.
 */
export function prepared(pcm: Int16Array, words: boolean, rate = CLIP_RATE): Int16Array {
  const clip = trimmed(pcm, rate);
  const most = Math.round(CLIP_MOST_S * rate);
  return levelled(!words && clip.length > most ? clip.slice(0, most) : clip);
}

/** Why a prepared recording cannot be a voice; null: it can. */
export function clipProblem(pcm: Int16Array, words: boolean, least = CLIP_LEAST_S, rate = CLIP_RATE): ClipProblem | null {
  if (peakOf(pcm) < QUIET) return 'silent';
  const seconds = secondsOf(pcm, rate);
  if (seconds < least) return 'too_short';
  if (words && seconds > CLIP_MOST_WITH_WORDS_S) return 'too_long';
  return null;
}

/** 16-bit mono PCM as a WAV file's bytes. */
export function clipWav(pcm: Int16Array, rate = CLIP_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + pcm.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => { for (let i = 0; i < text.length; i += 1) view.setUint8(at + i, text.charCodeAt(i)); };
  ascii(0, 'RIFF'); view.setUint32(4, 36 + pcm.length * 2, true); ascii(8, 'WAVEfmt '); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) view.setInt16(44 + i * 2, pcm[i], true);
  return bytes;
}

/**
 * What is read aloud for a recording, in a language: everyday words said calmly. What kind of sentence it is matters
 * less than its length, but it matters: of five of one length, a plain statement with many different sounds in it
 * cloned best (0.72), a question and a list a little worse, an excited one worst (0.66). So: statements, no
 * exclaiming, no question, sounds that differ.
 *
 * And they are easy: a few short sentences of a beginner's words, each with a breath after it, never one long
 * sentence. Whoever reads one may be reading a foreign language, and a long sentence of clauses is stumbled over (the
 * user, of an earlier Japanese one that took them 13.9 s, near the most a recording may be).
 *
 * Each language has its own, written as its speakers would say it, and timed by having a voice model read it at an
 * even pace (`.dev/tts/read-aloud-time.mjs`; the tables are written from `.dev/tts/read-aloud.json`). Two of them:
 * - a voice's first recording: four short sentences, about ten seconds read at ease (the lengths above);
 * - a recording more, in another language (`short`): two of them, about five seconds. It is only ever spoken on
 *   from, and three seconds do for that.
 * A language with none here is read in English: the voice is the reader's whatever the words.
 */
const READ_ALOUD: Readonly<Record<string, string>> = {
  zh: '今天天气真好。我想出去走一走。我们一起去喝杯咖啡吧。那家店离这里很近。',
  ja: '今日はいい天気ですね。散歩に行きたいです。一緒にコーヒーを飲みましょう。お店はここから近いです。',
  en: 'It\'s a nice day today. I want to go for a walk. Let\'s have a coffee together. The shop is very close to here.',
  ko: '오늘은 날씨가 좋네요. 산책하고 싶어요. 같이 커피 마셔요. 가게는 여기서 가까워요.',
  es: 'Hoy hace buen día. Quiero dar un paseo. Vamos a tomar un café juntos. La tienda está muy cerca de aquí.',
  fr: 'Il fait beau aujourd’hui. Je veux me promener. Allons prendre un café ensemble. Le café est tout près d’ici.',
  de: 'Heute ist schönes Wetter. Ich möchte spazieren gehen. Lass uns zusammen einen Kaffee trinken. Das Café ist ganz in der Nähe.',
  ru: 'Сегодня хорошая погода. Я хочу погулять. Давай вместе выпьем кофе. Кафе совсем рядом.',
  pt: 'Hoje está um dia bonito. Quero dar um passeio. Vamos tomar um café juntos. O café fica muito perto daqui.',
  it: 'Oggi è una bella giornata. Voglio fare una passeggiata. Prendiamo un caffè insieme. Il bar è molto vicino.',
};

const READ_ALOUD_SHORT: Readonly<Record<string, string>> = {
  zh: '今天天气真好。我们一起去喝杯咖啡吧。',
  ja: '今日はいい天気ですね。一緒にコーヒーを飲みましょう。',
  en: 'It\'s a nice day today. Let\'s have a coffee together.',
  ko: '오늘은 날씨가 좋네요. 같이 커피 마셔요.',
  es: 'Hoy hace buen día. Vamos a tomar un café juntos.',
  fr: 'Il fait beau aujourd’hui. Allons prendre un café ensemble.',
  de: 'Heute ist schönes Wetter. Lass uns zusammen einen Kaffee trinken.',
  ru: 'Сегодня хорошая погода. Давай вместе выпьем кофе.',
  pt: 'Hoje está um dia bonito. Vamos tomar um café juntos.',
  it: 'Oggi è una bella giornata. Prendiamo un caffè insieme.',
};

/** The sentence a reader of `language` is shown, and the language it is in: a voice's first (`long`), or one more of it in another language. */
export function readAloud(language: string, kind: 'long' | 'short' = 'long'): { text: string; language: string } {
  const base = language.toLowerCase().split(/[-_]/)[0];
  const table = kind === 'short' ? READ_ALOUD_SHORT : READ_ALOUD;
  return Object.prototype.hasOwnProperty.call(table, base) ? { text: table[base], language: base } : { text: table.en, language: 'en' };
}
