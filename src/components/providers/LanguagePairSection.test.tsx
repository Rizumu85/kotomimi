import { describe, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { AUTO } from '../../lib/provider/languages';
import { languageLabel } from '../../lib/language/label';
import type { LanguageContext } from '../../lib/provider/types';
import { fakeProvider } from '../../providers/fake/provider';
import { FAKE_DEFAULTS } from '../../providers/fake/settings';
import { PIN_SEPARATOR } from '../../lib/language/order';
import { LanguagePairSection } from './LanguagePairSection';

vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

const draw = (
  pair: { source: string; target: string },
  onChange = vi.fn(),
  extra: { sentence?: { mode: 'speaker' | 'participant' | 'both'; textOnly: boolean }; provider?: typeof fakeProvider } = {},
) => {
  render(
    <LanguagePairSection
      provider={extra.provider ?? fakeProvider}
      settings={FAKE_DEFAULTS}
      pair={pair}
      onChange={onChange}
      sentence={extra.sentence}
    />,
  );
  return onChange;
};
const values = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.value);
// The codes on offer, whatever the display order, pinned copies or separator.
const codesOf = (select: HTMLElement) => [...new Set(values(select).filter((v) => v !== PIN_SEPARATOR))].sort();

describe('LanguagePairSection', () => {
  it('names each option from the code, not from the option (unified language codes)', () => {
    // The file's react-i18next mock carries no i18n object: names come out in English.
    const provider = {
      ...fakeProvider,
      languages: {
        ...fakeProvider.languages,
        // Fork: `zh-TW` is named as `zh-Hant` is (label.ts), so the region here is one the fork leaves alone.
        sources: () => [{ value: 'zh-Hant' }, { value: 'zh-HK' }],
        targets: () => [{ value: 'zh-HK' }],
      },
    } as unknown as typeof fakeProvider;
    draw({ source: 'zh-Hant', target: 'zh-HK' }, vi.fn(), { provider });
    const texts = [...document.querySelectorAll('option')].map((o) => o.textContent);
    expect([...new Set(texts.filter((x) => x !== '──────────'))].sort()).toEqual([languageLabel('zh-Hant', 'en'), languageLabel('zh-HK', 'en')].sort());
    expect(languageLabel('zh-Hant', 'en')).not.toBe(languageLabel('zh-HK', 'en'));
  });

  it("offers exactly the provider's codes: its sources, and the targets of the chosen source", () => {
    draw({ source: 'en', target: 'ja' });
    expect(codesOf(screen.getByLabelText('settings.sourceLanguage'))).toEqual([AUTO, 'en', 'ja', 'zh'].sort());
    expect(codesOf(screen.getByLabelText('settings.targetLanguage'))).toEqual(['ja', 'zh']);
  });

  it('pins the current pair above a disabled separator, then lists auto first in the rest', () => {
    draw({ source: 'ja', target: 'en' });
    const select = screen.getByLabelText('settings.sourceLanguage') as HTMLSelectElement;
    expect(values(select).slice(0, 4)).toEqual(['ja', 'en', PIN_SEPARATOR, AUTO]);
    const separator = select.options[2];
    expect(separator.disabled).toBe(true);
    expect(separator.value).toBe(PIN_SEPARATOR);
  });

  it('names the AUTO source with the shared auto-detect label', () => {
    draw({ source: AUTO, target: 'en' });
    expect((screen.getByRole('option', { name: 'common.autoDetect' }) as HTMLOptionElement).value).toBe(AUTO);
  });

  it('moves the target when the new source does not offer it', () => {
    const onChange = draw({ source: 'en', target: 'ja' });
    fireEvent.change(screen.getByLabelText('settings.sourceLanguage'), { target: { value: 'ja' } });
    expect(onChange).toHaveBeenCalledWith({ source: 'ja', target: 'en' });
  });

  it('keeps the target when the new source offers it', () => {
    const onChange = draw({ source: 'en', target: 'ja' });
    fireEvent.change(screen.getByLabelText('settings.sourceLanguage'), { target: { value: 'zh' } });
    expect(onChange).toHaveBeenCalledWith({ source: 'zh', target: 'ja' });
  });

  it('changes the target', () => {
    const onChange = draw({ source: 'en', target: 'ja' });
    fireEvent.change(screen.getByLabelText('settings.targetLanguage'), { target: { value: 'zh' } });
    expect(onChange).toHaveBeenCalledWith({ source: 'en', target: 'zh' });
  });

  it('swaps a pair the provider supports in reverse', () => {
    const onChange = draw({ source: 'en', target: 'ja' });
    fireEvent.click(screen.getByTitle('simpleConfig.swapLanguages'));
    expect(onChange).toHaveBeenCalledWith({ source: 'ja', target: 'en' });
  });

  it('cannot swap an AUTO source', () => {
    draw({ source: AUTO, target: 'en' });
    expect(screen.getByTitle('simpleConfig.swapLanguages')).toBeDisabled();
  });

  it('the heading holds a help tooltip trigger (parity with LanguageSection.tsx)', () => {
    const { container } = render(
      <LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={vi.fn()} />,
    );
    expect(container.querySelector('h3 .tooltip-trigger')).toBeTruthy();
  });

  describe('with a sentence', () => {
    it("'both': I speak / they hear, and the mirror line shows", () => {
      draw({ source: 'ja', target: 'en' }, undefined, { sentence: { mode: 'both', textOnly: false } });
      expect(screen.getByText('settings.langSentence.iSpeak')).toBeTruthy();
      expect(screen.getByText('settings.langSentence.theyHear')).toBeTruthy();
      expect(screen.getByTestId('language-mirror-line')).toBeTruthy();
    });

    it("'participant': I read / they speak, and no mirror line", () => {
      draw({ source: 'ja', target: 'en' }, undefined, { sentence: { mode: 'participant', textOnly: false } });
      expect(screen.getByText('settings.langSentence.iRead')).toBeTruthy();
      expect(screen.getByText('settings.langSentence.theySpeak')).toBeTruthy();
      expect(screen.queryByTestId('language-mirror-line')).toBeNull();
    });

    it("textOnly on an 'optional' provider: they read", () => {
      draw({ source: 'ja', target: 'en' }, undefined, { sentence: { mode: 'speaker', textOnly: true } });
      expect(screen.getByText('settings.langSentence.iSpeak')).toBeTruthy();
      expect(screen.getByText('settings.langSentence.theyRead')).toBeTruthy();
    });
  });
});

describe('LanguagePairSection — a language context (Stage 2 Volcengine AST2, choice 1)', () => {
  const opt = (value: string) => ({ value, name: value, englishName: value });
  /** Speaking offers en and ja; text also ko — Doubao AST 2.0's shape. */
  const offered = (context?: LanguageContext) => [opt('en'), opt('ja'), ...(context?.speech ? [] : [opt('ko')])];
  const moody = {
    ...fakeProvider,
    languages: {
      sources: (_s: unknown, context?: LanguageContext) => offered(context),
      targets: (source: string, _s: unknown, context?: LanguageContext) => offered(context).filter((o) => o.value !== source),
    },
  } as unknown as typeof fakeProvider;
  const drawIn = (context: LanguageContext | undefined, pair: { source: string; target: string }, onChange = vi.fn()) => {
    render(<LanguagePairSection provider={moody} settings={FAKE_DEFAULTS} pair={pair} onChange={onChange} context={context} />);
    return onChange;
  };

  it('lists the offer for the context, and the widest one without', () => {
    drawIn({ speech: true }, { source: 'en', target: 'ja' });
    expect(codesOf(screen.getByLabelText('settings.sourceLanguage'))).toEqual(['en', 'ja']);
    expect(codesOf(screen.getByLabelText('settings.targetLanguage'))).toEqual(['ja']);
    cleanup();
    drawIn(undefined, { source: 'en', target: 'ja' });
    expect(codesOf(screen.getByLabelText('settings.sourceLanguage'))).toEqual(['en', 'ja', 'ko']);
  });

  it('normalizes a new source within the context, and swaps only within it', () => {
    const onChange = drawIn({ speech: true }, { source: 'en', target: 'ja' });
    fireEvent.change(screen.getByLabelText('settings.sourceLanguage'), { target: { value: 'ja' } });
    expect(onChange).toHaveBeenCalledWith({ source: 'ja', target: 'en' });
    cleanup();
    drawIn({ speech: false }, { source: 'en', target: 'ko' });
    expect(screen.getByTitle('simpleConfig.swapLanguages')).not.toBeDisabled();
    cleanup();
    drawIn({ speech: true }, { source: 'en', target: 'ko' });
    expect(screen.getByTitle('simpleConfig.swapLanguages')).toBeDisabled();
  });
});

describe('LanguagePairSection — my language and theirs (fork)', () => {
  const DETECT = '\u0000detect';
  type Mode = 'speaker' | 'participant' | 'both';
  const show = (mode: Mode, given: { on: boolean; available?: boolean; set(on: boolean): void } | undefined, onChange = vi.fn()) => {
    const detect = given && { available: true, ...given };
    cleanup();
    render(<LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={onChange} sentence={{ mode, textOnly: true }} detect={detect} owners />);
    return onChange;
  };
  const mine = () => screen.getByLabelText('fork.languageMenu.mine') as HTMLSelectElement;
  const theirs = () => screen.getByLabelText('fork.languageMenu.theirs') as HTMLSelectElement;
  const maySpeak = () => screen.queryByRole('group', { name: 'fork.languageMenu.theyMaySpeak' });
  const chipsOf = (group: HTMLElement) => [...group.querySelectorAll<HTMLButtonElement>('.language-chip')];
  const chipFor = (group: HTMLElement, code: string) => chipsOf(group).find((c) => c.textContent === languageLabel(code, 'en'))!;

  it('names the two selects for whose language they hold, the same in every mode, with nothing written under them', () => {
    for (const mode of ['speaker', 'participant', 'both'] as const) {
      show(mode, undefined);
      expect(mine().value).toBe('en');
      expect(theirs().value).toBe('ja');
      expect(screen.queryByTestId('language-mirror-line')).toBeNull();
    }
  });

  it('offers no detection where none was handed in, and keeps upstream\u2019s labels for any other provider', () => {
    show('both', undefined);
    expect(values(theirs())).not.toContain(DETECT);
    cleanup();
    render(<LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={vi.fn()} sentence={{ mode: 'both', textOnly: true }} />);
    expect(screen.getByLabelText('settings.langSentence.iSpeak')).toBeTruthy();
    expect(screen.getByTestId('language-mirror-line').textContent).toBe('settings.langSentence.mirror');
  });

  it('has "detect the language" as the first choice of their language — never of mine — in every mode it is handed in', () => {
    for (const mode of ['participant', 'both'] as const) {
      const set = vi.fn();
      const onChange = show(mode, { on: false, set });
      expect(theirs().options[0].value).toBe(DETECT);
      expect(theirs().options[0].textContent).toBe('fork.languageMenu.detect');
      expect(values(mine())).not.toContain(DETECT);
      expect(maySpeak()).toBeNull();
      fireEvent.change(theirs(), { target: { value: DETECT } });
      expect(set).toHaveBeenCalledWith(true);
      expect(onChange).not.toHaveBeenCalled();
    }
  });

  it('shows, while it is chosen, the languages they may speak as chips: the pair’s the one started with, another made it by a press', () => {
    const set = vi.fn();
    const onChange = show('both', { on: true, set });
    expect(theirs().value).toBe(DETECT);
    // Their languages, never mine: the fake's three, less English.
    expect(chipsOf(maySpeak()!)).toHaveLength(2);
    const ja = chipFor(maySpeak()!, 'ja');
    expect(ja.className).toContain('is-chosen');
    expect(ja.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chipFor(maySpeak()!, 'zh'));
    expect(onChange).toHaveBeenCalledWith({ source: 'en', target: 'zh' });
    // The one already started with: nothing changes.
    fireEvent.click(ja);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(set).not.toHaveBeenCalled();
  });

  it('marks the language followed into in a session apart from the one started with', () => {
    cleanup();
    render(<LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={vi.fn()} detect={{ on: true, available: true, set: vi.fn() }} followed="zh" owners />);
    expect(chipFor(maySpeak()!, 'ja').className).toContain('is-chosen');
    expect(chipFor(maySpeak()!, 'zh').className).toContain('is-live');
  });

  it('is turned off by choosing a language for them, which is then the pair\u2019s', () => {
    const set = vi.fn();
    const onChange = show('participant', { on: true, set });
    fireEvent.change(theirs(), { target: { value: 'zh' } });
    expect(set).toHaveBeenCalledWith(false);
    expect(onChange).toHaveBeenCalledWith({ source: 'en', target: 'zh' });
    // The language the pair already names: detection goes off, and the pair is as it was.
    const again = vi.fn();
    const quiet = show('participant', { on: true, set: again });
    fireEvent.change(theirs(), { target: { value: 'ja' } });
    expect(again).toHaveBeenCalledWith(false);
    expect(quiet).not.toHaveBeenCalled();
  });

  it('is greyed where what hears cannot detect and nothing here that could is downloaded — unless a run does it already', () => {
    const set = vi.fn();
    show('participant', { on: false, available: false, set });
    expect(theirs().options[0].disabled).toBe(true);
    expect(theirs().value).toBe('ja');
    show('participant', { on: true, available: false, set });
    expect(theirs().options[0].disabled).toBe(false);
  });
});

describe('LanguagePairSection — "I also speak" and what hears (fork)', () => {
  type Also = { chosen: string[]; offered?: string[] | null; available?: boolean; set(chosen: string[]): void };
  type Hearing = { mine?: { name: string; languages: string[] | null }; theirs?: { name: string; languages: string[] | null } };
  const show = (also: Also | undefined, extra: { hearing?: Hearing; detect?: boolean; onOpenHearing?: () => void } = {}) =>
    render(
      <LanguagePairSection
        provider={fakeProvider}
        settings={FAKE_DEFAULTS}
        pair={{ source: 'en', target: 'ja' }}
        onChange={vi.fn()}
        also={also && { offered: null, available: true, ...also }}
        {...(extra.hearing ? { hearing: extra.hearing } : {})}
        {...(extra.detect ? { detect: { on: true, available: true, set: vi.fn() } } : {})}
        {...(extra.onOpenHearing ? { onOpenHearing: extra.onOpenHearing } : {})}
        owners
      />,
    );
  const alsoSpeak = () => screen.queryByRole('group', { name: 'fork.languageMenu.alsoSpeak' });
  const chips = () => [...alsoSpeak()!.querySelectorAll<HTMLButtonElement>('.language-chip')];
  const chip = (code: string) => chips().find((c) => c.textContent?.endsWith(languageLabel(code, 'en')))!;

  it('offers the languages besides mine as chips, each turned on and off by a press', () => {
    const set = vi.fn();
    show({ chosen: [], set });
    expect(chips()).toHaveLength(2);
    fireEvent.click(chip('ja'));
    expect(set).toHaveBeenCalledWith(['ja']);
    cleanup();
    const again = vi.fn();
    show({ chosen: ['ja'], set: again });
    expect(chip('ja').className).toContain('is-on');
    fireEvent.click(chip('zh'));
    expect(again).toHaveBeenCalledWith(['ja', 'zh']);
    fireEvent.click(chip('ja'));
    expect(again).toHaveBeenLastCalledWith([]);
    cleanup();
  });

  it('offers only what hears can tell apart, and is greyed where it can tell none, unless some are on', () => {
    show({ chosen: [], offered: ['zh'], set: vi.fn() });
    expect(chips()).toHaveLength(1);
    cleanup();
    show({ chosen: [], available: false, set: vi.fn() });
    expect(chips().every((c) => c.disabled)).toBe(true);
    cleanup();
    show({ chosen: ['ja'], available: false, set: vi.fn() });
    expect(chips().every((c) => !c.disabled)).toBe(true);
    cleanup();
  });

  it('is not offered where not handed in', () => {
    show(undefined);
    expect(alsoSpeak()).toBeNull();
    cleanup();
  });

  it('names what hears once where both sides have the same, and opens its settings when pressed', () => {
    const open = vi.fn();
    show({ chosen: [], set: vi.fn() }, { hearing: { mine: { name: 'Qwen3-ASR 0.6B', languages: null }, theirs: { name: 'Qwen3-ASR 0.6B', languages: null } }, detect: true, onOpenHearing: open });
    const named = screen.getAllByRole('button', { name: 'fork.languageMenu.hearingBy' });
    expect(named).toHaveLength(1);
    fireEvent.click(named[0]);
    expect(open).toHaveBeenCalledTimes(1);
    cleanup();
    show({ chosen: [], set: vi.fn() }, { hearing: { mine: { name: 'Apple Speech', languages: null }, theirs: { name: 'SenseVoice-Small', languages: ['ja', 'zh', 'en', 'ko', 'yue'] } }, detect: true });
    expect(screen.getAllByRole('button', { name: 'fork.languageMenu.hearingBy' })).toHaveLength(2);
    cleanup();
  });
});
