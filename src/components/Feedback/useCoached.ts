import { useCoachingStore } from '../../stores/coachingStore';

/**
 * Fork: whether what answers the user's own sentences is grammar feedback. Told by the setting, not by the answer: an
 * answer's language is the one its reason is written in (the user's own), not the sentence's, and could not tell
 * feedback from a translation (seen 2026-10-23: a real run's feedback came tagged zh-CN under a Japanese sentence).
 */
export function useCoached(): boolean {
  return useCoachingStore((s) => s.coached);
}
