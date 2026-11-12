/**
 * Fork: the plans for this computer, at the top of the Kotomimi provider's cards: 轻量 / 均衡 / 精准, each with about
 * how much video memory it takes and what is left to download, the one that fits this computer starred. A plan opens
 * on its three models — the user's side, the other side, the translation — and is put to use only on a press: what is
 * missing downloads, and each stage switches once its model is here (`nativePlanStore`). Nothing switches by itself.
 * The two sides on different models (a CPU one for the user, one on the graphics card for the other side) is shown
 * by the plan itself, not explained. The speed test lives in the corner, for whoever wants it.
 */
import { useState } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Check, CircleCheck, Download, Gauge, Languages, Loader, MemoryStick, Mic, SlidersHorizontal, Users, X } from 'lucide-react';
import Tooltip from '../../components/Tooltip/Tooltip';
import { sizeText } from '../../lib/native/modelStorage';
import type { LanguagePair } from '../../lib/provider/types';
import { nativePlanStore } from '../../stores/nativePlanStore';
import type { LocalAISettings } from './localai';
import { NATIVE_MODELS } from './localaiNative';
import { NATIVE_TRANSLATORS } from './nativeTranslators';
import type { NativePlan, NativePlanId } from './nativePlans';
import { SpeedReportView, type SpeedTestState } from './SpeedTestView';
import { nativeName as nameOf, usePlans } from './usePlans';

const CATALOG = [...NATIVE_MODELS, ...NATIVE_TRANSLATORS];
const bytesOf = (id: string): number => CATALOG.find((m) => m.id === id)?.bytes ?? 0;
const onCpu = (id: string | null): boolean => !!id && NATIVE_MODELS.some((m) => m.id === id && m.usesGpu === false);
export const gb = (mb: number): string => `${(mb / 1024).toFixed(1)} GB`;

/** Why the starred plan is the one for this computer. */
export function planWhy(memoryMB: number | null | undefined, lending: boolean): 'lending' | 'big' | 'small' | 'default' {
  return lending ? 'lending' : memoryMB != null && memoryMB >= 15360 ? 'big' : memoryMB != null && memoryMB < 7680 ? 'small' : 'default';
}

export function PlanCard({ settings, pair, speed, ready, disabled }: { settings: LocalAISettings; pair: LanguagePair; speed: SpeedTestState; ready: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const { plans, recommended, current, inputs } = usePlans(settings, pair);
  const pending = useStore(nativePlanStore, (s) => s.pending);
  const [open, setOpen] = useState<NativePlanId | null>(null);
  const known = inputs.memoryMB !== undefined;
  const shown = plans.find((p) => p.id === (open ?? current ?? (known ? recommended : 'balanced')))!;
  const has = (id: string) => inputs.downloaded.includes(id);
  const stageAssets = (plan: NativePlan, stage: 'speaker' | 'participant' | 'translation') => (stage === 'translation' ? (plan.translation ? [plan.translation] : []) : plan[stage].models);
  const rows = [
    { stage: 'speaker' as const, icon: <Mic size={13} />, label: t('fork.languageMenu.iSay'), model: shown.speaker.model },
    { stage: 'participant' as const, icon: <Users size={13} />, label: t('fork.languageMenu.theySay'), model: shown.participant.model },
    { stage: 'translation' as const, icon: <Languages size={13} />, label: t('fork.plans.translation'), model: shown.translation },
  ];
  // Of a plan being put to use: how much of what it waits for has come.
  const waiting = pending?.stages.flatMap((s) => s.progress.filter((p) => s.waiting.includes(p.id))) ?? [];
  const total = waiting.reduce((sum, p) => sum + (p.total || bytesOf(p.id)), 0);
  const received = waiting.reduce((sum, p) => sum + p.received, 0);
  const failed = waiting.find((p) => p.state === 'failed');

  return (
    <section className="kt-card kt-plan" aria-label={t('fork.plans.title')}>
      <h4 className="kt-card__head">
        <span className="kt-card__icon"><SlidersHorizontal size={14} /></span>
        <span className="kt-card__title">{t('fork.plans.title')}</span>
        {current === null && <span className="kt-plan__custom">{t('fork.plans.custom')}</span>}
        <span className="kt-plan__corner">
          {speed.phase.name === 'running' ? (
            <Tooltip content={t('providers.localai.speedStop')} icon="none" position="top">
              <button type="button" className="kt-plan__icon-btn" onClick={speed.stop} aria-label={t('providers.localai.speedStop')}><Loader size={14} className="kt-plan__spin" /></button>
            </Tooltip>
          ) : ready && (
            <Tooltip content={t('fork.plans.speedTest')} icon="none" position="top">
              <button type="button" className="kt-plan__icon-btn" onClick={speed.start} disabled={disabled} aria-label={t('fork.plans.speedTest')}><Gauge size={14} /></button>
            </Tooltip>
          )}
        </span>
      </h4>

      <div className="kt-plan__options" role="radiogroup" aria-label={t('fork.plans.title')}>
        {plans.map((plan) => {
          const left = plan.downloadBytes;
          return (
            <button
              key={plan.id}
              type="button"
              role="radio"
              aria-checked={plan.id === shown.id}
              className={`kt-plan__option${plan.id === shown.id ? ' is-open' : ''}${plan.id === current ? ' is-current' : ''}`}
              onClick={() => setOpen(plan.id)}
            >
              <span className="kt-plan__name">
                {t(`fork.plans.${plan.id}`)}
                {known && plan.recommended && (
                  <Tooltip content={t(`fork.plans.why.${planWhy(inputs.memoryMB, inputs.lending)}`)} icon="none" position="top" maxWidth={240}>
                    <span className="kt-plan__recommended">{t('models.recommended', 'Recommended')}</span>
                  </Tooltip>
                )}
              </span>
              <Tooltip content={t('fork.plans.vram', { size: gb(plan.vramMB) })} icon="none" position="top">
                <span className="kt-plan__chip"><MemoryStick size={11} />{gb(plan.vramMB)}</span>
              </Tooltip>
              {/* In use, it is downloaded: the line says the one that matters. */}
              <span className={`kt-plan__chip${plan.id === current ? ' kt-plan__chip--current' : ''}`}>
                {plan.id === current ? <><CircleCheck size={11} />{t('fork.plans.inUse')}</>
                  : left > 0 ? <><Download size={11} />{sizeText(left)}</> : <><CircleCheck size={11} />{t('fork.plans.downloaded')}</>}
              </span>
            </button>
          );
        })}
      </div>

      <ul className="kt-plan__rows">
        {rows.map((row) => {
          const missing = stageAssets(shown, row.stage).filter((id) => !has(id));
          return (
            <li key={row.stage} className="kt-plan__row">
              <span className="kt-plan__row-icon">{row.icon}</span>
              <span className="kt-plan__row-label">{row.label}</span>
              <span className="kt-plan__row-model">{nameOf(row.model)}</span>
              {onCpu(row.model) && <span className="kt-plan__cpu">{t('providers.localai.tag_cpu')}</span>}
              <span className="kt-plan__row-state">
                {row.model && (missing.length === 0
                  ? <CircleCheck size={13} aria-label={t('fork.plans.downloaded')} />
                  : sizeText(missing.reduce((sum, id) => sum + bytesOf(id), 0)))}
              </span>
            </li>
          );
        })}
      </ul>

      {pending ? (
        <div className="kt-plan__pending" role="status">
          {failed ? <span className="kt-plan__failed">{t('fork.plans.failed')}</span>
            : <><Loader size={13} className="kt-plan__spin" /><span>{t('fork.plans.switching', { percent: total > 0 ? Math.floor((received / total) * 100) : 0 })}</span></>}
          <button type="button" className="kt-plan__cancel" onClick={() => nativePlanStore.getState().cancel()} aria-label={t('fork.plans.cancel')}><X size={13} /></button>
        </div>
      ) : shown.id !== current && (
        <button type="button" className="kt-plan__apply" onClick={() => nativePlanStore.getState().apply(shown)} disabled={disabled || !shown.speaker.model || !shown.participant.model}>
          {shown.downloadBytes > 0 ? <Download size={13} /> : <Check size={13} />}
          <span>{t('fork.plans.apply')}</span>
        </button>
      )}
      {/* The speed test pressed in the corner: its progress and what it found, here under it. */}
      <SpeedReportView state={speed} ready={ready} disabled={disabled} />
    </section>
  );
}
