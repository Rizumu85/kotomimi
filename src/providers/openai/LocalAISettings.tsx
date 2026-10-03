import type { ReactNode } from 'react';
import { ChevronRight, CircleHelp, GraduationCap, Languages, Mic, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InstructionsField } from '../../components/providers/fields/InstructionsField';
import ToggleSwitch from '../../components/Settings/shared/ToggleSwitch';
import Tooltip from '../../components/Tooltip/Tooltip';
import { CustomModels } from '../../components/CustomModels/CustomModels';
import { LanSharingSection } from '../../components/LanSharing/LanSharingSection';
import { getManifestEntry } from '../../lib/local-inference/modelManifest';
import { shortenModelName } from '../../lib/local-inference/modelName';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { SettingsProps } from '../../lib/provider/types';
import { useModelStatuses } from '../../stores/modelStore';
import { coachPrompt } from './coachPrompt';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { AsrVia, LocalAISettings as S, TranslateVia } from './localai';
import { deviceRecognizer, deviceTranslator, needsServer, translateViaOf } from './localaiDevice';
import { isKotomimiServer, modelsFor, type LocalAIModel } from './localaiModels';
import { isRealtimeModelId, realtimeLanguageName, realtimeLanguages } from './settings';
import './LocalAISettings.scss';

const helpIcon = <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '8px' }} />;

/** A choice between a few places a stage can run: the settings' own segmented buttons. */
function Places<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: ReadonlyArray<{ value: T; label: string }>; onChange(value: T): void; disabled: boolean; label: string }) {
  return (
    <div className="setting-item">
      <div className="turn-detection-options" role="group" aria-label={label}>
        {options.map((option) => (
          <button key={option.value} type="button" className={`option-button ${option.value === value ? 'active' : ''}`} aria-pressed={option.value === value} onClick={() => { if (option.value !== value) onChange(option.value); }} disabled={disabled}>
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** A labelled control. */
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="setting-item">
      <div className="setting-label"><span>{label}</span></div>
      {children}
    </div>
  );
}

interface TextModelFieldsProps {
  /** Distinguishes the two groups' ids. */
  id: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  /** What a blank model means: the list's first entry, or an empty field's placeholder. */
  blankLabel: string;
  /** The text models this slot's server lists — its own while the address is blank. Empty: none is known, and the name is typed. */
  options: readonly LocalAIModel[];
  onChange(patch: { baseUrl?: string; model?: string; needsKey?: boolean }): void;
  disabled: boolean;
}

/**
 * One text model: which it is, where it is served, and whether its server
 * wants a key (the key itself is a credential, entered beside the server
 * address). The model is chosen from what that server lists as text models;
 * a server that lists none — not asked yet, or one that does not list —
 * leaves a field to type the name into.
 */
function TextModelFields({ id, baseUrl, model, needsKey, blankLabel, options, onChange, disabled }: TextModelFieldsProps) {
  const { t } = useTranslation();
  const listed = model === '' || options.some((m) => m.id === model);
  return (
    <>
      <Field label={t('providers.localai.textModel')}>
        {options.length > 0 ? (
          <select id={`${id}-model`} className="select-dropdown" aria-label={t('providers.localai.textModel')} value={model} onChange={(e) => onChange({ model: e.target.value })} disabled={disabled}>
            <option value="">{blankLabel}</option>
            {/* A saved model the server no longer lists stays visible, so the setting is not silently another. */}
            {!listed && <option value={model}>{model}</option>}
            {options.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        ) : (
          <input id={`${id}-model`} type="text" className="text-input" aria-label={t('providers.localai.textModel')} value={model} onChange={(e) => onChange({ model: e.target.value })} placeholder={blankLabel} disabled={disabled} />
        )}
      </Field>
      <Field label={t('providers.localai.textBaseUrl')}>
        <input type="text" className="text-input" aria-label={t('providers.localai.textBaseUrl')} value={baseUrl} onChange={(e) => onChange({ baseUrl: e.target.value })} placeholder={t('providers.localai.textBaseUrlPlaceholder')} disabled={disabled} />
        {baseUrl.trim() !== '' && (
          <ToggleSwitch checked={needsKey} onChange={() => onChange({ needsKey: !needsKey })} label={t('providers.localai.needsKey')} disabled={disabled} />
        )}
      </Field>
    </>
  );
}

/** One stop of the route strip: a stage, where it runs, and the model that runs it. */
function Stop({ icon, stage, place, model, missing }: { icon: ReactNode; stage: string; place: string; model?: string; missing?: boolean }) {
  return (
    <div className={`kt-route__stop${missing ? ' kt-route__stop--missing' : ''}`}>
      <span className="kt-route__icon">{icon}</span>
      <span className="kt-route__text">
        <span className="kt-route__stage">{stage}</span>
        <span className="kt-route__place">{place}{model ? <span className="kt-route__model"> · {model}</span> : null}</span>
      </span>
    </div>
  );
}

/** A catalog model's short name, as the model chips show it. */
function deviceModelName(id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const entry = getManifestEntry(id);
  return entry ? shortenModelName(entry.name, entry.shortName) : id;
}

/**
 * Fork: this provider's own settings, a stage at a time — what hears, what
 * translates, and whether the speaker's own speech gets grammar feedback —
 * each with the places it can run and the fields of the place chosen. A
 * strip above them reads the whole route at a glance. The Realtime model is
 * a text field the server's list only suggests into (a `datalist`): what is
 * typed is what runs.
 */
export function LocalAISettingsView({ settings, update, disabled = false, pair, models = [] }: SettingsProps<S>) {
  const { t } = useTranslation();
  const initial = realtimeLanguages.initial?.(settings);
  const source = pair?.source ?? initial?.source ?? '';
  const target = pair?.target ?? initial?.target ?? '';
  const preview = resolveInstructions(settings, { participant: false, source: realtimeLanguageName(source), target: realtimeLanguageName(target) });
  // Each slot offers only the models that can do its work (`modelsFor`).
  const found: readonly LocalAIModel[] = models;
  const pipelines = modelsFor(found, 'pipeline');
  const recognizers = modelsFor(found, 'asr');
  // What a blank field runs (`effectiveLocalAIModel`): the first pipeline named `gpt-realtime*`, else the first.
  const fallback = pipelines.find((m) => isRealtimeModelId(m.id))?.id ?? pipelines[0]?.id ?? '';
  const asrListed = settings.asrModel === '' || recognizers.some((m) => m.id === settings.asrModel);

  const hearsHere = settings.asrVia === 'device';
  const via = translateViaOf(settings);
  const kotomimi = !hearsHere && isKotomimiServer(found);
  // A leg whose answers come from elsewhere only transcribes, and on a LocalAI takes the server's own recognizer (`localai.ts` `transcriptionFor`).
  const everyLegTranscribes = !hearsHere && via !== 'server' && !kotomimi;
  const someLegTranscribes = !hearsHere && !kotomimi && (via !== 'server' || settings.coach);
  const serverInUse = needsServer(settings);
  // Asked where the server is first used: with what hears when it hears, else with the translation.
  const serverKeySwitch = (
    <ToggleSwitch checked={settings.serverNeedsKey} onChange={() => update({ serverNeedsKey: !settings.serverNeedsKey })} label={t('providers.localai.serverNeedsKey')} disabled={disabled} tooltip={t('providers.localai.serverNeedsKeyTooltip')} />
  );

  // A download finishing elsewhere changes what this computer's slots resolve to.
  const statuses = useModelStatuses();
  void statuses;
  const coached = settings.coach;
  const hereRecognizer = hearsHere ? deviceRecognizer(coached ? target : source, coached ? source : target, settings.selections)?.modelId : undefined;
  const hereTranslator = via === 'device' ? deviceTranslator(source, target, settings.selections) : undefined;

  const places = { server: t('providers.localai.placeServer'), device: t('providers.localai.placeDevice') };
  const hearOptions: ReadonlyArray<{ value: AsrVia; label: string }> = [
    { value: 'server', label: places.server },
    { value: 'device', label: places.device },
  ];
  const translateOptions: ReadonlyArray<{ value: TranslateVia; label: string }> = [
    // This computer's recognizer has no server session for a pipeline to answer in.
    ...(hearsHere ? [] : [{ value: 'server' as const, label: t('providers.localai.viaServer') }]),
    { value: 'model', label: t('providers.localai.viaModel') },
    { value: 'device', label: places.device },
  ];

  return (
    <div className="kt-stages">
      <div className="kt-route" aria-label={t('providers.localai.route')}>
        <Stop
          icon={<Mic size={14} />}
          stage={t('providers.localai.hearStage')}
          place={hearsHere ? places.device : places.server}
          model={hearsHere ? deviceModelName(hereRecognizer) ?? t('providers.localai.notDownloaded') : settings.asrModel || undefined}
          missing={hearsHere && !hereRecognizer}
        />
        <ChevronRight size={14} className="kt-route__arrow" aria-hidden />
        <Stop
          icon={<Languages size={14} />}
          stage={t('providers.localai.translateStage')}
          place={via === 'device' ? places.device : via === 'model' ? t('providers.localai.viaModel') : t('providers.localai.viaServer')}
          model={via === 'device' ? deviceModelName(hereTranslator) ?? t('providers.localai.notDownloaded') : via === 'model' ? settings.translateModel || t('providers.localai.notChosen') : undefined}
          missing={(via === 'device' && !hereTranslator) || (via === 'model' && !settings.translateModel)}
        />
        {settings.coach && (
          <>
            <Plus size={12} className="kt-route__arrow" aria-hidden />
            <Stop
              icon={<GraduationCap size={14} />}
              stage={t('providers.localai.coachStage')}
              place={t('providers.localai.viaModel')}
              model={settings.coachModel || (via !== 'device' ? settings.translateModel : '') || t('providers.localai.notChosen')}
              missing={!settings.coachModel && (via === 'device' || !settings.translateModel)}
            />
          </>
        )}
      </div>

      <div className="settings-section kt-stage">
        <h2>
          <Mic size={15} className="kt-stage__icon" />
          {t('providers.localai.hearStage')}
          <Tooltip content={t('providers.localai.hearStageTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <Places label={t('providers.localai.hearStage')} value={settings.asrVia} options={hearOptions} onChange={(asrVia) => update({ asrVia })} disabled={disabled} />
        {hearsHere ? (
          <>
            <p className="kt-note">{t('providers.localai.hearDeviceNote')}</p>
            <CustomModels disabled={disabled} />
          </>
        ) : (
          <>
            <Field label={t('providers.localai.pipelineModel')}>
              <input type="text" className="text-input" aria-label={t('providers.localai.pipelineModel')} list="localai-models" value={settings.model} onChange={(e) => update({ model: e.target.value })} placeholder={fallback} disabled={disabled} />
              <datalist id="localai-models">
                {pipelines.map((m) => <option key={m.id} value={m.id} />)}
              </datalist>
              {found.length > 0 && <div className="models-info">{kotomimi ? t('providers.localai.kotomimiServer') : t('settings.modelsFound', 'Found {{count}} available models', { count: found.filter((m) => m.from === undefined).length })}</div>}
            </Field>
            <Field label={t('providers.localai.recognizer')}>
              <select className="select-dropdown" aria-label={t('providers.localai.recognizer')} value={settings.asrModel} onChange={(e) => update({ asrModel: e.target.value })} disabled={disabled || everyLegTranscribes}>
                <option value="">{t('providers.localai.asrModelServer')}</option>
                {!asrListed && <option value={settings.asrModel}>{settings.asrModel}</option>}
                {recognizers.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
              </select>
              {someLegTranscribes && <p className="kt-note">{t('providers.localai.asrFixedNote')}</p>}
            </Field>
            {serverKeySwitch}
          </>
        )}
      </div>

      <div className="settings-section kt-stage">
        <h2>
          <Languages size={15} className="kt-stage__icon" />
          {t('providers.localai.translateStage')}
          <Tooltip content={t('providers.localai.translateStageTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <Places label={t('providers.localai.translateStage')} value={via} options={translateOptions} onChange={(translateVia) => update({ translateVia })} disabled={disabled} />
        {via === 'device' && <p className="kt-note">{t('providers.localai.viaDeviceNote')}</p>}
        {via === 'server' && <p className="kt-note">{kotomimi ? t('providers.localai.viaServerKotomimiNote') : t('providers.localai.viaServerNote')}</p>}
        {/* Under the server's pipeline the text model still answers what a coached speaker types, and the feedback when it has no model of its own. */}
        {(via === 'model' || (via === 'server' && settings.coach)) && (
          <TextModelFields
            id="localai-translate"
            baseUrl={settings.translateBaseUrl}
            model={settings.translateModel}
            needsKey={settings.translateNeedsKey}
            blankLabel={t('providers.localai.translateModelPlaceholder')}
            options={modelsFor(found, 'translate', settings.translateBaseUrl.trim() === '')}
            onChange={(p) => update({
              ...(p.baseUrl !== undefined ? { translateBaseUrl: p.baseUrl } : {}),
              ...(p.model !== undefined ? { translateModel: p.model } : {}),
              ...(p.needsKey !== undefined ? { translateNeedsKey: p.needsKey } : {}),
            })}
            disabled={disabled}
          />
        )}
        {hearsHere && serverInUse && serverKeySwitch}
      </div>

      <div className="settings-section kt-stage">
        <h2>
          <GraduationCap size={15} className="kt-stage__icon" />
          {t('providers.localai.coachStage')}
          <Tooltip content={t('providers.localai.coachStageTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <ToggleSwitch checked={settings.coach} onChange={() => update({ coach: !settings.coach })} label={t('providers.localai.coach')} disabled={disabled} />
        {settings.coach && (
          <div className="kt-stage__body">
            <TextModelFields
              id="localai-coach"
              baseUrl={settings.coachBaseUrl}
              model={settings.coachModel}
              needsKey={settings.coachNeedsKey}
              blankLabel={via === 'device' ? t('providers.localai.translateModelPlaceholder') : t('providers.localai.coachModelPlaceholder')}
              options={modelsFor(found, 'coach', settings.coachBaseUrl.trim() === '')}
              onChange={(p) => update({
                ...(p.baseUrl !== undefined ? { coachBaseUrl: p.baseUrl } : {}),
                ...(p.model !== undefined ? { coachModel: p.model } : {}),
                ...(p.needsKey !== undefined ? { coachNeedsKey: p.needsKey } : {}),
              })}
              disabled={disabled}
            />
            <Field label={t('providers.localai.coachPrompt')}>
              <textarea
                className="text-input kt-prompt"
                aria-label={t('providers.localai.coachPrompt')}
                rows={4}
                value={settings.coachPrompt}
                onChange={(e) => update({ coachPrompt: e.target.value })}
                // The two placeholder names are handed in as values, so i18next prints them instead of reading them as its own.
                placeholder={t('providers.localai.coachPromptPlaceholder', { spoken: '{{SPOKEN}}', native: '{{NATIVE}}' })}
                disabled={disabled}
              />
              {/* What goes up while the box is blank: chosen by the two languages of the pair. */}
              <details className="kt-details">
                <summary>{t('providers.localai.coachPromptPreview')}</summary>
                <pre>{coachPrompt(target, source).system}</pre>
              </details>
            </Field>
          </div>
        )}
      </div>

      {/* The instructions are the server pipeline's and the text model's: this computer's translation models carry their own. */}
      {via !== 'device' && <InstructionsField value={settings} onChange={update} preview={preview} disabled={disabled} />}

      <LanSharingSection disabled={disabled} pair={pair} />
    </div>
  );
}
