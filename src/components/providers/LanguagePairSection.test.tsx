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
  type Mode = 'speaker' | 'participant' | 'both';
  const show = (mode: Mode) => {
    cleanup();
    render(<LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={vi.fn()} sentence={{ mode, textOnly: true }} owners />);
  };
  const mine = () => screen.getByLabelText('fork.languageMenu.mine') as HTMLSelectElement;
  const theirs = () => screen.getByLabelText('fork.languageMenu.theirs') as HTMLSelectElement;

  it('names the two selects for whose language they hold, the same in every mode, with nothing written under them', () => {
    for (const mode of ['speaker', 'participant', 'both'] as const) {
      show(mode);
      expect(mine().value).toBe('en');
      expect(theirs().value).toBe('ja');
      expect(screen.queryByTestId('language-mirror-line')).toBeNull();
    }
  });

  it('lists languages alone in their select — more are added beside it — and keeps upstream’s labels for any other provider', () => {
    show('both');
    expect(values(theirs()).filter((v) => v.startsWith('\u0000'))).toEqual([]);
    cleanup();
    render(<LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={vi.fn()} sentence={{ mode: 'both', textOnly: true }} />);
    expect(screen.getByLabelText('settings.langSentence.iSpeak')).toBeTruthy();
    expect(screen.getByTestId('language-mirror-line').textContent).toBe('settings.langSentence.mirror');
  });
});

describe('LanguagePairSection — the languages beside the main ones (fork)', () => {
  type Side = { chosen?: string[]; offered?: string[] | null; most?: number | null; any?: boolean; hearer?: { name: string; languages: string[] | null }; set?(chosen: string[]): void; lit?: string; light?(code: string): void };
  const side = (given: Side) => ({ chosen: [], offered: null, most: null, any: false, set: vi.fn(), ...given });
  const show = (more: { mine?: Side; theirs?: Side }, extra: { onOpenHearing?: () => void } = {}) => {
    cleanup();
    const sides = { ...(more.mine ? { mine: side(more.mine) } : {}), ...(more.theirs ? { theirs: side(more.theirs) } : {}) };
    render(<LanguagePairSection provider={fakeProvider} settings={FAKE_DEFAULTS} pair={{ source: 'en', target: 'ja' }} onChange={vi.fn()} more={sides} {...extra} owners />);
    return sides;
  };
  const row = (name: string) => screen.queryByRole('group', { name });
  const add = (group: HTMLElement) => group.querySelector<HTMLButtonElement>('.language-chip__add');
  const chips = (group: HTMLElement) => [...group.querySelectorAll<HTMLElement>('.language-chip')];
  const open = (group: HTMLElement) => fireEvent.mouseDown(add(group)!, { button: 0 });
  const option = (text: string) => screen.getAllByRole('option').find((o) => o.textContent?.startsWith(text))!;

  it('names each side’s row, and adds with "+" a language from what its recognizer tells apart', () => {
    const { mine } = show({ mine: {}, theirs: {} });
    expect(row('fork.languageMenu.alsoSpeak')).not.toBeNull();
    expect(row('fork.languageMenu.theyMaySpeak')).not.toBeNull();
    open(row('fork.languageMenu.alsoSpeak')!);
    fireEvent.click(option(languageLabel('zh', 'en')));
    expect(mine!.set).toHaveBeenCalledWith(['zh']);
  });

  it('takes a language off with its ×', () => {
    const { mine } = show({ mine: { chosen: ['zh'] } });
    fireEvent.click(screen.getByRole('button', { name: 'fork.languageMenu.removeLanguage' }));
    expect(mine!.set).toHaveBeenCalledWith([]);
  });

  it('has no "+" where its recognizer can take no more, and no row where it takes none', () => {
    show({ mine: { chosen: ['zh'], most: 1 }, theirs: { most: 0 } });
    expect(add(row('fork.languageMenu.alsoSpeak')!)).toBeNull();
    expect(row('fork.languageMenu.theyMaySpeak')).toBeNull();
    // Only what it tells apart is offered: none left, no "+" either.
    show({ mine: { offered: ['ja'] } });
    open(row('fork.languageMenu.alsoSpeak')!);
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([languageLabel('ja', 'en')]);
  });

  it('offers any language first where its recognizer tells many apart, and nothing beside it once chosen', () => {
    const { theirs } = show({ theirs: { any: true } });
    open(row('fork.languageMenu.theyMaySpeak')!);
    fireEvent.click(option('fork.languageMenu.anyLanguage'));
    expect(theirs!.set).toHaveBeenCalledWith(['auto']);
    show({ theirs: { any: true, chosen: ['auto'] } });
    const group = row('fork.languageMenu.theyMaySpeak')!;
    expect(chips(group).map((c) => c.textContent)).toEqual(['fork.languageMenu.anyLanguage']);
    expect(add(group)).toBeNull();
  });

  it('lights one of their languages by pressing it, and puts it out by pressing it again', () => {
    const light = vi.fn();
    show({ theirs: { chosen: ['zh', 'ko'], lit: 'zh', light } });
    const [zh, ko] = chips(row('fork.languageMenu.theyMaySpeak')!);
    expect(zh.className).toContain('is-lit');
    expect(ko.className).not.toContain('is-lit');
    const name = (chip: HTMLElement) => chip.querySelector<HTMLButtonElement>('.language-chip__name')!;
    expect(name(zh).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(name(ko));
    expect(light).toHaveBeenLastCalledWith('ko');
    fireEvent.click(name(zh));
    expect(light).toHaveBeenLastCalledWith('');
  });

  it('names what hears once in the heading where both sides have the same, and each side its own where not', () => {
    const openHearing = vi.fn();
    const same = { name: 'Qwen3-ASR 0.6B', languages: null };
    show({ mine: { hearer: same }, theirs: { hearer: same } }, { onOpenHearing: openHearing });
    const named = screen.getAllByRole('button', { name: 'fork.languageMenu.hearingBy' });
    expect(named).toHaveLength(1);
    expect(named[0].closest('h3')).not.toBeNull();
    fireEvent.click(named[0]);
    expect(openHearing).toHaveBeenCalledTimes(1);
    // The other side on an iPad, which takes no more than their main language: a row naming it alone.
    show({ mine: { hearer: same }, theirs: { hearer: { name: 'iPad · Apple Speech', languages: null }, most: 0 } });
    expect(screen.getAllByRole('button', { name: 'fork.languageMenu.hearingBy' })).toHaveLength(2);
    expect(screen.getByText('fork.languageMenu.hearsThem')).toBeInTheDocument();
  });
});
