import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PIN_SEPARATOR } from '../../lib/language/order';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import type { LanguageContext } from '../../lib/provider/types';

const { trackEvent } = vi.hoisted(() => ({ trackEvent: vi.fn() }));
vi.mock('../../lib/analytics', () => ({ useAnalytics: () => ({ trackEvent }) }));
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-i18next')>();
  return { ...actual, useTranslation: () => ({ t: (key: string) => key }) };
});

import { fakeProvider } from '../../providers/fake/provider';
import { FAKE_DEFAULTS } from '../../providers/fake/settings';
import { LOCALAI_DEFAULTS, localaiLanguages } from '../../providers/openai/localai';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { useProviderStore } from '../../stores/providerStore';
import { ProviderLanguages } from './ProviderLanguages';

beforeEach(() => {
  trackEvent.mockClear();
  useProviderStore.setState({
    entries: { fake: { settings: FAKE_DEFAULTS, credentials: {}, pair: { source: 'auto', target: 'en' } } },
    readiness: {},
    selected: 'fake',
    intent: { source: 'auto', target: 'en' },
  });
});

describe('ProviderLanguages', () => {
  it('changes the source language: setPair, and one language_changed for that side', () => {
    render(<ProviderLanguages providers={[fakeProvider]} />);
    fireEvent.change(screen.getByLabelText('settings.sourceLanguage'), { target: { value: 'ja' } });
    expect(trackEvent).toHaveBeenCalledWith('language_changed', { to_language: 'ja', language_type: 'source' });
    expect(trackEvent).not.toHaveBeenCalledWith('language_changed', expect.objectContaining({ language_type: 'target' }));
    expect(useProviderStore.getState().entries.fake?.pair).toEqual({ source: 'ja', target: 'en' });
  });

  it('changes the target language: setPair, and one language_changed for that side', () => {
    render(<ProviderLanguages providers={[fakeProvider]} />);
    fireEvent.change(screen.getByLabelText('settings.targetLanguage'), { target: { value: 'zh' } });
    expect(trackEvent).toHaveBeenCalledWith('language_changed', { to_language: 'zh', language_type: 'target' });
    expect(trackEvent).not.toHaveBeenCalledWith('language_changed', expect.objectContaining({ language_type: 'source' }));
    expect(useProviderStore.getState().entries.fake?.pair).toEqual({ source: 'auto', target: 'zh' });
  });

  it('a swap sends language_changed for both sides', () => {
    useProviderStore.setState((st) => ({ entries: { ...st.entries, fake: { ...st.entries.fake, pair: { source: 'en', target: 'ja' } } } }));
    render(<ProviderLanguages providers={[fakeProvider]} />);
    fireEvent.click(screen.getByTitle('simpleConfig.swapLanguages'));
    expect(trackEvent).toHaveBeenCalledWith('language_changed', { to_language: 'ja', language_type: 'source' });
    expect(trackEvent).toHaveBeenCalledWith('language_changed', { to_language: 'en', language_type: 'target' });
  });

  it('disables both selects and the swap', () => {
    useProviderStore.setState((st) => ({ entries: { ...st.entries, fake: { ...st.entries.fake, pair: { source: 'en', target: 'ja' } } } }));
    render(<ProviderLanguages providers={[fakeProvider]} disabled />);
    expect(screen.getByLabelText('settings.sourceLanguage')).toBeDisabled();
    expect(screen.getByLabelText('settings.targetLanguage')).toBeDisabled();
    expect(screen.getByTitle('simpleConfig.swapLanguages')).toBeDisabled();
  });
});

describe('ProviderLanguages — the language context (Stage 2 Volcengine AST2, choice 1)', () => {
  const opt = (value: string) => ({ value, name: value, englishName: value });
  const offered = (context?: LanguageContext) => [opt('en'), opt('ja'), ...(context?.speech ? [] : [opt('ko')])];
  const moody = {
    ...fakeProvider,
    id: 'moody',
    speech: 'optional',
    languages: {
      sources: (_s: unknown, context?: LanguageContext) => offered(context),
      targets: (source: string, _s: unknown, context?: LanguageContext) => offered(context).filter((o) => o.value !== source),
    },
  } as unknown as typeof fakeProvider;
  // The codes on offer: display order, pinned copies and the separator are not what this pins.
  const sources = () => [...new Set([...(screen.getByLabelText('settings.sourceLanguage') as HTMLSelectElement).options].map((o) => o.value).filter((v) => v !== PIN_SEPARATOR))].sort();

  it("offers the languages of the store's context: its legs, and whether they speak", () => {
    useProviderStore.setState({
      entries: { moody: { settings: FAKE_DEFAULTS, credentials: {}, pair: { source: 'en', target: 'ja' } } },
      selected: 'moody',
      legs: ['speaker'],
      speech: { textOnly: false, participantSpeech: false },
    });
    render(<ProviderLanguages providers={[moody]} />);
    expect(sources()).toEqual(['en', 'ja']);
    act(() => { useProviderStore.setState({ speech: { textOnly: true, participantSpeech: false } }); });
    expect(sources()).toEqual(['en', 'ja', 'ko']);
    act(() => { useProviderStore.setState({ legs: ['speaker', 'participant'], speech: { textOnly: true, participantSpeech: true } }); });
    expect(sources()).toEqual(['en', 'ja']);
  });
});

describe('ProviderLanguages — the Kotomimi provider: my language, theirs, and the languages beside them (fork)', () => {
  // The fake's lists, with the Kotomimi provider's own capabilities.
  const kotomimi = { ...fakeProvider, id: 'localai', languages: { ...fakeProvider.languages, more: localaiLanguages.more } } as unknown as typeof fakeProvider;
  /** This computer's engine, with these downloaded. */
  const engine = (...ids: string[]) => useNativeEngineStore.setState({ status: {
    supported: true, engine: 'ready', engineBytes: 1, up: [],
    models: Object.fromEntries(ids.map((id) => [id, { state: 'downloaded', received: 1, total: 1 }])),
    run: { state: 'stopped', model: null, port: 0, tail: '' },
  } as never });
  beforeEach(() => engine('qwen3-asr-1.7b-q8'));
  type Leg = 'speaker' | 'participant';
  const show = (settings: Record<string, unknown>, legs: Leg[], models: unknown[] = []) => {
    cleanup();
    useProviderStore.setState({
      entries: { localai: { settings: { ...LOCALAI_DEFAULTS, asrVia: 'device', asrHere: 'native', ...settings }, credentials: {}, pair: { source: 'zh', target: 'ja' } } } as never,
      selected: 'localai' as never,
      // The pair as picked: a settings write derives the pair from it.
      intent: { source: 'zh', target: 'ja' },
      legs,
      models: { localai: models } as never,
    });
    render(<ProviderLanguages providers={[kotomimi]} sentence={{ mode: legs.length === 2 ? 'both' : legs[0], textOnly: true }} />);
  };
  const saved = () => (useProviderStore.getState().entries as unknown as Record<string, { settings: Record<string, unknown> }>).localai.settings;
  const row = (name: string) => screen.queryByRole('group', { name });
  const add = (group: HTMLElement) => group.querySelector<HTMLButtonElement>('.language-chip__add');

  it('offers a row a side while each is heard, and a choice there is saved as the run reads it', () => {
    show({}, ['speaker', 'participant']);
    expect(row('fork.languageMenu.iSay')).not.toBeNull();
    expect(row('fork.languageMenu.theySay')).not.toBeNull();
    // One recognizer for both: named once, in the heading.
    expect(screen.getAllByRole('button', { name: 'fork.languageMenu.hearingBy' })).toHaveLength(1);
    fireEvent.mouseDown(add(row('fork.languageMenu.theySay')!)!, { button: 0 });
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent === 'fork.languageMenu.anyLanguage')!);
    expect(saved()).toMatchObject({ theyAlso: ['ja', 'auto'], theyLit: 'auto', asrDetectOther: true });
    // Only the user heard: their languages are still what the user's speech is translated into.
    show({}, ['speaker']);
    expect(row('fork.languageMenu.theySay')).not.toBeNull();
  });

  it('presses their row: one lit beside the main one, a third handing the main on, one put out: heard and translated into no more', () => {
    show({ theyAlso: ['en', 'ko'] }, ['speaker', 'participant']);
    const theirs = row('fork.languageMenu.theySay')!;
    const chip = (i: number) => theirs.querySelectorAll<HTMLButtonElement>('.language-chip--switch')[i];
    const target = () => (useProviderStore.getState().entries as unknown as Record<string, { pair: { target: string } }>).localai.pair.target;
    expect([0, 1, 2].map((i) => chip(i).getAttribute('aria-pressed'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(chip(1));
    expect(saved()).toMatchObject({ theyAlso: ['ja', 'en', 'ko'], theyLit: 'en', asrDetectOther: true });
    fireEvent.click(chip(2));
    expect(target()).toBe('en');
    expect(saved()).toMatchObject({ theyLit: 'ko', asrDetectOther: true });
    fireEvent.click(chip(2));
    expect(saved()).toMatchObject({ theyAlso: ['ja', 'en', 'ko'], theyLit: '', asrDetectOther: false });
  });

  it('makes a language of the user’s row theirs by pressing it, and dims the ones the other side has not lit', () => {
    show({ speakAlso: ['zh', 'en', 'ja'], theyAlso: ['ja', 'en'] }, ['speaker', 'participant']);
    const mine = row('fork.languageMenu.iSay')!;
    const chip = (i: number) => mine.querySelectorAll<HTMLButtonElement>('.language-chip--switch')[i];
    const pair = () => (useProviderStore.getState().entries as unknown as Record<string, { pair: { source: string; target: string } }>).localai.pair;
    // Their main one, Japanese, is in use; English is not lit for them.
    expect([0, 1, 2].map((i) => chip(i).className.includes('is-idle'))).toEqual([false, true, false]);
    expect(chip(0).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(chip(1));
    expect(pair().source).toBe('en');
    expect(saved()).toMatchObject({ speakAlso: ['zh', 'en', 'ja'] });
  });

  it('reads an older "detect their language" as any language', () => {
    show({ asrDetectOther: true }, ['participant']);
    expect(screen.getByText('fork.languageMenu.anyLanguage')).toBeInTheDocument();
  });

  it('has the Mac’s recognition hear one language beside mine, and none beside theirs', () => {
    useNativeEngineStore.setState({ status: {
      supported: true, engine: 'ready', engineBytes: 0, up: [],
      models: { 'apple-speech:zh': { state: 'downloaded', received: 0, total: 0 }, 'apple-speech:ja': { state: 'downloaded', received: 0, total: 0 } },
      run: { state: 'stopped', model: null, port: 0, tail: '' },
    } as never });
    show({ asrNativeModel: 'apple-speech:zh' }, ['speaker', 'participant']);
    const mine = row('fork.languageMenu.iSay')!;
    fireEvent.mouseDown(add(mine)!, { button: 0 });
    fireEvent.click(screen.getAllByRole('option').find((o) => /ja|日|Japanese/i.test(o.textContent ?? ''))!);
    expect(saved()).toMatchObject({ speakAlso: ['zh', 'ja'], speakBoth: false });
    // Theirs is one language at a time there: a press moves it.
    expect(row('fork.languageMenu.theySay')).not.toBeNull();
  });

  it('offers nothing beside a recognizer that must be told the language', () => {
    engine('r2t2-q8');
    show({ asrNativeModel: 'r2t2-q8' }, ['speaker', 'participant']);
    expect(row('fork.languageMenu.alsoSpeak')).toBeNull();
    // Theirs is switched one at a time.
    show({ asrNativeModel: 'r2t2-q8', theyAlso: ['en'] }, ['speaker', 'participant']);
    fireEvent.click(row('fork.languageMenu.theySay')!.querySelectorAll<HTMLButtonElement>('.language-chip--switch')[1]);
    expect((useProviderStore.getState().entries as unknown as Record<string, { pair: { target: string } }>).localai.pair.target).toBe('en');
    expect(saved()).toMatchObject({ theyLit: '', asrDetectOther: false });
  });
});
