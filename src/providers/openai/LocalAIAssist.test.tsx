import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Readiness } from '../../lib/provider/types';
import { useLocalServerStore } from '../../stores/localServerStore';
import { useModelStore } from '../../stores/modelStore';
import { NO_LOCAL_SERVER } from '../../lib/lan/localServer';
import { LocalAIAssist } from './LocalAIAssist';
import { LOCALAI_DEFAULTS, type LocalAISettings } from './localai';
import { PLACE_FIELDS } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
// The search of the network is the finder's own test: here only that it is drawn, and what a pick does.
vi.mock('../../components/LanSharing/ServerFinder', () => ({
  ServerFinder: ({ onPick, auto, hint }: { onPick(server: unknown): void; auto?: boolean; hint?: string }) => (
    <button type="button" data-auto={String(Boolean(auto))} data-hint={hint} onClick={() => onPick({ address: '192.168.1.9:8790', kind: 'kotomimi', name: 'DESK', product: '', models: 2, needsKey: true, self: false })}>finder</button>
  ),
}));
// The library is Local Inference's own, tested beside it: here only which one opens. Its card is the real one: the chat models are drawn with it.
vi.mock('../../components/Settings/sections/ModelManagementSection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/Settings/sections/ModelManagementSection')>()),
  ModelManagementSection: ({ stageFilter, direction }: { stageFilter?: string; direction?: string }) => <div data-testid="library">{`${stageFilter}:${direction}`}</div>,
}));
vi.mock('../../components/CustomModels/CustomModels', () => ({ CustomModels: () => null }));
// This computer's LocalAI, as the main process would answer: none, unless a test says so.
const localai = vi.hoisted(() => ({ pipes: { pipelines: [] as unknown[], recognizers: [] as string[], translators: [] as string[] } }));
vi.mock('../../lib/lan/localServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lan/localServer')>()),
  askLocalPipelines: async () => localai.pipes,
}));
// What the network holds, for the one search the cards make themselves (`KotomimiThere`).
const network = vi.hoisted(() => ({ servers: [] as unknown[] }));
vi.mock('../../lib/lan/discover', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/lan/discover')>()),
  canFindServers: () => true,
  findServers: async () => network.servers,
}));

/** What a LocalAI lists: a pipeline, a recognizer, two text models. */
const LISTED: LocalAIModel[] = [
  { id: 'gpt-realtime', kind: 'pipeline' },
  { id: 'whisper-large-turbo', kind: 'asr' },
  { id: 'hy-mt2-1.8b', kind: 'text' },
  { id: 'qwen3-4b', kind: 'text' },
];

interface Drawn { settings?: Partial<LocalAISettings>; values?: Record<string, string>; models?: LocalAIModel[]; readiness?: Readiness }

function draw({ settings = {}, values = { endpoint: '' }, models = [], readiness = { state: 'unknown' } }: Drawn = {}) {
  const update = vi.fn();
  const fill = vi.fn();
  const set = vi.fn();
  const check = vi.fn();
  const view = render(
    <LocalAIAssist settings={{ ...LOCALAI_DEFAULTS, ...settings }} values={values} set={set} fill={fill} update={update} pair={{ source: 'zh-CN', target: 'ja' }} legs={['speaker']} models={models} readiness={readiness} check={check} />,
  );
  const card = (stage: string) => within(screen.getByRole('region', { name: stage }));
  const places = (stage: string) => [...screen.getByRole('group', { name: stage }).querySelectorAll('button')];
  return { ...view, update, fill, set, check, card, places };
}

const HEAR = 'providers.localai.hearStage';
const TRANSLATE = 'providers.localai.translateStage';
const COACH = 'providers.localai.coachStage';
const THREE = ['providers.localai.placeServer', 'providers.localai.viaModel', 'providers.localai.placeDevice'];
const pressed = (buttons: Element[]) => buttons.find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent;
const options = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.value);

beforeEach(() => {
  // Nothing downloaded; the online translator is always there.
  useModelStore.setState({ initialized: true, webgpuAvailable: true, deviceFeatures: [], modelStatuses: {}, downloads: {} });
  // No LocalAI on this computer.
  useLocalServerStore.setState({ status: NO_LOCAL_SERVER });
  localai.pipes = { pipelines: [], recognizers: [], translators: [] };
});

describe('the stage cards: where each stage runs', () => {
  it('gives every stage the same three places, each chosen by itself', () => {
    const { places, update } = draw({ settings: { asrVia: 'device', translateAt: 'server', coach: true, coachAt: 'api' } });
    for (const stage of [HEAR, TRANSLATE, COACH]) expect(places(stage).map((b) => b.textContent)).toEqual(THREE);
    // What hears decides nothing about what translates.
    expect(pressed(places(HEAR))).toBe('providers.localai.placeDevice');
    expect(pressed(places(TRANSLATE))).toBe('providers.localai.placeServer');
    expect(pressed(places(COACH))).toBe('providers.localai.viaModel');
    fireEvent.click(places(TRANSLATE)[2]);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateAt: 'device' }));
    fireEvent.click(places(HEAR)[1]);
    expect(update).toHaveBeenLastCalledWith({ asrVia: 'api' });
    fireEvent.click(places(COACH)[2]);
    expect(update).toHaveBeenLastCalledWith({ coachAt: 'device' });
  });

  it('writes the places read out of an earlier build\'s settings with the first edit, and only with the first', () => {
    const { places, update } = draw({ settings: { translateAt: 'server', translateServerModel: 'translategemma-4b', coachAt: 'server', coachServerModel: 'translategemma-4b' } });
    fireEvent.click(places(HEAR)[2]);
    const first = update.mock.calls[0][0] as Record<string, unknown>;
    expect(Object.keys(first).sort()).toEqual([...PLACE_FIELDS, 'asrVia'].sort());
    expect(first).toMatchObject({ asrVia: 'device', translateAt: 'server', translateServerModel: 'translategemma-4b', coachAt: 'server', coachServerModel: 'translategemma-4b' });
    fireEvent.click(places(HEAR)[1]);
    expect(update).toHaveBeenLastCalledWith({ asrVia: 'api' });
  });

  it('asks where the feedback runs only once it is switched on', () => {
    const off = draw();
    expect(screen.queryByRole('group', { name: COACH })).toBeNull();
    fireEvent.click(off.card(COACH).getByText('providers.localai.coach'));
    expect(off.update).toHaveBeenLastCalledWith(expect.objectContaining({ coach: true }));
    off.unmount();
    draw({ settings: { coach: true } });
    expect(screen.getByRole('group', { name: COACH })).toBeTruthy();
  });
});

describe('the stage cards: on the other device', () => {
  it('chooses each stage\'s model from what the device lists for it, in the card itself', () => {
    const { card, update } = draw({ settings: { coach: true }, values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    const hear = card(HEAR).getByRole('combobox', { name: 'providers.localai.model' });
    expect(options(hear)).toEqual(['', 'whisper-large-turbo']);
    const translate = card(TRANSLATE).getByRole('combobox', { name: 'providers.localai.model' });
    expect(options(translate)).toEqual(['', 'hy-mt2-1.8b', 'qwen3-4b']);
    // Left blank while the device also hears: its own pipeline translates, in the same session.
    expect((translate as HTMLSelectElement).options[0].textContent).toBe('providers.localai.translateInSession');
    fireEvent.change(translate, { target: { value: 'qwen3-4b' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateServerModel: 'qwen3-4b' }));
    expect(options(card(COACH).getByRole('combobox', { name: 'providers.localai.model' }))).toEqual(['', 'hy-mt2-1.8b', 'qwen3-4b']);
  });

  it('offers the translation there to a leg this computer hears, too: the device\'s first model that translates when none is named', () => {
    const { card } = draw({ settings: { asrVia: 'device' }, values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    const translate = card(TRANSLATE).getByRole('combobox', { name: 'providers.localai.model' }) as HTMLSelectElement;
    expect(translate.options[0].textContent).toBe('providers.localai.auto');
    expect(options(translate)).toEqual(['', 'hy-mt2-1.8b', 'qwen3-4b']);
  });

  it('keeps a saved model the device no longer lists visible, and shows no recognizer a LocalAI would refuse', () => {
    const { card } = draw({ settings: { asrModel: 'whisper-large-turbo', translateServerModel: 'gone-model' }, values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    expect(options(card(TRANSLATE).getByRole('combobox', { name: 'providers.localai.model' }))).toEqual(['', 'gone-model', 'hy-mt2-1.8b', 'qwen3-4b']);
    // The translation is by a model named here: the leg only transcribes, with the device's own recognizer.
    const hear = card(HEAR).getByRole('combobox', { name: 'providers.localai.model' }) as HTMLSelectElement;
    expect(hear.disabled).toBe(true);
    expect(hear.value).toBe('');
    expect(card(HEAR).getByText('providers.localai.asrFixedNote')).toBeTruthy();
  });

  it('offers the way out of a recognizer that cannot be chosen: the Kotomimi on the same device, one press away', async () => {
    const kotomimi = (address: string) => ({ address, kind: 'kotomimi', name: 'MAC', product: '', models: 3, needsKey: true, self: false });
    // Another device's Kotomimi is not it; the same device's is.
    network.servers = [kotomimi('192.168.1.77:8790'), { address: '192.168.1.10:8080', kind: 'server', name: '', product: 'LocalAI', models: 4, needsKey: false, self: false }, kotomimi('192.168.1.10:8790')];
    const { card, fill, update } = draw({ settings: { translateServerModel: 'hy-mt2-1.8b' }, values: { endpoint: 'http://192.168.1.10:8080/' }, models: LISTED });
    fireEvent.click(card(HEAR).getByRole('button', { name: 'providers.localai.kotomimiThere' }));
    await waitFor(() => expect(fill).toHaveBeenCalledWith('endpoint', '192.168.1.10:8790'));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ serverNeedsKey: true }));
  });

  it('says what to do on that device when no Kotomimi is sharing there, and offers nothing where the recognizer can be chosen', async () => {
    network.servers = [{ address: '192.168.1.10:8080', kind: 'server', name: '', product: 'LocalAI', models: 4, needsKey: false, self: false }];
    const { card, fill, unmount } = draw({ settings: { translateServerModel: 'hy-mt2-1.8b' }, values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    fireEvent.click(card(HEAR).getByRole('button', { name: 'providers.localai.kotomimiThere' }));
    expect(await card(HEAR).findByText('providers.localai.kotomimiThereNone')).toBeTruthy();
    expect(fill).not.toHaveBeenCalled();
    unmount();
    // Translated in the session itself: the recognizer is chosen freely, and nothing is offered.
    const free = draw({ values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    expect(free.card(HEAR).queryByRole('button', { name: 'providers.localai.kotomimiThere' })).toBeNull();
    free.unmount();
    // A model server on this very computer: there is no other device to look on.
    const here = draw({ settings: { translateServerModel: 'hy-mt2-1.8b' }, values: { endpoint: '127.0.0.1:8080' }, models: LISTED });
    expect(here.card(HEAR).getByText('providers.localai.asrFixedNote')).toBeTruthy();
    expect(here.card(HEAR).queryByRole('button', { name: 'providers.localai.kotomimiThere' })).toBeNull();
  });

  it('offers the same way where the address no longer answers, and not where its key is refused', async () => {
    network.servers = [{ address: '192.168.1.10:8790', kind: 'kotomimi', name: 'MAC', product: '', models: 3, needsKey: false, self: false }];
    // The models are the last the device listed: it is the check that says it no longer answers.
    const silent = draw({ values: { endpoint: '192.168.1.10:8080' }, models: LISTED, readiness: { state: 'not-ready', reason: 'The other device could not be reached (192.168.1.10:8080): Failed to fetch' } });
    expect(screen.getByText('providers.localai.serverSilent')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'providers.localai.kotomimiThere' }));
    await waitFor(() => expect(silent.fill).toHaveBeenCalledWith('endpoint', '192.168.1.10:8790'));
    silent.unmount();
    draw({ values: { endpoint: '192.168.1.10:8080' }, readiness: { state: 'not-ready', reason: 'refused', code: 'auth' } });
    expect(screen.queryByText('providers.localai.serverSilent')).toBeNull();
  });

  it('says so when the device has no text model for the feedback', () => {
    const { card } = draw({ settings: { coach: true }, values: { endpoint: '192.168.1.10:8080' }, models: [{ id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' }, { id: 'bing-translator', kind: 'translate', host: 'kotomimi' }] });
    expect(card(COACH).getByText('providers.localai.coachNoModel')).toBeTruthy();
    expect(card(COACH).queryByRole('combobox')).toBeNull();
  });

  it('is found by searching, above the cards: a pick fills its address and asks for its key', () => {
    const { fill, update, set } = draw();
    const finder = screen.getByText('finder');
    // A stage wants the device and no address is set: the search runs by itself.
    expect(finder.dataset.auto).toBe('true');
    expect(finder.dataset.hint).toBe('providers.localai.otherDeviceHint');
    expect(screen.getAllByText('providers.localai.connectFirst').length).toBeGreaterThan(0);
    fireEvent.click(finder);
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ serverNeedsKey: true }));
    expect(fill).toHaveBeenCalledWith('endpoint', '192.168.1.9:8790');
    // Typed by hand, the address is a credential like any other.
    fireEvent.change(screen.getByRole('textbox', { name: 'providers.localai.endpoint' }), { target: { value: '192.168.1.20:8080' } });
    expect(set).toHaveBeenLastCalledWith('endpoint', '192.168.1.20:8080');
  });

  it('stays out of the way while no stage is placed on it: a search to press, and no address to fill', () => {
    draw({ settings: { asrVia: 'device', translateAt: 'device' } });
    expect(screen.getByText('finder').dataset.auto).toBe('false');
    expect(screen.queryByRole('textbox', { name: 'providers.localai.endpoint' })).toBeNull();
    expect(screen.queryByText('providers.localai.connectFirst')).toBeNull();
  });
});

describe('the stage cards: at an API', () => {
  it('asks for the address, the model and the key in the stage that uses them', () => {
    const { card, update, set } = draw({ settings: { asrVia: 'api', translateAt: 'api', translateNeedsKey: false } });
    const hear = card(HEAR);
    fireEvent.change(hear.getByRole('textbox', { name: 'providers.localai.asrApiBaseUrl' }), { target: { value: 'https://api.example.com/v1' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrApiBaseUrl: 'https://api.example.com/v1' }));
    fireEvent.change(hear.getByRole('combobox', { name: 'providers.localai.model' }), { target: { value: 'whisper-1' } });
    expect(update).toHaveBeenLastCalledWith({ asrApiModel: 'whisper-1' });
    // The key is a credential, written as typing writes one: no check at every letter.
    fireEvent.change(hear.getByLabelText('providers.localai.apiKey', { selector: 'input' }), { target: { value: 'sk-1' } });
    expect(set).toHaveBeenLastCalledWith('asrKey', 'sk-1');
    // An API that wants no key shows no field for one.
    expect(card(TRANSLATE).queryByLabelText('providers.localai.apiKey', { selector: 'input' })).toBeNull();
  });
});

describe('the stage cards: on this computer', () => {
  it('chooses the model in the card, and opens the library under it by itself while a model is missing', () => {
    const { card } = draw({ settings: { asrVia: 'device', translateAt: 'device' } });
    // No recognizer is downloaded: the library is the first thing seen, for the language heard; the tour points here.
    expect(card(HEAR).getByTestId('library').textContent).toBe('asr:zh→ja');
    expect(card(HEAR).getByRole('combobox').closest('[data-tour="engine-chips"]')).toBeTruthy();
    expect((card(HEAR).getByRole('combobox') as HTMLSelectElement).options[0].textContent).toBe('providers.localai.notDownloaded');
    // The online translator is always there: the translation has its model, and its library waits to be opened.
    expect(card(TRANSLATE).queryByTestId('library')).toBeNull();
    expect((card(TRANSLATE).getByRole('combobox') as HTMLSelectElement).options[0].textContent).toBe('providers.localai.auto');
    fireEvent.click(card(TRANSLATE).getByRole('button', { name: 'providers.localai.browse' }));
    expect(card(TRANSLATE).getByTestId('library').textContent).toBe('translation:zh→ja');
    fireEvent.click(card(TRANSLATE).getByRole('button', { name: 'providers.localai.browse' }));
    expect(card(TRANSLATE).queryByTestId('library')).toBeNull();
  });

  it('gives feedback with one of the catalog\'s chat models, downloaded from the card — in the library\'s own cards', () => {
    const downloadModel = vi.fn(async () => {});
    useModelStore.setState({ downloadModel });
    const { card, update } = draw({ settings: { coach: true, coachAt: 'device' } });
    const coach = card(COACH);
    // None downloaded: the list of them is open, a card each, as the other stages' libraries draw theirs.
    const ids = ['qwen2.5-0.5b-translation', 'qwen3-0.6b-translation', 'qwen3.5-0.8b-translation', 'qwen3.5-2b-translation'];
    for (const id of ids) expect(coach.getByTestId(`model-card-${id}`).className).toContain('model-card');
    const downloads = coach.getAllByTitle('models.download');
    expect(downloads).toHaveLength(4);
    fireEvent.click(downloads[0]);
    expect(downloadModel).toHaveBeenCalledWith('qwen2.5-0.5b-translation');
    // Downloaded ones can be picked: from the menu, or by their card. Left alone, the largest is the one in use.
    act(() => useModelStore.setState({ modelStatuses: { 'qwen3-0.6b-translation': 'downloaded', 'qwen3.5-2b-translation': 'downloaded' } }));
    fireEvent.click(coach.getByRole('button', { name: 'providers.localai.browse' }));
    expect(coach.getByTestId('model-card-qwen3.5-2b-translation').className).toContain('model-card--selected');
    const select = coach.getByRole('combobox', { name: 'providers.localai.model' });
    expect(options(select)).toEqual(['', 'qwen3-0.6b-translation', 'qwen3.5-2b-translation']);
    fireEvent.change(select, { target: { value: 'qwen3-0.6b-translation' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ coachDeviceModel: 'qwen3-0.6b-translation' }));
    fireEvent.click(coach.getByTestId('model-card-qwen3.5-2b-translation'));
    expect(update).toHaveBeenLastCalledWith({ coachDeviceModel: 'qwen3.5-2b-translation' });
  });

  it('loads the model store itself, and says nothing of the graphics card before it has looked', async () => {
    // The other device is away: the readiness check never gets as far as this computer's models.
    const initialize = vi.fn(async () => { useModelStore.setState({ initialized: true, webgpuAvailable: true }); });
    useModelStore.setState({ initialized: false, webgpuAvailable: false, initialize });
    const { card } = draw({ settings: { coach: true, coachAt: 'device' }, values: { endpoint: '192.168.1.10:8080' }, readiness: { state: 'not-ready', reason: 'The other device could not be reached (192.168.1.10:8080): Failed to fetch' } });
    expect(initialize).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(useModelStore.getState().initialized).toBe(true));
    expect(card(COACH).queryByText('providers.localai.chatModelsNoGpu')).toBeNull();
    expect(card(COACH).queryByText('settings.webgpuNotSupported')).toBeNull();
  });

  it('says nothing is downloaded only once the store has looked: while it scans, every choice is still being checked', async () => {
    // A model is downloaded; the store has not finished its first look at what is.
    let finish: () => void = () => {};
    const initialize = vi.fn(() => new Promise<void>((resolve) => { finish = () => { useModelStore.setState({ initialized: true, modelStatuses: { 'sensevoice-int8': 'downloaded', 'qwen3-0.6b-translation': 'downloaded' } }); resolve(); }; }));
    useModelStore.setState({ initialized: false, webgpuAvailable: false, modelStatuses: {}, initialize });
    const { card } = draw({ settings: { asrVia: 'device', translateAt: 'device', coach: true, coachAt: 'device' } });
    for (const stage of [HEAR, TRANSLATE, COACH]) {
      expect(card(stage).queryByText('providers.localai.notDownloaded'), stage).toBeNull();
      expect(card(stage).getAllByText('providers.localai.checking').length, stage).toBeGreaterThan(0);
      expect(card(stage).queryAllByRole('combobox').filter((select) => select.className.includes('kt-here__select--missing')), stage).toEqual([]);
    }
    // Nothing opens by itself on a gap that is not known to be one.
    expect(screen.queryByTestId('library')).toBeNull();
    for (const button of screen.getAllByRole('button', { name: 'providers.localai.browse' })) expect(button.getAttribute('aria-expanded')).toBe('false');
    await act(async () => { finish(); });
    expect(card(HEAR).queryByText('providers.localai.checking')).toBeNull();
  });

  it('says so once the store has looked and found no graphics card for them, and loads nothing while no stage is here', () => {
    const initialize = vi.fn(async () => {});
    useModelStore.setState({ initialized: true, webgpuAvailable: false, initialize });
    const { card, unmount } = draw({ settings: { coach: true, coachAt: 'device' } });
    expect(card(COACH).getByText('providers.localai.chatModelsNoGpu')).toBeTruthy();
    unmount();
    useModelStore.setState({ initialized: false });
    draw({ settings: { asrVia: 'server', translateAt: 'server', coach: false }, values: { endpoint: '192.168.1.10:8790' } });
    expect(initialize).not.toHaveBeenCalled();
  });

  it('says that an address on this computer is this computer\'s own model server', () => {
    draw({ values: { endpoint: '127.0.0.1:8080' } });
    expect(screen.getByText('providers.localai.localServerNote')).toBeTruthy();
  });

  it('says nothing of the kind for an address elsewhere, and no longer explains that the stages can be mixed', () => {
    draw({ values: { endpoint: '192.168.1.10:8080' } });
    expect(screen.queryByText('providers.localai.localServerNote')).toBeNull();
    expect(screen.queryByText('providers.localai.mixHint')).toBeNull();
  });
});

describe('the stage cards: whether it can all start', () => {
  it('says so in words, and asks again on a press', () => {
    const ready = draw({ readiness: { state: 'ready', models: [] } });
    expect(screen.getByText('providers.localai.ready')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'providers.localai.recheck' }));
    expect(ready.check).toHaveBeenCalledTimes(1);
    ready.unmount();
    const checking = draw({ readiness: { state: 'checking' } });
    expect(screen.getByText('providers.localai.checking')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'providers.localai.recheck' })).toBeNull();
    checking.unmount();
    draw({ readiness: { state: 'not-ready', reason: 'no' } });
    expect(screen.getByRole('button', { name: 'providers.localai.checkNow' })).toBeTruthy();
  });
});

describe('the stage cards: this computer\'s LocalAI', () => {
  const LOCALAI = 'providers.localai.hereLocalAI';
  /** A LocalAI installed here and up, with a pipeline, two recognizers and two text models. */
  const installed = (state: 'running' | 'stopped' = 'running') => {
    useLocalServerStore.setState({ status: { installed: true, state, port: 8085, models: state === 'running' ? ['gpt-realtime'] : [], tail: '' } });
    localai.pipes = { pipelines: [{ name: 'gpt-realtime', transcription: 'apple-speech-transcriber', llm: 'hy-mt2-1.8b' }], recognizers: ['apple-speech-transcriber', 'whisper-large-turbo'], translators: ['hy-mt2-1.8b', 'qwen3-4b'] };
  };
  const menu = (stage: string) => [...within(screen.getByRole('region', { name: stage })).getAllByRole('combobox')] as HTMLSelectElement[];
  const labels = (select: HTMLSelectElement) => [...select.options].map((o) => o.textContent);

  it('is not offered where this computer has none', () => {
    draw({ settings: { asrVia: 'device', translateAt: 'device' } });
    for (const stage of [HEAR, TRANSLATE]) for (const select of menu(stage)) expect(labels(select)).not.toContain(LOCALAI);
  });

  it('is one more entry in the model\'s own menu, for every stage placed here', async () => {
    installed();
    draw({ settings: { asrVia: 'device', translateAt: 'device', coach: true, coachAt: 'device' } });
    for (const stage of [HEAR, TRANSLATE, COACH]) expect(labels(menu(stage)[0]).pop()).toBe(LOCALAI);
  });

  it('hands the stage to it on a pick: with its address, its pipeline, and the model the pipeline names', async () => {
    installed();
    const { update } = draw({ settings: { asrVia: 'device', translateAt: 'device' } });
    // Its pipelines are asked for once it is seen to be up.
    await act(async () => {});
    const hear = menu(HEAR)[0];
    fireEvent.change(hear, { target: { value: [...hear.options].pop()!.value } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrHere: 'localai', asrHereModel: 'apple-speech-transcriber', hereAddress: '127.0.0.1:8085', herePipeline: 'gpt-realtime' }));
    const translate = menu(TRANSLATE)[0];
    fireEvent.change(translate, { target: { value: [...translate.options].pop()!.value } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateHere: 'localai', translateHereModel: 'hy-mt2-1.8b' }));
  });

  it('shows its models right under the choice, and the way back to the app\'s own', async () => {
    installed();
    const { update } = draw({ settings: { asrVia: 'device', asrHere: 'localai', asrHereModel: 'whisper-large-turbo', translateAt: 'device', translateHere: 'localai', translateHereModel: '' } });
    await act(async () => {});
    const [who, which] = menu(HEAR);
    expect(labels(who)).toEqual(['providers.localai.hereApp', LOCALAI]);
    expect(which.value).toBe('whisper-large-turbo');
    // The recognizer may be left to its pipeline; a text model has to be named.
    expect(labels(which)[0]).toBe('providers.localai.hereModelOwn');
    expect(labels(menu(TRANSLATE)[1])[0]).toBe('providers.localai.hereModelPick');
    expect([...menu(TRANSLATE)[1].options].map((o) => o.value)).toEqual(['', 'hy-mt2-1.8b', 'qwen3-4b']);
    fireEvent.change(menu(TRANSLATE)[1], { target: { value: 'qwen3-4b' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateHereModel: 'qwen3-4b' }));
    fireEvent.change(who, { target: { value: '' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrHere: 'app' }));
    // No library of the app's models under a stage the LocalAI runs.
    expect(within(screen.getByRole('region', { name: HEAR })).queryByRole('button', { name: 'providers.localai.browse' })).toBeNull();
  });

  it('is started from the card while it is down, and keeps a model it no longer lists visible', async () => {
    installed('stopped');
    const start = vi.fn(async () => {});
    useLocalServerStore.setState({ start });
    draw({ settings: { asrVia: 'device', asrHere: 'localai', asrHereModel: 'whisper-large-turbo' } });
    const hear = within(screen.getByRole('region', { name: HEAR }));
    expect(hear.getByText('providers.localai.hereStopped')).toBeTruthy();
    expect(menu(HEAR)[1].value).toBe('whisper-large-turbo');
    fireEvent.click(hear.getByRole('button', { name: 'providers.localai.hereStart' }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('says so where the settings name a LocalAI this computer does not have', () => {
    draw({ settings: { asrVia: 'device', asrHere: 'localai' } });
    const hear = within(screen.getByRole('region', { name: HEAR }));
    expect(hear.getByText('providers.localai.hereAbsent')).toBeTruthy();
    expect(hear.queryByRole('button', { name: 'providers.localai.hereStart' })).toBeNull();
  });
});
