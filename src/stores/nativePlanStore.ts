import { createStore } from 'zustand/vanilla';
import { subscribeWithSelector } from 'zustand/middleware';
import type { LanguagePair } from '../lib/provider/types';
import { localaiProvider, type LocalAISettings } from '../providers/openai/localai';
import { nativeDownloaded, nativeEngineOf, isApple, NATIVE_MODELS } from '../providers/openai/localaiNative';
import { currentNativeModels, type NativePlan, type NativePlanId, type NativeSide, type NativeStage, type PlanRecognition } from '../providers/openai/nativePlans';
import { useNativeEngineStore, useNativeTranslatorStore, type NativeEngineStore } from './nativeEngineStore';
import { useProviderStore } from './providerStore';
import { describeCause, reportError } from '../lib/diagnostics/report';

export interface NativePlanContext { settings: LocalAISettings; pair: LanguagePair }
export interface NativePlanApplyDeps {
  read(): NativePlanContext | null;
  write(patch: Partial<LocalAISettings>): void;
  subscribe(listener: () => void): () => void;
  recognition: NativeEngineStore;
  translation: NativeEngineStore;
}
export interface PendingNativeStage {
  stage: NativeStage;
  model: string;
  waiting: string[];
  progress: Array<{ id: string; received: number; total: number; state: string; error?: string }>;
}
export interface NativePlanApplyState {
  pending: { plan: NativePlanId | null; stages: PendingNativeStage[] } | null;
  apply(plan: NativePlan): void;
  applyRecognition(side: NativeSide, choice: PlanRecognition): void;
  /** Cancels the switch, not shared/library downloads. */
  cancel(stage?: NativeStage): void;
}
const base = (code: string) => code.trim().toLowerCase().split(/[-_]/)[0];

/** A single coordinator owns pending switches. Download completion is observed, never inferred from download() returning. */
export function createNativePlanStore(deps: NativePlanApplyDeps) {
  type Job = { stage: NativeStage; model: string; assets: string[]; signature: string };
  let jobs: Job[] = [];
  let plan: NativePlanId | null = null;
  let offs: Array<() => void> = [];
  let writing = false;
  const engine = (stage: NativeStage) => stage === 'translation' ? deps.translation : deps.recognition;
  const signature = (stage: NativeStage, ctx: NativePlanContext): string => {
    const { settings: s, pair } = ctx;
    if (stage === 'translation') return JSON.stringify([s.translateAt, s.translateHere, s.translateNativeModel, s.translateOther, s.translateOtherModel, s.translateModel, s.translateBaseUrl, s.translateServerModel]);
    const key = stage === 'speaker' ? base(pair.source) : s.asrDetectOther ? 'auto' : base(pair.target);
    return JSON.stringify([s.asrVia, s.asrHere, s.asrOther, s.asrOtherModel, s.asrModel, s.asrApiModel, s.asrApiBaseUrl,
      s.asrNativeByLanguage[key] ?? s.asrNativeModel, pair, s.speakAlso, s.speakBoth, s.theyLit, s.theyAlso, s.asrDetectOther]);
  };
  const stopWatching = () => { for (const off of offs.splice(0)) off(); };
  const publish = () => {
    store.setState({ pending: jobs.length ? { plan, stages: jobs.map((job) => {
      const status = engine(job.stage).getState().status;
      return { stage: job.stage, model: job.model, waiting: job.assets.filter((id) => !nativeDownloaded(status, id)),
        progress: job.assets.map((id) => ({ id, ...(status.models[id] ?? { state: 'absent', received: 0, total: 0 }) })) };
    }) } : null });
    if (!jobs.length) stopWatching();
  };
  const reconcile = () => {
    if (writing) return;
    const ctx = deps.read();
    jobs = ctx ? jobs.filter((job) => signature(job.stage, ctx) === job.signature) : [];
    if (!ctx) { publish(); return; }
    const current = currentNativeModels(ctx.settings, ctx.pair);
    // A manual choice on a shared engine wins over an incompatible pending switch on its peer.
    jobs = jobs.filter((job) => {
      if (job.stage === 'translation' || isApple(job.model)) return true;
      const other = job.stage === 'speaker' ? 'participant' : 'speaker';
      const peer = current[other];
      return !peer || peer === job.model || isApple(peer) || nativeEngineOf(peer) !== nativeEngineOf(job.model) || jobs.some((j) => j.stage === other);
    });
    const ready = jobs.filter((job) => job.assets.every((id) => nativeDownloaded(engine(job.stage).getState().status, id)));
    // Do not leave two different models on one engine during a partial application.
    const canApply = (job: Job) => {
      if (job.stage === 'translation') return true;
      // Placement is shared by both recognizers; move it only when both requested sides are ready.
      if (ctx.settings.asrVia !== 'device' && jobs.some((j) => j.stage !== 'translation' && !ready.includes(j))) return false;
      if (isApple(job.model)) return true;
      const other = job.stage === 'speaker' ? 'participant' : 'speaker';
      const next = ready.find((j) => j.stage === other)?.model ?? current[other];
      return !next || isApple(next) || next === job.model || nativeEngineOf(next) !== nativeEngineOf(job.model);
    };
    const applying = ready.filter(canApply);
    if (applying.length) {
      const patch: Partial<LocalAISettings> = {};
      const byLanguage = { ...ctx.settings.asrNativeByLanguage };
      // Pin both existing sides before changing the shared default/placement.
      for (const side of ['speaker', 'participant'] as const) {
        const key = side === 'speaker' ? base(ctx.pair.source) : ctx.settings.asrDetectOther ? 'auto' : base(ctx.pair.target);
        byLanguage[key] ??= current[side] ?? ctx.settings.asrNativeModel;
      }
      for (const job of applying) {
        if (job.stage === 'translation') Object.assign(patch, { translateAt: 'device', translateHere: 'native', translateNativeModel: job.model });
        else {
          const key = job.stage === 'speaker' ? base(ctx.pair.source) : ctx.settings.asrDetectOther ? 'auto' : base(ctx.pair.target);
          byLanguage[key] = job.model;
          Object.assign(patch, { asrVia: 'device', asrHere: 'native', asrNativeByLanguage: byLanguage });
        }
      }
      jobs = jobs.filter((job) => !applying.includes(job));
      writing = true;
      try { deps.write(patch); } finally { writing = false; }
      const next = deps.read();
      if (next) for (const job of jobs) job.signature = signature(job.stage, next);
    }
    publish();
  };
  const begin = (id: NativePlanId | null, choices: Array<{ stage: NativeStage; model: string | null; assets: string[] }>) => {
    stopWatching();
    const ctx = deps.read();
    if (!ctx) { jobs = []; publish(); return; }
    plan = id;
    jobs = choices.flatMap((choice) => choice.model ? [{ ...choice, model: choice.model, signature: signature(choice.stage, ctx) }] : []);
    offs = [deps.subscribe(reconcile), deps.recognition.subscribe(reconcile), deps.translation.subscribe(reconcile)];
    const missing = jobs.flatMap((job) => job.assets.filter((id) => !nativeDownloaded(engine(job.stage).getState().status, id)).map((id) => ({ id, stage: job.stage })));
    reconcile();
    for (const [id, stage] of new Map(missing.map((m) => [m.id, m.stage]))) {
      const source = engine(stage);
      const status = source.getState().status.models[id];
      if (status?.state === 'downloading' || status?.state === 'verifying') continue;
      void source.getState().download(id).catch(() => {
        // The engine normally reports failure as status; an injected downloader may reject.
        source.setState((state) => ({ status: { ...state.status, models: { ...state.status.models, [id]: { state: 'failed', received: 0, total: 0 } } } }));
      });
    }
  };
  const store = createStore<NativePlanApplyState>()(subscribeWithSelector<NativePlanApplyState>(() => ({
    pending: null,
    apply: (p) => begin(p.id, [
      { stage: 'speaker', model: p.speaker.model, assets: p.speaker.models },
      { stage: 'participant', model: p.participant.model, assets: p.participant.models },
      { stage: 'translation', model: p.translation, assets: p.translation ? [p.translation] : [] },
    ]),
    applyRecognition: (side, choice) => {
      const choices = [{ stage: side as NativeStage, model: choice.model, assets: choice.models }];
      const ctx = deps.read();
      const other = side === 'speaker' ? 'participant' : 'speaker';
      const current = ctx && currentNativeModels(ctx.settings, ctx.pair)[other];
      if (choice.model && current && current !== choice.model && !isApple(choice.model) && nativeEngineOf(current) === nativeEngineOf(choice.model)) {
        const model = NATIVE_MODELS.find((m) => m.id === choice.model);
        const language = ctx!.pair[other === 'speaker' ? 'source' : 'target'];
        if (model?.languages.includes(base(language))) choices.push({ stage: other, model: choice.model, assets: choice.models });
      }
      begin(null, choices);
    },
    cancel: (stage) => { jobs = stage ? jobs.filter((job) => job.stage !== stage) : []; reconcile(); },
  })));
  return store;
}

/** UI: useStore(nativePlanStore, selector). No subscriptions until an application is pending. */
export const nativePlanStore = createNativePlanStore({
  read: () => {
    const state = useProviderStore.getState();
    const entry = state.entries.localai;
    return state.selected === 'localai' && entry ? { settings: entry.settings as unknown as LocalAISettings, pair: entry.pair } : null;
  },
  write: (patch) => {
    // Read the definition only when writing. Importing the registry here would
    // enumerate providers while their Settings views are importing this store.
    const provider = localaiProvider;
    useProviderStore.getState().updateSettings(provider, patch);
    void useProviderStore.getState().flush(provider).then(async (saved) => {
      if (saved) {
        const { getAppSession } = await import('../app/session');
        await getAppSession().runner.retarget();
      }
    }).catch((error: unknown) => reportError('NativePlan', `Applying the native models to the session failed: ${describeCause(error)}`, { cause: error }));
  },
  subscribe: (listener) => useProviderStore.subscribe(listener),
  recognition: useNativeEngineStore,
  translation: useNativeTranslatorStore,
});
