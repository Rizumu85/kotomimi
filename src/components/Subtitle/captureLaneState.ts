import { useLayoutEffect, type RefObject } from 'react';
import type { Entry } from '../../lib/projection/types';
import type { SubtitleCaptureState } from '../../lib/subtitle/capture';

export const capturedHeld = new WeakMap<Document, SubtitleCaptureState['held']>();
export const captureLaneChange = new WeakMap<Document, () => void>();

/** A lane's timer changes what is drawn without a new model from the conversation. */
export function useSubtitleCaptureLanes(root: RefObject<HTMLElement | null>, entries: readonly Entry[], held: SubtitleCaptureState['held']) {
  useLayoutEffect(() => {
    const doc = root.current!.ownerDocument;
    capturedHeld.set(doc, held);
    captureLaneChange.get(doc)?.();
    return () => { capturedHeld.delete(doc); };
  }, [root, entries, held]);
}
