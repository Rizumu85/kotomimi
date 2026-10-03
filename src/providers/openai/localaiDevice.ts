/**
 * Fork: the stages this computer runs itself — the models the app downloads
 * and runs in its own workers (`src/lib/local-inference`), the ones the
 * built-in Local Inference provider uses. Here they are two more places a
 * stage can run: speech recognition, with its own turn detection, in place
 * of the Realtime server; and translation, in place of the server's pipeline
 * or a text model.
 *
 * Which model a stage runs is chosen as Local Inference chooses it: one
 * selection per stage of a direction (`src→tgt`), blank meaning the best
 * one downloaded. The model store answers; this module only asks it, for the
 * builder, the readiness check and the settings' own views.
 */
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { directionKey, emptyDirection, type Selections } from '../../lib/local-inference/selection/types';
import type { LegName } from '../../lib/conversation/types';
import type { EngineSlot, LanguagePair } from '../../lib/provider/types';
import { AUTO } from '../../lib/provider/languages';
import { useModelStore } from '../../stores/modelStore';

/** What the model manifest calls a language: its base (`zh-CN` → `zh`). */
export const deviceLanguage = (code: string): string => code.split('-')[0];

/** The settings a device stage reads: where each stage runs, and the picks. */
export interface DeviceChoices {
  asrVia: 'server' | 'api' | 'device';
  /** As `translateViaOf` answers it: never `server` while recognition is on the device. */
  translateVia: 'server' | 'model' | 'device';
  coach: boolean;
  selections: Selections;
}

/** What answers speech under these settings: a leg this computer hears has no server pipeline to answer it, so its own translation model does. */
export function translateViaOf(s: Pick<DeviceChoices, 'asrVia' | 'translateVia'>): DeviceChoices['translateVia'] {
  return s.asrVia !== 'server' && s.translateVia === 'server' ? 'device' : s.translateVia;
}

/** The stage settings that decide which servers a run calls. */
export interface StagePlacement extends Pick<DeviceChoices, 'asrVia' | 'translateVia' | 'coach'> {
  translateBaseUrl: string;
  translateModel: string;
  coachBaseUrl: string;
  coachModel: string;
}

/** The translation text model is in use: it answers speech, or — the speaker coached — typed text and, with no feedback model named, the feedback too. Never while this computer translates. */
export const usesTranslateModel = (s: StagePlacement): boolean => s.translateModel.trim() !== '' && translateViaOf(s) !== 'device' && (translateViaOf(s) === 'model' || s.coach);
/** The feedback has a model of its own. */
export const ownCoachModel = (s: StagePlacement): boolean => s.coach && s.coachModel.trim() !== '';

/** A stage of this run is on the Realtime server: it hears, or a text model in use names no server of its own. */
export function needsServer(s: StagePlacement): boolean {
  return s.asrVia === 'server'
    || (usesTranslateModel(s) && s.translateBaseUrl.trim() === '')
    || (ownCoachModel(s) && s.coachBaseUrl.trim() === '');
}

/** The stored settings as the device stages read them. */
export function deviceChoices(s: DeviceChoices): DeviceChoices {
  return { asrVia: s.asrVia, translateVia: translateViaOf(s), coach: s.coach, selections: s.selections };
}

/** The model store, loaded: its first scan of what is downloaded may still be running. */
export async function deviceModelsLoaded(signal?: AbortSignal): Promise<void> {
  const store = useModelStore.getState();
  if (store.initialized) return;
  const init = store.initialize();
  if (!signal) return init;
  if (signal.aborted) {
    init.catch(() => {});
    throw signal.reason ?? new Error('aborted');
  }
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    init.then(
      () => { signal.removeEventListener('abort', onAbort); resolve(); },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error); },
    );
  });
}

/** The recognizer for speech in `heard`, on the leg whose other language is `other`: the pick for `heard→other`, else the best downloaded. */
export function deviceRecognizer(heard: string, other: string, selections: Selections): { modelId: string; streaming: boolean } | null {
  if (heard === AUTO) return null;
  const resolved = useModelStore.getState().resolve(deviceLanguage(heard), deviceLanguage(other), selections).asr;
  if (!resolved) return null;
  return { modelId: resolved.modelId, streaming: getManifestEntry(resolved.modelId)?.type === 'asr-stream' };
}

/**
 * The translation model for `source→target`. A speech-translation model
 * picked here (an ASR model that translates what it hears) is no text
 * translator: the pick is then read as blank, and the best downloaded
 * translation model answers.
 */
export function deviceTranslator(source: string, target: string, selections: Selections): string | null {
  if (source === AUTO) return null;
  const src = deviceLanguage(source);
  const tgt = deviceLanguage(target);
  const { resolve } = useModelStore.getState();
  const picked = resolve(src, tgt, selections).translation;
  if (!picked) return null;
  if (getManifestEntry(picked.modelId)?.type === 'translation') return picked.modelId;
  const dir = directionKey(src, tgt);
  const masked = { ...selections, [dir]: { ...(selections[dir] ?? emptyDirection()), translation: { modelId: '' } } };
  const again = resolve(src, tgt, masked).translation;
  return again && getManifestEntry(again.modelId)?.type === 'translation' ? again.modelId : null;
}

/** One model a run would load on this computer, and whether the run cannot start without it. */
export interface DeviceNeed extends EngineSlot {
  leg: LegName;
  /** The language heard, or the pair translated, in app codes: for a refusal's words. */
  source: string;
  target: string;
  /** False: typed text alone needs it (a coached speaker's translation). */
  required: boolean;
}

/**
 * The device stages a run opens, speaker's first. A coached speaker speaks
 * the target language, so their recognizer is the one for `target→source`
 * — the same slot the participant's leg uses — and only what they type is
 * translated.
 */
export function deviceNeeds(s: DeviceChoices, pair: LanguagePair, legs: readonly LegName[]): DeviceNeed[] {
  const out: DeviceNeed[] = [];
  const slot = (src: string, tgt: string) => directionKey(deviceLanguage(src), deviceLanguage(tgt));
  for (const leg of legs) {
    const source = leg === 'participant' ? pair.target : pair.source;
    const target = leg === 'participant' ? pair.source : pair.target;
    const coached = s.coach && leg === 'speaker';
    if (s.asrVia === 'device') {
      const heard = coached ? target : source;
      const other = coached ? source : target;
      out.push({ leg, dir: slot(heard, other), stage: 'asr', source: heard, target: other, required: true });
    }
    if (s.translateVia === 'device') out.push({ leg, dir: slot(source, target), stage: 'translation', source, target, required: !coached });
  }
  return out;
}

/** The model a need resolves to now; null when none is downloaded for it. */
export function deviceModelFor(need: DeviceNeed, selections: Selections): string | null {
  return need.stage === 'asr' ? deviceRecognizer(need.source, need.target, selections)?.modelId ?? null : deviceTranslator(need.source, need.target, selections);
}

/** Calls back when a model finishes downloading or is deleted: a readiness answer about the old set is stale. */
export function watchDeviceModels(onChange: () => void): () => void {
  return useModelStore.subscribe((s) => s.modelStatuses, () => onChange());
}
