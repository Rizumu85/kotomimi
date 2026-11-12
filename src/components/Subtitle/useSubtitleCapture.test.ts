import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSubtitleCapture, subtitleCaptureTail } from './useSubtitleCapture';
import { useSubtitleCaptureLanes } from './captureLaneState';
import { setSubtitleWindowHost } from './surfaces/subtitleWindowHost';
import { saveSubtitleCapture } from '../../app/subtitleCapture';
import { useSubtitleStore } from '../../stores/subtitleStore';
import { useSubtitleLookStore } from '../../stores/subtitleLookStore';
import { useAnnotationStore } from '../../stores/annotationStore';
import type { Entry } from '../../lib/projection/types';
import { readSubtitleCapture, type SubtitleCaptureRecording, type SubtitleCaptureState } from '../../lib/subtitle/capture';
import fixture from '../../lib/subtitle/__fixtures__/capture.json';

vi.mock('../../services/ServiceFactory', () => ({ ServiceFactory: { getSettingsService: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: language }) }));
const language = { language: 'zh-CN' };
const loadedFixture = readSubtitleCapture(JSON.stringify(fixture), fixture.appVersion);
if (!loadedFixture.ok) throw new Error(loadedFixture.error);
const initial = loadedFixture.capture.frames[0].state as SubtitleCaptureState;
const model = { entries: initial.entries, session: initial.session, lit: new Map(initial.lit) };
let frame: HTMLIFrameElement;
let root: { current: HTMLDivElement };
let owner: Window;
let media: EventTarget;
let invoke: ReturnType<typeof vi.fn>;
const oldSettings = useSubtitleStore.getState();
const oldLook = useSubtitleLookStore.getState();
const oldAnnotation = useAnnotationStore.getState();

beforeEach(() => {
  frame = document.createElement('iframe');
  document.body.appendChild(frame);
  owner = frame.contentWindow!;
  root = { current: owner.document.createElement('div') };
  owner.document.body.appendChild(root.current);
  setSubtitleWindowHost(root.current);
  Object.defineProperties(owner, { innerWidth: { configurable: true, value: 720 }, innerHeight: { configurable: true, value: 240 }, devicePixelRatio: { configurable: true, value: 1.5 } });
  media = new EventTarget();
  Object.defineProperty(owner, 'matchMedia', { value: vi.fn(() => media), configurable: true });
  invoke = vi.fn().mockResolvedValue({ ok: true, path: 'saved.json' });
  vi.stubGlobal('electron', { invoke });
});
afterEach(() => {
  setSubtitleWindowHost(null);
  frame.remove();
  useSubtitleStore.setState(oldSettings);
  useSubtitleLookStore.setState(oldLook);
  useAnnotationStore.setState(oldAnnotation);
  vi.unstubAllGlobals();
});
const latestSave = () => invoke.mock.calls[invoke.mock.calls.length - 1][1] as SubtitleCaptureRecording;
const lastState = () => Object.assign({}, ...latestSave().frames.map((frame) => frame.state)) as SubtitleCaptureState;

describe('live subtitle capture hookup', () => {
  it('captures model, dwell, look, annotation and the child viewport, then completely detaches', async () => {
    const mounted = renderHook(({ current, held }) => {
      useSubtitleCaptureLanes(root, current.entries, held);
      useSubtitleCapture(root, current, 'electron');
    }, { initialProps: { current: model, held: initial.held } });
    await saveSubtitleCapture();
    expect(lastState()).toMatchObject({ entries: initial.entries, lit: initial.lit, session: initial.session,
      held: initial.held, viewport: { width: 720, height: 240, dpr: 1.5 } });
    act(() => {
      useSubtitleStore.setState({ fontSize: 42 });
      useSubtitleLookStore.setState({ align: 'center' });
      useAnnotationStore.setState({ pinyin: true });
    });
    mounted.rerender({ current: { ...model, lit: new Map([['t', 30]]) }, held: {} });
    Object.defineProperty(owner, 'innerWidth', { value: 600 });
    act(() => owner.dispatchEvent(new Event('resize')));
    Object.defineProperty(owner, 'devicePixelRatio', { value: 2 });
    act(() => media.dispatchEvent(new Event('change')));
    await saveSubtitleCapture();
    expect(lastState()).toMatchObject({ lit: [['t', 30]], held: {}, settings: { fontSize: 42 }, look: { align: 'center' },
      annotation: { pinyin: true }, viewport: { width: 600, height: 240, dpr: 2 } });
    expect(latestSave().frames.length).toBeGreaterThanOrEqual(5);
    mounted.unmount();
    expect(await saveSubtitleCapture()).toMatchObject({ ok: false, error: expect.stringContaining('closed') });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('stops on native pagehide, and a reopened surface starts with a fresh buffer', async () => {
    const mount = () => renderHook(() => useSubtitleCapture(root, model, 'electron'));
    const first = mount();
    act(() => owner.dispatchEvent(new Event('pagehide')));
    expect(await saveSubtitleCapture()).toMatchObject({ ok: false });
    first.unmount();
    const second = mount();
    await saveSubtitleCapture();
    expect(latestSave().frames).toHaveLength(1);
    second.unmount();
  });

  it('does not register desktop previews as live captures', async () => {
    setSubtitleWindowHost(null);
    const mounted = renderHook(() => useSubtitleCapture(root, model, 'electron'));
    expect(await saveSubtitleCapture()).toMatchObject({ ok: false });
    expect(owner.matchMedia).not.toHaveBeenCalled();
    mounted.unmount();
  });
});

it('keeps a bounded tail with the quiet leg, a distant last answer and a held answer', () => {
  const original = initial.entries[0] as Extract<Entry, { kind: 'exchange' }>;
  const entries: Entry[] = Array.from({ length: 200 }, (_, i) => ({ ...original, id: String(i), leg: 'participant', translation: i < 2 ? original.translation : [] }));
  entries.unshift({ ...original, id: 'quiet', leg: 'speaker' });
  const tail = subtitleCaptureTail(entries, { participant: '0' });
  expect(tail).toHaveLength(33);
  expect(tail.map((entry) => entry.id)).toEqual(['quiet', '0', '1', ...Array.from({ length: 30 }, (_, i) => String(170 + i))]);
});
