/**
 * The page's capture — with `appAudio.ts`, the only modules in `src/lib/audio`
 * that read the stores. Opens each leg's source for the platform, feeds the
 * microphone into playback's passthrough route, both legs into the echo
 * watch and what sounds into the microphone's echo gate, and reads the
 * settings the sources follow, live, from `audioStore`.
 */
import type { LegName } from '../conversation/types';
import type { Platform } from '../provider/types';
import type { OpenSource, Source } from '../session/source';
import { useVRChatStore, vrchatHolds } from '../../stores/vrchatStore';
import useAudioStore from '../../stores/audioStore';
import { getEnvironment } from '../../utils/environment';
import { createEchoWatch, type EchoWatch } from './capture/echoWatch';
import { createEchoFollower } from './capture/echoFollow';
import { openMic, type MicSettings } from './capture/mic';
import { createPlayoutReference, type PlayoutChunk } from './capture/playoutReference';
import { openSystemAudio, type SystemAudioSettings } from './capture/systemAudio';
import { openTab, type TabSettings } from './capture/tab';
import { createLevelMeter, type LevelMeter } from './levelMeter';
import { micLevel } from './micLevel';
import type { Playback } from './playback';
import { targetTabIdFromSearch } from './tabMicrophone';

export interface AppCapture {
  openSource: OpenSource;
  /** For the echo notice (plan 1d): `useEchoNotice`'s one-listener contract. */
  echo: EchoWatch;
  /** Whether each leg hears sound, for the dot on its footer button: over the chunks it delivers while `meterGate` lets them through. */
  levels: Readonly<Record<LegName, LevelMeter>>;
}

const audio = () => useAudioStore.getState();
const onAudioChange = (listener: () => void) => useAudioStore.subscribe(() => listener());

/** Asks the main process which applications are using a microphone (spec 2026-10-13 §1); null when it cannot tell. */
async function appsUsing(label: string): Promise<string[] | null> {
  try {
    const answer = (await window.electron.invoke('list-microphone-users', label)) as { ok?: unknown; users?: unknown } | undefined;
    if (answer?.ok !== true || !Array.isArray(answer.users)) return null;
    return answer.users.filter((user): user is string => typeof user === 'string');
  } catch {
    return null;
  }
}

const windowsDesktop = () => (window as { electron?: { osInfo?: { platform?: unknown } } }).electron?.osInfo?.platform === 'win32';

export function micSettings(): MicSettings {
  return {
    deviceId: () => audio().selectedInputDevice?.deviceId,
    deviceLabel: () => audio().selectedInputDevice?.label,
    isListed: (id) => audio().audioInputDevices.some((device) => device.deviceId === id),
    isUnusable: (id) => audio().unusableInputIds.includes(id),
    markUnusable: (id) => audio().markInputUnusable(id),
    noiseSuppression: () => audio().noiseSuppressionMode,
    noiseSuppressionState: (state) => audio().setNoiseSuppressionState(state),
    echoCancellation: () => audio().echoCancellationMode,
    muted: () => audio().isMicMuted,
    // Fork: the activation threshold, and the meter it is set by (`micGate.ts`, `micLevel.ts`).
    activation: () => audio().micGateThreshold,
    level: (level) => micLevel.set(level),
    // Fork: muted in VRChat, the user's own leg hears silence (`src/app/vrchat.ts`).
    held: () => vrchatHolds(),
    subscribe(listener) {
      const offAudio = onAudioChange(listener);
      const offHold = useVRChatStore.subscribe(vrchatHolds, listener);
      return () => { offAudio(); offHold(); };
    },
    ...(windowsDesktop() ? { appsUsing } : {}),
  };
}

export function systemAudioSettings(): SystemAudioSettings {
  return {
    sourceId: () => audio().selectedParticipantSource?.deviceId ?? 'desktop-audio-loopback',
    appLost: () => audio().participantAppLost(),
    muted: () => audio().isParticipantMuted,
    subscribe: onAudioChange,
    audioSeen: () => audio().markParticipantTapAudioSeen(),
  };
}

export function tabSettings(): TabSettings {
  return {
    tabId: () => targetTabIdFromSearch(window.location.search),
    outputDeviceId: () => audio().selectedMonitorDevice?.deviceId,
    muted: () => audio().isParticipantMuted,
  };
}

/** The source, with `cleanup` run once before it stops. */
function withCleanup(source: Source, cleanup: () => Promise<void> | void): Source {
  let stopping: Promise<unknown> | undefined;
  return {
    onPcm: (listener) => source.onPcm(listener),
    onEnded: (listener) => source.onEnded(listener),
    onDegraded: (listener) => source.onDegraded(listener),
    async stop() {
      stopping ??= Promise.all([cleanup(), source.stop()]);
      await stopping;
    },
  };
}

export interface AppCaptureOptions {
  onPcm?(leg: LegName, pcm: Int16Array): void;
  /** The whole system's playout, while one is captured (Windows, echo cancellation by loudness, or the participant is the whole system). */
  onPlayout?(chunk: PlayoutChunk): void;
  onMicTrack?: MicSettings['trackOpened'];
  /** Checked per chunk: false, and the leg's meter reads flat. Absent: every chunk moves it. */
  meterGate?(leg: LegName): boolean;
}

export function createAppCapture(playback: Playback, platform: Platform = getEnvironment(), options: AppCaptureOptions = {}): AppCapture {
  const { meterGate } = options;
  const watch = createEchoWatch(playback.ttsTap);
  // The echo watch's opt-in diagnostics (the `sokuji.echoDiagnostics` flag) tell the gate's onsets too: information, not a failure.
  let diagnostics = false;
  const echo: EchoWatch = { ...watch, setDiagnostics(enabled) { diagnostics = enabled; watch.setDiagnostics(enabled); } };
  const follower = createEchoFollower(undefined, (line) => { if (diagnostics) console.info(`[Sokuji] [EchoFollow] ${line}`); });
  // The app's own voice on the user's device comes back through the microphone like any other sound, and no
  // capture but the whole system's holds it: with the microphone alone on a Mac, every spoken translation was
  // heard as the user's. A whole-system capture hears it a second time, which changes nothing: the louder counts.
  playback.onPlayed((chunk) => follower.played(chunk));
  const reference = createPlayoutReference(follower, options.onPlayout);
  let participantWhole = false;
  let micSignal: AbortSignal | null = null;
  // macOS shares one Core Audio helper and Linux manages a PipeWire tap and monitor
  // volume. Those platforms follow the participant chunks with an application selected.
  const separateLoopback = platform === 'electron' && windowsDesktop();
  const syncReference = () => reference.setNeeded(separateLoopback && micSignal !== null && !micSignal.aborted &&
    !participantWhole && audio().echoCancellationMode === 'gate');
  const levels: Record<LegName, LevelMeter> = { speaker: createLevelMeter(), participant: createLevelMeter() };

  const open = (leg: LegName, signal: AbortSignal): Promise<Source> => {
    if (leg === 'speaker') return openMic({
      ...micSettings(),
      trackOpened: options.onMicTrack,
      voiced: (pcm) => audio().echoCancellationMode === 'gate' ? follower.voiced(pcm) : null,
    }, signal);
    if (platform === 'electron') return openSystemAudio({
      ...systemAudioSettings(),
      wholeSystem(inUse) {
        participantWhole = inUse;
        const handoff = syncReference();
        if (inUse) return handoff;
      },
      playout: (chunk) => {
        follower.played(chunk.mono);
        options.onPlayout?.(chunk);
      },
    }, signal);
    if (platform === 'extension') return openTab(tabSettings(), signal);
    return Promise.reject(new Error('This build has no participant source.'));
  };

  return {
    echo,
    levels,
    async openSource(leg, signal) {
      const source = await open(leg, signal);
      let closeMicReference: (() => Promise<void>) | undefined;
      if (leg === 'speaker' && separateLoopback) {
        micSignal = signal;
        const offMode = useAudioStore.subscribe((s) => s.echoCancellationMode, syncReference);
        const micEnded = () => {
          offMode();
          micSignal = null;
          return syncReference();
        };
        const offEnd = source.onEnded(micEnded);
        closeMicReference = () => { offEnd(); return micEnded(); };
        void syncReference();
      }
      const offPassthrough = source.onStream && platform !== 'web' ? playback.passthrough(source.onStream) : undefined;
      // A gate that shuts flattens the meter at its next chunk, not a stale
      // spell later: reset once on the way in, never per chunk.
      let metering = true;
      const offLevel = source.onPcm((pcm) => {
        // The delivered leg is the fallback. Whole-system audio feeds the follower before mute and split.
        if (leg === 'participant' && !participantWhole && !reference.active) follower.played(pcm);
        options.onPcm?.(leg, pcm);
        if (!meterGate || meterGate(leg)) {
          metering = true;
          levels[leg].push(pcm);
        } else if (metering) {
          metering = false;
          levels[leg].reset();
        }
      });
      const detach = echo.attach(leg, source);
      return withCleanup(source, () => {
        offPassthrough?.();
        offLevel();
        if (leg === 'participant' && !reference.active) follower.reset();
        levels[leg].reset();
        detach();
        return closeMicReference?.();
      });
    },
  };
}
