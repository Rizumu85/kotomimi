import { baseLanguage } from '../../lib/language/code';
import { nativeModel } from './localaiNative';

export interface NativeRecommendation {
  id: string | null;
  reason: 'lending' | 'big' | 'small' | 'default';
}

/** Advice for the native model list, after its direction/language filters. An empty list has no recommendation. */
export function recommendNativeModel(
  kind: 'asr' | 'translation', offered: readonly string[], memoryMB: number | null,
  lending: boolean, languages: readonly string[],
): NativeRecommendation {
  // Leave room below nominal 8/16 GiB: cards can report slightly less dedicated memory.
  const small = memoryMB !== null && memoryMB < 7680;
  let id: string;
  let reason: NativeRecommendation['reason'] = 'default';
  if (kind === 'translation') {
    id = small ? 'plamo-3-translate-0.8b' : 'index-translate-2b';
    if (small) reason = 'small';
  } else if (lending || (memoryMB !== null && memoryMB >= 15360)) {
    id = 'qwen3-asr-1.7b-q8';
    reason = lending ? 'lending' : 'big';
  } else if (small && languages.length > 0 && languages.every((language) => nativeModel('sensevoice-small-q8').languages.includes(baseLanguage(language) ?? ''))) {
    id = 'sensevoice-small-q8';
    reason = 'small';
  } else {
    id = 'qwen3-asr-0.6b-q8';
  }
  return offered.includes(id) ? { id, reason } : { id: offered[0] ?? null, reason: 'default' };
}
