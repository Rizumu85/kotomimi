import { CircleHelp } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InstructionsField } from '../../components/providers/fields/InstructionsField';
import Tooltip from '../../components/Tooltip/Tooltip';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { ModelOption, SettingsProps } from '../../lib/provider/types';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings as S, TranslateVia } from './localai';
import { isRealtimeModelId, realtimeLanguageName, realtimeLanguages } from './settings';

const helpIcon = <CircleHelp className="tooltip-trigger" size={14} style={{ marginLeft: '8px' }} />;

interface TextModelFieldsProps {
  /** Distinguishes the two groups' ids. */
  id: string;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  /** Shown in an empty model field: what a blank one means. */
  modelPlaceholder: string;
  /** The Realtime server's models, suggested while the address is its own. */
  models: readonly ModelOption[];
  onChange(patch: { baseUrl?: string; model?: string; needsKey?: boolean }): void;
  disabled: boolean;
}

/** One text model: where it is served, what it is called, and whether it wants a key (the key itself is a credential, entered beside the server address). */
function TextModelFields({ id, baseUrl, model, needsKey, modelPlaceholder, models, onChange, disabled }: TextModelFieldsProps) {
  const { t } = useTranslation();
  const own = baseUrl.trim() === '';
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
        <input
          type="text"
          className="text-input"
          aria-label={t('providers.localai.textModel')}
          list={own ? `${id}-models` : undefined}
          value={model}
          onChange={(e) => onChange({ model: e.target.value })}
          placeholder={modelPlaceholder}
          disabled={disabled}
        />
        {own && (
          <datalist id={`${id}-models`}>
            {models.map((m) => <option key={m.id} value={m.id} />)}
          </datalist>
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
  // What a blank field runs (`effectiveLocalAIModel`): the server's first `gpt-realtime*` name, else its first model.
  const fallback = models.find((m) => isRealtimeModelId(m.id))?.id ?? models[0]?.id ?? '';
  const asrListed = settings.asrModel === '' || models.some((m) => m.id === settings.asrModel);
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
            {models.map((m) => <option key={m.id} value={m.id} />)}
          </datalist>
          {models.length > 0 && <div className="models-info">{t('settings.modelsFound', 'Found {{count}} available models', { count: models.length })}</div>}
        </div>
      </div>
      <div className="settings-section">
        <h2>
          {t('settings.userTranscriptModel')}
          <Tooltip content={t('providers.localai.asrModelTooltip')} position="top">{helpIcon}</Tooltip>
        </h2>
        <div className="setting-item">
          <select className="select-dropdown" aria-label={t('settings.userTranscriptModel')} value={settings.asrModel} onChange={(e) => update({ asrModel: e.target.value })} disabled={disabled}>
            <option value="">{t('providers.localai.asrModelServer')}</option>
            {!asrListed && <option value={settings.asrModel}>{settings.asrModel}</option>}
            {models.map((m) => <option key={m.id} value={m.id}>{m.id}</option>)}
          </select>
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
          modelPlaceholder={t('providers.localai.translateModelPlaceholder')}
          models={models}
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
            modelPlaceholder={t('providers.localai.coachModelPlaceholder')}
            models={models}
            onChange={(p) => update({
              ...(p.baseUrl !== undefined ? { coachBaseUrl: p.baseUrl } : {}),
              ...(p.model !== undefined ? { coachModel: p.model } : {}),
              ...(p.needsKey !== undefined ? { coachNeedsKey: p.needsKey } : {}),
            })}
            disabled={disabled}
          />
        )}
      </div>
    </>
  );
}
