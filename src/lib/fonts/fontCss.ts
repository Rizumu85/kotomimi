/**
 * Fork: the user's fonts as a style sheet. Four choices, each optional:
 *
 * - `ui`: the app's own font — menus, settings, buttons.
 * - `latin`: Latin letters and digits in conversation text, and the
 *   romanization line under it.
 * - `text[lang]`: conversation and subtitle text in one language.
 * - `ruby[lang]`: the readings drawn above that language's text (furigana).
 *
 * Conversation text is marked by its row (`data-kt-text`, with the row's
 * `lang`), so a rule here reaches every surface that draws it. A font is put
 * in front of the stack it replaces, never instead of it: a glyph the chosen
 * font lacks still falls to the app's own fonts.
 *
 * In a language written in another script the Latin font goes first — it
 * has no glyphs of that script, so it takes the Latin letters alone and the
 * language's font takes the rest. In a language written in Latin letters the
 * language's own font goes first: it is the more particular choice.
 *
 * Pure: settings in, CSS text out.
 */

export interface FontSettings {
  ui: string;
  latin: string;
  /** By language tag, lower-cased: a base (`ja`) or a fuller tag (`zh-tw`). */
  text: Readonly<Record<string, string>>;
  ruby: Readonly<Record<string, string>>;
}

export const NO_FONTS: FontSettings = { ui: '', latin: '', text: {}, ruby: {} };

/** The attribute a surface puts on conversation text, beside its `lang`. */
export const TEXT_MARK = 'data-kt-text';

/** Languages not written in Latin letters: there the Latin font leads the stack. */
const OTHER_SCRIPTS = new Set([
  'ja', 'zh', 'yue', 'ko', 'ru', 'uk', 'be', 'bg', 'sr', 'mk', 'kk', 'mn', 'el', 'ar', 'fa', 'ur', 'he', 'hi', 'mr', 'ne', 'bn', 'gu', 'pa',
  'ta', 'te', 'kn', 'ml', 'si', 'th', 'lo', 'km', 'my', 'ka', 'hy', 'am',
]);

/** A language tag as these settings key it, or '' when it is none. */
export function fontLanguage(tag: unknown): string {
  const text = typeof tag === 'string' ? tag.trim().toLowerCase().replace(/_/g, '-') : '';
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/.test(text) && text !== 'auto' ? text : '';
}

/** A family name as it may be typed or listed, made safe to quote: no quote, backslash, brace or control character can leave the string it is put in. */
export function cleanFamily(name: unknown): string {
  // eslint-disable-next-line no-control-regex
  return typeof name === 'string' ? name.replace(/["'\\{};<>\u0000-\u001f]/g, '').trim().slice(0, 120) : '';
}

const quote = (name: string) => `"${cleanFamily(name)}"`;

/** Whatever was stored, as settings: every name cleaned, every key a language tag, blanks dropped. */
export function normalizeFonts(stored: unknown): FontSettings {
  const o = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>;
  const table = (value: unknown): Record<string, string> => {
    const out: Record<string, string> = {};
    if (!value || typeof value !== 'object') return out;
    for (const [key, name] of Object.entries(value as Record<string, unknown>)) {
      const lang = fontLanguage(key);
      const family = cleanFamily(name);
      if (lang && family) out[lang] = family;
    }
    return out;
  };
  return { ui: cleanFamily(o.ui), latin: cleanFamily(o.latin), text: table(o.text), ruby: table(o.ruby) };
}

/** The style sheet for these settings; '' when nothing is chosen. */
export function fontCss(settings: FontSettings): string {
  const f = normalizeFonts(settings);
  const rules: string[] = [];
  // What everything falls back to: the app's own stack, led by the UI font when one is chosen.
  const base = 'var(--kt-font-base, var(--font-sans))';
  const stack = (...names: string[]) => [...names.filter(Boolean).map(quote), base].join(', ');
  if (f.ui) {
    rules.push(`:root { --kt-font-base: ${quote(f.ui)}, var(--font-sans); }`);
    rules.push('body { font-family: var(--kt-font-base); }');
  }
  if (f.latin) rules.push(`[${TEXT_MARK}] { font-family: ${stack(f.latin)}; }`);
  // Shorter tags first: `zh-tw` then overrides `zh` for the rows it matches.
  const languages = [...new Set([...Object.keys(f.text), ...Object.keys(f.ruby)])].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const lang of languages) {
    const text = f.text[lang] ?? '';
    const ruby = f.ruby[lang] ?? '';
    const latinFirst = OTHER_SCRIPTS.has(lang.split('-')[0]);
    if (text) rules.push(`[${TEXT_MARK}]:lang(${lang}) { font-family: ${latinFirst ? stack(f.latin, text) : stack(text, f.latin)}; }`);
    // A reading is the language's own script: its font first, then the text's.
    if (ruby) rules.push(`[${TEXT_MARK}]:lang(${lang}) rt { font-family: ${stack(ruby, text)}; }`);
  }
  return rules.join('\n');
}

/** A few characters of a language's script: what a font is tried on, and shown with. */
const SAMPLES: Readonly<Record<string, string>> = {
  ja: 'あア', zh: '汉字', 'zh-tw': '漢字', yue: '漢字', ko: '한글', ru: 'Жд', uk: 'Жї', bg: 'Жд', el: 'αβ', ar: 'عر', fa: 'فا', he: 'אב', th: 'ไท', hi: 'हि',
};

/** The characters that show whether a font can write `lang`; Latin letters for any language not listed. */
export function scriptSample(lang: string): string {
  const tag = fontLanguage(lang);
  return SAMPLES[tag] ?? SAMPLES[tag.split('-')[0]] ?? 'Ag';
}
