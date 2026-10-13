// Fork: what the library lists for a language where a recognizer was found unusable for it
// (`src/lib/local-inference/selection/measuredRank.ts`). The store is a stand-in fed by this file, with the real
// resolver behind it, as in the library's own tests beside this one.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ModelManagementSection } from './ModelManagementSection';
import type { ModelStatus } from '../../../lib/local-inference/modelManifest';
import { resolveDirection } from '../../../lib/local-inference/selection/resolveStage';
import { wasmCandidates } from '../../../lib/local-inference/selection/candidates.wasm';
import { directionKey, type Selections } from '../../../lib/local-inference/selection/types';
import { LOCAL_INFERENCE_DEFAULTS, type LocalInferenceSettings } from '../../../providers/localInference/settings';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, fallback?: string) => (typeof fallback === 'string' ? fallback : key) }) }));
vi.mock('../../../lib/edge-tts/voiceList', async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), getEdgeTtsVoices: async () => [] }));
vi.mock('../../../lib/local-inference/voiceStorage', () => ({
  listVoices: vi.fn(async () => []), addVoice: vi.fn(async () => undefined), renameVoice: vi.fn(async () => undefined), deleteVoice: vi.fn(async () => undefined),
  VoiceImportError: class VoiceImportError extends Error {},
}));

const mockStatuses: Record<string, ModelStatus> = {};
const mockStoreState = {
  initialize: vi.fn(), downloadModel: vi.fn(), cancelDownload: vi.fn(), deleteModel: vi.fn(), deleteAllModels: vi.fn(),
  resolve: (src: string, tgt: string, selections: Selections) => resolveDirection(directionKey(src, tgt), selections, wasmCandidates({ modelStatuses: mockStatuses, webgpuAvailable: true, deviceFeatures: [] })),
};
vi.mock('../../../stores/modelStore', () => ({
  useModelStatuses: () => mockStatuses,
  useModelDownloads: () => ({}),
  useDownloadErrors: () => ({}),
  useStorageUsedMb: () => 0,
  useModelInitialized: () => true,
  useModelInitError: () => null,
  useWebGPUAvailable: () => true,
  useWebGPUSoftwareOnly: () => false,
  useDeviceFeatures: () => [],
  useModelVariants: () => ({}),
  useModelStore: Object.assign((sel?: (s: typeof mockStoreState) => unknown) => (sel ? sel(mockStoreState) : mockStoreState), { getState: () => mockStoreState }),
}));

beforeEach(() => { for (const id of Object.keys(mockStatuses)) delete mockStatuses[id]; });

const library = (direction: string, selections: Selections = {}, update = vi.fn()) => {
  const settings: LocalInferenceSettings = { ...LOCAL_INFERENCE_DEFAULTS, selections };
  const [source, target] = direction.split('→');
  return { update, ...render(<ModelManagementSection isSessionActive={false} stageFilter="asr" direction={direction} settings={settings} update={update} pair={{ source, target }} />) };
};
const KEPT: Selections = { 'ja→zh': { asr: { modelId: 'sensevoice-int8' }, translation: { modelId: '' }, tts: { modelId: '' } } };

describe('the library, for a language a recognizer is not offered for (fork)', () => {
  it('has no card of the SenseVoice that runs in the page for Japanese, downloaded or not, and every card of it for Chinese', () => {
    mockStatuses['sensevoice-int8'] = 'downloaded';
    const japanese = library('ja→zh');
    expect(screen.queryByTestId('model-card-sensevoice-int8')).toBeNull();
    expect(screen.queryByTestId('model-card-sensevoice-nano-int8')).toBeNull();
    // Not among the ones "for other languages" either: it is not a model of another language, it is not offered.
    const all = screen.queryByText(/Show all ASR models/);
    if (all) fireEvent.click(all);
    expect(screen.queryByTestId('model-card-sensevoice-int8')).toBeNull();
    expect(screen.getByTestId('model-card-whisper-large-v3-turbo-webgpu')).toBeTruthy();
    japanese.unmount();
    library('zh→ja');
    expect(screen.getByTestId('model-card-sensevoice-int8').className).toContain('model-card--selected');
    expect(screen.getByTestId('model-card-sensevoice-nano-int8')).toBeTruthy();
  });

  it('keeps the card of one chosen for Japanese before, as the one in use, until another is chosen', () => {
    mockStatuses['sensevoice-int8'] = 'downloaded';
    mockStatuses['moonshine-tiny-ja-quant'] = 'downloaded';
    const { update } = library('ja→zh', KEPT);
    const kept = screen.getByTestId('model-card-sensevoice-int8');
    expect(kept.className).toContain('model-card--selected');
    expect(kept.querySelector('.model-card__recommended-badge')).toBeNull();
    // The other build of it was never chosen: still not offered.
    expect(screen.queryByTestId('model-card-sensevoice-nano-int8')).toBeNull();
    // Last of the cards: after everything that is offered.
    const cards = [...document.querySelectorAll<HTMLElement>('[data-testid^="model-card-"]')].map((one) => one.dataset.testid);
    expect(cards[cards.length - 1]).toBe('model-card-sensevoice-int8');
    fireEvent.click(screen.getByTestId('model-card-moonshine-tiny-ja-quant'));
    expect(update).toHaveBeenLastCalledWith({ selections: { 'ja→zh': { asr: { modelId: 'moonshine-tiny-ja-quant' }, translation: { modelId: '' }, tts: { modelId: '' } } } });
  });
});
