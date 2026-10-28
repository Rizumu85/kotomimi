// src/lib/share/viewerEntry.ts
import type { Entry, Row } from '../projection/types';
import type { ViewerEntry, ViewerRow } from './types';

const row = (r: Row): ViewerRow => ({ key: r.key, text: r.text, final: r.final });

/**
 * What a viewer reads of one entry; notices stay with the host (spec 2026-10-04 §3.1). Fork: `feedback`, the entry's
 * answer is grammar feedback on what the user said, which is theirs alone: the viewer reads what was said, no answer.
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
    translation: feedback ? [] : entry.translation.map(row),
  };
}
