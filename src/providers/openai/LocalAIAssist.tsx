import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleCheck, CircleHelp, GraduationCap, Languages, LibraryBig, Loader, Mic, MonitorSmartphone, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { CustomModels } from '../../components/CustomModels/CustomModels';
import { ServerFinder } from '../../components/LanSharing/ServerFinder';
import { useWasmEngineAdapter } from '../../components/Settings/engine/useWasmEngineAdapter';
import { ModelGroup } from '../../components/Settings/sections/ModelManagementControls';
import { ModelCard, ModelManagementSection } from '../../components/Settings/sections/ModelManagementSection';
import ToggleSwitch from '../../components/Settings/shared/ToggleSwitch';
import Tooltip from '../../components/Tooltip/Tooltip';
import { canFindServers, findServers, plainAddress, type FoundServer } from '../../lib/lan/discover';
import { modelLabel } from '../../lib/lan/modelLabel';
import { deviceReady, getManifestEntry, getModelSizeMb } from '../../lib/local-inference/modelManifest';
import { shortenModelName } from '../../lib/local-inference/modelName';
import type { CredentialAssistProps } from '../../lib/provider/types';
import { useDeviceFeatures, useDownloadErrors, useModelDownloads, useModelInitialized, useModelStatuses, useModelStore, useWebGPUAvailable } from '../../stores/modelStore';
import { coachPrompt } from './coachPrompt';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { deviceChatModels, deviceCoachModel, deviceLanguage, deviceModelsLoaded, needsServer, PLACE_FIELDS, PLACES, type DeviceNeed, type Place } from './localaiDevice';
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
  return entry ? shortenModelName(entry.name, entry.shortName) : modelLabel(id);
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

interface ApiFieldsProps {
  /** Distinguishes the three groups' ids. */
  id: string;
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

/** An API: where it is, which model, and its key — all in the stage that uses it. */
function ApiFields({ id, baseUrl, model, needsKey, apiKey, urlPlaceholder, modelPlaceholder, options, onChange, onKey, disabled }: ApiFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      <Field label={t('providers.localai.asrApiBaseUrl')}>
        <input type="text" className="kt-input" aria-label={t('providers.localai.asrApiBaseUrl')} value={baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder={urlPlaceholder} spellCheck={false} disabled={disabled} />
      </Field>
      <Field label={t('providers.localai.model')}>
        <input type="text" className="kt-input" aria-label={t('providers.localai.model')} list={`${id}-models`} value={model} onChange={(e) => onChange({ model: e.target.value })} placeholder={modelPlaceholder} spellCheck={false} disabled={disabled} />
        <datalist id={`${id}-models`}>
          {options.map((m) => <option key={m.id} value={m.id} />)}
        </datalist>
      </Field>
      <ToggleSwitch checked={needsKey} onChange={() => onChange({ needsKey: !needsKey })} label={t('providers.localai.asrApiNeedsKey')} disabled={disabled} />
      {needsKey && (
        <Field label={t('providers.localai.apiKey')}>
          <input type="password" className="kt-input" aria-label={t('providers.localai.apiKey')} value={apiKey} onChange={(e) => onKey(e.target.value)} placeholder={t('providers.localai.apiKey')} autoComplete="off" disabled={disabled} />
        </Field>
      )}
    </>
  );
}

/**
 * This computer's models for one stage: for each direction a run would load,
 * the model in use — chosen from the ones downloaded — and, beside it, the
 * way into the model library, which opens right here, under the choice it
 * serves. It opens by itself while a direction has no model to run: what is
 * missing is then the first thing seen.
 */
function DeviceModels({ stage, settings, update, pair, legs, disabled, tour }: Pick<Props, 'settings' | 'update' | 'pair' | 'legs' | 'disabled'> & { stage: 'asr' | 'translation'; tour?: boolean }) {
  const { t } = useTranslation();
  const device = useDeviceSettings(settings, update);
  // The catalog's own codes: the pair as Local Inference would hold it.
  const source = deviceLanguage(pair.source);
  const target = deviceLanguage(pair.target);
  const basePair = useMemo(() => ({ source, target }), [source, target]);
  const override = useMemo(() => ({ settings: device.settings, update: device.update, pair: basePair }), [device.settings, device.update, basePair]);
  const adapter = useWasmEngineAdapter(Boolean(disabled), override);
  const slots = useDeviceSlots(settings, pair, legs).filter((slot) => slot.stage === stage);
  const missing = slots.find((slot) => !adapter.resolved(slot));
  // undefined: as it falls — open on what is missing. A direction's key: opened for it. null: closed by hand.
  const [picked, setPicked] = useState<string | null | undefined>(undefined);
  const open = picked === undefined ? missing?.dir ?? null : picked;
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
              className={`select-dropdown${resolved ? '' : ' kt-here__select--missing'}`}
              aria-label={label}
              value={resolved?.source === 'explicit' ? resolved.modelId : ''}
              onChange={(e) => { void adapter.select(slot, e.target.value); }}
              disabled={disabled}
            >
              <option value="">{auto ? t('providers.localai.auto', { name: adapter.displayName(auto) }) : t('providers.localai.notDownloaded')}</option>
              {adapter.readyCandidates(slot).map((c) => <option key={c.id} value={c.id}>{c.sizeLabel ? `${c.name} · ${c.sizeLabel}` : c.name}</option>)}
            </select>
          </div>
        );
      })}
      {open !== null && slots.some((slot) => slot.dir === open) && (
        <div className="kt-here__library">
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
function DeviceChat({ value, onChange, disabled }: { value: string; onChange(id: string): void; disabled?: boolean }) {
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
  const open = picked ?? ready.length === 0;
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
        <select className={`select-dropdown${auto ? '' : ' kt-here__select--missing'}`} aria-label={label} value={ready.some((m) => m.id === value) ? value : ''} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
          <option value="">{auto ? t('providers.localai.auto', { name: name(auto) }) : t('providers.localai.notDownloaded')}</option>
          {ready.map((m) => <option key={m.id} value={m.id}>{`${name(m.id)} · ${getModelSizeMb(m, features)} MB`}</option>)}
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
  const tourAt = settings.asrVia === 'device' ? 'asr' : settings.translateAt === 'device' ? 'translation' : null;

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
        {settings.asrVia === 'device' && <DeviceModels stage="asr" settings={settings} update={put} pair={pair} legs={legs} disabled={disabled} tour={tourAt === 'asr'} />}
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
        {settings.translateAt === 'device' && <DeviceModels stage="translation" settings={settings} update={put} pair={pair} legs={legs} disabled={disabled} tour={tourAt === 'translation'} />}
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
            {settings.coachAt === 'device' && <DeviceChat value={settings.coachDeviceModel} onChange={(coachDeviceModel) => put({ coachDeviceModel })} disabled={disabled} />}
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
