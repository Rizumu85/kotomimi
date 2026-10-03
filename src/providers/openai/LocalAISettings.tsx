import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InstructionsField } from '../../components/providers/fields/InstructionsField';
import Tooltip from '../../components/Tooltip/Tooltip';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { SettingsProps } from '../../lib/provider/types';
import { coachPrompt } from './coachPrompt';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings as S, TranslateVia } from './localai';
import { modelsFor, type LocalAIModel } from './localaiModels';
import { isRealtimeModelId, realtimeLanguageName, realtimeLanguages } from './settings';

const helpIcon = <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '8px' }} />;

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
 * One text model: where it is served, which it is, and whether its server
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
      <div className="setting-item">
        <input
          type="text"
          className="text-input"
          aria-label={t('providers.localai.textBaseUrl')}
          value={baseUrl}
          onChange={(e) => onChange({ baseUrl: e.target.value })}
          placeholder={t('providers.localai.textBaseUrlPlaceholder')}
          disabled={disabled}
        />
      </div>
      <div className="setting-item">
        {options.length > 0 ? (
          <select id={`${id}-model`} className="select-dropdown" aria-label={t('providers.localai.textModel')} value={model} onChange={(e) => onChange({ model: e.target.value })} disabled={disabled}>
            <option value="">{blankLabel}</option>
            {/* A saved model the server no longer lists stays visible, so the setting is not silently another. */}
            {!listed && <option value={model}>{model}</option>}
            {options.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
        ) : (
          <input
            id={`${id}-model`}
            type="text"
            className="text-input"
            aria-label={t('providers.localai.textModel')}
            value={model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder={blankLabel}
            disabled={disabled}
          />
        )}
      </div>
      <div className="setting-item">
        <label className="localai-check">
          <input type="checkbox" checked={needsKey} onChange={(e) => onChange({ needsKey: e.target.checked })} disabled={disabled} />
          <span>{t('providers.localai.needsKey')}</span>
        </label>
      </div>
    </>
  );
}

/**
 * Fork: LocalAI Realtime's own settings — the instructions, the Realtime
 * model, the transcription model, and the stages chosen apart: what answers
 * speech, and whether the speaker's own speech gets grammar feedback. The
 * Realtime model is a text field the server's list only suggests into (a
 * `datalist`): what is typed is what runs.
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
  // A leg whose answers come from a text model only transcribes, and takes the server's own recognizer (`localai.ts` `transcriptionFor`).
  const everyLegTranscribes = settings.translateVia === 'model';
  const someLegTranscribes = everyLegTranscribes || settings.coach;
  return (
    <>
      <InstructionsField value={settings} onChange={update} preview={preview} disabled={disabled} />
      <div className="settings-section">
        <h2>
          {t('settings.model')}
          <Tooltip content={t('providers.localai.modelTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <div className="setting-item">
          <input
            type="text"
            className="text-input"
            aria-label={t('settings.model')}
            list="localai-models"
            value={settings.model}
            onChange={(e) => update({ model: e.target.value })}
            placeholder={fallback}
            disabled={disabled}
          />
          <datalist id="localai-models">
            {pipelines.map((m) => <option key={m.id} value={m.id} />)}
          </datalist>
          {found.length > 0 && <div className="models-info">{t('settings.modelsFound', 'Found {{count}} available models', { count: found.filter((m) => m.from === undefined).length })}</div>}
        </div>
      </div>
      <div className="settings-section">
        <h2>
          {t('settings.userTranscriptModel')}
          <Tooltip content={t('providers.localai.asrModelTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <div className="setting-item">
          <select className="select-dropdown" aria-label={t('settings.userTranscriptModel')} value={settings.asrModel} onChange={(e) => update({ asrModel: e.target.value })} disabled={disabled || everyLegTranscribes}>
            <option value="">{t('providers.localai.asrModelServer')}</option>
            {!asrListed && <option value={settings.asrModel}>{settings.asrModel}</option>}
            {recognizers.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
          {someLegTranscribes && <div className="models-info localai-note">{t('providers.localai.asrFixedNote')}</div>}
        </div>
      </div>
      <div className="settings-section">
        <h2>
          {t('providers.localai.translateStage')}
          <Tooltip content={t('providers.localai.translateStageTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <div className="setting-item">
          <select className="select-dropdown" aria-label={t('providers.localai.translateStage')} value={settings.translateVia} onChange={(e) => update({ translateVia: e.target.value as TranslateVia })} disabled={disabled}>
            <option value="server">{t('providers.localai.viaServer')}</option>
            <option value="model">{t('providers.localai.viaModel')}</option>
          </select>
        </div>
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
      </div>
      <div className="settings-section">
        <h2>
          {t('providers.localai.coachStage')}
          <Tooltip content={t('providers.localai.coachStageTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <div className="setting-item">
          <label className="localai-check">
            <input type="checkbox" checked={settings.coach} onChange={(e) => update({ coach: e.target.checked })} disabled={disabled} />
            <span>{t('providers.localai.coach')}</span>
          </label>
        </div>
        {settings.coach && (
          <TextModelFields
            id="localai-coach"
            baseUrl={settings.coachBaseUrl}
            model={settings.coachModel}
            needsKey={settings.coachNeedsKey}
            blankLabel={t('providers.localai.coachModelPlaceholder')}
            options={modelsFor(found, 'coach', settings.coachBaseUrl.trim() === '')}
            onChange={(p) => update({
              ...(p.baseUrl !== undefined ? { coachBaseUrl: p.baseUrl } : {}),
              ...(p.model !== undefined ? { coachModel: p.model } : {}),
              ...(p.needsKey !== undefined ? { coachNeedsKey: p.needsKey } : {}),
            })}
            disabled={disabled}
          />
        )}
        {settings.coach && (
          <div className="setting-item">
            <textarea
              className="text-input localai-prompt"
              aria-label={t('providers.localai.coachPrompt')}
              rows={4}
              value={settings.coachPrompt}
              onChange={(e) => update({ coachPrompt: e.target.value })}
              // The two placeholder names are handed in as values, so i18next prints them instead of reading them as its own.
              placeholder={t('providers.localai.coachPromptPlaceholder', { spoken: '{{SPOKEN}}', native: '{{NATIVE}}' })}
              disabled={disabled}
            />
            {/* What goes up while the box is blank: chosen by the two languages of the pair. */}
            <details className="localai-prompt-preview">
              <summary>{t('providers.localai.coachPromptPreview')}</summary>
              <pre>{coachPrompt(target, source).system}</pre>
            </details>
          </div>
        )}
      </div>
    </>
  );
}
