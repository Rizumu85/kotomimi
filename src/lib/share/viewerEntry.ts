// src/lib/share/viewerEntry.ts
import type { Entry, Row } from '../projection/types';
import type { ViewerEntry, ViewerRow } from './types';

const row = (r: Row): ViewerRow => ({ key: r.key, text: r.text, final: r.final, language: r.language });

/**
 * What a viewer reads of one entry; notices stay with the host (spec 2026-10-04 §3.1). Fork: `feedback`, the entry's
 * legacy answer is grammar feedback on what the user said. Explicit translations remain visible alongside private feedback.
 */
export function toViewerEntry(entry: Entry, feedback = false): ViewerEntry | null {
  // Fork: a video's words (VRChat) are the host's aside, not the conversation.
  if (entry.kind !== 'exchange' || entry.lane === 'video') return null;
  return {
    id: entry.id,
    leg: entry.leg,
    t: entry.t,
    languages: { source: entry.languages.source, target: entry.languages.target },
    source: entry.source.map(row),
    translation: entry.translation.filter((r) => r.purpose !== 'feedback' && (!feedback || r.purpose === 'translation')).map(row),
  };
}
