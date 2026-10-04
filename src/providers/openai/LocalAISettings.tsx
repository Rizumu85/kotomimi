import { InstructionsField } from '../../components/providers/fields/InstructionsField';
import { LanSharingSection } from '../../components/LanSharing/LanSharingSection';
import { LocalServerCard } from '../../components/LanSharing/LocalServerCard';
import { resolveInstructions } from '../../lib/provider/instructions';
import type { SettingsProps } from '../../lib/provider/types';
// Type only: `localai.ts` imports this view, and a value import back would close a cycle.
import type { LocalAISettings as S } from './localai';
import { realtimeLanguageName, realtimeLanguages } from './settings';
import './LocalAISettings.scss';

/**
 * Fork: what the provider's own page holds besides the stages. The stages —
 * where each runs, and its model — are the cards under the provider
 * (`LocalAIAssist`), the same in both layouts; here are the two things that
 * belong to no single stage: the translation's instructions, and sharing this
 * computer's models with other devices.
 */
export function LocalAISettingsView({ settings, update, disabled = false, pair }: SettingsProps<S>) {
  const initial = realtimeLanguages.initial?.(settings);
  const source = pair?.source ?? initial?.source ?? '';
  const target = pair?.target ?? initial?.target ?? '';
  const preview = resolveInstructions(settings, { participant: false, source: realtimeLanguageName(source), target: realtimeLanguageName(target) });
  return (
    <div className="kt-stages">
      {/* The instructions are the other device's pipeline's and a text model's: this computer's translation models carry their own. */}
      {settings.translateAt !== 'device' && <InstructionsField value={settings} onChange={update} preview={preview} disabled={disabled} />}
      <LocalServerCard disabled={disabled} />
      <LanSharingSection disabled={disabled} pair={pair} />
    </div>
  );
}
