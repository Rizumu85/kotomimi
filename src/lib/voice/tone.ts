/**
 * Fork: a cloning model takes no tone instruction, so choosing the recording sets the tone of a sentence.
 * A rough judgment from the words keeps speech quick and avoids the memory cost of another model.
 * When cues compete, the first matching tone in the table wins. An exclamation mark alone is the last resort.
 */
export const TONES = ['lively', 'laugh', 'gentle', 'serious', 'angry'] as const;
export type Tone = (typeof TONES)[number];

const cues: readonly [Tone, ...RegExp[]][] = [
  ['laugh',
    /哈{2,}|呵{2,}|嘿{2,}|笑死|ㅋ{2,}|ㅎ{2,}|😂|🤣/u,
    /(?<![a-z0-9])[wｗ]{3,}(?![a-z0-9]|\.[a-z])|(?:^|[\s\p{P}])草[\p{P}\s]*$/iu,
    /\b(?:lol|lmao|(?:ha){2,}h?|(?:ja){2,}|(?:ah){2,}a?)\b/i,
  ],
  ['angry',
    /[气氣]死|[烦煩]死了|[滚滾][开開蛋出]|[给給]我[滚滾]|(?:^|[\s\p{P}])[滚滾](?=$|[\s\p{P}])|可[恶惡]|ふざけ|むかつく|ムカつく|うるさい|짜증|닥쳐/u,
    /\b(?:damn|wtf|shut up|verdammt|cállate)\b/i,
  ],
  ['gentle',
    /谢谢|謝謝|没关系|沒關係|辛苦了|晚安|[对對]不起|抱歉|ありがとう|大丈夫|おやすみ|ごめん|お疲れ|すみません|고마워|고맙|감사합니다|미안|괜찮아|죄송|잘 자/u,
    /\b(?:thanks|thank you|sorry|good night|take care|danke|merci|bonne nuit|boa noite|obrigad[oa]|gracias|buenas noches|grazie|buonanotte)\b/i,
    /(?<!\p{L})(?:спасибо|спокойной ночи)(?!\p{L})/iu,
  ],
  ['lively',
    /太好了|好耶|太棒了|好[开開]心|やった|嬉しい|最高|楽しい|좋아|신난다|신나요/u,
    /\b(?:yay|hooray|awesome|so happy|fantastisch|evviva)\b/i,
  ],
  ['serious',
    /[请請]注意|必[须須]|很重要|[认認]真|警告|危[险險険]|注意して|大事|중요|조심|경고|위험/u,
    /\b(?:important|must|warning|seriously|be careful|achtung|attenzione|cuidado)\b/i,
    /(?<!\p{L})(?:осторожно|внимание)(?!\p{L})/iu,
  ],
];

/** The tone suggested by the speaker's words or their translation, or '' for a plain reading. */
export function toneOf(said: string, translated: string): Tone | '' {
  for (const [tone, ...patterns] of cues) {
    if (patterns.some((cue) => cue.test(said) || cue.test(translated))) return tone;
  }
  return /[!！]/.test(said + translated) ? 'lively' : '';
}
