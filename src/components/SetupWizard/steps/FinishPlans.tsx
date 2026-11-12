/**
 * Fork: the setup's last step, for the Kotomimi provider on this computer: the three plans as one row of choices, the
 * one that fits this computer starred and chosen until another is, each with what it leaves to download. Finish puts
 * the chosen one to use (`applySetup.ts`): its models download after the setup, and each stage switches once its
 * model is in. The models themselves are on the plan card in Settings.
 */
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, Download, Star } from 'lucide-react';
import { sizeText } from '../../../lib/native/modelStorage';
import { LOCALAI_DEFAULTS } from '../../../providers/openai/localai';
import { usePlans } from '../../../providers/openai/usePlans';
import type { SetupAction, SetupDraft } from '../setupDraft';

/** `keep`: a re-run that left the place alone: nothing is chosen until one is, and Finish then keeps the models. */
export function FinishPlans({ draft, dispatch, keep = false }: { draft: SetupDraft; dispatch: React.Dispatch<SetupAction>; keep?: boolean }) {
  const { t } = useTranslation();
  // The settings as Finish will write them: this computer for every stage.
  const settings = useMemo(() => ({ ...LOCALAI_DEFAULTS, asrVia: 'device' as const, translateAt: 'device' as const }), []);
  const pair = useMemo(() => ({ source: draft.sourceLanguage!, target: draft.targetLanguage! }), [draft.sourceLanguage, draft.targetLanguage]);
  const { plans, recommended, inputs } = usePlans(settings, pair);
  const chosen = draft.plan ?? (!keep && inputs.memoryMB !== undefined ? recommended : null);
  return (
    <div className="setup-plans" role="radiogroup" aria-label={t('fork.plans.title')}>
      {plans.map((plan) => (
        <button
          key={plan.id}
          type="button"
          role="radio"
          aria-checked={plan.id === chosen}
          className={`setup-plans__option${plan.id === chosen ? ' is-chosen' : ''}`}
          onClick={() => dispatch({ type: 'setPlan', plan: plan.id })}
        >
          <span className="setup-plans__name">
            {t(`fork.plans.${plan.id}`)}
            {inputs.memoryMB !== undefined && plan.id === recommended && <Star size={12} className="setup-plans__star" aria-label={t('models.recommended', 'Recommended')} />}
          </span>
          <span className="setup-plans__size">
            {plan.downloadBytes > 0 ? <><Download size={11} />{sizeText(plan.downloadBytes)}</> : <><CircleCheck size={11} />{t('fork.plans.downloaded')}</>}
          </span>
        </button>
      ))}
    </div>
  );
}
