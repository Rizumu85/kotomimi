/**
 * Fork: the grammar-feedback model's prompt, chosen by language.
 *
 * Two languages decide it. The **native** language picks the template
 * itself: a model told what to do in Chinese explains in Chinese far more
 * reliably than one told in English to "answer in Chinese" (measured on
 * 4B-class local models, 2026-10-03). The **spoken** language — the one
 * being practised — picks what to look for (particles and politeness in
 * Japanese, articles and tense in English) and the worked examples. The
 * examples go up as earlier turns of the chat, not as text in the
 * instructions: a small model continues a list of examples it reads in its
 * instructions, and follows ones it is shown as its own past answers.
 *
 * The answer has two shapes the row can show (`pipeline.ts` `tidyAnswer`):
 * a bare ✓, or the corrected sentence over one line of why.
 *
 * A user's own prompt replaces the template; `{{SPOKEN}}` and `{{NATIVE}}`
 * in it are still filled in, so it too follows the language pair. Pure.
 */

/** A language code's base: `zh-CN` → `zh`, `pt_BR` → `pt`. */
const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];

/**
 * A language's name in another language: `ja` in `zh-CN` is 日语. The
 * platform's own names (`Intl.DisplayNames`), so every pair has one; the
 * code itself when the platform knows none.
 */
export function languageNameIn(code: string, displayLanguage: string): string {
  try {
    return new Intl.DisplayNames([displayLanguage.replace('_', '-')], { type: 'language' }).of(code.replace('_', '-')) ?? code;
  } catch {
    return code;
  }
}

interface Example { said: string; corrected?: string; why?: string }

interface Template {
  /** `{{SPOKEN}}`, `{{NATIVE}}` and `{{HINTS}}` are filled in. */
  body: string;
  /** What to look for, by spoken language. */
  hints: Readonly<Record<string, string>>;
  /** Worked examples, by spoken language; the explanations are in this template's language. */
  examples: Readonly<Record<string, readonly Example[]>>;
}

const ZH: Template = {
  body: [
    '你是一位{{SPOKEN}}口语教练，学生的母语是{{NATIVE}}。',
    '用户发来的每条消息，都是学生刚刚用{{SPOKEN}}说出的一句话，由语音识别转成了文字。标点、空格和同音字的写法可能是识别造成的，不算学生的错。你只判断语法、用词和表达是否自然。',
    '{{HINTS}}',
    '回答规则：',
    '1. 如果这句话正确而且自然，只回答一个符号：✓',
    '2. 否则只回答两行，不要有任何其他内容。第一行是改正后的{{SPOKEN}}句子；第二行用{{NATIVE}}写一句简短的话，说明错在哪里。',
    '3. 第二行必须用{{NATIVE}}写，不能用{{SPOKEN}}。',
    '4. 不要回答这句话的内容，不要翻译，不要加序号、标题、引号或问候。',
  ].join('\n'),
  hints: {
    ja: '重点检查：助词（は、が、を、に、で）、动词和形容词的活用、时态、敬体与简体是否混用、自动词和他动词。',
    ko: '重点检查：助词（은/는、이/가、을/를、에、에서）、动词词尾和时态、敬语等级是否前后一致。',
    en: '重点检查：时态、冠词（a、an、the）、单复数、主谓一致、介词搭配。',
    ru: '重点检查：名词和形容词的格、性和数的一致、动词的体和变位、前置词搭配。',
    fr: '重点检查：名词的阴阳性和冠词、动词变位和时态、形容词的性数配合。',
    de: '重点检查：名词的性和格、冠词变化、动词的位置和变位。',
    es: '重点检查：名词的阴阳性、动词变位和时态、ser 与 estar 的用法。',
  },
  examples: {
    ja: [
      { said: '昨日、友達と映画を見ます。', corrected: '昨日、友達と映画を見ました。', why: '“昨日”说的是过去的事，动词要用过去式“見ました”。' },
      { said: '今日は天気がいいですね。' },
      { said: '私は学校を行きます。', corrected: '私は学校に行きます。', why: '表示去的目的地要用助词“に”，不能用“を”。' },
    ],
    en: [
      { said: 'Yesterday I go to the cinema with my friend.', corrected: 'Yesterday I went to the cinema with my friend.', why: '“yesterday”说的是过去的事，动词要用过去式“went”。' },
      { said: 'The weather is really nice today.' },
    ],
    ko: [
      { said: '어제 친구하고 영화를 봐요.', corrected: '어제 친구하고 영화를 봤어요.', why: '“어제”说的是过去的事，动词要用过去式“봤어요”。' },
      { said: '오늘 날씨가 좋네요.' },
    ],
  },
};

const EN: Template = {
  body: [
    'You are a {{SPOKEN}} speaking coach. The learner\'s native language is {{NATIVE}}.',
    'Each user message is one thing the learner just said aloud in {{SPOKEN}}, written down by a speech recognizer. Punctuation, spacing and the spelling of homophones may be the recognizer\'s doing and are not the learner\'s mistakes. Judge only grammar, word choice and naturalness.',
    '{{HINTS}}',
    'Rules for your reply:',
    '1. If the sentence is correct and natural, reply with exactly one character: ✓',
    '2. Otherwise reply with exactly two lines and nothing else. Line one is the corrected {{SPOKEN}} sentence. Line two is one short sentence in {{NATIVE}} explaining the mistake.',
    '3. Line two must be written in {{NATIVE}}, not in {{SPOKEN}}.',
    '4. Never answer the utterance, never translate it, never add numbering, a label, quotation marks or a greeting.',
  ].join('\n'),
  hints: {
    ja: 'Look especially at: particles (は, が, を, に, で), verb and adjective conjugation, tense, mixing polite and plain forms, transitive versus intransitive verbs.',
    ko: 'Look especially at: particles (은/는, 이/가, 을/를, 에, 에서), verb endings and tense, a consistent speech level.',
    en: 'Look especially at: tense, articles (a, an, the), singular and plural, subject-verb agreement, prepositions.',
    ru: 'Look especially at: noun and adjective case, gender and number agreement, verb aspect and conjugation, prepositions.',
    fr: 'Look especially at: noun gender and articles, verb conjugation and tense, adjective agreement.',
    de: 'Look especially at: noun gender and case, article endings, verb position and conjugation.',
    es: 'Look especially at: noun gender, verb conjugation and tense, ser versus estar.',
    zh: 'Look especially at: measure words, word order, the particles 了, 过 and 着, and 的, 得 and 地.',
  },
  examples: {
    ja: [
      { said: '昨日、友達と映画を見ます。', corrected: '昨日、友達と映画を見ました。', why: '"昨日" is in the past, so the verb needs the past form "見ました".' },
      { said: '今日は天気がいいですね。' },
      { said: '私は学校を行きます。', corrected: '私は学校に行きます。', why: 'A destination takes the particle "に", not "を".' },
    ],
  },
};

/** The templates there are, by the native language's base; any other native language reads the English one, which still names it as the language to explain in. */
const TEMPLATES: Readonly<Record<string, Template>> = { zh: ZH, en: EN };

/** The language a native speaker's instructions are written in: their own when there is a template for it, else English. */
export function coachTemplateLanguage(native: string): string {
  return TEMPLATES[base(native)] ? base(native) : 'en';
}

/** A template or a user's own prompt with the two language names filled in. */
function fill(text: string, spoken: string, native: string): string {
  // Named in the language the instructions are read in: a Chinese template says 日语, the English one Japanese.
  const display = TEMPLATES[base(native)] ? native : 'en';
  return text.split('{{SPOKEN}}').join(languageNameIn(spoken, display)).split('{{NATIVE}}').join(languageNameIn(native, display));
}

/** One worked example as a turn of the chat: what the learner said, and the answer the model is shown as its own. */
export interface CoachShot { said: string; answer: string }

export interface CoachPrompt {
  system: string;
  /** Sent before the real utterance, as user and assistant turns. */
  shots: readonly CoachShot[];
}

/**
 * The feedback model's prompt for a learner whose own language is `native`,
 * practising `spoken`. `custom`, when not blank, is the user's own
 * instructions: it replaces the template, and goes up with no examples —
 * they would teach the template's answer shape, which may not be the user's.
 */
export function coachPrompt(spoken: string, native: string, custom = ''): CoachPrompt {
  if (custom.trim()) return { system: fill(custom.trim(), spoken, native), shots: [] };
  const template = TEMPLATES[coachTemplateLanguage(native)];
  const hints = template.hints[base(spoken)] ?? '';
  // A language with no hints leaves no blank line where they would be.
  const body = template.body.split('\n').flatMap((line) => (line === '{{HINTS}}' ? (hints ? [hints] : []) : [line])).join('\n');
  const shots = (template.examples[base(spoken)] ?? []).map((e) => ({ said: e.said, answer: e.corrected ? `${e.corrected}\n${e.why}` : '✓' }));
  return { system: fill(body, spoken, native), shots };
}
