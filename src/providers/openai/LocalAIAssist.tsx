import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, GraduationCap, Languages, LibraryBig, Loader, Mic, MonitorSmartphone, RefreshCw, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { ServerFinder, type FinderStage } from '../../components/LanSharing/ServerFinder';
import ToggleSwitch from '../../components/Settings/shared/ToggleSwitch';
import Tooltip from '../../components/Tooltip/Tooltip';
import { canFindServers, findServers, phoneBase, phoneHears, phoneLends, plainAddress, type FoundServer, type PhoneTextModel } from '../../lib/lan/discover';
import { useKnownDeviceStore } from '../../lib/lan/knownDevices';
import { phoneKey, setPhoneKey } from '../../lib/lan/phoneKeys';
import { engineNode } from '../../lib/native/remoteEngine';
import { modelLabel } from '../../lib/lan/modelLabel';
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { shortenModelName } from '../../lib/local-inference/modelName';
import type { CredentialAssistProps } from '../../lib/provider/types';
import { useHeardByStore } from '../../stores/heardByStore';
import { useTranslatedByStore } from '../../stores/translatedByStore';

import { ApiModelPicker } from './ApiModelPicker';
import { savedKeyOf } from './apiServiceKey';
import { API_SERVICES, preferredModel, serviceOf, servicesFor, type ApiKind, type ApiService } from './apiServices';
import { coachPrompt } from './coachPrompt';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { coachesAtOwnDevice, coachesOnShared, deviceLanguage, hearingPlace, hearsAtOwnDevice, needsServer, PLACE_FIELDS, PLACES, translatePlace, translatesAtOwnDevice, type DeviceNeed, type Place } from './localaiDevice';
import { NATIVE_MODELS, hearingPick, isApple, isAutoLanguage, nativeDownloaded, nativeEither, nativeEngineOf, nativeHears, nativeModel, nativeModelFor, nativePicked } from './localaiNative';
import { chooseNativeRow, nativeChoiceFix, nativeChoiceRows, nativeRowChoice } from './nativeChoices';
import { alsoFirst, alsoSpoken, detectsOther, heardBy, speaksBoth } from './localaiDevice';
import { languageLabel } from '../../lib/language/label';
import { NativeEngineCard, nativeStoreOf, type NativeCardModel, type NativeKind } from './NativeEngineCard';
import { NATIVE_TRANSLATORS, nativeTranslates, nativeTranslator } from './nativeTranslators';
import { NATIVE_COACHES, nativeCoach } from './nativeCoaches';
import { lentChoice } from './phoneText';
import { useNativeStageSlots } from './LocalAIEngine';
import { recommendNativeModel, type NativeRecommendation } from './nativeRecommendation';
import { useNativeRecommendationInputs } from './useNativeRecommendationInputs';
import { fitsPair, isKotomimiServer, modelsFor, SERVER_SILENT, serverDefaultModel, translationDefault, type LocalAIModel } from './localaiModels';
import { choiceOf, perLanguage, recognizerChoices } from './serverRecognizers';
import { isRealtimeModelId } from './settings';
import { SpeedLine, useSpeedTest } from './SpeedTestView';
import { PlanCard, gb } from './PlanCard';
import { usePlans } from './usePlans';
import { currentNativeModels, nativeModelFit, type NativeStage } from './nativePlans';
import { sessionLags } from '../../app/sessionLags';
import { useStore } from 'zustand';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
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
  const native = NATIVE_MODELS.find((m) => m.id === id) ?? NATIVE_TRANSLATORS.find((m) => m.id === id) ?? NATIVE_COACHES.find((m) => m.id === id);
  if (native) return id.includes(':') ? `${native.name} (${id.slice(id.indexOf(':') + 1)})` : native.name;
  return modelLabel(id);
}

/** A labelled control. */
function Field({ label, aside, children }: { label: string; aside?: string; children: ReactNode }) {
  return (
    <label className="kt-field">
      <span className="kt-field__label">{label}{aside && <span className="kt-field__aside">{aside}</span>}</span>
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
function StageCard({ id, icon, title, tooltip, lead, children }: { id?: string; icon: ReactNode; title: string; tooltip: string; lead?: ReactNode; children?: ReactNode }) {
  return (
    <section className="kt-card" aria-label={title} {...(id ? { id } : {})}>
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
function ServerModel({ label, value, blank, options, onChange, disabled, aside, present = false }: { label: string; value: string; blank: string; options: ReadonlyArray<Pick<LocalAIModel, 'id'>>; onChange(id: string): void; disabled?: boolean; aside?: string; present?: boolean }) {
  const { t } = useTranslation();
  const listed = value === '' || options.some((m) => m.id === value);
  // Fork: `present`: the device has it, only not for a language of this run (said under the menu) — it is not gone.
  return (
    <Field label={label} aside={aside}>
      <select className="select-dropdown" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{blank}</option>
        {/* A saved model the device no longer lists stays visible, so the setting is not silently another — and where
            the device did list its models, it is said that this one is not among them. */}
        {!listed && <option value={value}>{options.length > 0 && !present ? t('providers.localai.modelGone', { name: shownName(value) }) : shownName(value)}</option>}
        {options.map((m) => <option key={m.id} value={m.id}>{shownName(m.id)}</option>)}
      </select>
    </Field>
  );
}

/**
 * A device a stage can be given beside the shared one (a phone, an iPad), by its address, its name where it gave one,
 * and whether it answered last time it was asked (`knownDevices.ts`): one not answering now stays chosen.
 */
interface OwnDevice { address: string; name: string; reachable?: boolean }

/**
 * A stage's device, where there is more than the shared one to run it: the device the stages share first (by the
 * name the search knew it by, else its address), then the phones that lend what the stage runs. `value`: the phone's
 * address, blank for the shared device.
 */
function StageDevice({ value, shared, phones, onChange, disabled }: { value: string; shared: string; phones: readonly OwnDevice[]; onChange(address: string): void; disabled?: boolean }) {
  const { t } = useTranslation();
  const label = t('providers.localai.stageDevice');
  return (
    <Field label={label}>
      <select className="select-dropdown" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        <option value="">{shared}</option>
        {phones.map((phone) => {
          // As it names itself (an iPad, a MacBook, a phone): its address where it gave no name.
          const named = phone.name || plainAddress(phone.address).replace(/:\d+$/, '');
          return <option key={phone.address} value={plainAddress(phone.address)}>{phone.reachable === false ? t('providers.localai.deviceAway', { name: named }) : named}</option>;
        })}
      </select>
    </Field>
  );
}

/** A text model a phone lends, by the name it has here where it is one of this computer's own, else by the phone's. */
const lentName = (m: Pick<PhoneTextModel, 'id' | 'name'>): string => (NATIVE_TRANSLATORS.some((n) => n.id === m.id) || NATIVE_COACHES.some((n) => n.id === m.id) ? shownName(m.id) : m.name || shownName(m.id));

/**
 * The model a text stage asks of a phone, among the ones of that kind it lends — chosen here, and shown alone where
 * it lends only one. `lent`: what the search last found it lending; null where it was not found this time (asleep,
 * or no search made yet): the saved model stays visible, so the setting is not silently another.
 */
function PhoneModel({ value, lent, onChange, disabled }: { value: string; lent: readonly PhoneTextModel[] | null; onChange(id: string): void; disabled?: boolean }) {
  const { t } = useTranslation();
  const label = t('providers.localai.model');
  const options = lent ?? [];
  const listed = options.some((m) => m.id === value);
  return (
    <Field label={label}>
      <select className="select-dropdown" aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled || (listed && options.length === 1)}>
        {!listed && <option value={value}>{lent ? t('providers.localai.modelGone', { name: shownName(value) }) : shownName(value)}</option>}
        {options.map((m) => <option key={m.id} value={m.id}>{m.fits === false ? t('providers.localai.phoneModelTooBig', { name: lentName(m) }) : lentName(m)}</option>)}
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
      <ApiModelPicker
        id={id}
        label={t('providers.localai.model')}
        model={model}
        placeholder={service ? t(service.modelHintKey ?? 'providers.localai.apiServiceModel') : modelPlaceholder}
        baseUrl={baseUrl}
        needsKey={needsKey}
        apiKey={apiKey}
        known={options.map((m) => m.id)}
        service={service}
        kind={kind}
        onModel={(next) => onChange({ model: next })}
        onTyping={setTyping}
        disabled={disabled}
      />
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

/** And of the entries that hand hearing to the native engine, one for each of its models. */
const NATIVE_ENTRY = '\u0000native:';
/** The native translation engine's single row: it runs one model for every direction, not one a direction. */
const ENGINE_ROW = '\u0000engine';

/** A stage's native models, as their cards and menus read them. */
const NATIVE_OF: Record<NativeKind, readonly NativeCardModel[]> = { asr: NATIVE_MODELS, translation: NATIVE_TRANSLATORS, coach: NATIVE_COACHES };

/** Whether a native model serves a direction: hears its language, or translates its pair. */
const nativeFits = (kind: NativeKind, id: string, source: string, target: string): boolean => (kind === 'asr'
  ? nativeHears(nativeModel(id), source)
  : kind === 'translation' ? nativeTranslates(nativeTranslator(id), source, target) : true);

/** A stage's native models this computer can run, and which of them are downloaded or on their way. */
function useNativeModels(kind: NativeKind): { offered: readonly NativeCardModel[]; ready: readonly NativeCardModel[] } {
  const status = nativeStoreOf(kind)((s) => s.status);
  return useMemo(() => {
    // The main process lists the models this system is offered: one it leaves out has no card here.
    // One no longer offered (`retired`) keeps its card only where it is already on this computer: to be used, or removed.
    const offered = status.supported ? NATIVE_OF[kind].filter((m) => status.models[m.id] !== undefined && (!m.retired || status.models[m.id].state !== 'absent')) : [];
    return { offered, ready: offered.filter((m) => nativeDownloaded(status, m.id)) };
  }, [status, kind]);
}

/** Download intent belongs to the stage, so closing its library cannot lose the target row. */
function useNativeDownloads(kind: NativeKind, disabled: boolean | undefined, select: (id: string, slot?: DeviceNeed) => void) {
  const status = nativeStoreOf(kind)((s) => s.status);
  const pending = useRef(new Map<string, { slot?: DeviceNeed; fetching: boolean }>());
  useEffect(() => {
    for (const [id, intent] of pending.current) {
      const state = status.models[id]?.state;
      if (nativeDownloaded(status, id)) {
        pending.current.delete(id);
        if (!disabled) select(id, intent.slot);
      } else if (status.engine === 'downloading' || state === 'downloading' || state === 'verifying') intent.fetching = true;
      else if (state === 'failed' || intent.fetching) pending.current.delete(id);
    }
  }, [status, disabled, select]);
  return (id: string, slot?: DeviceNeed) => { pending.current.set(id, { slot, fetching: false }); };
}

/** The button that opens a stage's model library, the same in every menu of "this computer". */
function BrowseButton({ open, onToggle }: { open: boolean; onToggle(): void }) {
  const { t } = useTranslation();
  return (
    <button type="button" className={`kt-here__browse${open ? ' is-open' : ''}`} aria-expanded={open} onClick={onToggle}>
      <LibraryBig size={13} />
      <span>{t('providers.localai.browse')}</span>
    </button>
  );
}

/** What a model's own menu offers of a native engine: its downloaded models, and the way to hand the stage to one. */
interface NativeRunner {
  /** A model of the engine is to run the stage: for one row where a row was chosen in, for every row it serves otherwise. */
  onPick(id: string, slot?: DeviceNeed): void;
  /** Present while the engine runs the stage: the model that serves a row, or null where none is chosen for it. */
  inUse(slot?: DeviceNeed): NativeCardModel | null;
}

/** The value of a language's menu while no native model hears it. No model's id. */
const NONE_ENTRY = '\u0000none';


/**
 * This computer's models for one stage: for each direction a run would load,
 * the model in use — chosen from the ones downloaded — and, beside it, the
 * way into the model library, which opens right here, under the choice it
 * serves. It opens by itself while a direction has no model to run: what is
 * missing is then the first thing seen.
 */
function DeviceModels({ stage, settings, update, pair, legs, models, disabled, tour, native, below }: Pick<Props, 'settings' | 'update' | 'pair' | 'legs' | 'models' | 'disabled'> & { stage: 'asr' | 'translation'; tour?: boolean; native: NativeRunner; /** Drawn under the rows. */ below?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const engine = useNativeModels(stage);
  const status = nativeStoreOf(stage)((one) => one.status);
  const source = deviceLanguage(pair.source);
  const target = deviceLanguage(pair.target);
  const nameOf = (code: string) => languageLabel(deviceLanguage(code), i18n.language);
  const slots = useNativeStageSlots(settings, pair, legs, models).filter((slot) => slot.stage === stage);
  /**
   * Fork: the native translation engine runs one model for the whole stage, not a copy for each direction (unlike
   * the app's own models). Its rows are drawn as the one choice it is, and the menu lists only models that take
   * every direction this run translates: a model offered for one direction would be the wrong one for the other
   * (`translatorUnfit`). The recognizer's engine keeps its rows, one a language (`byLanguage`).
   */
  const engineOne = stage === 'translation';
  const engineFits = (id: string): boolean => slots.every((slot) => nativeFits('translation', id, slot.source, slot.target));
  // What is downloaded is known only once the native engine has looked: until then a blank is its blank, not an answer.
  const looked = nativeStoreOf(stage)((one) => one.asked);
  /** The language a row hears: where the engine hears, the other side's may be left to be detected. */
  const heardIn = (slot: DeviceNeed): string => (stage === 'asr' ? heardBy(settings, pair, slot.leg) : slot.source);
  /** The engine's model that serves a row; null: the engine runs the stage and none is chosen for the row; undefined: the app's own models run it. */
  const using = (slot: DeviceNeed): NativeCardModel | null => native.inUse(slot);
  /**
   * Fork: the speaker heard in either of the pair's languages: the Mac's recognition hears that too, where it has both
   * (`nativeEither`) — offered for them as their own language's model.
   */
  const hearsEither = (id: string, slot: DeviceNeed): boolean => stage === 'asr' && slot.leg === 'speaker' && isAutoLanguage(heardIn(slot)) && isApple(id)
    && nativeModelFor(id, slot.source)?.id === id && nativeEither({ model: id, either: { own: pair.source, others: [alsoFirst(settings, pair) ?? pair.target] } }, (one) => nativeDownloaded(status, one)) !== null;
  const choiceRows = nativeChoiceRows(settings, pair, legs);
  const fits = (id: string, slot: DeviceNeed): boolean => stage === 'asr' ? nativeRowChoice(choiceRows, slot.leg, id).ok : nativeFits(stage, id, heardIn(slot), slot.target);
  /** Keep the row's candidates even when another row, or one of its detected languages, prevents choosing them. */
  const offers = (id: string, slot: DeviceNeed): boolean => stage === 'asr'
    ? nativeFits(stage, id, heardIn(slot), slot.target) || hearsEither(id, slot) || nativeFits(stage, id, slot.source, slot.target)
      || isAutoLanguage(heardIn(slot)) && !isApple(id) && (choiceRows.find((row) => row.key === slot.leg)?.languages.some((code) => nativeHears(nativeModel(id), code)) ?? false)
    : fits(id, slot);
  /** A row with nothing to run, or whose model needs the person: not on this computer yet, or the engine failed with it. */
  const wanting = (slot: DeviceNeed): boolean => {
    const model = using(slot);
    return model === null || !nativeDownloaded(status, model.id) || (status.run.state === 'failed' && status.run.model === model.id);
  };
  const missing = slots.find(wanting);
  // undefined: as it falls — open on what is missing. A direction's key: opened for it. null: closed by hand.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const open = picked === undefined ? missing?.dir ?? null : picked;
  /** The engine's models a row can be given: the downloaded ones that serve it, and the one in use whatever its state. */
  const nativeFor = (slot: DeviceNeed): readonly NativeCardModel[] => {
    if (!native) return [];
    const ready = engine.ready.filter((m) => offers(m.id, slot));
    const mine = using(slot);
    return mine && !ready.some((m) => m.id === mine.id) ? [mine, ...ready] : ready;
  };
  // Fork: the one model recommended in a list: the recommended plan's for this stage (`nativePlans.ts`), and why.
  const { memoryMB, lending } = useNativeRecommendationInputs();
  const { plans, recommended } = usePlans(settings, pair);
  const plan = plans.find((p) => p.id === recommended)!;
  const advise = (kind: 'asr' | 'translation', offered: readonly NativeCardModel[], languages: readonly string[], at: NativeStage): { id: string | null; hint?: string } => {
    // The Mac's own recognition is the most accurate there, and leads its list.
    if (kind === 'asr' && offered[0] && isApple(offered[0].id)) return { id: offered[0].id };
    // Not answered yet: no mark, and the list in its own order, rather than one that moves when the answer comes.
    if (memoryMB === undefined) return { id: null };
    const advice: NativeRecommendation = recommendNativeModel(kind, offered.map((m) => m.id), memoryMB, lending, languages, { plan, stage: at });
    const said = advice.reason !== 'default' ? advice.reason
      : advice.id === 'qwen3-asr-0.6b-q8' ? 'hearDefault'
        : advice.id === 'index-translate-2b' ? 'translateDefault'
          : null;
    return { id: advice.id, ...(said ? { hint: t(`providers.localai.recommendWhy.${said}`) } : {}) };
  };
  // Fork: how well each model runs here beside the other stages' models (`nativeModelFit`), as its card's chip.
  const behind = useStore(sessionLags.state, (s) => s.fallingBehind);
  const fitOf = (id: string, at: NativeStage) => {
    const { fit, needMB, leftMB } = nativeModelFit(id, at, currentNativeModels(settings, pair), memoryMB, Object.values(behind).map((one) => one!.model));
    if (fit === null || fit === 'cpu') return undefined;
    const tone = fit === 'smooth' ? 'ok' as const : fit === 'maybe-slow' ? 'warn' as const : 'bad' as const;
    const label = t(fit === 'smooth' ? 'fork.fit.smooth' : fit === 'maybe-slow' ? 'fork.fit.maybeSlow' : 'fork.fit.cannot');
    return { label, tone, hint: t('fork.fit.hint', { need: gb(needMB ?? 0), left: gb(Math.max(0, leftMB ?? 0)) }) };
  };
  /** The list with the recommended one first. */
  const leading = <M extends NativeCardModel>(list: readonly M[], id: string | null): M[] => [...list.filter((m) => m.id === id), ...list.filter((m) => m.id !== id)];
  const downloading = useNativeDownloads(stage, disabled, (id, slot) => {
    if (engineOne ? engineFits(id) : slot && slots.some((current) => current.dir === slot.dir && current.leg === slot.leg) && fits(id, slot)) native.onPick(id, slot);
  });
  if (slots.length === 0) return null;
  if (looked && !status.supported) return <p className="kt-note">{t('providers.localai.nativeUnsupportedShort')}</p>;

  // The native translation engine, as the one model it runs: a model that takes every direction this run translates.
  if (engineOne) {
    const mine = native.inUse();
    const ready = engine.ready.filter((m) => engineFits(m.id));
    // A model chosen before and no longer offered still stands, so the setting is not silently another.
    const shown = mine && !ready.some((m) => m.id === mine.id) ? [mine, ...ready] : ready;
    const nothing = mine ? null : looked ? t('providers.localai.nativeNone') : t('providers.localai.checking');
    // Open on what needs the person: no model chosen, or the chosen one not on this computer yet.
    const missingModel = mine === null || !nativeDownloaded(status, mine.id);
    const libraryOpen = picked === undefined ? (looked && missingModel) : picked === ENGINE_ROW;
    const fittingAll = engine.offered.filter((m) => engineFits(m.id));
    const advice = advise('translation', fittingAll, [], 'translation');
    const label = slots.length > 1
      ? `${nameOf(source)} ⇄ ${nameOf(target)}`
      : `${nameOf(deviceLanguage(slots[0]!.source))} → ${nameOf(deviceLanguage(slots[0]!.target))}`;
    return (
      <div className="kt-here" {...(tour ? { 'data-tour': 'engine-chips' } : {})}>
        <div className="kt-here__row">
          <div className="kt-here__head">
            <span className="kt-field__label">{label}</span>
            <BrowseButton open={libraryOpen} onToggle={() => setPicked(libraryOpen ? null : ENGINE_ROW)} />
          </div>
          <select
            className={`select-dropdown${nothing === null ? '' : ' kt-here__select--missing'}`}
            aria-label={label}
            value={mine ? `${NATIVE_ENTRY}${mine.id}` : NONE_ENTRY}
            onChange={(e) => {
              const value = e.target.value;
              if (value === NONE_ENTRY) return;
              if (value.startsWith(NATIVE_ENTRY)) native.onPick(value.slice(NATIVE_ENTRY.length));
            }}
            disabled={disabled}
          >
            {nothing !== null && <option value={NONE_ENTRY}>{nothing}</option>}
            {shown.length > 0 && (
              <optgroup label={t('providers.localai.groupNative')}>
                {shown.map((m) => <option key={m.id} value={`${NATIVE_ENTRY}${m.id}`}>{m.name}</option>)}
              </optgroup>
            )}
          </select>
          {mine && !engineFits(mine.id) && <p className="kt-note kt-note--todo" role="status">{t('providers.localai.translatorUnfit', { name: mine.name })}</p>}
        </div>
        {below}
        {libraryOpen && (
          <div className="kt-here__library">
            {/* The engine's models that take every direction: one model, so one list. The app's own are chosen a
                direction at a time, in the rows the menu's "app's own models" entry goes back to. */}
            {fittingAll.length > 0 && (
              <div className="model-management-section kt-here__native">
                <div className="model-subgroup">
                  <div className="model-subgroup__label"><Star size={11} />{t('models.recommendedGroup', 'Recommended')}</div>
                  {leading(fittingAll, advice.id).map((m) => <NativeEngineCard key={m.id} kind="translation" model={m} onDownloadStarted={() => downloading(m.id)} recommended={m.id === advice.id} {...(advice.hint ? { recommendHint: advice.hint } : {})} fit={fitOf(m.id, 'translation')} selected={mine?.id === m.id} onSelect={() => { if (mine?.id !== m.id) native.onPick(m.id); }} disabled={disabled} />)}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // The native models that serve the direction whose library is open, best first.
  const openSlot = slots.find((slot) => slot.dir === open);
  const fitting = native && openSlot ? engine.offered.filter((m) => offers(m.id, openSlot)) : [];
  const usedThere = openSlot ? using(openSlot) : undefined;
  // Fork: a row whose language is left to be detected lists apart the models that tell languages apart and those that
  // must be told one: the latter greyed, under a name of their own, so that what can hear it shows by where it is.
  const detectRow = stage === 'asr' && !!openSlot && isAutoLanguage(heardIn(openSlot));
  const tellApart = detectRow ? fitting.filter((m) => nativeModel(m.id).detects || hearsEither(m.id, openSlot!)) : fitting;
  const mustBeTold = detectRow && native ? engine.offered.filter((m) => !tellApart.includes(m)) : [];
  // What the open row must hear: its language; where it is detected, the user's own languages; else unknown.
  const rowLanguages = !openSlot ? [] : !detectRow ? [heardIn(openSlot)] : openSlot.leg === 'speaker' ? [pair.source, ...alsoSpoken(settings, pair)] : [];
  const at: NativeStage = stage === 'asr' ? (openSlot?.leg === 'participant' ? 'participant' : 'speaker') : 'translation';
  const advice = advise(stage === 'asr' ? 'asr' : 'translation', tellApart, rowLanguages, at);

  const title = (slot: DeviceNeed) => {
    if (stage !== 'asr') return `${nameOf(deviceLanguage(slot.source))} → ${nameOf(deviceLanguage(slot.target))}`;
    // A leg whose language is left to be detected: the other side's, in any language, or the user's own in either of the pair's (`speakBoth`).
    const heard = heardIn(slot);
    const named = (code: string) => nameOf(deviceLanguage(code));
    if (!isAutoLanguage(heard)) return t('providers.localai.hears', { language: named(heard) });
    return slot.leg === 'speaker' ? t('providers.localai.hearsEither', { first: named(pair.source), second: named(alsoFirst(settings, pair) ?? pair.target) }) : t('providers.localai.hearsOther');
  };

  // Fork: why a recognizer cannot be this row's (`nativeRowChoice`): the language it would leave unheard, here or on a
  // row it would have to take over. Null: it can.
  const blockedFor = (slot: DeviceNeed | undefined, id: string): string | null => {
    if (stage !== 'asr' || !slot) return null;
    const choice = nativeRowChoice(choiceRows, slot.leg, id);
    if (choice.ok) return null;
    return choice.unheard === 'auto' ? t('fork.rows.noDetect') : t('fork.rows.unheard', { language: nameOf(choice.unheard) });
  };
  // Fork: two models on one engine, chosen before this was refused: one press puts every row on one.
  const fix = stage === 'asr' ? nativeChoiceFix(settings, choiceRows, engine.offered.map((m) => m.id)) : null;
  const fixButton = fix && (
    <button type="button" className="kt-here__fix" onClick={() => update(fix.patch)} disabled={disabled}>
      {t('fork.rows.fix', { model: nativeModel(fix.model).name.replace(/ GGUF$/, '') })}
    </button>
  );

  return (
    <div className="kt-here" {...(tour ? { 'data-tour': 'engine-chips' } : {})}>
      {slots.map((slot) => {
        const label = title(slot);
        const mine = using(slot);
        const natives = nativeFor(slot);
        const nothing = mine ? null : t('providers.localai.nativeNone');
        return (
          <div className="kt-here__row" key={slot.dir}>
            <div className="kt-here__head">
              <span className="kt-field__label">{label}</span>
              <BrowseButton open={open === slot.dir} onToggle={() => setPicked(open === slot.dir ? null : slot.dir)} />
            </div>
            <select
              className={`select-dropdown${(mine !== null) ? '' : ' kt-here__select--missing'}`}
              aria-label={label}
              value={mine ? `${NATIVE_ENTRY}${mine.id}` : NONE_ENTRY}
              onChange={(e) => {
                const value = e.target.value;
                if (value === NONE_ENTRY) return;
                if (value.startsWith(NATIVE_ENTRY)) native.onPick(value.slice(NATIVE_ENTRY.length), slot);

              }}
              disabled={disabled}
            >
              {nothing !== null && <option value={NONE_ENTRY}>{nothing}</option>}
              {natives.length > 0 && (
                <optgroup label={t('providers.localai.groupNative')}>
                  {natives.map((m) => {
                    const blocked = m.id === mine?.id ? null : blockedFor(slot, m.id);
                    return <option key={m.id} value={`${NATIVE_ENTRY}${m.id}`} disabled={blocked !== null}>{blocked ? `${m.name}（${blocked}）` : m.name}</option>;
                  })}
                </optgroup>
              )}

            </select>
            {mine === null && <p className="kt-note kt-note--todo" role="status">{isAutoLanguage(heardIn(slot)) ? t('providers.localai.detectOtherNeeds') : t('providers.localai.nativeUnchosen', { source: languageLabel(heardIn(slot), i18n.language) })}</p>}
            {mine && !fits(mine.id, slot) && <p className="kt-note kt-note--todo" role="status">{t(stage === 'asr' ? 'providers.localai.nativeUnheard' : 'providers.localai.translatorUnfit', { name: mine.name })}{fix?.row === slot.leg && fixButton}</p>}
            {/* The engine runs one of its models at a time (`chooseNative` moves a language over where it can): said
                here, on the row, not first at Start. Said once, on the later row. */}
            {(() => {
              if (stage !== 'asr' || !mine || isApple(mine.id) || !fits(mine.id, slot)) return null;
              const before = slots.slice(0, slots.indexOf(slot)).map(using).find((other) => other && !isApple(other.id) && other.id !== mine.id && nativeEngineOf(other.id) === nativeEngineOf(mine.id));
              return before ? <p className="kt-note kt-note--todo" role="status">{t('providers.localai.nativeTwoModels', { name: mine.name, other: before.name })}{fix?.row !== slot.leg && fixButton}</p> : null;
            })()}
          </div>
        );
      })}
      {below}
      {open !== null && openSlot && (
        <div className="kt-here__library">
          {/* The native engines' models first, as a group of their own: what serves this direction best, where it was measured. */}
          {(tellApart.length > 0 || mustBeTold.length > 0) && (
            <div className="model-management-section kt-here__native">
              {tellApart.length > 0 && (
                <div className="model-subgroup">
                  <div className="model-subgroup__label">{detectRow ? t('models.detectsGroup') : <><Star size={11} />{t('models.recommendedGroup', 'Recommended')}</>}</div>
                  {leading(tellApart, advice.id).map((m) => <NativeEngineCard key={m.id} kind={stage} model={m} onDownloadStarted={() => downloading(m.id, openSlot)} recommended={m.id === advice.id} {...(advice.hint ? { recommendHint: advice.hint } : {})} fit={fitOf(m.id, at)} blocked={usedThere?.id === m.id ? null : blockedFor(openSlot, m.id)} selected={usedThere?.id === m.id} onSelect={() => { if (usedThere?.id !== m.id) native.onPick(m.id, openSlot); }} disabled={disabled} />)}
                </div>
              )}
              {mustBeTold.length > 0 && (
                <div className="model-subgroup model-subgroup--off">
                  <div className="model-subgroup__label">{t('models.namedGroup')}</div>
                  {mustBeTold.map((m) => <NativeEngineCard key={m.id} kind={stage} model={m} onDownloadStarted={() => downloading(m.id, openSlot)} recommended={false} selected={false} onSelect={() => undefined} disabled />)}
                </div>
              )}
            </div>
          )}

        </div>
      )}
    </div>
  );
}

function DeviceChat({ disabled, native }: { disabled?: boolean; native: NativeRunner }) {
  const { t } = useTranslation();
  const engine = useNativeModels('coach');
  // The native feedback engine's model whose download ends while this is shown is the one wanted: it is used from then on.
  const downloading = useNativeDownloads('coach', disabled, (id) => native.onPick(id));
  const status = nativeStoreOf('coach')((one) => one.status);
  const looked = nativeStoreOf('coach')((one) => one.asked);
  const mine = native.inUse();
  const natives = mine && !engine.ready.some((m) => m.id === mine.id) ? [mine, ...engine.ready] : engine.ready;
  const [picked, setPicked] = useState<boolean | undefined>(undefined);
  const open = picked ?? (!mine || !nativeDownloaded(status, mine.id) || (status.run.state === 'failed' && status.run.model === mine.id));
  const nothing = mine ? null : t('providers.localai.nativeNone');
  const label = t('providers.localai.model');
  if (looked && !status.supported) return <p className="kt-note">{t('providers.localai.nativeUnsupportedShort')}</p>;
  return (
    <div className="kt-here">
      <div className="kt-here__row">
        <div className="kt-here__head">
          <span className="kt-field__label">{label}</span>
          <BrowseButton open={open} onToggle={() => setPicked(!open)} />
        </div>
        <select
          className={`select-dropdown${mine ? '' : ' kt-here__select--missing'}`}
          aria-label={label}
          value={mine ? `${NATIVE_ENTRY}${mine.id}` : NONE_ENTRY}
          onChange={(e) => {
            const picked = e.target.value;
            if (picked === NONE_ENTRY) return;
            if (picked.startsWith(NATIVE_ENTRY)) native.onPick(picked.slice(NATIVE_ENTRY.length));

          }}
          disabled={disabled}
        >
          {nothing !== null && <option value={NONE_ENTRY}>{nothing}</option>}
          {natives.length > 0 && (
            <optgroup label={t('providers.localai.groupNative')}>
              {natives.map((m) => <option key={m.id} value={`${NATIVE_ENTRY}${m.id}`}>{m.name}</option>)}
            </optgroup>
          )}

        </select>
      </div>
      {open && (
        <div className="kt-here__library">
          {/* The native feedback engine's models first, as a group of their own. */}
          {native && engine.offered.length > 0 && (
            <div className="model-management-section kt-here__native">
              <div className="model-subgroup">
                <div className="model-subgroup__label"><Star size={11} />{t('models.recommendedGroup', 'Recommended')}</div>
                {engine.offered.map((m, at) => <NativeEngineCard key={m.id} kind="coach" model={m} onDownloadStarted={() => downloading(m.id)} recommended={at === 0} selected={mine?.id === m.id} onSelect={() => { if (mine?.id !== m.id) native.onPick(m.id); }} disabled={disabled} />)}
              </div>
            </div>
          )}

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
  const { t, i18n } = useTranslation();
  // The places an earlier build's settings were read into are written together by the first edit made here (`PLACE_FIELDS`).
  const pinned = useRef(false);
  const latest = useRef(settings);
  latest.current = settings;
  const listed = useRef(models);
  listed.current = models;
  const put = useCallback((asked: Partial<S>) => {
    const now = latest.current;
    // A detection kept from when what hears could detect is shown off while it cannot (`localaiLanguages.detection`):
    // a change of what hears drops it, so that it never comes back on unseen.
    const hearing = 'asrVia' in asked || 'asrHere' in asked || 'asrOther' in asked;
    const patch: Partial<S> = {
      ...(hearing && now.asrDetectOther && !detectsOther(now, listed.current) ? { asrDetectOther: false } : {}),
      ...(hearing && alsoSpoken(now, pair).length > 0 && !speaksBoth(now, listed.current, pair) ? { speakBoth: false, speakAlso: [] } : {}),
      ...asked,
    };
    if (pinned.current) {
      update(patch);
      return;
    }
    pinned.current = true;
    update({ ...Object.fromEntries(PLACE_FIELDS.map((field) => [field, now[field]])), ...patch } as Partial<S>);
  }, [update, pair]);

  const found: readonly LocalAIModel[] = models;
  // On the device the stages share: a device of the hearing stage's own (a phone) is none of what follows.
  const onServer = hearingPlace(settings) === 'server';
  const serverInUse = needsServer(settings);
  const address = values.endpoint ?? '';
  // The address names this computer itself: a model server running here (a LocalAI), reached the way another device is.
  const onThisComputer = /^(?:[a-z]+:\/\/)?(?:127\.0\.0\.1|localhost|\[::1\])(?::|\/|$)/i.test(address.trim());
  const kotomimi = serverInUse && isKotomimiServer(found);
  const ownModels = found.filter((m) => m.from === undefined);

  // What hears on the other device.
  const pipelines = modelsFor(found, 'pipeline');
  const recognizers = modelsFor(found, 'asr');
  // As a person chooses among them (`serverRecognizers.ts`): one to a language is one choice, and only what hears a
  // language of this run is listed. A choice saved as one member of a family shows as the family.
  const recognizerMenu = recognizerChoices(recognizers, legs.map((leg) => heardBy(settings, pair, leg, models))).map((id) => ({ id }));
  // Fork: what the other device says it hears each leg with in the run under way — said beside the choice where it is
  // not simply the model chosen: left to the device, or another of its own taken in its place (`heardByStore.ts`).
  const inUse = useHeardByStore((state) => state.byLeg);
  const inUseText = (chosen: string): string | undefined => {
    const shown = (['participant', 'speaker'] as const).filter((leg) => inUse[leg] && (chosen === '' || choiceOf(inUse[leg]!) !== choiceOf(chosen)));
    if (shown.length === 0) return undefined;
    const names = shown.map((leg) => shownName(inUse[leg]!));
    if (shown.length === 1 || names[0] === names[1]) return t('providers.localai.inUse', { name: names[0] });
    return t('providers.localai.inUseLegs', { theirs: names[0], mine: names[1] });
  };
  const recognizerChosen = recognizers.some((m) => choiceOf(m.id) === choiceOf(settings.asrModel) && perLanguage(m.id)) ? choiceOf(settings.asrModel) : settings.asrModel;
  // Fork: the translation model the device answered with in the run under way — left to it, or one of its own where
  // the engine was busy (`translatedByStore.ts`). Shown beside the choice, as the recognizer's is.
  const served = useTranslatedByStore((state) => state.byLeg);
  const servedText = (chosen: string): string | undefined => {
    const shown = (['participant', 'speaker'] as const).filter((leg) => served[leg] && served[leg] !== chosen);
    if (shown.length === 0) return undefined;
    const names = shown.map((leg) => shownName(served[leg]!));
    if (shown.length === 1 || names[0] === names[1]) return t('providers.localai.inUse', { name: names[0] });
    return t('providers.localai.inUseLegs', { theirs: names[0], mine: names[1] });
  };
  // Fork: the languages of this run the chosen family has no member for (the Mac's Apple Speech without Korean): those
  // legs are left to the device, which said so only in the small "in use" beside the menu (the user, 2026-10-28).
  const familyMembers = recognizers.map((m) => perLanguage(m.id)).filter((one) => one !== null && one.family === choiceOf(settings.asrModel));
  const familyMissing = familyMembers.length === 0 ? [] : [...new Set(legs.map((leg) => heardBy(settings, pair, leg, models)))]
    .filter((language) => language && !isAutoLanguage(language) && !familyMembers.some((one) => one!.language.split('-')[0] === language.split('-')[0]));
  // What a blank pipeline field runs (`effectiveLocalAIModel`): the first pipeline named `gpt-realtime*`, else the first.
  const fallback = pipelines.find((m) => isRealtimeModelId(m.id))?.id ?? pipelines[0]?.id ?? '';
  // A leg whose answers come from a stage of its own only transcribes, and on a LocalAI takes the device's own recognizer (`localai.ts` `transcriptionFor`).
  const speechAsked = translatePlace(settings) !== 'server' || settings.translateServerModel.trim() !== '';
  const everyLegTranscribes = onServer && !kotomimi && speechAsked;
  const someLegTranscribes = onServer && !kotomimi && (speechAsked || settings.coach);

  // What a blank translation model on the other device runs: its own pipeline where that hears the leg, else the
  // one model it lists that translates — several are not a choice, and the card asks for one (`translationDefault`).
  const translateDefault = translationDefault(found);
  const translateBlank = kotomimi
    ? t('providers.localai.translateKotomimiOwn')
    : onServer && !speechAsked
      ? t('providers.localai.translateInSession')
      : translateDefault ? t('providers.localai.auto', { name: shownName(translateDefault) }) : t('providers.localai.hereModelPick');
  const coachOptions = modelsFor(found, 'coach');
  const coachDefault = serverDefaultModel(found);
  // The device says what its models are for, and none of them is a text model.
  const coachNone = ownModels.some((m) => m.kind !== undefined) && coachOptions.length === 0;

  // Fork: every device a search has found, kept (`knownDevices.ts`): what a stage can be given a device of its own from,
  // as it named itself, whether or not it answers now — not only what the last search found.
  const seen = useKnownDeviceStore((st) => st.devices);
  useEffect(() => { void useKnownDeviceStore.getState().hydrate(); }, []);
  // A phone that asks for an access key, picked: its key is typed under the search, which then looks again with it,
  // and the phone found answering is used as a pick of it would be (`phoneKeys.ts`).
  const [keyFor, setKeyFor] = useState<FoundServer | null>(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [keyWrong, setKeyWrong] = useState(false);
  const [searchTurn, setSearchTurn] = useState(0);
  const keyAsked = useRef<string | null>(null);
  // The hearing stage's own device: a phone, by its address. The ones found, and the one saved though it was not
  // found this time (the phone asleep, or no search made yet): it stays visible, so the setting is not silently another.
  const ownHearing = plainAddress(settings.asrOther);
  const hearsAtOwn = settings.asrVia === 'server' && ownHearing !== '';
  // The recognizers the stage's device can be asked for by name (the iPad app): as the search last found it — or, where
  // no search has found it since this card was drawn (a run began and ended, the app was opened again), as the device
  // itself says when asked, as a run asks it at Start.
  const foundHears = seen.find((server) => server.kind === 'phone' && plainAddress(server.address) === ownHearing)?.hears ?? [];
  const [askedHears, setAskedHears] = useState<{ address: string; hears: readonly string[] } | null>(null);
  useEffect(() => {
    if (!hearsAtOwn || foundHears.length > 0) return undefined;
    let gone = false;
    const base = phoneBase({ address: ownHearing });
    void engineNode(base, fetch, phoneKey(base) || undefined).then((node) => {
      if (!gone && node) setAskedHears({ address: ownHearing, hears: node.hears });
    });
    return () => { gone = true; };
  }, [hearsAtOwn, ownHearing, foundHears.length]);
  const ownHears = foundHears.length > 0 ? foundHears : askedHears?.address === ownHearing ? askedHears.hears : [];
  const hearingPhones = [
    ...seen.filter(phoneHears),
    ...(ownHearing !== '' && !seen.some((server) => phoneHears(server) && plainAddress(server.address) === ownHearing) ? [{ address: ownHearing, name: '', model: settings.asrOtherModel, reachable: false }] : []),
  ];
  // The same of the translation and the feedback: the phones that lend a model of the stage's kind, and the one saved.
  const textPhones = (kind: PhoneTextModel['kind'], saved: string): OwnDevice[] => [
    ...seen.filter((server) => phoneLends(server, kind).length > 0),
    ...(saved !== '' && !seen.some((server) => phoneLends(server, kind).length > 0 && plainAddress(server.address) === saved) ? [{ address: saved, name: '', reachable: false }] : []),
  ];
  // What a phone lends of a kind, as the search last found it; null where it did not find it this time.
  const lentBy = (address: string, kind: PhoneTextModel['kind']): readonly PhoneTextModel[] | null => {
    const phone = seen.find((server) => server.kind === 'phone' && plainAddress(server.address) === address);
    return phone ? phoneLends(phone, kind) : null;
  };
  const ownTranslate = plainAddress(settings.translateOther);
  const translatesAtOwn = translatesAtOwnDevice(settings);
  const translatePhones = textPhones('translate', ownTranslate);
  const ownCoach = plainAddress(settings.coachOther);
  const coachesAtOwn = coachesAtOwnDevice(settings);
  const coachPhones = textPhones('coach', ownCoach);
  // A phone's translator that does not translate the pair: said as this computer's own is.
  const phoneTranslator = translatesAtOwn ? NATIVE_TRANSLATORS.find((m) => m.id === settings.translateOtherModel) : undefined;
  const phoneTranslatorUnfit = phoneTranslator !== undefined && !nativeTranslates(phoneTranslator, pair.source, pair.target);
  // The shared device by the name the search knew it by, where it found it.
  const sharedName = seen.find((server) => server.kind !== 'phone' && plainAddress(server.address) === plainAddress(address))?.name ?? '';
  const sharedLabel = address.trim() ? sharedName || plainAddress(address) : t('providers.localai.sharedDeviceNone');
  /** A text stage given a phone (or, with a blank address, the shared device again), with the model it lends that suits it. */
  const textOn = (kind: PhoneTextModel['kind'], picked: string, found?: FoundServer): Partial<S> => {
    const phone = found ?? seen.find((server) => server.kind === 'phone' && plainAddress(server.address) === picked);
    const saved = kind === 'translate' ? ownTranslate : ownCoach;
    const current = kind === 'translate' ? settings.translateOtherModel : settings.coachOtherModel;
    // The phone saved, not found this time: its model as it was.
    const model = !picked ? '' : phone ? lentChoice(phone.text ?? [], kind, pair, current) : picked === saved ? current : '';
    const address = phone ? phone.address : picked;
    return (kind === 'translate' ? { translateOther: address, translateOtherModel: model } : { coachOther: address, coachOtherModel: model }) as Partial<S>;
  };
  // The same as a pick in the search above the cards.
  const useServer = (server: FoundServer) => {
    // A phone lends its engines: it is the "another device" of each stage it can run. Hearing is given it from
    // wherever it is, as it always was; the translation and the feedback where they are on "another device", which
    // a pick there names — a stage placed on an API or this computer stays there. A phone that lends text models
    // alone, picked while neither is on "another device", is given the translation (or else the feedback): it was
    // picked to be used. (`settled` reads a hearing phone as an API at its address, and the run reads it live:
    // `remoteEngine.ts`; a text stage on a phone is asked as this computer's native engine is: `buildLocalAI`.)
    if (server.kind === 'phone' && server.needsKey) {
      setKeyFor(server);
      setKeyDraft('');
      setKeyWrong(false);
      return;
    }
    if (server.kind === 'phone') {
      const translates = phoneLends(server, 'translate').length > 0;
      const coaches = phoneLends(server, 'coach').length > 0;
      const address = plainAddress(server.address);
      let patch: Partial<S> = {
        ...(phoneHears(server) ? { asrVia: 'server' as const, asrOther: server.address, asrOtherModel: server.model ?? '' } : {}),
        ...(translates && settings.translateAt === 'server' ? textOn('translate', address, server) : {}),
        ...(coaches && settings.coachAt === 'server' ? textOn('coach', address, server) : {}),
      };
      if (Object.keys(patch).length === 0) {
        patch = translates ? { translateAt: 'server', ...textOn('translate', address, server) } : coaches ? { coachAt: 'server', ...textOn('coach', address, server) } : {};
      }
      if (Object.keys(patch).length > 0) put(patch);
      return;
    }
    if (server.needsKey !== settings.serverNeedsKey) put({ serverNeedsKey: server.needsKey });
    fill('endpoint', server.address);
  };

  /** The key typed for the phone asked about: kept, and the search made again with it. */
  const tryPhoneKey = async () => {
    if (!keyFor || !keyDraft.trim()) return;
    await setPhoneKey(keyFor.address, keyDraft);
    keyAsked.current = plainAddress(keyFor.address);
    setKeyWrong(false);
    setSearchTurn((turn) => turn + 1);
  };
  /** What the search found: and, after a key was typed, the phone it was for, used where it now answers. */
  const searched = (servers: FoundServer[]) => {
    const asked = keyAsked.current;
    if (!asked) return;
    keyAsked.current = null;
    const phone = servers.find((server) => server.kind === 'phone' && plainAddress(server.address) === asked);
    if (phone && !phone.needsKey) {
      setKeyFor(null);
      useServer(phone);
    } else setKeyWrong(true);
  };

  // The other device does not answer at its address (the check's `SERVER_SILENT`). The models shown are the last it listed.
  const silent = serverInUse && !onThisComputer && readiness.state === 'not-ready' && readiness.reason.startsWith(SERVER_SILENT);

  const connectFirst = !address.trim() && <p className="kt-note kt-note--todo">{t('providers.localai.connectFirst')}</p>;
  // The first card with a stage on this computer carries the tour's anchor.
  const tourAt = settings.asrVia === 'device' ? 'asr' : settings.translateAt === 'device' ? 'translation' : null;
  // What each leg hears: the speaker their own language, or — coached — the one they practise; the other side theirs.
  const heardByLegs = legs.map((leg) => heardBy(settings, pair, leg, models));
  // The native recognizer, language by language: a choice is the model in use from then on, and that language's by name.
  const bothOn = speaksBoth(settings, models, pair) && pair.source.toLowerCase() !== pair.target.toLowerCase();
  const nativePick = hearingPick(settings, pair, {
    detecting: detectsOther(settings, models),
    both: bothOn,
    // A model that cannot name the language is a best effort, not a reason to keep another one in its place.
    bestEffort: alsoSpoken(settings, pair).length > 0 || settings.asrDetectOther === true,
  });
  const choiceRows = nativeChoiceRows(settings, pair, legs);
  const pickNativeFor = (id: string, slot?: DeviceNeed) => {
    const row = slot?.leg ?? choiceRows.find((one) => nativeRowChoice(choiceRows, one.key, id).ok)?.key;
    const next = row && chooseNativeRow(settings, choiceRows, row, id);
    if (next) put(next);
  };
  // While the other side's language is left to be detected (chosen among the languages, `LanguagePairSection`): what
  // that takes, where no row of this computer's says it (`hearsOther`).
  const detectOther = legs.includes('participant') && detectsOther(settings, models)
    ? <p className="kt-note">{t('providers.localai.detectOtherNote')}</p>
    : null;

  // The speed test, asked for beside the readiness check; each stage's result in its card (`SpeedTestView.tsx`).
  const ready = readiness.state === 'ready';
  const speed = useSpeedTest({ settings, values, pair, legs, models, ready, disabled: !!disabled });
  const nativeSupported = useNativeEngineStore((s) => s.status.supported);
  // Fork: a speed test's findings show once one is run in this visit; an earlier one's are kept, not shown.
  const [speedShown, setSpeedShown] = useState(false);
  // Where a stage on this computer's native engine falls behind: a smaller model of it, downloaded and fit for the
  // languages, the largest of them. Elsewhere — another device, an API — the suggestion names none.
  const nativeAsr = useNativeModels('asr');
  const nativeTranslation = useNativeModels('translation');
  const nativeCoaching = useNativeModels('coach');
  const smaller = (offered: readonly NativeCardModel[], current: NativeCardModel | null, fits: (id: string) => boolean): NativeCardModel | null => (current
    ? [...offered].filter((m) => m.id !== current.id && m.bytes < current.bytes && fits(m.id)).sort((a, b) => b.bytes - a.bytes)[0] ?? null
    : null);
  const asrNow = settings.asrVia === 'device' && settings.asrHere === 'native'
    ? heardByLegs.map((language) => nativePicked(nativePick, language)).find((m) => m !== null) ?? null
    : null;
  // A leg left to be detected keeps being so: only a model that detects is suggested for it.
  const asrSmaller = smaller(nativeAsr.ready, asrNow, (id) => heardByLegs.every((language) => (isAutoLanguage(language) ? nativeModel(id).detects === true : nativeHears(nativeModel(id), language))));
  const translatedPairs = legs.flatMap((leg) => (leg === 'speaker'
    ? settings.coach && !bothOn ? [] : [[pair.source, pair.target], ...(bothOn ? [[pair.target, pair.source]] : [])]
    : [[pair.target, pair.source]]));
  const translationSmaller = smaller(nativeTranslation.ready, settings.translateAt === 'device' && settings.translateHere === 'native' ? nativeTranslator(settings.translateNativeModel) : null,
    (id) => translatedPairs.every(([from, to]) => nativeTranslates(nativeTranslator(id), from, to)));
  const coachSmaller = smaller(nativeCoaching.ready, settings.coachAt === 'device' && settings.coachHere === 'native' ? nativeCoach(settings.coachNativeModel) : null, () => true);
  // The other device's translation model is one choice for every direction this run translates (the speaker's typed
  // text too, where their speech is coached): a model that cannot take one of them is not offered, and a saved one
  // that no longer can is said under the menu (`present`), not shown as gone.
  const translateDirections = legs.map((leg) => (leg === 'speaker' ? [pair.source, pair.target] : [pair.target, pair.source]))
    // A language left to be detected is no direction a model's languages could be measured against.
    .filter(([from, to]) => !isAutoLanguage(from) && !isAutoLanguage(to));
  const translateOptions = modelsFor(found, 'translate').filter((m) => translateDirections.every(([from, to]) => fitsPair(m, from, to)));
  const translatePresent = modelsFor(found, 'translate').some((m) => m.id === settings.translateServerModel);
  const switchTo = (patch: () => void) => () => { patch(); speed.againAfterChange(); };
  // The stages each device found runs now: the device they share, and a phone each asks of its own. Only while a
  // stage is on the shared device is its address one: with a phone hearing, the address may be one nothing asks.
  const deviceUses = (server: FoundServer): FinderStage[] => {
    const at = plainAddress(server.address);
    const is = (one: string) => one.trim() !== '' && plainAddress(one) === at;
    const shared = serverInUse && is(address);
    const hears = hearsAtOwnDevice(settings) ? is(settings.asrOther)
      : settings.asrVia === 'api' ? server.kind === 'phone' && is(settings.asrApiBaseUrl)
      : shared && hearingPlace(settings) === 'server';
    return [
      ...(hears ? ['asr' as const] : []),
      ...((translatesAtOwn ? is(settings.translateOther) : shared && translatePlace(settings) === 'server') ? ['translate' as const] : []),
      ...((coachesAtOwn ? is(settings.coachOther) : shared && coachesOnShared(settings)) ? ['coach' as const] : []),
    ];
  };

  return (
    <div className="kt-stages-assist">
      {/* Fork: the plans for this computer, where its native engines can run (`PlanCard.tsx`). */}
      {nativeSupported && <PlanCard settings={settings} pair={pair} speed={speed} speedShown={speedShown} onSpeedTest={() => { setSpeedShown(true); speed.start(); }} ready={ready} disabled={disabled} />}
      <section className={`kt-device${serverInUse ? ' is-used' : ''}`} aria-label={t('providers.localai.placeServer')}>
        <ServerFinder
          key={searchTurn}
          heading={(
            <h4 className="kt-card__head">
              <span className="kt-card__icon"><MonitorSmartphone size={14} /></span>
              <span className="kt-card__title">{t('providers.localai.placeServer')}</span>
            </h4>
          )}
          phones
          uses={deviceUses}
          onFound={searched}
          auto={(serverInUse && !address.trim()) || searchTurn > 0}
          disabled={disabled}
          onPick={useServer}
        />
        {keyFor && (
          <div className="kt-phone-key">
            <p className="kt-note">{t('providers.localai.phoneKeyNote')}</p>
            <Field label={t('providers.localai.phoneKey', { name: keyFor.name || plainAddress(keyFor.address) })}>
              <input
                type="password"
                className="kt-input"
                aria-label={t('providers.localai.phoneKey', { name: keyFor.name || plainAddress(keyFor.address) })}
                value={keyDraft}
                onChange={(e) => { setKeyDraft(e.target.value); setKeyWrong(false); }}
                onKeyDown={(e) => { if (e.key === 'Enter') void tryPhoneKey(); }}
                autoComplete="off"
                spellCheck={false}
                disabled={disabled}
              />
            </Field>
            {keyWrong && <p className="kt-note kt-note--todo">{t('providers.localai.phoneKeyWrong')}</p>}
            <button type="button" className="kt-there__switch" onClick={() => { void tryPhoneKey(); }} disabled={disabled || !keyDraft.trim()}>
              {t('providers.localai.phoneKeyUse')}
            </button>
          </div>
        )}
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

      <StageCard id="hearing-section" icon={<Mic size={14} />} title={t('providers.localai.hearStage')} tooltip={t('providers.localai.hearStageTooltip')}>
        <PlaceSwitch label={t('providers.localai.hearStage')} value={settings.asrVia} onChange={(asrVia) => put({ asrVia })} disabled={disabled} />
        {/* Which device, where there is more than the shared one to choose from: the phones that lend their recognition. */}
        {settings.asrVia === 'server' && hearingPhones.length > 0 && (
          <StageDevice
            value={ownHearing}
            shared={sharedLabel}
            phones={hearingPhones}
            onChange={(chosen) => {
              const picked = hearingPhones.find((phone) => plainAddress(phone.address) === chosen);
              put({ asrOther: picked ? picked.address : '', asrOtherModel: picked?.model ?? '' } as Partial<S>);
            }}
            disabled={disabled}
          />
        )}
        {hearsAtOwn && (
          <>
            {/* A phone lends one model at a time, the one chosen on it: named here, and asked again at every start. A
                device that can be asked for any of its recognizers (the iPad app) is chosen from here: blank, the one
                it lends. */}
            {ownHears.length > 1 ? (
              <ServerModel label={t('providers.localai.model')} value={settings.asrOtherModel} blank={t('providers.localai.deviceDefault')} options={ownHears.map((id) => ({ id }))} onChange={(asrOtherModel) => put({ asrOtherModel } as Partial<S>)} disabled={disabled} />
            ) : (
              <ServerModel label={t('providers.localai.model')} value="" blank={settings.asrOtherModel ? shownName(settings.asrOtherModel) : t('providers.localai.deviceDefault')} options={[]} onChange={() => {}} disabled />
            )}
            {detectOther}
          </>
        )}
        {settings.asrVia === 'server' && !hearsAtOwn && (
          <>
            {connectFirst}
            <ServerModel label={t('providers.localai.model')} value={everyLegTranscribes ? '' : recognizerChosen} blank={t('providers.localai.deviceDefault')} options={everyLegTranscribes ? [] : recognizerMenu} onChange={(asrModel) => put({ asrModel })} disabled={disabled || everyLegTranscribes} aside={inUseText(everyLegTranscribes ? '' : recognizerChosen)} present={familyMembers.length > 0} />
            {!everyLegTranscribes && familyMissing.length > 0 && (
              <p className="kt-note kt-note--todo" role="status">{t('providers.localai.familyUnheard', { name: shownName(recognizerChosen), languages: familyMissing.map((language) => languageLabel(language, i18n.language)).join(t('providers.localai.listJoin')) })}</p>
            )}
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
            {detectOther}
          </>
        )}
        {settings.asrVia === 'device' && (
          <DeviceModels
            stage="asr" settings={settings} update={put} pair={pair} legs={legs} models={models} disabled={disabled} tour={tourAt === 'asr'}
            native={{
              onPick: pickNativeFor,
              inUse: (slot) => choiceRows.find((row) => row.key === slot?.leg)?.model ?? null,
            }}
          />
        )}
        <SpeedLine
          stage="hear" result={speedShown ? speed.result('hear') : null} disabled={disabled}
          advice={asrSmaller && { name: asrSmaller.name, onSwitch: switchTo(() => pickNativeFor(asrSmaller.id)) }}
        />
      </StageCard>

      <StageCard icon={<Languages size={14} />} title={t('providers.localai.translateStage')} tooltip={t('providers.localai.translateStageTooltip')}>
        <PlaceSwitch label={t('providers.localai.translateStage')} value={settings.translateAt} onChange={(translateAt) => put({ translateAt })} disabled={disabled} />
        {/* Which device, where there is more than the shared one to choose from: the phones that lend a translator. */}
        {settings.translateAt === 'server' && translatePhones.length > 0 && (
          <StageDevice value={ownTranslate} shared={sharedLabel} phones={translatePhones} onChange={(picked) => put(textOn('translate', picked))} disabled={disabled} />
        )}
        {translatesAtOwn && (
          <>
            <PhoneModel value={settings.translateOtherModel} lent={lentBy(ownTranslate, 'translate')} onChange={(translateOtherModel) => put({ translateOtherModel } as Partial<S>)} disabled={disabled} />
            {phoneTranslatorUnfit && <p className="kt-note kt-note--todo" role="status">{t('providers.localai.translatorUnfit', { name: phoneTranslator.name })}</p>}
          </>
        )}
        {settings.translateAt === 'server' && !translatesAtOwn && (
          <>
            {connectFirst}
            <ServerModel label={t('providers.localai.model')} value={settings.translateServerModel} blank={translateBlank} options={translateOptions} present={translatePresent} onChange={(translateServerModel) => put({ translateServerModel })} disabled={disabled} />
            {servedText(settings.translateServerModel) && <p className="kt-note" role="note">{servedText(settings.translateServerModel)}</p>}
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
        {settings.translateAt === 'device' && (
          <DeviceModels
            stage="translation" settings={settings} update={put} pair={pair} legs={legs} models={models} disabled={disabled} tour={tourAt === 'translation'}
            native={{
              onPick: (translateNativeModel) => put({ translateHere: 'native', translateNativeModel }),
              inUse: () => nativeTranslator(settings.translateNativeModel),
            }}
          />
        )}
        <ToggleSwitch checked={settings.translateBySentence} onChange={() => put({ translateBySentence: !settings.translateBySentence })} label={t('providers.localai.bySentence')} disabled={disabled} tooltip={t('providers.localai.bySentenceTooltip')} />
        <SpeedLine
          stage="translate" result={speedShown ? speed.result('translate') : null} disabled={disabled}
          advice={translationSmaller && { name: translationSmaller.name, onSwitch: switchTo(() => put({ translateHere: 'native', translateNativeModel: translationSmaller.id })) }}
        />
      </StageCard>

      <StageCard
        icon={<GraduationCap size={14} />}
        title={t('providers.localai.coachStage')}
        tooltip={t('providers.localai.coachStageTooltip')}
        lead={<ToggleSwitch checked={settings.coach} onChange={() => put({ coach: !settings.coach })} label={t('providers.localai.coach')} disabled={disabled} />}
      >
        {/* Feedback answers what the user says: with the other side alone heard there is nothing for it to answer. */}
        {settings.coach && !legs.includes('speaker') && <p className="kt-note kt-note--todo" role="status">{t('providers.localai.coachNeedsSpeaker')}</p>}
        {settings.coach && (
          <>
            <PlaceSwitch label={t('providers.localai.coachStage')} value={settings.coachAt} onChange={(coachAt) => put({ coachAt })} disabled={disabled} />
            {settings.coachAt === 'server' && coachPhones.length > 0 && (
              <StageDevice value={ownCoach} shared={sharedLabel} phones={coachPhones} onChange={(picked) => put(textOn('coach', picked))} disabled={disabled} />
            )}
            {coachesAtOwn && <PhoneModel value={settings.coachOtherModel} lent={lentBy(ownCoach, 'coach')} onChange={(coachOtherModel) => put({ coachOtherModel } as Partial<S>)} disabled={disabled} />}
            {settings.coachAt === 'server' && !coachesAtOwn && (
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
            {settings.coachAt === 'device' && (
              <DeviceChat
                disabled={disabled}
                native={{
                  onPick: (coachNativeModel) => put({ coachHere: 'native', coachNativeModel }),
                  inUse: () => nativeCoach(settings.coachNativeModel),
                }}
              />
            )}
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
            <SpeedLine
              stage="coach" result={speedShown ? speed.result('coach') : null} disabled={disabled}
              advice={coachSmaller && { name: coachSmaller.name, onSwitch: switchTo(() => put({ coachHere: 'native', coachNativeModel: coachSmaller.id })) }}
            />
          </>
        )}
      </StageCard>

      {/* Whether all of it can start, in words: asked again by itself after an edit, and by hand here while it is not
          ready (another device come back, a model fetched elsewhere). The speed test is on the plans. */}
      <div className={`kt-ready kt-ready--${readiness.state}`} role="status">
        {readiness.state === 'ready' && <><CircleCheck size={15} /><span>{t('providers.localai.ready')}</span></>}
        {readiness.state === 'checking' && <><Loader size={15} className="kt-ready__spin" /><span>{t('providers.localai.checking')}</span></>}
        <span className="kt-ready__actions">
          {check && readiness.state !== 'checking' && readiness.state !== 'ready' && speed.phase.name !== 'running' && (
            <button type="button" className="kt-ready__again" onClick={check} disabled={disabled}>
              <RefreshCw size={12} />
              <span>{t('providers.localai.checkNow')}</span>
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
