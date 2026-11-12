/**
 * Fork: the plans for this computer, at the top of the Kotomimi provider's cards: 轻量 / 均衡 / 精准, each with about
 * how much video memory it takes and what is left to download, the one that fits this computer starred. A plan opens
 * on its three models — the user's side, the other side, the translation — and is put to use only on a press: what is
 * missing downloads, and each stage switches once its model is here (`nativePlanStore`). Nothing switches by itself.
 * The two sides on different models (a CPU one for the user, one on the graphics card for the other side) is shown
 * by the plan itself, not explained. The speed test lives in the corner, for whoever wants it.
 */
import { useEffect, useState } from 'react';
import { useStore } from 'zustand';
import { useTranslation } from 'react-i18next';
import { Check, ChevronDown, CircleCheck, Download, Gauge, Languages, Loader, MemoryStick, Mic, SlidersHorizontal, Star, Users, X } from 'lucide-react';
import { useSettingsNavigationTarget } from '../../stores/settingsStore';
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

/**
 * `speedShown`: a speed test was run in this visit, so its findings show; before that nothing of an earlier one does.
 * `onSpeedTest`: starts one (and says so to the stage cards, which show their lines then too).
 */
export function PlanCard({ settings, pair, speed, speedShown, onSpeedTest, ready, disabled }: { settings: LocalAISettings; pair: LanguagePair; speed: SpeedTestState; speedShown: boolean; onSpeedTest(): void; ready: boolean; disabled?: boolean }) {
  const { t } = useTranslation();
  const { plans, recommended, current, inputs } = usePlans(settings, pair);
  const pending = useStore(nativePlanStore, (s) => s.pending);
  const [open, setOpen] = useState<NativePlanId | null>(null);
  // Quiet once set up: one line, the plan in use. Open on a first use (nothing downloaded), while a plan is being
  // put to use, when sent here (the falling-behind notice's "See plans"), or by a press.
  const target = useSettingsNavigationTarget();
  const [expanded, setExpanded] = useState(() => inputs.downloaded.length === 0);
  useEffect(() => { if (target === 'plans') setExpanded(true); }, [target]);
  const unfolded = expanded || pending !== null;
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

  const fold = (
    <button type="button" className="kt-plan__fold" onClick={() => setExpanded(!unfolded)} aria-expanded={unfolded}>
      <span className="kt-plan__now">{current ? t(`fork.plans.${current}`) : t('fork.plans.custom')}</span>
      <ChevronDown size={14} className={`kt-plan__chevron${unfolded ? ' is-open' : ''}`} />
    </button>
  );
  if (!unfolded) {
    return (
      <section className="kt-card kt-plan kt-plan--folded" id="plans-section" aria-label={t('fork.plans.title')}>
        <h4 className="kt-card__head">
          <span className="kt-card__icon"><SlidersHorizontal size={14} /></span>
          <span className="kt-card__title">{t('fork.plans.title')}</span>
          {fold}
        </h4>
      </section>
    );
  }

  return (
    <section className="kt-card kt-plan" id="plans-section" aria-label={t('fork.plans.title')}>
      <h4 className="kt-card__head">
        <span className="kt-card__icon"><SlidersHorizontal size={14} /></span>
        <span className="kt-card__title">{t('fork.plans.title')}</span>
        <span className="kt-plan__corner">
          {speed.phase.name === 'running' ? (
            <Tooltip content={t('providers.localai.speedStop')} icon="none" position="top">
              <button type="button" className="kt-plan__icon-btn" onClick={speed.stop} aria-label={t('providers.localai.speedStop')}><Loader size={14} className="kt-plan__spin" /></button>
            </Tooltip>
          ) : ready && (
            <Tooltip content={t('fork.plans.speedTest')} icon="none" position="top">
              <button type="button" className="kt-plan__icon-btn" onClick={onSpeedTest} disabled={disabled} aria-label={t('fork.plans.speedTest')}><Gauge size={14} /></button>
            </Tooltip>
          )}
          {fold}
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
                    <Star size={12} className="kt-plan__recommended" aria-label={t('models.recommended', 'Recommended')} />
                  </Tooltip>
                )}
              </span>
              <Tooltip content={t('fork.plans.vram', { size: gb(plan.vramMB) })} icon="none" position="top">
                <span className="kt-plan__chip"><MemoryStick size={11} />{gb(plan.vramMB)}</span>
              </Tooltip>
              {/* In use, it is downloaded: the line says the one that matters. */}
              {(() => {
                // A word longer than the choice is wide (French, Tamil) ends in an ellipsis, whole on hover.
                const said = plan.id === current ? t('fork.plans.inUse') : left > 0 ? sizeText(left) : t('fork.plans.downloaded');
                return (
                  <span className={`kt-plan__chip${plan.id === current ? ' kt-plan__chip--current' : ''}`} title={said}>
                    {left > 0 && plan.id !== current ? <Download size={11} /> : <CircleCheck size={11} />}
                    <span className="kt-plan__chip-text">{said}</span>
                  </span>
                );
              })()}
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
      {/* The speed test pressed in the corner: its progress and what it found, here under it, once run in this visit. */}
      {speedShown && <SpeedReportView state={speed} ready={ready} disabled={disabled} />}
    </section>
  );
}
