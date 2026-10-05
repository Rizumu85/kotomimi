import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, GraduationCap, Languages, LibraryBig, Loader, Mic, MonitorSmartphone, Play, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CustomModels } from '../../components/CustomModels/CustomModels';
import { ServerFinder } from '../../components/LanSharing/ServerFinder';
import { useWasmEngineAdapter } from '../../components/Settings/engine/useWasmEngineAdapter';
import { ModelGroup } from '../../components/Settings/sections/ModelManagementControls';
import { ModelCard, ModelManagementSection } from '../../components/Settings/sections/ModelManagementSection';
import ToggleSwitch from '../../components/Settings/shared/ToggleSwitch';
import Tooltip from '../../components/Tooltip/Tooltip';
import { canFindServers, findServers, plainAddress, type FoundServer } from '../../lib/lan/discover';
import { askLocalPipelines, NO_PIPELINES, type LocalPipelines } from '../../lib/lan/localServer';
import { modelLabel } from '../../lib/lan/modelLabel';
import { deviceReady, getManifestEntry, getModelSizeMb } from '../../lib/local-inference/modelManifest';
import { shortenModelName } from '../../lib/local-inference/modelName';
import type { CredentialAssistProps } from '../../lib/provider/types';
import { useLocalServerStore } from '../../stores/localServerStore';

import { useDeviceFeatures, useDownloadErrors, useModelDownloads, useModelInitialized, useModelStatuses, useModelStore, useWebGPUAvailable } from '../../stores/modelStore';
import { savedKeyOf } from './apiServiceKey';
import { API_SERVICES, preferredModel, serviceOf, servicesFor, type ApiKind, type ApiService } from './apiServices';
import { coachPrompt } from './coachPrompt';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { deviceChatModels, deviceCoachModel, deviceLanguage, deviceModelsLoaded, needsServer, PLACE_FIELDS, PLACES, type DeviceNeed, type Place } from './localaiDevice';
import { NATIVE_MODELS, nativeDownloaded, nativeHears, nativeModel, nativeModelFor } from './localaiNative';
import { NativeEngineCard, nativeStoreOf, type NativeCardModel, type NativeKind } from './NativeEngineCard';
import { NATIVE_TRANSLATORS, nativeTranslates, nativeTranslator } from './nativeTranslators';
import { useDeviceSettings, useDeviceSlots } from './LocalAIEngine';
import { isKotomimiServer, modelsFor, SERVER_SILENT, serverDefaultModel, type LocalAIModel } from './localaiModels';
import { isRealtimeModelId } from './settings';
import './LocalAIAssist.scss';

type Props = CredentialAssistProps<S>;

/**
 * A model another device lists, by a name a person reads: the catalog's own name for one of the app's models (a
 * Kotomimi shares those under their catalog ids), else its id written out (`modelLabel`). The id stays what is sent.
 */
function shownName(id: string): string {
  const entry = getManifestEntry(id);
  if (entry) return shortenModelName(entry.name, entry.shortName);
  // A native engine's model the other Kotomimi shares: by the name it has here. The Mac's recognition is a model to a language.
  const native = NATIVE_MODELS.find((m) => m.id === id) ?? NATIVE_TRANSLATORS.find((m) => m.id === id);
  if (native) return id.includes(':') ? `${native.name} (${id.slice(id.indexOf(':') + 1)})` : native.name;
  return modelLabel(id);
}

/** A labelled control. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="kt-field">
      <span className="kt-field__label">{label}</span>
      {children}
    </label>
  );
}

/** The three places a stage can run, as one row of buttons: the same three, in the same order, for every stage. */
function PlaceSwitch({ label, value, onChange, disabled }: { label: string; value: Place; onChange(place: Place): void; disabled?: boolean }) {
  const { t } = useTranslation();
  const names: Record<Place, string> = { server: t('providers.localai.placeServer'), api: t('providers.localai.viaModel'), device: t('providers.localai.placeDevice') };
  return (
    <div className="kt-seg" role="group" aria-label={label}>
      {PLACES.map((place) => (
        <button key={place} type="button" className={`kt-seg__option${place === value ? ' is-active' : ''}`} aria-pressed={place === value} onClick={() => { if (place !== value) onChange(place); }} disabled={disabled}>
          {names[place]}
        </button>
      ))}
    </div>
  );
}

/** One stage: its name, and everything that decides how it runs. */
function StageCard({ icon, title, tooltip, lead, children }: { icon: ReactNode; title: string; tooltip: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="kt-card" aria-label={title}>
      <h4 className="kt-card__head">
        <span className="kt-card__icon">{icon}</span>
        <span className="kt-card__title">{title}</span>
        <Tooltip content={tooltip} position="top" maxWidth={320}><CircleHelp className="tooltip-trigger" size={13} /></Tooltip>
      </h4>
      {lead}
      {children}
    </section>
  );
}

/** A model of the other device's, chosen from what it lists; the first option is what a blank choice runs. */
function ServerModel({ label, value, blank, options, onChange, disabled }: { label: string; value: string; blank: string; options: readonly LocalAIModel[]; onChange(id: string): void; disabled?: boolean }) {
  const listed = value === '' || options.some((m) => m.id === value);
  return (
    <Field label={label}>
      <select className="select-dropdown" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{blank}</option>
        {/* A saved model the device no longer lists stays visible, so the setting is not silently another. */}
        {!listed && <option value={value}>{shownName(value)}</option>}
        {options.map((m) => <option key={m.id} value={m.id}>{shownName(m.id)}</option>)}
      </select>
    </Field>
  );
}

/**
 * The way out of a recognizer that cannot be chosen. The other device is a plain model server (a LocalAI), which
 * hears with its own recognizer whenever the answers come from a model chosen here; a Kotomimi sharing on the same
 * device takes any of its recognizers. This looks for one there, and switches the address to it.
 */
function KotomimiThere({ address, onPick, disabled }: { address: string; onPick(server: FoundServer): void; disabled?: boolean }) {
  // Also where the address no longer answers: a Kotomimi keeps its LocalAI to its own computer, and lends its models itself.
  const { t } = useTranslation();
  const [state, setState] = useState<'idle' | 'looking' | 'none'>('idle');
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  const host = plainAddress(address).replace(/:\d+$/, '');
  const look = async () => {
    setState('looking');
    const there = (await findServers()).find((server) => server.kind === 'kotomimi' && !server.self && server.address.replace(/:\d+$/, '') === host);
    if (!alive.current) return;
    if (there) onPick(there);
    setState(there ? 'idle' : 'none');
  };
  return (
    <div className="kt-there">
      <button type="button" className="kt-there__switch" onClick={() => { void look(); }} disabled={disabled || state === 'looking'}>
        {state === 'looking' ? <Loader size={12} className="kt-ready__spin" /> : <MonitorSmartphone size={12} />}
        <span>{t(state === 'looking' ? 'providers.localai.kotomimiThereLooking' : 'providers.localai.kotomimiThere')}</span>
      </button>
      {state === 'none' && <p className="kt-note kt-note--todo" role="status">{t('providers.localai.kotomimiThereNone')}</p>}
    </div>
  );
}

/** One more stage's API, with the key that opens it. */
interface OtherApi { baseUrl: string; key: string }

interface ApiFieldsProps {
  /** Distinguishes the three groups' ids. */
  id: string;
  /** What the stage asks of an API: it is offered the services that serve it, and given a model of that kind. */
  kind: ApiKind;
  /** The other stages' APIs: a service one of them already opens is not asked for its key a second time. */
  others: readonly OtherApi[];
  baseUrl: string;
  model: string;
  needsKey: boolean;
  apiKey: string;
  urlPlaceholder: string;
  modelPlaceholder: string;
  /** The models the API lists, when it lists any: they only suggest — what is typed is what is asked for. */
  options: readonly LocalAIModel[];
  onChange(patch: { baseUrl?: string; model?: string; needsKey?: boolean }): void;
  onKey(value: string): void;
  disabled?: boolean;
}

/** The menu's entry for an address of the user's own. No service's id. */
const CUSTOM_API = 'custom';
const sameAddress = (a: string, b: string) => a.trim().replace(/\/+$/, '').toLowerCase() === b.trim().replace(/\/+$/, '').toLowerCase();

/**
 * An API: which service, which model, and its key — all in the stage that uses it.
 *
 * The service is a menu (`apiServices.ts`): choosing one fills its address and whether it wants a key, takes the key
 * from where it is already saved — another stage that uses the same service, or the built-in provider of that
 * service — and leaves the model to be picked from what the service lists, the one that suits the stage by itself.
 * "Custom address" is what the fields were before: an address, a model and a key, typed.
 */
function ApiFields({ id, kind, others, baseUrl, model, needsKey, apiKey, urlPlaceholder, modelPlaceholder, options, onChange, onKey, disabled }: ApiFieldsProps) {
  const { t } = useTranslation();
  const service = serviceOf(baseUrl, kind);
  const nameOf = (s: ApiService) => (s.nameKey ? t(s.nameKey) : s.name);
  // Where the key in the field came from, when it was not typed: said under it, once.
  const [reused, setReused] = useState<string | null>(null);
  // The model field is not filled in under the user's hands: only while it is not being typed in.
  const [typing, setTyping] = useState(false);
  const change = useRef(onChange);
  change.current = onChange;
  const key = useRef(onKey);
  key.current = onKey;

  const choose = (chosen: string) => {
    const next = API_SERVICES.find((s) => s.id === chosen);
    setReused(null);
    // The key in the field opens the service it was typed for, and is sent to no other.
    key.current('');
    if (!next) {
      change.current({ baseUrl: '', model: '' });
      return;
    }
    change.current({ baseUrl: next.baseUrl, needsKey: next.needsKey, model: '' });
    if (!next.needsKey) return;
    const beside = others.find((o) => o.key.trim() && sameAddress(o.baseUrl, next.baseUrl));
    if (beside) {
      key.current(beside.key);
      return;
    }
    if (!next.keyOf) return;
    void savedKeyOf(next.keyOf).then((saved) => {
      if (!saved) return;
      key.current(saved);
      setReused(nameOf(next));
    });
  };

  // A service's model, when none is named: the one of its own list that suits the stage (`preferredModel`).
  const pick = service && !model.trim() ? preferredModel(service, kind, options.map((m) => m.id)) : undefined;
  useEffect(() => {
    if (pick && !typing && !disabled) change.current({ model: pick });
  }, [pick, typing, disabled]);

  return (
    <>
      <Field label={t('providers.localai.apiService')}>
        <select className="select-dropdown" aria-label={t('providers.localai.apiService')} value={service?.id ?? CUSTOM_API} onChange={(e) => choose(e.target.value)} disabled={disabled}>
          {servicesFor(kind).map((s) => <option key={s.id} value={s.id}>{nameOf(s)}</option>)}
          <option value={CUSTOM_API}>{t('providers.localai.apiServiceCustom')}</option>
        </select>
      </Field>
      {!service && (
        <Field label={t('providers.localai.asrApiBaseUrl')}>
          <input type="text" className="kt-input" aria-label={t('providers.localai.asrApiBaseUrl')} value={baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder={urlPlaceholder} spellCheck={false} disabled={disabled} />
        </Field>
      )}
      <Field label={t('providers.localai.model')}>
        <input
          type="text"
          className="kt-input"
          aria-label={t('providers.localai.model')}
          list={`${id}-models`}
          value={model}
          onChange={(e) => onChange({ model: e.target.value })}
          onFocus={() => setTyping(true)}
          onBlur={() => setTyping(false)}
          placeholder={service ? t(service.modelHintKey ?? 'providers.localai.apiServiceModel') : modelPlaceholder}
          spellCheck={false}
          disabled={disabled}
        />
        <datalist id={`${id}-models`}>
          {options.map((m) => <option key={m.id} value={m.id} />)}
        </datalist>
      </Field>
      {/* Whether a service wants a key is known; of an address typed by hand it is asked. */}
      {!service && <ToggleSwitch checked={needsKey} onChange={() => onChange({ needsKey: !needsKey })} label={t('providers.localai.asrApiNeedsKey')} disabled={disabled} />}
      {needsKey && (
        <Field label={t('providers.localai.apiKey')}>
          <input type="password" className="kt-input" aria-label={t('providers.localai.apiKey')} value={apiKey} onChange={(e) => { setReused(null); onKey(e.target.value); }} placeholder={t('providers.localai.apiKey')} autoComplete="off" disabled={disabled} />
        </Field>
      )}
      {needsKey && reused && apiKey && <p className="kt-note">{t('providers.localai.apiKeyReused', { name: reused })}</p>}
    </>
  );
}

/** The value of the menu's entry that hands the stage to this computer's LocalAI. No model's id. */
const LOCALAI_ENTRY = '\u0000localai';
/** And of the entries that hand hearing to the native engine, one for each of its models. */
const NATIVE_ENTRY = '\u0000native:';

/** A stage's native models, as their cards and menus read them. */
const NATIVE_OF: Record<NativeKind, readonly NativeCardModel[]> = { asr: NATIVE_MODELS, translation: NATIVE_TRANSLATORS };

/** The mark of the one measured best: every recognizer (a system has one family of them), and the first of the translators. */
const recommendedNative = (kind: NativeKind, model: NativeCardModel): boolean => kind === 'asr' || NATIVE_OF[kind][0].id === model.id;

/** Whether a native model serves a direction: hears its language, or translates its pair. */
const nativeFits = (kind: NativeKind, id: string, source: string, target: string): boolean => (kind === 'asr'
  ? nativeHears(nativeModel(id), source)
  : nativeTranslates(nativeTranslator(id), source, target));

/** A stage's native models this computer can run, and which of them are downloaded or on their way. */
function useNativeModels(kind: NativeKind): { offered: readonly NativeCardModel[]; ready: readonly NativeCardModel[]; fetching: readonly string[] } {
  const status = nativeStoreOf(kind)((s) => s.status);
  return useMemo(() => {
    // The main process lists the models this system is offered: one it leaves out has no card here.
    const offered = status.supported ? NATIVE_OF[kind].filter((m) => status.models[m.id] !== undefined) : [];
    const fetching = offered.filter((m) => status.models[m.id]?.state === 'downloading' || status.models[m.id]?.state === 'verifying').map((m) => m.id);
    return { offered, ready: offered.filter((m) => nativeDownloaded(status, m.id)), fetching };
  }, [status, kind]);
}

/** What a model's own menu offers of a native engine: its downloaded models, and the way to hand the stage to one. */
interface NativeRunner { onPick(id: string): void }

/**
 * A stage run by a native engine: who runs it — the same menu, with the way
 * back to the app's own models and to a LocalAI — and under it the engine's
 * model, in the library's own card, with what the engine is doing.
 */
function NativeHere({ kind, model, inUse, unfit, onModel, onBack, other, disabled }: { kind: NativeKind; model: NativeCardModel; /** The models a run would use: the one named — or, where each language has a model of its own, the one of each language. */ inUse?: readonly NativeCardModel[]; unfit: boolean; onModel(id: string): void; onBack(): void; other?: OtherRunner; disabled?: boolean }) {
  const { t } = useTranslation();
  const { offered } = useNativeModels(kind);
  const used = inUse && inUse.length > 0 ? inUse : [model];
  // In the menu a family of models goes by one entry: the Mac's recognition is one choice, whatever the languages.
  const families = (offered.some((m) => m.id === model.id) ? offered : [model, ...offered]).filter((m, at, all) => m.id === model.id || (m.name !== model.name && all.findIndex((one) => one.name === m.name) === at));
  return (
    <div className="kt-here">
      <div className="kt-here__row">
        <div className="kt-here__head"><span className="kt-field__label">{t('providers.localai.model')}</span></div>
        <select
          className="select-dropdown"
          aria-label={t('providers.localai.model')}
          value={`${NATIVE_ENTRY}${model.id}`}
          onChange={(e) => {
            const picked = e.target.value;
            if (picked === LOCALAI_ENTRY) other?.onPick();
            else if (picked.startsWith(NATIVE_ENTRY)) onModel(picked.slice(NATIVE_ENTRY.length));
            else onBack();
          }}
          disabled={disabled}
        >
          <option value="">{t('providers.localai.hereApp')}</option>
          {families.map((m) => <option key={m.id} value={`${NATIVE_ENTRY}${m.id}`}>{t('providers.localai.nativeEntry', { name: m.name })}</option>)}
          {other && <option value={LOCALAI_ENTRY}>{other.label}</option>}
        </select>
      </div>
      {unfit && <p className="kt-note kt-note--todo" role="status">{t(kind === 'asr' ? 'providers.localai.nativeUnheard' : 'providers.localai.translatorUnfit', { name: model.name })}</p>}
      <div className="kt-here__library">
        <div className="model-management-section">
          {/* The one in use, then the engine's others: downloaded and chosen right here. */}
          {used.map((m) => <NativeEngineCard key={m.id} kind={kind} model={m} recommended={recommendedNative(kind, m)} selected onSelect={() => undefined} disabled={disabled} />)}
          {offered.filter((m) => m.name !== model.name && !used.some((one) => one.id === m.id)).map((m) => <NativeEngineCard key={m.id} kind={kind} model={m} recommended={recommendedNative(kind, m)} selected={false} onSelect={() => onModel(m.id)} disabled={disabled} />)}
        </div>
      </div>
    </div>
  );
}

/** The LocalAI installed on this computer, as the stage cards read it. */
interface LocalAIHereState {
  /** There is one: installed, or up though something else started it. */
  present: boolean;
  up: boolean;
  starting: boolean;
  port: number;
  pipes: LocalPipelines;
}

/** Whether this computer has a LocalAI, whether it is up, and what it offers each stage — asked again each time it comes up. */
function useLocalAIHere(): LocalAIHereState {
  const status = useLocalServerStore((s) => s.status);
  const up = status.state === 'running' || status.state === 'external';
  const [pipes, setPipes] = useState<LocalPipelines>(NO_PIPELINES);
  useEffect(() => {
    if (!up) {
      setPipes(NO_PIPELINES);
      return undefined;
    }
    let live = true;
    void askLocalPipelines().then((found) => { if (live) setPipes(found); });
    return () => { live = false; };
  }, [up, status.models.length]);
  return { present: status.installed || status.state === 'external', up, starting: status.state === 'starting', port: status.port, pipes };
}

/** What a model's own menu offers besides the app's models: this computer's LocalAI. Absent where there is none. */
interface OtherRunner { label: string; onPick(): void }

/**
 * A stage run by this computer's LocalAI: who runs it — the same menu, with
 * the way back to the app's own models — and, right under it, which of the
 * LocalAI's models. The recognizer may be left to the LocalAI's pipeline; a
 * text model has to be named. While the LocalAI is down, it is started from
 * here.
 */
function LocalAIHere({ kind, model, onModel, onBack, local, disabled }: { kind: 'asr' | 'text'; model: string; onModel(id: string): void; onBack(): void; local: LocalAIHereState; disabled?: boolean }) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const options = kind === 'asr' ? local.pipes.recognizers : local.pipes.translators;
  const listed = model === '' || options.includes(model);
  const start = async () => {
    setBusy(true);
    try {
      await useLocalServerStore.getState().start();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kt-here">
      <div className="kt-here__row">
        <div className="kt-here__head"><span className="kt-field__label">{t('providers.localai.model')}</span></div>
        <select className="select-dropdown" aria-label={t('providers.localai.model')} value={LOCALAI_ENTRY} onChange={(e) => { if (e.target.value !== LOCALAI_ENTRY) onBack(); }} disabled={disabled}>
          <option value="">{t('providers.localai.hereApp')}</option>
          <option value={LOCALAI_ENTRY}>{t('providers.localai.hereLocalAI')}</option>
        </select>
      </div>
      <div className="kt-here__row kt-here__row--under">
        <select className={`select-dropdown${kind === 'text' && model === '' && local.up ? ' kt-here__select--missing' : ''}`} aria-label={t('providers.localai.hereModel')} value={model} onChange={(e) => onModel(e.target.value)} disabled={disabled}>
          <option value="">{t(kind === 'asr' ? 'providers.localai.hereModelOwn' : 'providers.localai.hereModelPick')}</option>
          {/* A saved model it no longer lists stays visible, so the setting is not silently another. */}
          {!listed && <option value={model}>{shownName(model)}</option>}
          {options.map((id) => <option key={id} value={id}>{shownName(id)}</option>)}
        </select>
      </div>
      {!local.up && (
        <div className="kt-there">
          <p className="kt-note kt-note--todo" role="status">{t(local.starting || busy ? 'providers.localai.hereStarting' : local.present ? 'providers.localai.hereStopped' : 'providers.localai.hereAbsent')}</p>
          {local.present && !local.starting && !busy && (
            <button type="button" className="kt-there__switch" onClick={() => { void start(); }} disabled={disabled}>
              <Play size={12} />
              <span>{t('providers.localai.hereStart')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * This computer's models for one stage: for each direction a run would load,
 * the model in use — chosen from the ones downloaded — and, beside it, the
 * way into the model library, which opens right here, under the choice it
 * serves. It opens by itself while a direction has no model to run: what is
 * missing is then the first thing seen.
 */
function DeviceModels({ stage, settings, update, pair, legs, disabled, tour, other, native }: Pick<Props, 'settings' | 'update' | 'pair' | 'legs' | 'disabled'> & { stage: 'asr' | 'translation'; tour?: boolean; other?: OtherRunner; native?: NativeRunner }) {
  const { t } = useTranslation();
  const engine = useNativeModels(stage);
  const device = useDeviceSettings(settings, update);
  // The catalog's own codes: the pair as Local Inference would hold it.
  const source = deviceLanguage(pair.source);
  const target = deviceLanguage(pair.target);
  const basePair = useMemo(() => ({ source, target }), [source, target]);
  const override = useMemo(() => ({ settings: device.settings, update: device.update, pair: basePair }), [device.settings, device.update, basePair]);
  const adapter = useWasmEngineAdapter(Boolean(disabled), override);
  const slots = useDeviceSlots(settings, pair, legs).filter((slot) => slot.stage === stage);
  // What is downloaded is known only once the model store has looked: until then a blank is its blank, not an answer.
  const looked = useModelInitialized();
  const missing = looked ? slots.find((slot) => !adapter.resolved(slot)) : undefined;
  // undefined: as it falls — open on what is missing. A direction's key: opened for it. null: closed by hand.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const open = picked === undefined ? missing?.dir ?? null : picked;
  const nativeFor = (slot: DeviceNeed) => (native ? engine.ready.filter((m) => nativeFits(stage, m.id, slot.source, slot.target)) : []);
  // An engine's model whose download ends while this is shown is the one wanted: it hears from then on, without being asked twice.
  const sawFetching = useRef(new Set<string>());
  useEffect(() => {
    for (const id of engine.fetching) sawFetching.current.add(id);
    const done = engine.ready.find((m) => sawFetching.current.has(m.id));
    if (!done) return;
    sawFetching.current.delete(done.id);
    if (native && !disabled && slots.some((slot) => nativeFits(stage, done.id, slot.source, slot.target))) native.onPick(done.id);
  }, [engine]); // eslint-disable-line react-hooks/exhaustive-deps
  if (slots.length === 0) return null;

  const title = (slot: DeviceNeed) => (stage === 'asr'
    ? t('providers.localai.hears', { language: adapter.languageName(deviceLanguage(slot.source)) })
    : `${adapter.languageName(deviceLanguage(slot.source))} → ${adapter.languageName(deviceLanguage(slot.target))}`);

  return (
    <div className="kt-here" {...(tour ? { 'data-tour': 'engine-chips' } : {})}>
      {slots.map((slot) => {
        const resolved = adapter.resolved(slot);
        const auto = adapter.autoPick(slot);
        const label = title(slot);
        return (
          <div className="kt-here__row" key={slot.dir}>
            <div className="kt-here__head">
              <span className="kt-field__label">{label}</span>
              <button type="button" className={`kt-here__browse${open === slot.dir ? ' is-open' : ''}`} aria-expanded={open === slot.dir} onClick={() => setPicked(open === slot.dir ? null : slot.dir)}>
                <LibraryBig size={13} />
                <span>{t('providers.localai.browse')}</span>
              </button>
            </div>
            <select
              className={`select-dropdown${resolved || !looked ? '' : ' kt-here__select--missing'}`}
              aria-label={label}
              value={resolved?.source === 'explicit' ? resolved.modelId : ''}
              onChange={(e) => {
                const value = e.target.value;
                if (value === LOCALAI_ENTRY) other?.onPick();
                else if (value.startsWith(NATIVE_ENTRY)) native?.onPick(value.slice(NATIVE_ENTRY.length));
                else void adapter.select(slot, value);
              }}
              disabled={disabled}
            >
              <option value="">{!looked ? t('providers.localai.checking') : auto ? t('providers.localai.auto', { name: adapter.displayName(auto) }) : t('providers.localai.notDownloaded')}</option>
              {nativeFor(slot).map((m) => <option key={m.id} value={`${NATIVE_ENTRY}${m.id}`}>{t('providers.localai.nativeEntry', { name: m.name })}</option>)}
              {adapter.readyCandidates(slot).map((c) => <option key={c.id} value={c.id}>{c.sizeLabel ? `${c.name} · ${c.sizeLabel}` : c.name}</option>)}
              {other && <option value={LOCALAI_ENTRY}>{other.label}</option>}
            </select>
          </div>
        );
      })}
      {open !== null && slots.some((slot) => slot.dir === open) && (
        <div className="kt-here__library">
          {/* The native engine's models first: what serves this direction best, where it was measured. */}
          {native && engine.offered.filter((m) => { const slot = slots.find((one) => one.dir === open)!; return nativeFits(stage, m.id, slot.source, slot.target); }).map((m) => (
            <div className="model-management-section kt-here__native" key={m.id}>
              <NativeEngineCard kind={stage} model={m} recommended={recommendedNative(stage, m)} selected={false} onSelect={() => native.onPick(m.id)} disabled={disabled} />
            </div>
          ))}
          <ModelManagementSection isSessionActive={Boolean(disabled)} stageFilter={stage} direction={open} settings={device.settings} update={device.update} pair={basePair} />
          {stage === 'asr' && <CustomModels disabled={Boolean(disabled)} />}
        </div>
      )}
    </div>
  );
}

/**
 * This computer's feedback model: one of the catalog's chat models. The same
 * shape as the other stages' — the model in use, and the library under it,
 * in the library's own cards — but a list of its own: only a chat model can
 * be told what feedback is.
 */
function DeviceChat({ value, onChange, disabled, other }: { value: string; onChange(id: string): void; disabled?: boolean; other?: OtherRunner }) {
  const { t } = useTranslation();
  const statuses = useModelStatuses();
  const downloads = useModelDownloads();
  const errors = useDownloadErrors();
  // Whether this computer has a graphics card for them is only known once the model store has looked: until then
  // "no" is the store's blank, not an answer, and nothing is said of it.
  const looked = useModelInitialized();
  const webgpu = useWebGPUAvailable() || !looked;
  const features = useDeviceFeatures();
  const all = deviceChatModels();
  const ready = all.filter((m) => statuses[m.id] === 'downloaded' && deviceReady(m, webgpu));
  const auto = deviceCoachModel('');
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  // Opened by itself on a gap the store has found, not on its blank before it has looked.
  const open = picked ?? (looked && ready.length === 0);
  const name = (id: string) => { const entry = getManifestEntry(id); return entry ? shortenModelName(entry.name, entry.shortName) : id; };
  const label = t('providers.localai.model');
  return (
    <div className="kt-here">
      <div className="kt-here__row">
        <div className="kt-here__head">
          <span className="kt-field__label">{label}</span>
          <button type="button" className={`kt-here__browse${open ? ' is-open' : ''}`} aria-expanded={open} onClick={() => setPicked(!open)}>
            <LibraryBig size={13} />
            <span>{t('providers.localai.browse')}</span>
          </button>
        </div>
        <select className={`select-dropdown${auto || !looked ? '' : ' kt-here__select--missing'}`} aria-label={label} value={ready.some((m) => m.id === value) ? value : ''} onChange={(e) => { if (e.target.value === LOCALAI_ENTRY) other?.onPick(); else onChange(e.target.value); }} disabled={disabled}>
          <option value="">{!looked ? t('providers.localai.checking') : auto ? t('providers.localai.auto', { name: name(auto) }) : t('providers.localai.notDownloaded')}</option>
          {ready.map((m) => <option key={m.id} value={m.id}>{`${name(m.id)} · ${getModelSizeMb(m, features)} MB`}</option>)}
          {other && <option value={LOCALAI_ENTRY}>{other.label}</option>}
        </select>
      </div>
      {open && (
        <div className="kt-here__library">
          {!webgpu && <p className="kt-note kt-note--todo">{t('providers.localai.chatModelsNoGpu')}</p>}
          <div className="model-management-section">
            <ModelGroup title={label} bare>
              {all.map((m) => {
                const runs = deviceReady(m, webgpu);
                return (
                  <ModelCard
                    key={m.id}
                    entry={m}
                    status={statuses[m.id] || 'not_downloaded'}
                    download={downloads[m.id]}
                    errorMessage={errors[m.id]}
                    isSessionActive={Boolean(disabled)}
                    // The one a run would load: the pick while it can run, else what a blank choice falls to.
                    isSelected={deviceCoachModel(value) === m.id}
                    isAutoSelected={!ready.some((r) => r.id === value) && auto === m.id}
                    isCompatible={runs}
                    compatibilityHint={runs ? undefined : t('settings.webgpuNotSupported', 'Not available in current environment')}
                    deviceFeatures={features}
                    onSelect={() => onChange(m.id)}
                    onDownload={() => { useModelStore.getState().downloadModel(m.id).catch(() => { /* The store keeps the reason, and the card shows it. */ }); }}
                    onCancel={() => useModelStore.getState().cancelDownload(m.id)}
                    onDelete={() => { void useModelStore.getState().deleteModel(m.id); }}
                  />
                );
              })}
            </ModelGroup>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Fork: under the provider, the three stages — what hears, what translates,
 * what gives grammar feedback — a card each. A card holds everything of its
 * stage in one spot: the place it runs (another device, an API, this
 * computer: the same three for all), and right under it what that place
 * needs — the model, and for an API its address and key; for this computer
 * the model library itself, to download what is missing. Nothing of a stage
 * is asked anywhere else, in either layout.
 *
 * Above the cards, the other device: the app's search of the local network
 * (`ServerFinder`), its address, and its access key. A model server on this
 * very computer (a LocalAI) is found by the same search and used the same
 * way; the card then says that it is this computer's. It is one device for
 * every stage placed on it, so it is asked once. The search runs by itself
 * only while a stage wants the device and no address is set: a settings
 * panel opened for something else asks the network nothing.
 */
export function LocalAIAssist({ settings, values, set, fill, update, disabled, pair, legs, models, readiness, check }: Props) {
  const { t } = useTranslation();
  // The places an earlier build's settings were read into are written together by the first edit made here (`PLACE_FIELDS`).
  const pinned = useRef(false);
  const latest = useRef(settings);
  latest.current = settings;
  const put = useCallback((patch: Partial<S>) => {
    if (pinned.current) {
      update(patch);
      return;
    }
    pinned.current = true;
    const now = latest.current;
    update({ ...Object.fromEntries(PLACE_FIELDS.map((field) => [field, now[field]])), ...patch } as Partial<S>);
  }, [update]);

  // A stage on this computer needs the model store loaded — what is downloaded, and what the graphics card can run.
  // The readiness check loads it too, but only after the other device has answered: with that device away, the
  // cards here would show an empty library and a computer without a graphics card.
  const here = settings.asrVia === 'device' || settings.translateAt === 'device' || (settings.coach && settings.coachAt === 'device');
  // This computer's LocalAI, where there is one: one more runner of a stage placed here, chosen in the model's own menu.
  const local = useLocalAIHere();
  const pipe = local.pipes.pipelines[0];
  /** Hands a stage to it: with the model it had there, else the one its pipeline names, else its first. */
  const toLocalAI = (patch: Partial<S>): OtherRunner | undefined => (local.present
    ? { label: t('providers.localai.hereLocalAI'), onPick: () => put({ ...patch, hereAddress: `127.0.0.1:${local.port}`, herePipeline: pipe?.name ?? settings.herePipeline }) }
    : undefined);
  const firstText = pipe?.llm || local.pipes.translators[0] || '';
  useEffect(() => {
    if (here) deviceModelsLoaded().catch(() => { /* The library's own card says why, with a retry. */ });
  }, [here]);

  const found: readonly LocalAIModel[] = models;
  const onServer = settings.asrVia === 'server';
  const serverInUse = needsServer(settings);
  const address = values.endpoint ?? '';
  // The address names this computer itself: a model server running here (a LocalAI), reached the way another device is.
  const onThisComputer = /^(?:[a-z]+:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(address.trim());
  const kotomimi = serverInUse && isKotomimiServer(found);
  const ownModels = found.filter((m) => m.from === undefined);

  // What hears on the other device.
  const pipelines = modelsFor(found, 'pipeline');
  const recognizers = modelsFor(found, 'asr');
  // What a blank pipeline field runs (`effectiveLocalAIModel`): the first pipeline named `gpt-realtime*`, else the first.
  const fallback = pipelines.find((m) => isRealtimeModelId(m.id))?.id ?? pipelines[0]?.id ?? '';
  // A leg whose answers come from a stage of its own only transcribes, and on a LocalAI takes the device's own recognizer (`localai.ts` `transcriptionFor`).
  const speechAsked = settings.translateAt !== 'server' || settings.translateServerModel.trim() !== '';
  const everyLegTranscribes = onServer && !kotomimi && speechAsked;
  const someLegTranscribes = onServer && !kotomimi && (speechAsked || settings.coach);

  // What a blank translation model on the other device runs.
  const translateDefault = serverDefaultModel(found, 'translate');
  const translateBlank = kotomimi
    ? t('providers.localai.translateKotomimiOwn')
    : onServer
      ? t('providers.localai.translateInSession')
      : translateDefault ? t('providers.localai.auto', { name: shownName(translateDefault) }) : t('providers.localai.deviceDefault');
  const coachOptions = modelsFor(found, 'coach');
  const coachDefault = serverDefaultModel(found, 'coach');
  // The device says what its models are for, and none of them is a text model.
  const coachNone = ownModels.some((m) => m.kind !== undefined) && coachOptions.length === 0;

  // The same as a pick in the search above the cards.
  const useServer = (server: FoundServer) => {
    if (server.needsKey !== settings.serverNeedsKey) put({ serverNeedsKey: server.needsKey });
    fill('endpoint', server.address);
  };

  // The other device does not answer at its address (the check's `SERVER_SILENT`). The models shown are the last it listed.
  const silent = serverInUse && !onThisComputer && readiness.state === 'not-ready' && readiness.reason.startsWith(SERVER_SILENT);

  const connectFirst = !address.trim() && <p className="kt-note kt-note--todo">{t('providers.localai.connectFirst')}</p>;
  // The first card with a stage on this computer carries the tour's anchor.
  const tourAt = settings.asrVia === 'device' && settings.asrHere === 'app' ? 'asr' : settings.translateAt === 'device' && settings.translateHere === 'app' ? 'translation' : null;
  const asrToLocalAI = toLocalAI({ asrHere: 'localai', asrHereModel: settings.asrHereModel || pipe?.transcription || '' });
  // What each leg hears: the speaker their own language, or — coached — the one they practise; the other side theirs.
  const heardByLegs = legs.map((leg) => (leg === 'speaker' && !settings.coach ? pair.source : pair.target));
  const translateToLocalAI = toLocalAI({ translateHere: 'localai', translateHereModel: settings.translateHereModel || firstText });
  // What each leg translates: the speaker the pair, the other side its reverse.
  const translatedByLegs = legs.map((leg) => (leg === 'speaker' ? pair : { source: pair.target, target: pair.source }));

  return (
    <div className="kt-stages-assist">
      <section className={`kt-device${serverInUse ? ' is-used' : ''}`} aria-label={t('providers.localai.placeServer')}>
        <h4 className="kt-card__head">
          <span className="kt-card__icon"><MonitorSmartphone size={14} /></span>
          <span className="kt-card__title">{t('providers.localai.placeServer')}</span>
        </h4>
        <ServerFinder
          hint={t('providers.localai.otherDeviceHint')}
          value={address}
          auto={serverInUse && !address.trim()}
          disabled={disabled}
          onPick={useServer}
        />
        {(serverInUse || address.trim() !== '') && (
          <>
            <Field label={t('providers.localai.endpoint')}>
              <input type="text" className="kt-input" aria-label={t('providers.localai.endpoint')} value={address} onChange={(e) => set('endpoint', e.target.value)} placeholder={t('providers.localai.endpointPlaceholder')} spellCheck={false} disabled={disabled} />
            </Field>
            {onThisComputer && <p className="kt-note">{t('providers.localai.localServerNote')}</p>}
            <ToggleSwitch checked={settings.serverNeedsKey} onChange={() => put({ serverNeedsKey: !settings.serverNeedsKey })} label={t('providers.localai.serverNeedsKey')} disabled={disabled} tooltip={t('providers.localai.serverNeedsKeyTooltip')} />
            {settings.serverNeedsKey && (
              <Field label={t('providers.localai.serverKey')}>
                <input type="password" className="kt-input" aria-label={t('providers.localai.serverKey')} value={values.serverKey ?? ''} onChange={(e) => set('serverKey', e.target.value)} placeholder={t('providers.localai.serverKey')} autoComplete="off" disabled={disabled} />
              </Field>
            )}
            {serverInUse && ownModels.length > 0 && (
              <p className="kt-note">{kotomimi ? t('providers.localai.kotomimiServer') : t('settings.modelsFound', 'Found {{count}} available models', { count: ownModels.length })}</p>
            )}
            {silent && canFindServers() && (
              <>
                <p className="kt-note kt-note--todo">{t('providers.localai.serverSilent')}</p>
                <KotomimiThere address={address} onPick={useServer} disabled={disabled} />
              </>
            )}
          </>
        )}
      </section>

      <StageCard icon={<Mic size={14} />} title={t('providers.localai.hearStage')} tooltip={t('providers.localai.hearStageTooltip')}>
        <PlaceSwitch label={t('providers.localai.hearStage')} value={settings.asrVia} onChange={(asrVia) => put({ asrVia })} disabled={disabled} />
        {settings.asrVia === 'server' && (
          <>
            {connectFirst}
            <ServerModel label={t('providers.localai.model')} value={everyLegTranscribes ? '' : settings.asrModel} blank={t('providers.localai.deviceDefault')} options={everyLegTranscribes ? [] : recognizers} onChange={(asrModel) => put({ asrModel })} disabled={disabled || everyLegTranscribes} />
            {someLegTranscribes && recognizers.length > 0 && (
              <>
                <p className="kt-note">{t('providers.localai.asrFixedNote')}</p>
                {!onThisComputer && canFindServers() && <KotomimiThere address={address} onPick={useServer} disabled={disabled} />}
              </>
            )}
            <details className="kt-details">
              <summary>{t('providers.localai.advanced')}</summary>
              <Field label={t('providers.localai.pipelineModel')}>
                <input type="text" className="kt-input" aria-label={t('providers.localai.pipelineModel')} list="localai-pipelines" value={settings.model} onChange={(e) => put({ model: e.target.value })} placeholder={fallback || t('providers.localai.deviceDefault')} spellCheck={false} disabled={disabled} />
                <datalist id="localai-pipelines">
                  {pipelines.map((m) => <option key={m.id} value={m.id} />)}
                </datalist>
              </Field>
              <p className="kt-note">{t('providers.localai.pipelineNote')}</p>
            </details>
          </>
        )}
        {settings.asrVia === 'api' && (
          <>
            <ApiFields
              id="localai-asr-api"
              kind="asr"
              others={[{ baseUrl: settings.translateBaseUrl, key: values.translateKey ?? '' }, { baseUrl: settings.coachBaseUrl, key: values.coachKey ?? '' }]}
              baseUrl={settings.asrApiBaseUrl}
              model={settings.asrApiModel}
              needsKey={settings.asrApiNeedsKey}
              apiKey={values.asrKey ?? ''}
              urlPlaceholder={t('providers.localai.asrApiBaseUrlPlaceholder')}
              modelPlaceholder={t('providers.localai.asrApiModelPlaceholder')}
              options={found.filter((m) => m.from === 'asr')}
              onChange={(p) => put({
                ...(p.baseUrl !== undefined ? { asrApiBaseUrl: p.baseUrl } : {}),
                ...(p.model !== undefined ? { asrApiModel: p.model } : {}),
                ...(p.needsKey !== undefined ? { asrApiNeedsKey: p.needsKey } : {}),
              })}
              onKey={(value) => set('asrKey', value)}
              disabled={disabled}
            />
            <p className="kt-note">{t('providers.localai.hearApiNote')}</p>
          </>
        )}
        {settings.asrVia === 'device' && (settings.asrHere === 'localai'
          ? <LocalAIHere kind="asr" model={settings.asrHereModel} onModel={(asrHereModel) => put({ asrHereModel })} onBack={() => put({ asrHere: 'app' })} local={local} disabled={disabled} />
          : settings.asrHere === 'native'
            ? <NativeHere kind="asr" model={nativeModel(settings.asrNativeModel)} inUse={[...new Map(heardByLegs.flatMap((language) => { const one = nativeModelFor(settings.asrNativeModel, language); return one ? [[one.id, one] as const] : []; })).values()]} unfit={heardByLegs.some((language) => !nativeModelFor(settings.asrNativeModel, language))} onModel={(asrNativeModel) => put({ asrNativeModel })} onBack={() => put({ asrHere: 'app' })} other={asrToLocalAI} disabled={disabled} />
            : <DeviceModels stage="asr" settings={settings} update={put} pair={pair} legs={legs} disabled={disabled} tour={tourAt === 'asr'} other={asrToLocalAI} native={{ onPick: (asrNativeModel) => put({ asrHere: 'native', asrNativeModel }) }} />)}
      </StageCard>

      <StageCard icon={<Languages size={14} />} title={t('providers.localai.translateStage')} tooltip={t('providers.localai.translateStageTooltip')}>
        <PlaceSwitch label={t('providers.localai.translateStage')} value={settings.translateAt} onChange={(translateAt) => put({ translateAt })} disabled={disabled} />
        {settings.translateAt === 'server' && (
          <>
            {connectFirst}
            <ServerModel label={t('providers.localai.model')} value={settings.translateServerModel} blank={translateBlank} options={modelsFor(found, 'translate')} onChange={(translateServerModel) => put({ translateServerModel })} disabled={disabled} />
          </>
        )}
        {settings.translateAt === 'api' && (
          <ApiFields
            id="localai-translate-api"
            kind="text"
            others={[{ baseUrl: settings.coachBaseUrl, key: values.coachKey ?? '' }, { baseUrl: settings.asrApiBaseUrl, key: values.asrKey ?? '' }]}
            baseUrl={settings.translateBaseUrl}
            model={settings.translateModel}
            needsKey={settings.translateNeedsKey}
            apiKey={values.translateKey ?? ''}
            urlPlaceholder={t('providers.localai.textBaseUrlPlaceholder')}
            modelPlaceholder={t('providers.localai.textModelPlaceholder')}
            options={modelsFor(found, 'translate', false)}
            onChange={(p) => put({
              ...(p.baseUrl !== undefined ? { translateBaseUrl: p.baseUrl } : {}),
              ...(p.model !== undefined ? { translateModel: p.model } : {}),
              ...(p.needsKey !== undefined ? { translateNeedsKey: p.needsKey } : {}),
            })}
            onKey={(value) => set('translateKey', value)}
            disabled={disabled}
          />
        )}
        {settings.translateAt === 'device' && (settings.translateHere === 'localai'
          ? <LocalAIHere kind="text" model={settings.translateHereModel} onModel={(translateHereModel) => put({ translateHereModel })} onBack={() => put({ translateHere: 'app' })} local={local} disabled={disabled} />
          : settings.translateHere === 'native'
            ? <NativeHere kind="translation" model={nativeTranslator(settings.translateNativeModel)} unfit={translatedByLegs.some((one) => !nativeTranslates(nativeTranslator(settings.translateNativeModel), one.source, one.target))} onModel={(translateNativeModel) => put({ translateNativeModel })} onBack={() => put({ translateHere: 'app' })} other={translateToLocalAI} disabled={disabled} />
            : <DeviceModels stage="translation" settings={settings} update={put} pair={pair} legs={legs} disabled={disabled} tour={tourAt === 'translation'} other={translateToLocalAI} native={{ onPick: (translateNativeModel) => put({ translateHere: 'native', translateNativeModel }) }} />)}
      </StageCard>

      <StageCard
        icon={<GraduationCap size={14} />}
        title={t('providers.localai.coachStage')}
        tooltip={t('providers.localai.coachStageTooltip')}
        lead={<ToggleSwitch checked={settings.coach} onChange={() => put({ coach: !settings.coach })} label={t('providers.localai.coach')} disabled={disabled} />}
      >
        {settings.coach && (
          <>
            <PlaceSwitch label={t('providers.localai.coachStage')} value={settings.coachAt} onChange={(coachAt) => put({ coachAt })} disabled={disabled} />
            {settings.coachAt === 'server' && (
              <>
                {connectFirst}
                {coachNone
                  ? <p className="kt-note kt-note--todo">{t('providers.localai.coachNoModel')}</p>
                  : <ServerModel label={t('providers.localai.model')} value={settings.coachServerModel} blank={coachDefault ? t('providers.localai.auto', { name: shownName(coachDefault) }) : t('providers.localai.deviceDefault')} options={coachOptions} onChange={(coachServerModel) => put({ coachServerModel })} disabled={disabled} />}
              </>
            )}
            {settings.coachAt === 'api' && (
              <ApiFields
                id="localai-coach-api"
                kind="text"
                others={[{ baseUrl: settings.translateBaseUrl, key: values.translateKey ?? '' }, { baseUrl: settings.asrApiBaseUrl, key: values.asrKey ?? '' }]}
                baseUrl={settings.coachBaseUrl}
                model={settings.coachModel}
                needsKey={settings.coachNeedsKey}
                apiKey={values.coachKey ?? ''}
                urlPlaceholder={t('providers.localai.textBaseUrlPlaceholder')}
                modelPlaceholder={t('providers.localai.textModelPlaceholder')}
                options={modelsFor(found, 'coach', false)}
                onChange={(p) => put({
                  ...(p.baseUrl !== undefined ? { coachBaseUrl: p.baseUrl } : {}),
                  ...(p.model !== undefined ? { coachModel: p.model } : {}),
                  ...(p.needsKey !== undefined ? { coachNeedsKey: p.needsKey } : {}),
                })}
                onKey={(value) => set('coachKey', value)}
                disabled={disabled}
              />
            )}
            {settings.coachAt === 'device' && (settings.coachHere === 'localai'
              ? <LocalAIHere kind="text" model={settings.coachHereModel} onModel={(coachHereModel) => put({ coachHereModel })} onBack={() => put({ coachHere: 'app' })} local={local} disabled={disabled} />
              : <DeviceChat value={settings.coachDeviceModel} onChange={(coachDeviceModel) => put({ coachDeviceModel })} disabled={disabled} other={toLocalAI({ coachHere: 'localai', coachHereModel: settings.coachHereModel || firstText })} />)}
            <details className="kt-details">
              <summary>{t('providers.localai.coachPrompt')}</summary>
              <textarea
                className="kt-input kt-prompt"
                aria-label={t('providers.localai.coachPrompt')}
                rows={4}
                value={settings.coachPrompt}
                onChange={(e) => put({ coachPrompt: e.target.value })}
                // The two placeholder names are handed in as values, so i18next prints them instead of reading them as its own.
                placeholder={t('providers.localai.coachPromptPlaceholder', { spoken: '{{SPOKEN}}', native: '{{NATIVE}}' })}
                disabled={disabled}
              />
              {/* What goes up while the box is blank: chosen by the two languages of the pair. */}
              <p className="kt-note">{t('providers.localai.coachPromptPreview')}</p>
              <pre>{coachPrompt(pair.target, pair.source).system}</pre>
            </details>
          </>
        )}
      </StageCard>

      {/* Whether all of it can start, in words: asked again by itself after an edit, and by hand here. */}
      <div className={`kt-ready kt-ready--${readiness.state}`} role="status">
        {readiness.state === 'ready' && <><CircleCheck size={15} /><span>{t('providers.localai.ready')}</span></>}
        {readiness.state === 'checking' && <><Loader size={15} className="kt-ready__spin" /><span>{t('providers.localai.checking')}</span></>}
        {check && readiness.state !== 'checking' && (
          <button type="button" className="kt-ready__again" onClick={check} disabled={disabled}>
            <RefreshCw size={12} />
            <span>{readiness.state === 'ready' ? t('providers.localai.recheck') : t('providers.localai.checkNow')}</span>
          </button>
        )}
      </div>
    </div>
  );
}
