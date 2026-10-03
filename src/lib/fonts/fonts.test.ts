import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanFamily, fontCss, fontLanguage, NO_FONTS, normalizeFonts, scriptSample } from './fontCss';
import { faceNames, listFontFamilies } from './systemFonts';
import { applyFonts, useFontStore } from '../../stores/fontStore';
import { persistSetting } from '../../services/persistSetting';

// The store saves each choice through a module it imports when first used. Left
// real, that import is still loading the settings service when this file ends.
vi.mock('../../services/persistSetting', () => ({ persistSetting: vi.fn(async () => true) }));

const BASE = 'var(--kt-font-base, var(--font-sans))';
const RANGE = 'U+0020-007E, U+00A0-024F, U+0250-02AF, U+0300-036F, U+1E00-1EFF';

describe('the fonts as a style sheet', () => {
  it('adds nothing while nothing is chosen', () => {
    expect(fontCss(NO_FONTS)).toBe('');
  });

  it('puts the interface font in front of the app\'s own stack, never instead of it', () => {
    expect(fontCss({ ...NO_FONTS, ui: 'Segoe UI Variable' })).toBe([
      ':root { --kt-font-base: "Segoe UI Variable", var(--font-sans); }',
      // The app's root names its own stack: the page alone would not reach the menus and buttons.
      'body, .App { font-family: var(--kt-font-base); }',
    ].join('\n'));
  });

  it('gives conversation text the Latin font — for its Latin letters only — and its romanization with it', () => {
    expect(fontCss({ ...NO_FONTS, latin: 'Georgia' }).split('\n')).toEqual([
      `@font-face { font-family: "kt-latin"; src: local("Georgia"), local("Georgia Regular"); unicode-range: ${RANGE}; }`,
      `[data-kt-text] { font-family: "kt-latin", ${BASE}; }`,
    ]);
  });

  it('finds the Latin font\'s face by the names the platform gave for it, before the family\'s own', () => {
    expect(fontCss({ ...NO_FONTS, latin: 'MiSans VF', latinFaces: ['MiSans VF Normal', 'MiSansVF-Normal'] }).split('\n')[0])
      .toBe(`@font-face { font-family: "kt-latin"; src: local("MiSans VF Normal"), local("MiSansVF-Normal"), local("MiSans VF"), local("MiSans VF Regular"); unicode-range: ${RANGE}; }`);
  });

  it('leads a language of another script with the Latin font, which takes the Latin letters alone — even one that could draw the rest', () => {
    const css = fontCss({ ...NO_FONTS, latin: 'MiSans VF', text: { ja: 'Yu Mincho' } });
    expect(css).toContain(`[data-kt-text]:lang(ja) { font-family: "kt-latin", "Yu Mincho", ${BASE}; }`);
    // Never by its own name: named plainly it would draw the kanji too, and the language's font would not be reached.
    expect(css.split('\n').slice(1).join('\n')).not.toContain('"MiSans VF"');
  });

  it('leads a language written in Latin letters with its own font', () => {
    const css = fontCss({ ...NO_FONTS, latin: 'Georgia', text: { fr: 'Garamond' } });
    expect(css).toContain(`[data-kt-text]:lang(fr) { font-family: "Garamond", "kt-latin", ${BASE}; }`);
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
      .toEqual({ ui: 'Arial', latin: '', latinFaces: [], text: { ja: 'Meiryo' }, ruby: {} });
    // A face's names are kept only with the font they name.
    expect(normalizeFonts({ latin: 'Georgia', latinFaces: ['Georgia', 'Georgia', 7, 'X"}'] }).latinFaces).toEqual(['Georgia', 'X']);
    expect(normalizeFonts({ latin: '', latinFaces: ['Georgia'] }).latinFaces).toEqual([]);
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
    vi.mocked(persistSetting).mockClear();
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

  it('applies each choice as it is made, saves it, and a blank choice removes it', async () => {
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
    // One write per choice, each the whole of what was chosen by then.
    await vi.waitFor(() => expect(persistSetting).toHaveBeenCalledTimes(6));
    const saved = vi.mocked(persistSetting).mock.calls;
    expect(saved.every(([key]) => key === 'settings.common.fonts')).toBe(true);
    expect(saved[2][1]).toEqual({ ui: '', latin: 'Georgia', latinFaces: [], text: { ja: 'Yu Mincho' }, ruby: { ja: 'Meiryo' } });
    expect(saved[5][1]).toEqual(NO_FONTS);
  });
});

describe('a family\'s own face', () => {
  it('is known by the names the platform lists for its regular face', async () => {
    (window as unknown as { queryLocalFonts: () => Promise<unknown[]> }).queryLocalFonts = async () => [
      { family: 'MiSans VF', fullName: 'MiSans VF Bold', postscriptName: 'MiSansVF-Bold', style: 'Bold' },
      // Listed before the regular face: still not the one taken for it.
      { family: 'MiSans VF', fullName: 'MiSans VF Medium', postscriptName: 'MiSansVF-Medium', style: 'Medium' },
      { family: 'MiSans VF', fullName: 'MiSans VF', postscriptName: 'MiSansVF-Regular', style: 'Regular' },
      { family: 'Georgia', fullName: 'Georgia', postscriptName: 'Georgia', style: 'Regular' },
    ];
    expect(await listFontFamilies()).toEqual(['Georgia', 'MiSans VF']);
    expect(faceNames('MiSans VF')).toEqual(['MiSans VF', 'MiSansVF-Regular']);
    expect(faceNames('Georgia')).toEqual(['Georgia']);
    expect(faceNames('Nope')).toEqual([]);
  });
});
