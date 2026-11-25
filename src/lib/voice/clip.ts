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
/** A laugh: nobody laughs for three seconds because they were asked to. */
export const CLIP_LEAST_LAUGH_S = 2;
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

/**
 * And the sentences a tone of voice is read in (`tone.ts`): words that bring the tone with them, since the model
 * takes the tone from how the recording sounds and from nothing else — laughter is read as laughter. About five
 * seconds each, easy as the others; here exclaiming is the point. No word in them says whether the reader is a man or
 * a woman. Laughing is shorter: a laugh and a few words (`CLIP_LEAST_LAUGH_S`).
 */
const READ_ALOUD_TONES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  lively: {
    zh: '太好了！今天终于放假了，我们一起去玩吧！',
    ja: 'やった！今日はやっと休みだ。一緒に遊びに行こう！',
    en: 'Yes! It\'s finally the weekend. Let\'s go out and have fun!',
    ko: '야호! 드디어 쉬는 날이에요. 같이 놀러 가요!',
    es: '¡Qué bien! Por fin es fin de semana. ¡Vamos a divertirnos!',
    fr: 'Super ! C’est enfin le week-end. Allons nous amuser !',
    de: 'Juhu! Endlich ist Wochenende. Lass uns etwas unternehmen!',
    ru: 'Ура! Наконец-то выходные. Пойдём гулять!',
    pt: 'Que bom! Finalmente é fim de semana. Vamos nos divertir!',
    it: 'Evviva! Finalmente è il fine settimana. Andiamo a divertirci!',
  },
  // A laugh as it comes, and a few words said through it: not a sentence about laughing.
  laugh: {
    zh: '哈哈哈哈哈！太好笑了。',
    ja: 'あはははは！面白すぎる。',
    en: 'Hahahaha! That’s so funny.',
    ko: '하하하하하! 너무 웃겨요.',
    es: '¡Jajajaja! Qué gracioso.',
    fr: 'Hahahaha ! Trop drôle.',
    de: 'Hahahaha! Wie lustig.',
    ru: 'Ха-ха-ха-ха! Как смешно.',
    pt: 'Hahahaha! Que engraçado.',
    it: 'Ahahahah! Che ridere.',
  },
  gentle: {
    zh: '没关系，慢慢来。今天辛苦了，早点休息吧。',
    ja: '大丈夫だよ、ゆっくりでいいよ。今日はお疲れさま。早く休んでね。',
    en: 'It\'s all right, take your time. You did well today. Get some rest.',
    ko: '괜찮아요, 천천히 해요. 오늘 수고했어요. 푹 쉬어요.',
    es: 'No pasa nada, tómate tu tiempo. Hoy lo has hecho muy bien. Descansa.',
    fr: 'Ce n’est rien, prends ton temps. Tu as bien travaillé aujourd’hui. Repose-toi.',
    de: 'Schon gut, lass dir Zeit. Du hast das heute gut gemacht. Ruh dich aus.',
    ru: 'Ничего страшного, не спеши. Ты сегодня молодец. Отдохни.',
    pt: 'Não faz mal, vai com calma. Hoje correu muito bem. Descansa.',
    it: 'Non fa niente, fai con calma. Oggi hai fatto un buon lavoro. Riposati.',
  },
  serious: {
    zh: '这件事很重要。请你认真听我说，然后再做决定。',
    ja: 'これは大事な話です。よく聞いてから、決めてください。',
    en: 'This is important. Please listen carefully before you decide.',
    ko: '이건 중요한 일이에요. 잘 듣고 나서 결정하세요.',
    es: 'Esto es importante. Escucha con atención antes de decidir.',
    fr: 'C’est important. Écoute bien avant de décider.',
    de: 'Das ist wichtig. Hör bitte genau zu, bevor du dich entscheidest.',
    ru: 'Это важно. Послушай внимательно, а потом решай.',
    pt: 'Isto é importante. Ouve com atenção antes de decidir.',
    it: 'Questo è importante. Ascolta bene prima di decidere.',
  },
  angry: {
    zh: '我真的生气了！都说了多少次了，不要再这样了！',
    ja: 'もう本当に怒ったよ！何回も言ったでしょう。もうやめて！',
    en: 'I\'m really angry now! I\'ve told you so many times. Stop it!',
    ko: '나 진짜 화났어요! 몇 번이나 말했잖아요. 그만해요!',
    es: '¡Qué rabia! Te lo he dicho muchas veces. ¡Basta ya!',
    fr: 'Je suis vraiment en colère ! Je te l’ai dit plusieurs fois. Arrête !',
    de: 'Ich bin wirklich sauer! Ich habe es dir so oft gesagt. Hör auf damit!',
    ru: 'Я правда злюсь! Сколько раз можно повторять. Хватит!',
    pt: 'Que raiva! Já te disse tantas vezes. Para com isso!',
    it: 'Che rabbia! Te l’ho detto tante volte. Smettila!',
  },
};

/**
 * The sentence a reader of `language` is shown, and the language it is in: a voice's first (`long`), one more of it
 * in another language (`short`), or — `tone` — the one that tone of voice is read in.
 */
export function readAloud(language: string, kind: 'long' | 'short' = 'long', tone = ''): { text: string; language: string } {
  const base = language.toLowerCase().split(/[-_]/)[0];
  const toned = Object.prototype.hasOwnProperty.call(READ_ALOUD_TONES, tone) ? READ_ALOUD_TONES[tone] : undefined;
  const table = toned ?? (kind === 'short' ? READ_ALOUD_SHORT : READ_ALOUD);
  return Object.prototype.hasOwnProperty.call(table, base) ? { text: table[base], language: base } : { text: table.en, language: 'en' };
}
