import { create } from 'zustand';
import { useSettingsStore } from '../stores/settingsStore';
import { DeviceCaptureRecorder } from '../lib/modern-audio/DeviceCaptureRecorder';
import { micSettings } from '../lib/audio/appCapture';
import { SAMPLE_RATE } from '../lib/contract/adapter';
import type { LegName } from '../lib/conversation/types';
import type { Entry, Row } from '../lib/projection/types';
import type { RunState } from '../lib/session/types';
import type { Readable } from '../lib/view/conversationView';
import { describeCause, reportError } from '../lib/diagnostics/report';
import { isElectron } from '../utils/environment';

export type SessionRecordingResult = { ok: true } | { ok: false; error: string; reason?: 'not-recorded' | 'desktop-only' };
const recordingState = create<{ running: boolean }>(() => ({ running: false }));
export const useSessionRecording = () => recordingState((s) => s.running);
const text = (rows: Row[]) => rows.map((r) => r.text).join('');
export type ExchangeEntry = Extract<Entry, { kind: 'exchange' }>;

async function invoke(channel: string, payload?: unknown): Promise<SessionRecordingResult> {
  if (!isElectron()) return { ok: false, reason: 'desktop-only', error: 'Session recordings require the desktop app.' };
  try {
    const result: SessionRecordingResult = await window.electron.invoke(channel, payload);
    if (!result.ok && result.reason !== 'not-recorded') reportError('SessionRecording', result.error);
    return result;
  } catch (cause) {
    const error = describeCause(cause);
    reportError('SessionRecording', error, { cause });
    return { ok: false, error };
  }
}

export function markSessionLine(entry: ExchangeEntry): Promise<SessionRecordingResult> {
  return invoke('session-recording:mark', { wallTime: entry.t, leg: entry.leg, entryId: entry.id,
    sourceText: text(entry.source), translationText: text(entry.translation), markedAt: Date.now() });
}
export function openSessionRecordings(): Promise<SessionRecordingResult> { return invoke('session-recording:open'); }

/** One run owns the raw device and a bounded IPC queue. A slow disk ends recording, never translation. */
export function createSessionRecording() {
  type Run = {
    startedAt: number; origin: number; accepting: boolean; failed: boolean; opened: boolean; pendingBytes: number;
    queue: Promise<void>; raw: DeviceCaptureRecorder; rawOpening: Promise<void>;
    seen: Map<string, { source: boolean; translation: boolean }>;
  };
  let current: Run | null = null;
  let settled = Promise.resolve();
  const ms = (run: Run) => performance.now() - run.origin;
  const enqueue = (run: Run, channel: string, payload: unknown, bytes = 0) => {
    run.pendingBytes += bytes;
    run.queue = run.queue.then(async () => {
      try {
        if (run.failed && channel === 'session-recording:write') return;
        const result = await invoke(channel, payload);
        if (channel === 'session-recording:start' && result.ok) run.opened = true;
        if (!result.ok) {
          run.failed = true; run.accepting = false; recordingState.setState({ running: false });
          for (const t of run.raw.getStream()?.getTracks() ?? []) t.stop();
        }
      } finally { run.pendingBytes -= bytes; }
    });
  };
  const pcm = (leg: LegName | 'raw', chunk: Int16Array, rate = SAMPLE_RATE) => {
    const run = current;
    if (!run?.accepting) return;
    if (run.pendingBytes + chunk.byteLength > 8 * 1024 * 1024) {
      run.accepting = false;
      recordingState.setState({ running: false });
      reportError('SessionRecording', 'Recording stopped because the disk could not keep up.');
      for (const t of run.raw.getStream()?.getTracks() ?? []) t.stop();
      return;
    }
    enqueue(run, 'session-recording:write', { kind: 'pcm', leg, pcm: chunk.slice(), rate, ms: ms(run) }, chunk.byteLength);
  };
  const track = (data: Record<string, unknown>) => {
    const run = current;
    if (run?.accepting) enqueue(run, 'session-recording:write', { kind: 'track', data: { ...data, ms: ms(run), wallTime: Date.now() } });
  };
  const measure = (entries: readonly Entry[]) => {
    const run = current;
    if (!run?.accepting) return;
    for (const entry of entries) {
      if (entry.kind !== 'exchange' || entry.lane === 'video' || entry.t < run.startedAt) continue;
      const key = `${entry.leg}:${entry.id}`;
      const seen = run.seen.get(key) ?? { source: false, translation: false };
      for (const stage of ['source', 'translation'] as const) {
        if (seen[stage] || !entry[stage].some((r) => r.text.trim()) || !entry[stage].every((r) => r.final)) continue;
        if (stage === 'translation' && !seen.source) continue;
        seen[stage] = true;
        enqueue(run, 'session-recording:write', { kind: 'line', data: {
          stage, leg: entry.leg, entryId: entry.id, ms: ms(run), wallTime: Date.now(), lineWallTime: entry.t,
          sourceText: text(entry.source), sourceLanguage: entry.source.find((r) => r.language)?.language,
          translations: entry.translation.map((r) => ({ text: r.text, language: r.language })),
        } });
      }
      if (seen.source) run.seen.set(key, seen);
    }
  };
  const end = () => {
    const run = current;
    if (!run) return settled;
    current = null;
    run.accepting = false;
    recordingState.setState({ running: false });
    const endedAt = Date.now(), durationMs = ms(run);
    for (const t of run.raw.getStream()?.getTracks() ?? []) t.stop();
    void run.rawOpening.then(async () => {
      await run.raw.end();
    }).catch((cause: unknown) => reportError('SessionRecording', `Closing raw capture failed: ${describeCause(cause)}`, { cause }));
    settled = run.queue.then(async () => {
      if (run.opened) await invoke('session-recording:end', { endedAt, durationMs });
    });
    return settled;
  };
  return {
    pcm, track, settled: () => settled,
    drive(deps: {
      runner: { state: { getState(): RunState; subscribe(fn: () => void): () => void } };
      view: Readable<{ entries: readonly Entry[] }> & { flush(): void };
      metadata(): Record<string, unknown>;
    }) {
      let previousPhase = deps.runner.state.getState().phase;
      let lastMetadata = '';
      const metadata = () => {
        if (!current?.accepting) return;
        const data = deps.metadata();
        const serialized = JSON.stringify(data);
        if (serialized === lastMetadata) return;
        lastMetadata = serialized;
        enqueue(current, 'session-recording:write', { kind: 'metadata', data });
      };
      const phase = () => {
        const phase = deps.runner.state.getState().phase;
        const began = phase === 'starting' && previousPhase === 'idle';
        previousPhase = phase;
        if (began && isElectron() && useSettingsStore.getState().recordSessions) {
          const settings = micSettings();
          const deviceId = settings.deviceId();
          const run: Run = { startedAt: Date.now(), origin: performance.now(), accepting: true, failed: false, opened: false,
            pendingBytes: 0, queue: settled, raw: new DeviceCaptureRecorder(SAMPLE_RATE), rawOpening: Promise.resolve(), seen: new Map() };
          current = run;
          lastMetadata = '';
          enqueue(run, 'session-recording:start', { startedAt: run.startedAt, metadata: {
            ...deps.metadata(), microphoneDeviceId: deviceId, microphoneLabel: settings.deviceLabel(),
            echoCancellation: settings.echoCancellation(), rawFollowsDeviceChanges: false,
          } });
          run.rawOpening = run.queue.then(async () => {
            if (current !== run || !run.accepting) return;
            recordingState.setState({ running: true });
            if (!deviceId) throw new Error('No microphone is selected for unprocessed capture.');
            if (!await run.raw.begin({ deviceId })) throw new Error('The unprocessed microphone could not be opened.');
            if (current !== run || !run.accepting) { await run.raw.end(); return; }
            const rawTrack = run.raw.getStream()!.getAudioTracks()[0];
            track({ kind: 'raw', label: rawTrack.label, settings: rawTrack.getSettings() });
            rawTrack.addEventListener('ended', () => {
              if (current === run && run.accepting) {
                track({ kind: 'raw-ended' });
                reportError('SessionRecording', 'The unprocessed microphone track ended during recording.');
              }
            }, { once: true });
            await run.raw.record((data) => { if (current === run) pcm('raw', data.mono); });
          }).catch((cause: unknown) => {
            if (current === run) track({ kind: 'raw-error', error: describeCause(cause) });
            reportError('SessionRecording', `Raw microphone capture failed: ${describeCause(cause)}`, { cause });
          });
        }
        if (phase === 'running') metadata();
        if (phase === 'idle' && current) { deps.view.flush(); measure(deps.view.get().entries); void end(); }
      };
      const offs = [deps.runner.state.subscribe(phase), deps.view.subscribe(() => {
        if (deps.runner.state.getState().phase !== 'idle') metadata();
        measure(deps.view.get().entries);
      }),
        useSettingsStore.subscribe((s) => s.recordSessions, (on) => { if (!on) void end(); })];
      return () => { for (const off of offs) off(); void end(); };
    },
  };
}
