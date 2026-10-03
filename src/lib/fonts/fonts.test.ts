import { beforeEach, describe, expect, it } from 'vitest';
import { cleanFamily, fontCss, fontLanguage, NO_FONTS, normalizeFonts, scriptSample } from './fontCss';
import { applyFonts, useFontStore } from '../../stores/fontStore';

const BASE = 'var(--kt-font-base, var(--font-sans))';

describe('the fonts as a style sheet', () => {
  it('adds nothing while nothing is chosen', () => {
    expect(fontCss(NO_FONTS)).toBe('');
  });

  it('puts the interface font in front of the app\'s own stack, never instead of it', () => {
    expect(fontCss({ ...NO_FONTS, ui: 'Segoe UI Variable' })).toBe([
      ':root { --kt-font-base: "Segoe UI Variable", var(--font-sans); }',
      'body { font-family: var(--kt-font-base); }',
    ].join('\n'));
  });

  it('gives conversation text the Latin font, and its romanization with it', () => {
    expect(fontCss({ ...NO_FONTS, latin: 'Georgia' })).toBe(`[data-kt-text] { font-family: "Georgia", ${BASE}; }`);
  });

  it('leads a language of another script with the Latin font, which takes the Latin letters alone', () => {
    const css = fontCss({ ...NO_FONTS, latin: 'Georgia', text: { ja: 'Yu Mincho' } });
    expect(css).toContain(`[data-kt-text]:lang(ja) { font-family: "Georgia", "Yu Mincho", ${BASE}; }`);
  });

  it('leads a language written in Latin letters with its own font', () => {
    const css = fontCss({ ...NO_FONTS, latin: 'Georgia', text: { fr: 'Garamond' } });
    expect(css).toContain(`[data-kt-text]:lang(fr) { font-family: "Garamond", "Georgia", ${BASE}; }`);
  });

  it('draws a language\'s readings in their own font, then the text\'s', () => {
    expect(fontCss({ ...NO_FONTS, text: { ja: 'Meiryo' }, ruby: { ja: 'UD Digi Kyokasho N' } }).split('\n')).toEqual([
      `[data-kt-text]:lang(ja) { font-family: "Meiryo", ${BASE}; }`,
      `[data-kt-text]:lang(ja) rt { font-family: "UD Digi Kyokasho N", "Meiryo", ${BASE}; }`,
    ]);
    // A reading font alone changes the readings alone.
    expect(fontCss({ ...NO_FONTS, ruby: { ja: 'Yu Mincho' } })).toBe(`[data-kt-text]:lang(ja) rt { font-family: "Yu Mincho", ${BASE}; }`);
  });

  it('writes a fuller tag after its base, so Traditional Chinese overrides Chinese for its own rows', () => {
    const lines = fontCss({ ...NO_FONTS, text: { 'zh-tw': 'Microsoft JhengHei', zh: 'KaiTi' } }).split('\n');
    expect(lines[0]).toContain(':lang(zh)');
    expect(lines[1]).toContain(':lang(zh-tw)');
  });
});

describe('what is stored, made safe', () => {
  it('reads a language tag, and refuses what is none', () => {
    expect(fontLanguage('zh_TW')).toBe('zh-tw');
    expect(fontLanguage(' JA ')).toBe('ja');
    expect(fontLanguage('auto')).toBe('');
    expect(fontLanguage('ja) { color: red } :lang(x')).toBe('');
    expect(fontLanguage(undefined)).toBe('');
  });

  it('strips from a family name whatever could leave its quotes', () => {
    expect(cleanFamily('  Yu Gothic UI ')).toBe('Yu Gothic UI');
    expect(cleanFamily('X"; } body { display: none; } a { font-family: "Y')).toBe('X  body  display: none  a  font-family: Y');
    expect(cleanFamily(7)).toBe('');
    expect(fontCss({ ...NO_FONTS, ui: 'A"}body{display:none}' })).not.toContain('display:none}');
  });

  it('keeps well-formed settings, and drops blanks, bad tags and anything of the wrong type', () => {
    expect(normalizeFonts({ ui: 'Arial', latin: 3, text: { JA: 'Meiryo', 'not a tag': 'X', ko: '' }, ruby: 'nope' }))
      .toEqual({ ui: 'Arial', latin: '', text: { ja: 'Meiryo' }, ruby: {} });
    expect(normalizeFonts(null)).toEqual(NO_FONTS);
  });

  it('knows a few characters of each script, and Latin letters for the rest', () => {
    expect(scriptSample('ja')).toBe('あア');
    expect(scriptSample('zh-TW')).toBe('漢字');
    expect(scriptSample('zh-CN')).toBe('汉字');
    expect(scriptSample('fr')).toBe('Ag');
  });
});

describe('the fonts on the page', () => {
  beforeEach(() => {
    document.getElementById('kt-fonts')?.remove();
    useFontStore.setState({ ...NO_FONTS });
  });

  it('writes one style element, rewrites it, and removes it when nothing is chosen', () => {
    applyFonts({ ...NO_FONTS, ui: 'Arial' });
    expect(document.querySelectorAll('#kt-fonts')).toHaveLength(1);
    expect(document.getElementById('kt-fonts')?.textContent).toContain('"Arial"');
    applyFonts({ ...NO_FONTS, ui: 'Verdana' });
    expect(document.querySelectorAll('#kt-fonts')).toHaveLength(1);
    expect(document.getElementById('kt-fonts')?.textContent).toContain('"Verdana"');
    applyFonts(NO_FONTS);
    expect(document.getElementById('kt-fonts')).toBeNull();
  });

  it('applies each choice as it is made, and a blank choice removes it', () => {
    const { setLatin, setText, setRuby, clearLanguage } = useFontStore.getState();
    setLatin('Georgia');
    setText('JA', 'Yu Mincho');
    setRuby('ja', 'Meiryo');
    expect(useFontStore.getState()).toMatchObject({ latin: 'Georgia', text: { ja: 'Yu Mincho' }, ruby: { ja: 'Meiryo' } });
    expect(document.getElementById('kt-fonts')?.textContent).toContain(':lang(ja) rt');
    setText('ja', '');
    expect(useFontStore.getState().text).toEqual({});
    clearLanguage('ja');
    setLatin('');
    expect(useFontStore.getState()).toMatchObject({ latin: '', text: {}, ruby: {} });
    expect(document.getElementById('kt-fonts')).toBeNull();
  });
});
