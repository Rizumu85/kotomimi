import type { LanguagePair, SharedSettings } from '../provider/types';
import type { GlossarySnapshot } from '../glossary/types';

/**
 * What every builder may read beyond its own settings, resolved once per
 * run: the segmentation pauses, which direction is the participant's, and
 * the display segmentation. The participant's direction is the pair's
 * reverse as the provider states it (`reversedPair`; Stage 2 Palabra,
 * ruling 9), null when the pair has none. The system instructions are each
 * provider's own setting (Stage 2 Gemini, ruling 4;
 * `src/lib/provider/instructions.ts`). The glossary is the table itself, every
 * leg's: what a model is told comes from it at the start, and what recognition
 * wrote is put right from it as it stands (`WordFix`, during a run).
 */
export function buildSharedSettings(
  participant: LanguagePair | null,
  pauses: SharedSettings['pauses'],
  segmentation: SharedSettings['segmentation'],
  glossary?: GlossarySnapshot,
): Omit<SharedSettings, 'models'> {
  return {
    pauses,
    segmentation,
    reversed: (direction) => participant !== null && direction.source === participant.source && direction.target === participant.target,
    ...(glossary ? { glossary } : {}),
  };
}
