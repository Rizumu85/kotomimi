import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Readiness } from '../../lib/provider/types';
import { useLocalServerStore } from '../../stores/localServerStore';
import { useHeardByStore } from '../../stores/heardByStore';
import { useModelStore } from '../../stores/modelStore';
import { useNativeEngineStore, useNativeTranslatorStore } from '../../stores/nativeEngineStore';
import { NO_LOCAL_SERVER } from '../../lib/lan/localServer';
import { FarSourceNote, LocalAIAssist } from './LocalAIAssist';
import { LOCALAI_DEFAULTS, type LocalAISettings } from './localai';
import { PLACE_FIELDS } from './localaiDevice';
import type { LocalAIModel } from './localaiModels';

// The catalog's keys stand for its strings.
vi.mock('react-i18next', async (importOriginal) => ({ ...(await importOriginal<typeof import('react-i18next')>()), useTranslation: () => ({ t: (key: string) => key }) }));
// The search of the network is the finder's own test: here only that it is drawn, and what a pick does.
vi.mock('../../components/LanSharing/ServerFinder', () => ({
  ServerFinder: ({ onPick, onFound, auto, hint, phone }: { onPick(server: unknown): void; onFound?(servers: unknown[]): void; auto?: boolean; hint?: string; phone?: string | string[] }) => {
    const aPhone = { address: '192.168.4.28:8792', kind: 'phone', name: 'Pixel', product: '', models: 1, needsKey: false, self: false, model: 'qwen3-asr-0.6b-q8' };
    // A phone of 0.8.0: its recognizer, two translators and the feedback model; and one that lends a translator alone.
    const lending = { ...aPhone, models: 4, text: [
      { id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', loaded: false },
      { id: 'index-translate-2b', kind: 'translate', name: 'Index-Translate 2B', loaded: false },
      { id: 'gemma-4-e2b', kind: 'coach', name: 'Gemma 4 E2B', loaded: false },
    ] };
    const textOnly = { address: '192.168.4.30:8792', kind: 'phone', name: 'F22', product: '', models: 1, needsKey: false, self: false, text: [{ id: 'hy-mt2-1.8b', kind: 'translate', name: 'Hunyuan MT 2 1.8B', loaded: true }] };
    return (
      <>
        <button type="button" data-auto={String(Boolean(auto))} data-hint={hint} data-phone={[phone ?? []].flat().join(' ')} onClick={() => onPick({ address: '192.168.1.9:8790', kind: 'kotomimi', name: 'DESK', product: '', models: 2, needsKey: true, self: false })}>finder</button>
        <button type="button" onClick={() => onFound?.([aPhone])}>a search that finds a phone</button>
        <button type="button" onClick={() => onPick(aPhone)}>the phone, picked</button>
        <button type="button" onClick={() => onFound?.([lending, textOnly])}>a search that finds phones lending text models</button>
        <button type="button" onClick={() => onPick(lending)}>the lending phone, picked</button>
        <button type="button" onClick={() => onPick(textOnly)}>the text phone, picked</button>
      </>
    );
  },
}));
// The library is Local Inference's own, tested beside it: here only which one opens. Its card is the real one: the chat models are drawn with it.
vi.mock('../../components/Settings/sections/ModelManagementSection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../components/Settings/sections/ModelManagementSection')>()),
  ModelManagementSection: ({ stageFilter, direction }: { stageFilter?: string; direction?: string }) => <div data-testid="library">{`${stageFilter}:${direction}`}</div>,
}));
vi.mock('../../components/CustomModels/CustomModels', () => ({ CustomModels: () => null }));
// The keys the built-in providers keep, by their settings prefix.
const saved = vi.hoisted(() => ({ keys: {} as Record<string, string> }));
vi.mock('./apiServiceKey', () => ({ savedKeyOf: async (prefix: string) => saved.keys[prefix] ?? '' }));
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

interface Drawn { settings?: Partial<LocalAISettings>; values?: Record<string, string>; models?: LocalAIModel[]; readiness?: Readiness; legs?: Array<'speaker' | 'participant'> }

function draw({ settings = {}, values = { endpoint: '' }, models = [], readiness = { state: 'unknown' }, legs = ['speaker'] }: Drawn = {}) {
  const update = vi.fn();
  const fill = vi.fn();
  const set = vi.fn();
  const check = vi.fn();
  const view = render(
    <LocalAIAssist settings={{ ...LOCALAI_DEFAULTS, ...settings }} values={values} set={set} fill={fill} update={update} pair={{ source: 'zh-CN', target: 'ja' }} legs={legs} models={models} readiness={readiness} check={check} />,
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
  saved.keys = {};
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
  it('says beside the model what the device hears with now, where it is not simply the one chosen', () => {
    useHeardByStore.setState({ byLeg: { speaker: 'qwen3-asr-1.7b-q8' } });
    const left = draw({ values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    expect(left.card(HEAR).getByText('providers.localai.inUse')).toBeTruthy();
    left.unmount();
    useHeardByStore.setState({ byLeg: { speaker: 'whisper-large-turbo' } });
    const chosen = draw({ settings: { asrModel: 'whisper-large-turbo' }, values: { endpoint: '192.168.1.10:8080' }, models: LISTED });
    expect(chosen.card(HEAR).queryByText('providers.localai.inUse')).toBeNull();
    chosen.unmount();
    useHeardByStore.setState({ byLeg: {} });
  });

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

describe('the stage cards: an API chosen by its service', () => {
  const SERVICE = 'providers.localai.apiService';
  const names = (select: HTMLElement) => [...(select as HTMLSelectElement).options].map((o) => o.textContent);

  it('offers each stage the services that serve it, and a custom address last', () => {
    const { card } = draw({ settings: { asrVia: 'api', translateAt: 'api' } });
    expect(names(card(HEAR).getByRole('combobox', { name: SERVICE }))).toEqual(['OpenAI', 'Groq', 'providers.localai.apiServiceSiliconFlow', 'providers.localai.apiServiceCustom']);
    expect(names(card(TRANSLATE).getByRole('combobox', { name: SERVICE }))).toEqual(['OpenAI', 'Google Gemini', 'providers.localai.apiServiceArk', 'DeepSeek', 'Groq', 'providers.localai.apiServiceSiliconFlow', 'OpenRouter', 'providers.localai.apiServiceOllama', 'providers.localai.apiServiceCustom']);
    // Nothing chosen yet is a custom address: the fields as they were.
    expect((card(TRANSLATE).getByRole('combobox', { name: SERVICE }) as HTMLSelectElement).value).toBe('custom');
    expect(card(TRANSLATE).getByRole('textbox', { name: 'providers.localai.asrApiBaseUrl' })).toBeTruthy();
  });

  it('fills the address and whether a key is wanted on a pick, and no longer asks for either', () => {
    const { card, update, set } = draw({ settings: { translateAt: 'api', translateNeedsKey: false } });
    fireEvent.change(card(TRANSLATE).getByRole('combobox', { name: SERVICE }), { target: { value: 'deepseek' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateBaseUrl: 'https://api.deepseek.com/v1', translateNeedsKey: true, translateModel: '' }));
    // The key that was in the field was another address's: it is sent to no other.
    expect(set).toHaveBeenLastCalledWith('translateKey', '');
    // Ollama on this computer wants none.
    fireEvent.change(card(TRANSLATE).getByRole('combobox', { name: SERVICE }), { target: { value: 'ollama' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateBaseUrl: 'http://localhost:11434/v1', translateNeedsKey: false }));
  });

  it('shows the service of an address already set, with its address and the key question out of the way', () => {
    const { card } = draw({ settings: { translateAt: 'api', translateBaseUrl: 'https://api.openai.com/v1/', translateModel: 'gpt-5.4-mini', translateNeedsKey: true }, values: { endpoint: '', translateKey: 'sk-1' } });
    const translate = card(TRANSLATE);
    expect((translate.getByRole('combobox', { name: SERVICE }) as HTMLSelectElement).value).toBe('openai');
    expect(translate.queryByRole('textbox', { name: 'providers.localai.asrApiBaseUrl' })).toBeNull();
    expect(translate.queryByRole('switch', { name: 'providers.localai.asrApiNeedsKey' })).toBeNull();
    expect(translate.queryByText('providers.localai.asrApiNeedsKey')).toBeNull();
    expect(translate.getByLabelText('providers.localai.apiKey', { selector: 'input' })).toBeTruthy();
  });

  it('goes back to an address typed by hand on "custom": the address and the model are emptied', () => {
    const { card, update } = draw({ settings: { translateAt: 'api', translateBaseUrl: 'https://api.openai.com/v1', translateModel: 'gpt-5.4-mini' } });
    fireEvent.change(card(TRANSLATE).getByRole('combobox', { name: SERVICE }), { target: { value: 'custom' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateBaseUrl: '', translateModel: '' }));
  });

  it('names the model by itself from what the service lists: the one that suits the stage', () => {
    const models: LocalAIModel[] = [
      { id: 'gpt-5.5', kind: 'text', from: 'translate' },
      { id: 'gpt-5.4-mini', kind: 'text', from: 'translate' },
      { id: 'gpt-4.1-mini', kind: 'text', from: 'translate' },
      { id: 'whisper-1', kind: 'asr', from: 'asr' },
      { id: 'gpt-4o-mini-transcribe', kind: 'asr', from: 'asr' },
    ];
    const { update } = draw({ settings: { asrVia: 'api', asrApiBaseUrl: 'https://api.openai.com/v1', translateAt: 'api', translateBaseUrl: 'https://api.openai.com/v1' }, models });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ translateModel: 'gpt-5.4-mini' }));
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ asrApiModel: 'gpt-4o-mini-transcribe' }));
  });

  it('leaves a model that is named alone, and one of a custom address to the user', () => {
    const models: LocalAIModel[] = [{ id: 'gpt-5.4-mini', kind: 'text', from: 'translate' }];
    expect(draw({ settings: { translateAt: 'api', translateBaseUrl: 'https://api.openai.com/v1', translateModel: 'gpt-5.5' }, models }).update).not.toHaveBeenCalled();
    expect(draw({ settings: { translateAt: 'api', translateBaseUrl: 'https://api.example.com/v1' }, models }).update).not.toHaveBeenCalled();
  });

  it('does not fill the model in under the user\'s hands: only once the field is left', () => {
    const models: LocalAIModel[] = [{ id: 'gpt-5.4-mini', kind: 'text', from: 'translate' }];
    const settings = { ...LOCALAI_DEFAULTS, translateAt: 'api' as const, translateBaseUrl: 'https://api.openai.com/v1', translateModel: 'gpt-5.5' };
    const update = vi.fn();
    const props = { values: { endpoint: '' }, set: vi.fn(), fill: vi.fn(), update, pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker' as const], models, readiness: { state: 'unknown' } as Readiness, check: vi.fn() };
    const view = render(<LocalAIAssist settings={settings} {...props} />);
    const field = within(screen.getByRole('region', { name: TRANSLATE })).getByRole('combobox', { name: 'providers.localai.model' });
    fireEvent.focus(field);
    // Emptied while typing: nothing is written for the user.
    view.rerender(<LocalAIAssist settings={{ ...settings, translateModel: '' }} {...props} />);
    expect(update).not.toHaveBeenCalled();
    fireEvent.blur(field);
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateModel: 'gpt-5.4-mini' }));
  });

  it('takes the key from another stage that already uses the same service', () => {
    const { card, set } = draw({ settings: { translateAt: 'api', translateBaseUrl: 'https://api.groq.com/openai/v1', translateNeedsKey: true, asrVia: 'api' }, values: { endpoint: '', translateKey: 'gsk-1', asrKey: '' } });
    fireEvent.change(card(HEAR).getByRole('combobox', { name: SERVICE }), { target: { value: 'groq' } });
    expect(set).toHaveBeenLastCalledWith('asrKey', 'gsk-1');
  });

  it('takes the key the built-in provider of that service keeps, and says where it came from', async () => {
    saved.keys = { gemini: 'AIza-1' };
    const settings = { ...LOCALAI_DEFAULTS, translateAt: 'api' as const };
    const set = vi.fn();
    const props = { set, fill: vi.fn(), update: vi.fn(), pair: { source: 'zh-CN', target: 'ja' }, legs: ['speaker' as const], models: [], readiness: { state: 'unknown' } as Readiness, check: vi.fn() };
    const view = render(<LocalAIAssist settings={settings} values={{ endpoint: '', translateKey: '' }} {...props} />);
    fireEvent.change(within(screen.getByRole('region', { name: TRANSLATE })).getByRole('combobox', { name: SERVICE }), { target: { value: 'gemini' } });
    await waitFor(() => expect(set).toHaveBeenLastCalledWith('translateKey', 'AIza-1'));
    view.rerender(<LocalAIAssist settings={{ ...settings, translateBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', translateNeedsKey: true }} values={{ endpoint: '', translateKey: 'AIza-1' }} {...props} />);
    expect(screen.getByText('providers.localai.apiKeyReused')).toBeTruthy();
    // A service with no built-in provider, or none saved: the field is left empty to be typed in.
    set.mockClear();
    fireEvent.change(within(screen.getByRole('region', { name: TRANSLATE })).getByRole('combobox', { name: SERVICE }), { target: { value: 'openai' } });
    await act(async () => { await Promise.resolve(); });
    expect(set).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenLastCalledWith('translateKey', '');
  });
});

describe('the stage cards: on this computer', () => {
  it('says "not chosen" where a model of the engine is downloaded and nothing hears yet, and "not downloaded" only where nothing is', () => {
    const before = useNativeEngineStore.getState().status;
    try {
      useNativeEngineStore.setState({ status: { supported: true, engine: 'ready', engineBytes: 1, models: { 'qwen3-asr-1.7b-q8': { state: 'downloaded', received: 1, total: 1 } }, run: { state: 'stopped', model: null, port: 0, tail: '' }, up: [] } });
      const { card } = draw({ settings: { asrVia: 'device', translateAt: 'device' } });
      const menu = card(HEAR).getByRole('combobox') as HTMLSelectElement;
      expect(menu.options[0].textContent).toBe('providers.localai.nativeNone');
      // The engine's model, under the engine's own group and by its own name.
      // No model of the app's own is downloaded, so its group has nothing to offer and is not drawn.
      expect([...menu.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['providers.localai.groupNative']);
      expect([...menu.querySelectorAll('optgroup')[0].querySelectorAll('option')].map((o) => o.textContent)).toEqual(['Qwen3-ASR 1.7B GGUF']);
    } finally {
      useNativeEngineStore.setState({ status: before });
    }
  });


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
    expect(labels(who)).toEqual(['providers.localai.appAuto', LOCALAI]);
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

describe('the other device’s recognizers in the menu', () => {
  /** A Mac sharing: the system’s recognition for three languages, and a downloaded recognizer that hears many. */
  const MAC_MODELS = [
    { id: 'kotomimi', kind: 'pipeline', host: 'kotomimi' },
    { id: 'apple-speech:ja', kind: 'asr', host: 'kotomimi', languages: ['ja'] },
    { id: 'apple-speech:zh', kind: 'asr', host: 'kotomimi', languages: ['zh'] },
    { id: 'apple-speech:ko', kind: 'asr', host: 'kotomimi', languages: ['ko'] },
    { id: 'qwen3-asr-1.7b-q8', kind: 'asr', host: 'kotomimi', languages: ['ja', 'zh', 'en'] },
    { id: 'kotoba-whisper', kind: 'asr', host: 'kotomimi', languages: ['ja'] },
  ] as never;
  const menu = (card: ReturnType<typeof draw>['card']) => card(HEAR).getByRole('combobox', { name: 'providers.localai.model' }) as HTMLSelectElement;

  it('shows a recognizer that is one to a language once, and nothing that hears no language of this run', () => {
    // Chinese is heard (the pair of these tests): Korean’s recognition and the Japanese-only model are not offered.
    const { card } = draw({ settings: { asrVia: 'server' }, values: { endpoint: '192.168.1.10:8790' }, models: MAC_MODELS });
    expect(options(menu(card))).toEqual(['', 'apple-speech', 'qwen3-asr-1.7b-q8']);
    expect([...menu(card).options].map((o) => o.textContent)).toEqual(['providers.localai.deviceDefault', 'Apple Speech', expect.any(String)]);
  });

  it('shows a choice saved as one member of the family as the family, and stores the family', () => {
    const { card, update } = draw({ settings: { asrVia: 'server', asrModel: 'apple-speech:ja' }, values: { endpoint: '192.168.1.10:8790' }, models: MAC_MODELS });
    expect(menu(card).value).toBe('apple-speech');
    fireEvent.change(menu(card), { target: { value: 'qwen3-asr-1.7b-q8' } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ asrModel: 'qwen3-asr-1.7b-q8' }));
  });

  it('says of a saved model the device no longer has that it is gone', () => {
    const { card } = draw({ settings: { asrVia: 'server', asrModel: 'apple-speech-transcriber' }, values: { endpoint: '192.168.1.10:8790' }, models: MAC_MODELS });
    expect(menu(card).value).toBe('apple-speech-transcriber');
    expect(menu(card).selectedOptions[0].textContent).toBe('providers.localai.modelGone');
  });
});

describe('one menu for a stage of this computer, whoever runs it', () => {
  const engineOf = (models: Record<string, 'downloaded' | 'absent'>, run: { state: string; model: string | null } = { state: 'stopped', model: null }) => ({
    supported: true, engine: 'ready', engineBytes: 1,
    models: Object.fromEntries(Object.entries(models).map(([id, state]) => [id, { state, received: state === 'downloaded' ? 1 : 0, total: 1 }])),
    run: { ...run, port: 0, tail: '' }, up: [],
  }) as never;
  const groups = (select: HTMLSelectElement) => [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.textContent)]);
  let before: { asr: unknown; translation: unknown };
  beforeEach(() => {
    before = { asr: useNativeEngineStore.getState().status, translation: useNativeTranslatorStore.getState().status };
    useNativeEngineStore.setState({ status: engineOf({ 'qwen3-asr-1.7b-q8': 'downloaded' }) });
    useNativeTranslatorStore.setState({ status: engineOf({ 'index-translate-2b': 'downloaded', 'hy-mt2-1.8b': 'downloaded' }) });
  });
  afterEach(() => {
    useNativeEngineStore.setState({ status: before.asr as never });
    useNativeTranslatorStore.setState({ status: before.translation as never });
  });

  it('lists the same choices while a native engine translates as while the app’s own model does', () => {
    const app = draw({ settings: { translateAt: 'device', translateHere: 'app' } });
    const whileApp = groups(app.card(TRANSLATE).getByRole('combobox') as HTMLSelectElement);
    app.unmount();
    const native = draw({ settings: { translateAt: 'device', translateHere: 'native', translateNativeModel: 'index-translate-2b' } });
    const menu = native.card(TRANSLATE).getByRole('combobox') as HTMLSelectElement;
    // The engine's models under their own heading, by their own names; the app's own under theirs; nothing else.
    expect(groups(menu)).toEqual(whileApp);
    expect(groups(menu)[0]).toEqual(['providers.localai.groupNative', ['Index-Translate 2B', 'Hunyuan MT 2 1.8B']]);
    expect(groups(menu)[1][0]).toBe('providers.localai.groupApp');
    // What is in use is what the menu shows.
    expect(menu.selectedOptions[0].textContent).toBe('Index-Translate 2B');
  });

  it('hands the stage back to the app’s own models when one of them is chosen, and to another of the engine’s when that is', () => {
    const { card, update } = draw({ settings: { translateAt: 'device', translateHere: 'native', translateNativeModel: 'index-translate-2b' } });
    const menu = card(TRANSLATE).getByRole('combobox') as HTMLSelectElement;
    fireEvent.change(menu, { target: { value: '' } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ translateHere: 'app' }));
    const other = [...menu.options].find((o) => o.textContent === 'Hunyuan MT 2 1.8B')!;
    fireEvent.change(menu, { target: { value: other.value } });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ translateHere: 'native', translateNativeModel: 'hy-mt2-1.8b' }));
  });

  it('keeps the library shut for a model that is chosen and here, and opens it for one that is not', () => {
    const here = draw({ settings: { translateAt: 'device', translateHere: 'native', translateNativeModel: 'index-translate-2b' } });
    expect(here.card(TRANSLATE).getByRole('button', { name: 'providers.localai.browse' }).getAttribute('aria-expanded')).toBe('false');
    expect(here.container.querySelector('.kt-here__library')).toBeNull();
    // By its button, as the app’s own library opens.
    fireEvent.click(here.card(TRANSLATE).getByRole('button', { name: 'providers.localai.browse' }));
    expect(here.container.querySelector('.kt-here__library')).not.toBeNull();
    here.unmount();
    useNativeTranslatorStore.setState({ status: engineOf({ 'index-translate-2b': 'absent', 'hy-mt2-1.8b': 'downloaded' }) });
    const gone = draw({ settings: { translateAt: 'device', translateHere: 'native', translateNativeModel: 'index-translate-2b' } });
    expect(gone.card(TRANSLATE).getByRole('button', { name: 'providers.localai.browse' }).getAttribute('aria-expanded')).toBe('true');
    // Still what the menu shows: the choice is not silently another.
    expect((gone.card(TRANSLATE).getByRole('combobox') as HTMLSelectElement).selectedOptions[0].textContent).toBe('Index-Translate 2B');
  });

  it('hears by the engine in the same row, with the same button', () => {
    const { card } = draw({ settings: { asrVia: 'device', asrHere: 'native', asrNativeModel: 'qwen3-asr-1.7b-q8', translateAt: 'device' } });
    const menu = card(HEAR).getByRole('combobox') as HTMLSelectElement;
    expect(menu.selectedOptions[0].textContent).toBe('Qwen3-ASR 1.7B GGUF');
    expect(groups(menu)[0]).toEqual(['providers.localai.groupNative', ['Qwen3-ASR 1.7B GGUF']]);
    expect(card(HEAR).getByRole('button', { name: 'providers.localai.browse' }).getAttribute('aria-expanded')).toBe('false');
  });

  /** The engine's cards in the library that is open, in the order drawn, and which of them carry the mark. */
  const cards = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('.kt-here__native [data-testid^="model-card-native:"]')]
    .map((one) => `${one.dataset.testid!.slice('model-card-native:'.length)}${one.querySelector('.model-card__recommended-badge') ? ' ★' : ''}`);
  const EVERY = { 'qwen3-asr-1.7b-q8': 'absent', 'r2t2-q8': 'absent', 'sensevoice-small-q8': 'absent', 'qwen3-asr-0.6b-q8': 'absent', 'nemotron-asr-0.6b-q8': 'absent' } as const;
  const hearing = (pair: { source: string; target: string }, chosen = 'qwen3-asr-1.7b-q8') => render(
    <LocalAIAssist settings={{ ...LOCALAI_DEFAULTS, asrVia: 'device', asrHere: 'native', asrNativeModel: chosen, translateAt: 'device' }} values={{ endpoint: '' }} set={vi.fn()} fill={vi.fn()} update={vi.fn()} pair={pair} legs={['speaker']} models={[]} readiness={{ state: 'unknown' }} check={vi.fn()} />,
  );

  it('offers SenseVoice-Small among the engine’s models for the five languages it hears: after the more accurate ones, before the small Qwen3, and never with the mark', () => {
    // Windows: every model of the engine the app downloads, R2T2 among them. None is here yet, so the library is open.
    useNativeEngineStore.setState({ status: engineOf(EVERY) });
    for (const source of ['ja', 'zh-CN', 'en', 'ko']) {
      const view = hearing({ source, target: 'ru' });
      expect(cards(view.container), source).toEqual(['qwen3-asr-1.7b-q8 ★', 'r2t2-q8', 'sensevoice-small-q8', 'qwen3-asr-0.6b-q8', 'nemotron-asr-0.6b-q8']);
      view.unmount();
    }
    // Cantonese: R2T2 and Nemotron do not hear it.
    const cantonese = hearing({ source: 'yue', target: 'en' });
    expect(cards(cantonese.container)).toEqual(['qwen3-asr-1.7b-q8 ★', 'sensevoice-small-q8', 'qwen3-asr-0.6b-q8']);
    cantonese.unmount();
    // A language it does not hear has no card of it.
    const russian = hearing({ source: 'ru', target: 'zh-CN' });
    expect(cards(russian.container)).toEqual(['qwen3-asr-1.7b-q8 ★', 'r2t2-q8', 'qwen3-asr-0.6b-q8', 'nemotron-asr-0.6b-q8']);
    russian.unmount();
    // One only the last model hears: that one alone, and so the one marked.
    const ukrainian = hearing({ source: 'uk', target: 'zh-CN' }, 'nemotron-asr-0.6b-q8');
    expect(cards(ukrainian.container)).toEqual(['nemotron-asr-0.6b-q8 ★']);
  });

  it('offers it on a Mac too, after the system’s own recognition and Qwen3-ASR 1.7B: the system’s is the one marked for each of its five languages', () => {
    // A Mac: the system's recognition, a model to a language, and the engine's models but R2T2, which names Windows alone.
    const MAC = { 'apple-speech:ja': 'absent', 'apple-speech:zh': 'absent', 'apple-speech:en': 'absent', 'apple-speech:ko': 'absent', 'apple-speech:yue': 'absent', 'qwen3-asr-1.7b-q8': 'absent', 'sensevoice-small-q8': 'absent', 'qwen3-asr-0.6b-q8': 'absent', 'nemotron-asr-0.6b-q8': 'absent' } as const;
    useNativeEngineStore.setState({ status: engineOf(MAC) });
    for (const [source, own] of [['ja', 'ja'], ['zh-CN', 'zh'], ['en', 'en'], ['ko', 'ko']] as const) {
      const view = hearing({ source, target: 'ru' });
      expect(cards(view.container), source).toEqual([`apple-speech:${own} ★`, 'qwen3-asr-1.7b-q8', 'sensevoice-small-q8', 'qwen3-asr-0.6b-q8', 'nemotron-asr-0.6b-q8']);
      view.unmount();
    }
    // Cantonese: Nemotron does not hear it.
    const cantonese = hearing({ source: 'yue', target: 'en' });
    expect(cards(cantonese.container)).toEqual(['apple-speech:yue ★', 'qwen3-asr-1.7b-q8', 'sensevoice-small-q8', 'qwen3-asr-0.6b-q8']);
    cantonese.unmount();
    // A language neither the system nor it hears: Qwen3-ASR's, as before.
    const russian = hearing({ source: 'ru', target: 'zh-CN' });
    expect(cards(russian.container)).toEqual(['qwen3-asr-1.7b-q8 ★', 'qwen3-asr-0.6b-q8', 'nemotron-asr-0.6b-q8']);
    russian.unmount();
    // A Mac whose system has no such recognition (before macOS 26): the engine's models alone, in their order.
    useNativeEngineStore.setState({ status: engineOf({ 'qwen3-asr-1.7b-q8': 'absent', 'sensevoice-small-q8': 'absent', 'qwen3-asr-0.6b-q8': 'absent', 'nemotron-asr-0.6b-q8': 'absent' }) });
    const older = hearing({ source: 'ja', target: 'zh-CN' });
    expect(cards(older.container)).toEqual(['qwen3-asr-1.7b-q8 ★', 'sensevoice-small-q8', 'qwen3-asr-0.6b-q8', 'nemotron-asr-0.6b-q8']);
  });

  it('has no card of a model the engine of this system does not list', () => {
    useNativeEngineStore.setState({ status: engineOf({ 'qwen3-asr-1.7b-q8': 'absent', 'qwen3-asr-0.6b-q8': 'absent' }) });
    const japanese = hearing({ source: 'ja', target: 'zh-CN' });
    expect(cards(japanese.container)).toEqual(['qwen3-asr-1.7b-q8 ★', 'qwen3-asr-0.6b-q8']);
  });

  it('lists it in a row’s menu once it is downloaded, for a language it hears and for no other', () => {
    useNativeEngineStore.setState({ status: engineOf({ ...EVERY, 'qwen3-asr-1.7b-q8': 'downloaded', 'sensevoice-small-q8': 'downloaded' }) });
    const japanese = hearing({ source: 'ja', target: 'ru' }, 'sensevoice-small-q8');
    const menu = within(screen.getByRole('region', { name: HEAR })).getByRole('combobox') as HTMLSelectElement;
    expect(menu.selectedOptions[0].textContent).toBe('SenseVoice-Small GGUF');
    expect(groups(menu)[0]).toEqual(['providers.localai.groupNative', ['Qwen3-ASR 1.7B GGUF', 'SenseVoice-Small GGUF']]);
    japanese.unmount();
    // Russian is not one of its five: the row has no model chosen, says so, and offers the one that hears it.
    hearing({ source: 'ru', target: 'ja' }, 'sensevoice-small-q8');
    const other = within(screen.getByRole('region', { name: HEAR })).getByRole('combobox') as HTMLSelectElement;
    expect(other.selectedOptions[0].textContent).toBe('Qwen3-ASR 1.7B GGUF');
    expect(groups(other)[0]).toEqual(['providers.localai.groupNative', ['Qwen3-ASR 1.7B GGUF']]);
    // Taken down before the engine's state is put back: the row would then have no model, in words this test's stand-in for the catalog does not have.
    cleanup();
  });
});

describe('the SenseVoice that runs in the page, which writes Japanese without its kana', () => {
  const groups = (select: HTMLSelectElement) => [...select.querySelectorAll('optgroup')].map((g) => [g.label, [...g.querySelectorAll('option')].map((o) => o.value)]);
  const KEPT = { 'ja→zh': { asr: { modelId: 'sensevoice-int8' }, translation: { modelId: '' }, tts: { modelId: '' } } };
  // The other side speaks Japanese: the participant's row is the one that hears it.
  const row = (selections = {}) => {
    const { card } = draw({ settings: { asrVia: 'device', translateAt: 'device', selections }, legs: ['participant'] });
    return card(HEAR).getByRole('combobox') as HTMLSelectElement;
  };

  it('is not what hears Japanese by itself, nor in the row’s menu, though it is downloaded for its Chinese', () => {
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'sensevoice-nano-int8': 'downloaded' } });
    const menu = row();
    // Nothing here hears Japanese: said as that, and the library opens on it.
    expect(menu.selectedOptions[0].textContent).toBe('providers.localai.notDownloaded');
    expect(menu.className).toContain('kt-here__select--missing');
    expect(groups(menu)).toEqual([]);
    expect(screen.getByTestId('library').textContent).toBe('asr:ja→zh');
  });

  it('is still the one that hears where it was chosen before, and the menu says so: the model is never silently another', () => {
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'moonshine-tiny-ja-quant': 'downloaded' } });
    const menu = row(KEPT);
    expect(menu.value).toBe('sensevoice-int8');
    expect(menu.selectedOptions[0].textContent).toContain('SenseVoice');
    expect(menu.className).not.toContain('kt-here__select--missing');
    // The automatic choice beside it is the other recognizer, never this one.
    expect(groups(menu)).toEqual([['providers.localai.groupApp', ['', 'sensevoice-int8', 'moonshine-tiny-ja-quant']]]);
    cleanup();
    // Also with nothing else downloaded: it hears, and nothing is said to be missing.
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded' } });
    const alone = row(KEPT);
    expect(alone.value).toBe('sensevoice-int8');
    expect(alone.className).not.toContain('kt-here__select--missing');
    expect(screen.queryByTestId('library')).toBeNull();
    cleanup();
    // Chosen away from, it is no longer offered for the language.
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'moonshine-tiny-ja-quant': 'downloaded' } });
    expect(groups(row())).toEqual([['providers.localai.groupApp', ['']]]);
  });

  it('hears Chinese as ever', () => {
    useModelStore.setState({ modelStatuses: { 'sensevoice-int8': 'downloaded', 'moonshine-tiny-ja-quant': 'downloaded' } });
    const { card } = draw({ settings: { asrVia: 'device', translateAt: 'device' }, legs: ['speaker'] });
    const menu = card(HEAR).getByRole('combobox') as HTMLSelectElement;
    expect(menu.selectedOptions[0].textContent).toBe('providers.localai.auto');
    expect(menu.className).not.toContain('kt-here__select--missing');
  });
});

describe('the other side\u2019s language left to be detected', () => {
  const engineOf = (models: Record<string, 'downloaded' | 'absent'>) => ({
    supported: true, engine: 'ready', engineBytes: 1,
    models: Object.fromEntries(Object.entries(models).map(([id, state]) => [id, { state, received: state === 'downloaded' ? 1 : 0, total: 1 }])),
    run: { state: 'stopped', model: null, port: 0, tail: '' }, up: [],
  }) as never;
  const BOTH: Array<'speaker' | 'participant'> = ['speaker', 'participant'];
  let before: unknown;
  beforeEach(() => { before = useNativeEngineStore.getState().status; });
  afterEach(() => { useNativeEngineStore.setState({ status: before as never }); });

  it('gives the other side\u2019s row a model that can tell languages apart, by itself, and still lists the ones that cannot: chosen, the detection ends', () => {
    useNativeEngineStore.setState({ status: engineOf({ 'r2t2-q8': 'downloaded', 'qwen3-asr-1.7b-q8': 'downloaded' }) });
    // Japanese is heard by R2T2, which tells no language; the other side is whatever it turns out to be.
    const { card, update } = draw({ settings: { asrVia: 'device', asrHere: 'native', asrNativeModel: 'r2t2-q8', asrDetectOther: true, translateAt: 'device' }, legs: BOTH });
    const menus = card(HEAR).getAllByRole('combobox') as HTMLSelectElement[];
    const other = menus.find((m) => m.getAttribute('aria-label') === 'providers.localai.hearsOther')!;
    expect(other.selectedOptions[0].textContent).toBe('Qwen3-ASR 1.7B GGUF');
    // Every model downloaded that hears the pair's language is there to choose.
    expect([...other.querySelectorAll('optgroup')[0].querySelectorAll('option')].map((o) => o.textContent).sort()).toEqual(['Confucius4 R2T2 GGUF', 'Qwen3-ASR 1.7B GGUF']);
    // The app's own models tell no language: that row lists none of them.
    expect([...other.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['providers.localai.groupNative']);
    // And while the other side's language is detected, the same model hears the user's own (the engine runs one at
    // a time): its row shows that model.
    const named = menus.find((m) => m !== other)!;
    expect(named.selectedOptions[0].textContent).toBe('Qwen3-ASR 1.7B GGUF');
    // No switch in the card: the choice is made among the languages. What it takes is said here.
    expect(card(HEAR).queryByText('providers.localai.detectOther')).toBeNull();
    expect(card(HEAR).getByText('providers.localai.detectOtherNote')).toBeTruthy();
    // R2T2 chosen for the other side: it is heard in the pair's language, by R2T2, and no longer detected.
    fireEvent.change(other, { target: { value: '\u0000native:r2t2-q8' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrHere: 'native', asrNativeModel: 'r2t2-q8', asrDetectOther: false, asrNativeByLanguage: expect.objectContaining({ ja: 'r2t2-q8' }) }));
  });

  it('ends the user\'s own detection — speaking either language — when a model that cannot detect is chosen for them', () => {
    useNativeEngineStore.setState({ status: engineOf({ 'r2t2-q8': 'downloaded', 'qwen3-asr-1.7b-q8': 'downloaded' }) });
    const { card, update } = draw({ settings: { asrVia: 'device', asrHere: 'native', asrNativeModel: 'qwen3-asr-1.7b-q8', speakBoth: true, translateAt: 'device' }, legs: BOTH });
    const menus = card(HEAR).getAllByRole('combobox') as HTMLSelectElement[];
    expect(menus.map((m) => m.getAttribute('aria-label'))).toEqual(['providers.localai.hearsEither', 'providers.localai.hears']);
    fireEvent.change(menus[0], { target: { value: '\u0000native:r2t2-q8' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrHere: 'native', speakBoth: false, asrNativeByLanguage: expect.objectContaining({ zh: 'r2t2-q8' }) }));
    expect(update.mock.calls[update.mock.calls.length - 1][0]).not.toHaveProperty('asrDetectOther');
  });

  it('ends the detection, kept from before, when a model that cannot detect is what makes the engine hear', () => {
    useNativeEngineStore.setState({ status: engineOf({ 'r2t2-q8': 'downloaded', 'qwen3-asr-1.7b-q8': 'downloaded' }) });
    const { card, update } = draw({ settings: { asrVia: 'device', asrHere: 'app', asrDetectOther: true, translateAt: 'device' }, legs: BOTH });
    const menus = card(HEAR).getAllByRole('combobox') as HTMLSelectElement[];
    // The app's models hear: the other side is heard in Japanese, its row the second.
    fireEvent.change(menus[1], { target: { value: '\u0000native:r2t2-q8' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrHere: 'native', asrDetectOther: false }));
  });

  it('says a model has to be downloaded only where none here can tell languages apart', () => {
    useNativeEngineStore.setState({ status: engineOf({ 'r2t2-q8': 'downloaded' }) });
    const { card } = draw({ settings: { asrVia: 'device', asrHere: 'native', asrNativeModel: 'r2t2-q8', asrDetectOther: true, translateAt: 'device' }, legs: BOTH });
    const other = (card(HEAR).getAllByRole('combobox') as HTMLSelectElement[]).find((m) => m.getAttribute('aria-label') === 'providers.localai.hearsOther')!;
    expect(other.selectedOptions[0].textContent).toBe('providers.localai.nativeNone');
    expect(card(HEAR).getByText('providers.localai.detectOtherNeeds')).toBeTruthy();
  });

  it('says nothing of it while only the microphone is heard', () => {
    useNativeEngineStore.setState({ status: engineOf({ 'qwen3-asr-1.7b-q8': 'downloaded' }) });
    const { card } = draw({ settings: { asrVia: 'device', asrHere: 'native', asrNativeModel: 'qwen3-asr-1.7b-q8', asrDetectOther: true, translateAt: 'device' }, legs: ['speaker'] });
    expect(card(HEAR).queryByText('providers.localai.detectOtherNote')).toBeNull();
    expect(card(HEAR).queryByRole('combobox', { name: 'providers.localai.hearsOther' })).toBeNull();
  });
});

describe('the app\'s own models, where their source is far', () => {
  it('says what to expect of a download there, and that the models above are another matter', () => {
    const { rerender } = render(<FarSourceNote rest far />);
    expect(screen.getByRole('note').textContent).toBe('providers.localai.farSourceRest');
    // With no native model above, nothing is said of one.
    rerender(<FarSourceNote rest={false} far />);
    expect(screen.getByRole('note').textContent).toBe('providers.localai.farSource');
  });

  it('says nothing anywhere else', () => {
    render(<FarSourceNote rest far={false} />);
    expect(screen.queryByRole('note')).toBeNull();
  });
});

describe('a phone that lends its recognition: the "another device" of the hearing stage alone', () => {
  const PHONE = { asrVia: 'server' as const, asrOther: '192.168.4.28:8792', asrOtherModel: 'qwen3-asr-0.6b-q8' };

  it('is chosen by a pick in the search: the stage is on another device, that one, and nothing is typed', () => {
    const { update, fill } = draw({ settings: { asrVia: 'device' } });
    fireEvent.click(screen.getByText('the phone, picked'));
    expect(update).toHaveBeenCalledWith(expect.objectContaining(PHONE));
    // It is not the device the other stages share.
    expect(fill).not.toHaveBeenCalled();
  });

  it('shows as "another device" with the model it lends, and asks for no address of the shared one', () => {
    const { card, places } = draw({ settings: { ...PHONE, translateAt: 'device' } });
    expect(pressed(places(HEAR))).toBe('providers.localai.placeServer');
    const device = card(HEAR).getByRole('combobox', { name: 'providers.localai.stageDevice' }) as HTMLSelectElement;
    expect(device.value).toBe('192.168.4.28:8792');
    expect((card(HEAR).getByRole('combobox', { name: 'providers.localai.model' }) as HTMLSelectElement).selectedOptions[0].textContent).toContain('Qwen3-ASR 0.6B');
    expect(card(HEAR).queryByText('providers.localai.connectFirst')).toBeNull();
    // The search marks it as the one recognition is asked of.
    expect(screen.getByText('finder').getAttribute('data-phone')).toBe('192.168.4.28:8792');
  });

  it('is offered beside the shared device once a search has found it, and either can be chosen there', () => {
    const { card, update } = draw({ settings: { asrVia: 'server' }, values: { endpoint: '192.168.1.9:8790' } });
    // One device to hear on: nothing to choose among.
    expect(card(HEAR).queryByRole('combobox', { name: 'providers.localai.stageDevice' })).toBeNull();
    fireEvent.click(screen.getByText('a search that finds a phone'));
    const device = card(HEAR).getByRole('combobox', { name: 'providers.localai.stageDevice' }) as HTMLSelectElement;
    expect(options(device)).toEqual(['', '192.168.4.28:8792']);
    expect(device.options[0].textContent).toBe('192.168.1.9:8790');
    fireEvent.change(device, { target: { value: '192.168.4.28:8792' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrOther: '192.168.4.28:8792', asrOtherModel: 'qwen3-asr-0.6b-q8' }));
  });

  it('gives the stage back to the shared device when that is chosen', () => {
    const { card, update } = draw({ settings: PHONE, values: { endpoint: '192.168.1.9:8790' } });
    fireEvent.change(card(HEAR).getByRole('combobox', { name: 'providers.localai.stageDevice' }), { target: { value: '' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ asrOther: '', asrOtherModel: '' }));
  });
});

describe('a phone that lends its text models: the "another device" of the translation and the feedback', () => {
  const SILENT: Readiness = { state: 'not-ready', reason: 'The other device could not be reached (192.168.1.10:8790): Failed to fetch' };
  const device = (stage: string, card: (stage: string) => ReturnType<typeof within>) => card(stage).queryByRole('combobox', { name: 'providers.localai.stageDevice' }) as HTMLSelectElement | null;
  const model = (stage: string, card: (stage: string) => ReturnType<typeof within>) => card(stage).getByRole('combobox', { name: 'providers.localai.model' }) as HTMLSelectElement;

  it('is offered in the translation card once a search has found one, beside the shared device', () => {
    const { card, update } = draw({ settings: { translateAt: 'server' }, values: { endpoint: '192.168.1.9:8790' } });
    expect(device(TRANSLATE, card)).toBeNull();
    fireEvent.click(screen.getByText('a search that finds phones lending text models'));
    const select = device(TRANSLATE, card)!;
    expect(options(select)).toEqual(['', '192.168.4.28:8792', '192.168.4.30:8792']);
    expect(select.options[0].textContent).toBe('192.168.1.9:8790');
    // The phone that lends two: the better of this computer's own order for the pair.
    fireEvent.change(select, { target: { value: '192.168.4.28:8792' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateOther: '192.168.4.28:8792', translateOtherModel: 'index-translate-2b' }));
    // A phone that lends text models alone is no device to hear with.
    const hearing = device(HEAR, card);
    expect(hearing ? options(hearing) : []).not.toContain('192.168.4.30:8792');
  });

  it('shows the model asked of the phone: a choice among the ones it lends', () => {
    const { card, update } = draw({ settings: { translateAt: 'server', translateOther: '192.168.4.28:8792', translateOtherModel: 'index-translate-2b' }, values: { endpoint: '192.168.1.9:8790' } });
    // Not found yet: the saved phone and model as they were.
    expect(device(TRANSLATE, card)!.value).toBe('192.168.4.28:8792');
    expect(model(TRANSLATE, card).selectedOptions[0].textContent).toBe('Index-Translate 2B');
    expect(card(TRANSLATE).queryByText('providers.localai.connectFirst')).toBeNull();
    fireEvent.click(screen.getByText('a search that finds phones lending text models'));
    expect(options(model(TRANSLATE, card))).toEqual(['hy-mt2-1.8b', 'index-translate-2b']);
    expect(model(TRANSLATE, card).disabled).toBe(false);
    fireEvent.change(model(TRANSLATE, card), { target: { value: 'hy-mt2-1.8b' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateOtherModel: 'hy-mt2-1.8b' }));
    // Back on the shared device.
    fireEvent.change(device(TRANSLATE, card)!, { target: { value: '' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateOther: '', translateOtherModel: '' }));
  });

  it('fixes the model where the phone lends one, and says so where it no longer lends the one chosen', () => {
    const gone = draw({ settings: { translateAt: 'server', translateOther: '192.168.4.30:8792', translateOtherModel: 'index-translate-2b' } });
    fireEvent.click(screen.getByText('a search that finds phones lending text models'));
    expect(model(TRANSLATE, gone.card).selectedOptions[0].textContent).toBe('providers.localai.modelGone');
    cleanup();
    const one = draw({ settings: { translateAt: 'server', translateOther: '192.168.4.30:8792', translateOtherModel: 'hy-mt2-1.8b' } });
    fireEvent.click(screen.getByText('a search that finds phones lending text models'));
    expect(model(TRANSLATE, one.card).disabled).toBe(true);
    expect(model(TRANSLATE, one.card).selectedOptions[0].textContent).toBe('Hunyuan MT 2 1.8B');
  });

  it("says where the phone's translator does not translate the pair", () => {
    render(<LocalAIAssist settings={{ ...LOCALAI_DEFAULTS, translateAt: 'server', translateOther: '192.168.4.30:8792', translateOtherModel: 'hy-mt2-1.8b' }} values={{ endpoint: '' }} set={vi.fn()} fill={vi.fn()} update={vi.fn()} pair={{ source: 'zh-CN', target: 'sw' }} legs={['speaker']} models={[]} readiness={{ state: 'unknown' }} check={vi.fn()} />);
    expect(within(screen.getByRole('region', { name: TRANSLATE })).getByText('providers.localai.translatorUnfit')).toBeTruthy();
  });

  it('is offered in the feedback card the same way', () => {
    const { card, update } = draw({ settings: { coach: true, coachAt: 'server' }, values: { endpoint: '192.168.1.9:8790' } });
    fireEvent.click(screen.getByText('a search that finds phones lending text models'));
    const select = device(COACH, card)!;
    // Only the phone that lends a feedback model.
    expect(options(select)).toEqual(['', '192.168.4.28:8792']);
    fireEvent.change(select, { target: { value: '192.168.4.28:8792' } });
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ coachOther: '192.168.4.28:8792', coachOtherModel: 'gemma-4-e2b' }));
    cleanup();
    const there = draw({ settings: { coach: true, coachAt: 'server', coachOther: '192.168.4.28:8792', coachOtherModel: 'gemma-4-e2b' } });
    expect(model(COACH, there.card).selectedOptions[0].textContent).toBe('Gemma 4 E2B');
    expect(there.card(COACH).queryByText('providers.localai.connectFirst')).toBeNull();
  });

  it('picked in the search, is given every stage on "another device" it can run, and none placed elsewhere', () => {
    const onServer = draw({ settings: { asrVia: 'device', translateAt: 'server', coachAt: 'server' } });
    fireEvent.click(screen.getByText('the lending phone, picked'));
    expect(onServer.update).toHaveBeenLastCalledWith(expect.objectContaining({
      asrVia: 'server', asrOther: '192.168.4.28:8792', asrOtherModel: 'qwen3-asr-0.6b-q8',
      translateOther: '192.168.4.28:8792', translateOtherModel: 'index-translate-2b',
      coachOther: '192.168.4.28:8792', coachOtherModel: 'gemma-4-e2b',
    }));
    expect(onServer.fill).not.toHaveBeenCalled();
    cleanup();
    const elsewhere = draw({ settings: { asrVia: 'device', translateAt: 'device', coachAt: 'api' } });
    fireEvent.click(screen.getByText('the lending phone, picked'));
    const patch = elsewhere.update.mock.lastCall?.[0] as Partial<LocalAISettings>;
    expect(patch).toMatchObject({ asrVia: 'server', asrOther: '192.168.4.28:8792', translateAt: 'device' });
    expect(patch).not.toHaveProperty('translateOther');
    expect(patch).not.toHaveProperty('coachOther');
  });

  it('picked in the search while it can run no stage placed there, is given the translation: it lends that alone', () => {
    const { update } = draw({ settings: { asrVia: 'device', translateAt: 'device' } });
    fireEvent.click(screen.getByText('the text phone, picked'));
    expect(update).toHaveBeenLastCalledWith(expect.objectContaining({ translateAt: 'server', translateOther: '192.168.4.30:8792', translateOtherModel: 'hy-mt2-1.8b' }));
    expect(update.mock.lastCall?.[0]).not.toHaveProperty('asrOther');
  });

  it('is marked in the search as in use by the stages that ask it', () => {
    draw({ settings: { asrVia: 'device', translateAt: 'server', translateOther: '192.168.4.30:8792', translateOtherModel: 'hy-mt2-1.8b', coach: true, coachAt: 'server', coachOther: '192.168.4.28:8792', coachOtherModel: 'gemma-4-e2b' } });
    expect(screen.getByText('finder').getAttribute('data-phone')).toBe('192.168.4.30:8792 192.168.4.28:8792');
  });

  it("leaves the shared device's silence unsaid where no stage is on it", () => {
    const everyStageOnPhones: Partial<LocalAISettings> = { asrVia: 'server', asrOther: '192.168.4.28:8792', asrOtherModel: 'qwen3-asr-0.6b-q8', translateAt: 'server', translateOther: '192.168.4.28:8792', translateOtherModel: 'index-translate-2b', coach: true, coachAt: 'server', coachOther: '192.168.4.28:8792', coachOtherModel: 'gemma-4-e2b' };
    draw({ settings: everyStageOnPhones, values: { endpoint: '192.168.1.10:8790' }, readiness: SILENT });
    expect(screen.queryByText('providers.localai.serverSilent')).toBeNull();
    expect(screen.queryByRole('button', { name: 'providers.localai.kotomimiThere' })).toBeNull();
    cleanup();
    // On an API and this computer, as on phones.
    draw({ settings: { ...everyStageOnPhones, translateAt: 'device', coachAt: 'api' }, values: { endpoint: '192.168.1.10:8790' }, readiness: SILENT });
    expect(screen.queryByText('providers.localai.serverSilent')).toBeNull();
    cleanup();
    // One stage left on it, and its silence is said.
    draw({ settings: { ...everyStageOnPhones, translateOther: '' }, values: { endpoint: '192.168.1.10:8790' }, readiness: SILENT });
    expect(screen.getByText('providers.localai.serverSilent')).toBeTruthy();
  });
});
