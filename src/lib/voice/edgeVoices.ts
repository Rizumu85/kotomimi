/**
 * Fork: Microsoft Edge's online voices as a place a translation is spoken (`src/providers/openai/voice.ts`): what
 * stands for it where an API's address would, the languages it speaks, and the voice a language is spoken in until
 * another is chosen. The whole list is the service's own, asked when a menu opens (`src/lib/edge-tts/voiceList.ts`).
 */

/** What Edge is named by where a voice API's base URL stands: no address, since none is typed for it. */
export const EDGE_BASE = 'edge:';

/** The voice of each language until another is chosen, by the language's base code. */
const EDGE_FIRST: Readonly<Record<string, string>> = {
  ja: 'ja-JP-NanamiNeural',
  zh: 'zh-CN-XiaoxiaoNeural',
  yue: 'zh-HK-HiuGaaiNeural',
  en: 'en-US-AvaMultilingualNeural',
  ko: 'ko-KR-SunHiNeural',
  fr: 'fr-FR-DeniseNeural',
  de: 'de-DE-KatjaNeural',
  es: 'es-ES-ElviraNeural',
  pt: 'pt-BR-FranciscaNeural',
  it: 'it-IT-ElsaNeural',
  ru: 'ru-RU-SvetlanaNeural',
  uk: 'uk-UA-PolinaNeural',
  nl: 'nl-NL-ColetteNeural',
  pl: 'pl-PL-ZofiaNeural',
  tr: 'tr-TR-EmelNeural',
  ar: 'ar-EG-SalmaNeural',
  hi: 'hi-IN-SwaraNeural',
  th: 'th-TH-PremwadeeNeural',
  vi: 'vi-VN-HoaiMyNeural',
  id: 'id-ID-GadisNeural',
  ms: 'ms-MY-YasminNeural',
  fil: 'fil-PH-BlessicaNeural',
  sv: 'sv-SE-SofieNeural',
  da: 'da-DK-ChristelNeural',
  fi: 'fi-FI-NooraNeural',
  cs: 'cs-CZ-VlastaNeural',
};

/** The languages Edge speaks here: those with a voice named above. */
export const EDGE_LANGUAGES: readonly string[] = Object.keys(EDGE_FIRST);

const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** The voice a language is spoken in until another is chosen. Undefined: Edge is not offered for it here. */
export const edgeVoiceFor = (language: string): string | undefined => EDGE_FIRST[language.toLowerCase()] ?? EDGE_FIRST[baseOf(language)];
