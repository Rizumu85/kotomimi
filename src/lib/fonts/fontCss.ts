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
 * In a language written in another script the Latin font goes first and
 * takes the Latin letters alone; the language's font takes the rest. It is
 * held to Latin letters by its own `@font-face`, limited by `unicode-range` —
 * many fonts chosen for their Latin letters draw Chinese and Japanese too,
 * and named plainly at the head of the stack one of those would take the
 * whole line and the language's font would never be reached. In a language
 * written in Latin letters the language's own font goes first: it is the
 * more particular choice.
 *
 * The interface font is put on the page and on the app's root: the root
 * names the app's stack itself, so a font set on the page alone would stop
 * there.
 *
 * Pure: settings in, CSS text out.
 */

export interface FontSettings {
  ui: string;
  latin: string;
  /**
   * The Latin font's own face, by the names `local()` finds a face by (its full name, its PostScript name), as the
   * platform listed them when it was chosen. Empty: the family name is tried, which is the face's name for most fonts.
   */
  latinFaces: readonly string[];
  /** By language tag, lower-cased: a base (`ja`) or a fuller tag (`zh-tw`). */
  text: Readonly<Record<string, string>>;
  ruby: Readonly<Record<string, string>>;
}

export const NO_FONTS: FontSettings = { ui: '', latin: '', latinFaces: [], text: {}, ruby: {} };

/** The family the Latin font is used under: its Latin letters, digits and punctuation, and nothing else. */
export const LATIN_FAMILY = 'kt-latin';

/** Basic Latin, Latin-1, Latin Extended A and B, IPA, the combining marks and Latin Extended Additional: what romanization and European languages are written in. */
const LATIN_RANGE = 'U+0020-007E, U+00A0-024F, U+0250-02AF, U+0300-036F, U+1E00-1EFF';

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
  const latin = cleanFamily(o.latin);
  const latinFaces = latin && Array.isArray(o.latinFaces) ? [...new Set(o.latinFaces.map(cleanFamily).filter(Boolean))].slice(0, 6) : [];
  return { ui: cleanFamily(o.ui), latin, latinFaces, text: table(o.text), ruby: table(o.ruby) };
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
    // The app's root names the app's stack itself: the page alone would not reach what is drawn inside it.
    rules.push('body, .App { font-family: var(--kt-font-base); }');
  }
  // The Latin font, as a family of its own that holds Latin letters only.
  const latin = f.latin ? LATIN_FAMILY : '';
  if (f.latin) {
    const faces = [...new Set([...f.latinFaces, f.latin, `${f.latin} Regular`])];
    rules.push(`@font-face { font-family: ${quote(LATIN_FAMILY)}; src: ${faces.map((name) => `local(${quote(name)})`).join(', ')}; unicode-range: ${LATIN_RANGE}; }`);
    rules.push(`[${TEXT_MARK}] { font-family: ${stack(latin)}; }`);
  }
  // Shorter tags first: `zh-tw` then overrides `zh` for the rows it matches.
  const languages = [...new Set([...Object.keys(f.text), ...Object.keys(f.ruby)])].sort((a, b) => a.length - b.length || a.localeCompare(b));
  for (const lang of languages) {
    const text = f.text[lang] ?? '';
    const ruby = f.ruby[lang] ?? '';
    const latinFirst = OTHER_SCRIPTS.has(lang.split('-')[0]);
    if (text) rules.push(`[${TEXT_MARK}]:lang(${lang}) { font-family: ${latinFirst ? stack(latin, text) : stack(text, latin)}; }`);
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
