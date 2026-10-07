import { useMemo, type CSSProperties } from 'react';
import type { LegName, SegmentId } from '../../lib/conversation/types';
import type { Entry } from '../../lib/projection/types';
import { displayItems, type LegFilters } from '../../lib/view/filter';
import { ConversationList, type ConversationListProps } from '../Conversation/ConversationList';
import { useVisibleEntries } from '../Conversation/useVisibleEntries';
import { SubtitleLanes } from './SubtitleLanes';
import { hasPanel, isLight, LOOKS, shadowFor } from '../../lib/subtitle/look';
import { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import './SubtitleStream.scss';

export interface SubtitleBodyProps {
  entries: readonly Entry[];
  /** Characters spoken so far, per segment. */
  lit: ReadonlyMap<SegmentId, number>;
  compact: boolean;
  fontSize: number;
  /** The subtitle's own display modes (independent of the panel's). */
  filters: LegFilters;
  sourceTextColor?: string;
  translationTextColor?: string;
  /** Fork: the panel's opacity, 0–100. Under `PANEL_FROM` there is no panel, and the lanes draw nothing that belongs to one (the hairline between them). Absent: taken for a panel. */
  bgOpacity?: number;
  newItemHighlightEnabled: boolean;
  /** Panel notes (spec 2026-10-05 §5): after the entries in the expanded list, never in the bands, which read L1 as the exports do (Ruling 8). */
  notes?: readonly Entry[];
  /** The action a system row in the expanded list offers, if any. */
  noticeAction?: ConversationListProps['noticeAction'];
  /** Fork: the legs this run hears, for the compact view's lanes. Absent: the legs that have said something. */
  legs?: readonly LegName[];
  /** Fork: told the height the compact view is laid out for and the least it can be squeezed into, whenever either changes: the window is fitted to the one and held above the other. */
  onHeight?(height: number, least: number): void;
}

const NO_REPLAY: ReadonlySet<LegName> = new Set();
const cannotReplay = () => false;
const noReplay = () => {};

/**
 * The subtitle's body. Compact: the fork's lanes (`SubtitleLanes`) — each
 * side's newest sentence with what answers it — in place of upstream's four
 * flowing bands (`src/lib/subtitle/bands.ts`, kept and no longer drawn).
 * Expanded: the panel's own list with the subtitle's filters and no replay.
 * The font size and the two text colours are published under today's names
 * for both (`--subtitle-*` for the lanes, `--conversation-*` for the list).
 */
export function SubtitleBody(props: SubtitleBodyProps) {
  const { lit, compact, fontSize, filters, sourceTextColor, translationTextColor, bgOpacity, notes, noticeAction, onHeight } = props;
  // The panel notes join the expanded list only (the same merge MainPanel does).
  const listed = useMemo(
    () => (compact || !notes || notes.length === 0 ? props.entries : [...props.entries, ...notes]),
    [compact, notes, props.entries],
  );
  // A transient notice (a microphone switch) or note leaves the subtitle once its time is up.
  const entries = useVisibleEntries(listed);
  const style: CSSProperties & Record<string, string> = {
    fontSize: `${fontSize}px`,
    '--conversation-font-size': `${fontSize}px`,
  };
  if (sourceTextColor) {
    style['--subtitle-source-color'] = sourceTextColor;
    style['--conversation-source-color'] = sourceTextColor;
  }
  if (translationTextColor) {
    style['--subtitle-translation-color'] = translationTextColor;
    style['--conversation-translation-color'] = translationTextColor;
  }
  // Fork: what the look draws around the text — a shadow or an outline, dark around light text and light around
  // dark — and where the lanes' text sits.
  const shadow = useSubtitleLookStore((state) => state.shadow);
  const align = useSubtitleLookStore((state) => state.align);
  const edge = LOOKS[useSubtitleLookStore((state) => state.look)].edge;
  style['--subtitle-shadow-source'] = shadowFor(sourceTextColor ?? '#ffffff', shadow, edge);
  style['--subtitle-shadow-answer'] = shadowFor(translationTextColor ?? '#ffffff', shadow, edge);
  // The small writing of the strip — readings, romanization — has an edge of its own.
  style['--subtitle-shadow-small'] = shadowFor(sourceTextColor ?? '#ffffff', shadow, edge, true);
  const edged = shadow > 0 && edge === 'outline' ? (isLight(sourceTextColor ?? '#ffffff') ? 'dark' : 'light') : undefined;
  // No panel under the text: the hairline between the lanes, which is the panel's, is not drawn (the user, 2026-10-07).
  const panel = bgOpacity !== undefined && !hasPanel(bgOpacity) ? 'none' : undefined;
  const items = useMemo(() => (compact ? [] : displayItems(entries, filters)), [compact, entries, filters]);
  // A lane for each leg heard; where the caller does not say which, for each that has said something.
  const legs = useMemo<readonly LegName[]>(
    () => props.legs ?? (['participant', 'speaker'] as const).filter((leg) => entries.some((entry) => entry.leg === leg)),
    [props.legs, entries],
  );
  return (
    <div className={`subtitle-stream ${compact ? 'compact' : 'expanded'}`} data-align={align} data-edge={edged} data-panel={panel} style={style}>
      {compact ? (
        <SubtitleLanes entries={entries} lit={lit} legs={legs} filters={filters} fontSize={fontSize} onHeight={onHeight} />
      ) : (
        <ConversationList
          items={items}
          lit={lit}
          replaying={null}
          replayLegs={NO_REPLAY}
          canReplay={cannotReplay}
          onReplay={noReplay}
          noticeAction={noticeAction}
          compact={false}
          fontSize={fontSize}
          empty={null}
        />
      )}
    </div>
  );
}
