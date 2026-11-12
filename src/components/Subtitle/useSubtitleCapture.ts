import { useLayoutEffect, useRef, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { registerSubtitleCapture } from '../../app/subtitleCapture';
import { createSubtitleRecorder, type SubtitleCaptureState } from '../../lib/subtitle/capture';
import type { Entry } from '../../lib/projection/types';
import { captionRows } from '../../lib/subtitle/dwell';
import { STREAM_MOST } from '../../lib/subtitle/lanes';
import { overlayTail } from '../../lib/subtitle/wire';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import { getSubtitleWindowHost } from './surfaces/subtitleWindowHost';
import type { SubtitleModel } from './SubtitleView';
import { capturedHeld, captureLaneChange } from './captureLaneState';

type Held = SubtitleCaptureState['held'];

/** The common tail plus each lane's answer anchor (which can be older during a long untranslated stretch). */
export function subtitleCaptureTail(entries: readonly Entry[], held: Held): readonly Entry[] {
  const included = new Set(overlayTail(entries));
  for (const leg of ['speaker', 'participant'] as const) {
    const mine = entries.filter((entry) => entry.leg === leg && entry.kind === 'exchange' && entry.lane !== 'video');
    for (const entry of mine.slice(-STREAM_MOST)) included.add(entry);
    const answer = [...mine].reverse().find((entry) => entry.kind === 'exchange' && captionRows(entry).some((row) => row.text.trim()));
    if (answer) included.add(answer);
    const anchor = mine.find((entry) => entry.id === held[leg]);
    if (anchor) included.add(anchor);
  }
  return entries.filter((entry) => included.has(entry));
}

/** Mounted only on a real surface; all listeners, buffers and save access disappear on close. */
export function useSubtitleCapture(root: RefObject<HTMLElement | null>, model: SubtitleModel, surface: SubtitleCaptureState['surface']) {
  const { i18n } = useTranslation();
  const latest = useRef(model);
  const record = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    latest.current = model;
    record.current?.();
  }, [model]);
  useLayoutEffect(() => {
    const element = root.current!;
    // Development previews use SubtitleView too; they are not the live desktop surface.
    if (surface === 'electron' && !getSubtitleWindowHost()?.contains(element)) return;
    const doc = element.ownerDocument;
    const owner = doc.defaultView!;
    const recorder = createSubtitleRecorder();
    const capture = () => {
      const { entries, session, lit } = latest.current;
      const held = capturedHeld.get(doc) ?? {};
      const tail = subtitleCaptureTail(entries, held);
      const ids = new Set(tail.flatMap((e) => e.kind === 'exchange' ? [...e.source, ...e.translation, ...(e.feedback ?? [])].map((r) => r.segmentId) : []));
      const { fontSize, compactMode, bgOpacity, bgColor, sourceTextColor, translationTextColor, newItemHighlightEnabled,
        alwaysOnTop, positionLocked, speakerDisplayMode, participantDisplayMode } = useSubtitleStore.getState();
      const { look, shadow, align } = useSubtitleLookStore.getState();
      const { furigana, romanization, romanizationOff, pinyin, jyutping, sourceItalic } = useAnnotationStore.getState();
      recorder.record({ entries: tail, session, lit: [...lit].filter(([id]) => ids.has(id)), held,
        settings: { fontSize, compactMode, bgOpacity, bgColor, sourceTextColor, translationTextColor, newItemHighlightEnabled,
          alwaysOnTop, positionLocked, speakerDisplayMode, participantDisplayMode },
        look: { look, shadow, align }, annotation: { furigana, romanization, romanizationOff, pinyin, jyutping, sourceItalic },
        viewport: { width: owner.innerWidth, height: owner.innerHeight, dpr: owner.devicePixelRatio }, surface });
    };
    record.current = capture;
    // Child layout effects run before the parent's model update. Read after that commit, not a mix of two renders.
    captureLaneChange.set(doc, () => queueMicrotask(() => { if (record.current === capture) capture(); }));
    const off = [useSubtitleStore.subscribe(capture), useSubtitleLookStore.subscribe(capture), useAnnotationStore.subscribe(capture),
      registerSubtitleCapture({ snapshot: () => { capture(); return recorder.snapshot(); }, language: () => i18n.language })];
    let resolution = owner.matchMedia(`(resolution: ${owner.devicePixelRatio}dppx)`);
    const dprChanged = () => {
      resolution.removeEventListener('change', dprChanged);
      resolution = owner.matchMedia(`(resolution: ${owner.devicePixelRatio}dppx)`);
      resolution.addEventListener('change', dprChanged);
      capture();
    };
    resolution.addEventListener('change', dprChanged);
    owner.addEventListener('resize', capture);
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      off.forEach((fn) => fn());
      resolution.removeEventListener('change', dprChanged);
      owner.removeEventListener('resize', capture);
      owner.removeEventListener('pagehide', stop);
      captureLaneChange.delete(doc);
      capturedHeld.delete(doc);
      recorder.clear();
      record.current = null;
    };
    owner.addEventListener('pagehide', stop);
    capture();
    return stop;
  }, [root, surface, i18n]);
}
