import { useMemo } from 'react';
import type { EchoNoticeState } from '../../lib/modern-audio/EchoMonitor';
import type { RunEnd, RunState } from '../../lib/session/types';
import type { SubtitleIdleModel } from '../../lib/subtitle/session';
import { statusLine, type StatusEntry } from '../../lib/view/statusLine';
import { useSelectedInputDevice } from '../../stores/audioStore';
import { useSubtitleEntryHint } from '../../stores/subtitleStore';
import { useVRChatStore, vrchatHolds } from '../../stores/vrchatStore';

export interface UseStatusLineArgs {
  run: RunState;
  idle: SubtitleIdleModel;
  canStart: boolean;
  dismissedEnd: RunEnd | null;
  /** `useEchoNotice`'s visible notice; null where no echo is watched (the takeover window). */
  echo: EchoNoticeState | null;
}

/**
 * The status line's inputs from the stores (spec 2026-10-05 §3): the
 * selected input for the microphone wait, the subtitle store for the entry
 * hint; the run, the gate and the echo come from the caller. Shared by
 * MainPanel and the Electron takeover, so both draw the same line.
 */
export function useStatusLine({ run, idle, canStart, dismissedEnd, echo }: UseStatusLineArgs): StatusEntry | null {
  const selectedInput = useSelectedInputDevice();
  const entryHint = useSubtitleEntryHint();
  // No usable input is selected: `audioStore` clears the selection when none is left (#596).
  const waitingForMicrophone = run.phase === 'running' && run.legs.speaker !== undefined && selectedInput === null;
  // Fork: muted in VRChat, the microphone source gives silence (`src/app/vrchat.ts`).
  const held = useVRChatStore((state) => vrchatHolds(state));
  const mutedInVRChat = held && run.phase === 'running' && run.legs.speaker !== undefined;
  return useMemo(
    () => statusLine({ run, idle, canStart, dismissedEnd, waitingForMicrophone, mutedInVRChat, subtitleEntryHint: entryHint === 'refresh', echo }),
    [run, idle, canStart, dismissedEnd, waitingForMicrophone, mutedInVRChat, entryHint, echo],
  );
}
