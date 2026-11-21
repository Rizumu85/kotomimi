/**
 * Fork: any line of the conversation, said aloud for the user alone — to hear how it is pronounced. Asked of the same
 * voice stage a run speaks its translations by (`settings.localai.speak`, `src/providers/openai/voice.ts`), whether
 * or not a run is open, and played on the replay route: the real device, never the meeting.
 *
 * `useLineVoiceStore` (light, for the rows) says whether a voice is there and which line is on; this module keeps it
 * true: the stage's settings and its engine's downloads are watched from the app's start (`watchLineVoice`).
 */
import { realClock } from '../lib/contract/clock';
import { describeCause, reportWarning } from '../lib/diagnostics/report';
import { getAppAudio } from '../lib/audio/appAudio';
import { liveVoiceDeps } from '../lib/voice/liveVoice';
import { holdNative, nativeDownloaded, voiceUp } from '../providers/openai/localaiNative';
import { speaksByEdge, voiceLanguages, voiceSpeaks, voiceStageOf, VOICE_DEFAULTS, type VoiceChoice } from '../providers/openai/localaiVoice';
import { nativeVoice } from '../providers/openai/nativeVoices';
import { speakText, spokenText } from '../providers/openai/voice';
import { useLineVoiceStore } from '../stores/lineVoiceStore';
import { useNativeVoiceStore } from '../stores/nativeEngineStore';
import { useProviderStore } from '../stores/providerStore';
import useAudioStore from '../stores/audioStore';
import { getEnvironment } from '../utils/environment';
import { replayBlocked } from '../components/MainPanel/panel/replayGate';
import { getAppSession } from './session';

const LOCALAI = 'localai';

/** The voice stage as it is set now: Kotomimi's own, whichever provider is selected. Defaults before its settings have loaded. */
export function voiceChoiceNow(): VoiceChoice {
  const settings = useProviderStore.getState().entries[LOCALAI]?.settings as { speak?: VoiceChoice } | undefined;
  return settings?.speak ?? VOICE_DEFAULTS;
}

/** Whether the stage can be asked for a sentence now: on, and what speaks is here. */
export function voiceReady(choice: VoiceChoice = voiceChoiceNow()): boolean {
  if (!choice.on) return false;
  if (choice.at === 'device') return nativeDownloaded(useNativeVoiceStore.getState().status, nativeVoice(choice.nativeModel).id);
  return speaksByEdge(choice) || (choice.apiBaseUrl.trim() !== '' && choice.apiModel.trim() !== '');
}

/** Whether a line in this language can be said now. */
export const canSay = (language: string, choice: VoiceChoice = voiceChoiceNow()): boolean => voiceReady(choice) && voiceSpeaks(choice, language);

/**
 * Whether nothing may be played on the real device now: a run is capturing the whole system as the other side, and
 * would hear the line and translate it again — the rule a replay is held to (`replayBlocked`).
 */
export function lineBlocked(): boolean {
  const session = getAppSession();
  const codes = session.view.get().legs.find((leg) => leg.leg === 'participant')?.notices.flatMap((notice) => (notice.code ? [notice.code] : [])) ?? [];
  return replayBlocked({ run: session.runner.state.getState(), platform: getEnvironment(), participantSourceId: useAudioStore.getState().selectedParticipantSource?.deviceId, participantNoticeCodes: codes });
}

let current: AbortController | null = null;

/** Stops the line being fetched or heard. */
export function stopLine(): void {
  current?.abort(new Error('stopped'));
  current = null;
  useLineVoiceStore.setState({ line: null, phase: 'idle' });
  void getAppAudio().then((audio) => audio.playback.stopReplay()).catch(() => undefined);
}

/**
 * Says `text` in `language`, in place of whatever line was on. `id` is what the asking button knows itself by. `with`:
 * a choice other than the stored one — a voice being tried in the stage's card before it is kept.
 */
export async function sayLine(id: string, text: string, language: string, using?: VoiceChoice): Promise<void> {
  const choice = using ?? voiceChoiceNow();
  const said = spokenText(text);
  const stage = said ? voiceStageOf(choice, [language]) : null;
  current?.abort(new Error('another line'));
  const control = new AbortController();
  current = control;
  if (!stage || !voiceSpeaks(choice, language) || lineBlocked()) {
    useLineVoiceStore.setState({ line: null, phase: 'idle', failed: id });
    return;
  }
  useLineVoiceStore.setState({ line: id, phase: 'loading', failed: null });
  // This computer's engine is brought up for the line where no run has it up, and let go a while after.
  const done = stage.engine ? holdNative('voice') : null;
  try {
    const audio = await getAppAudio();
    if (control.signal.aborted) return;
    audio.playback.stopReplay();
    // Whatever takes the replay queue from here on (a kept clip replayed, a run that clears it) ends this line: its
    // later pieces would otherwise be played after what took its place.
    const queue = audio.playback.queues.replay;
    const mine = queue.clears;
    if (stage.engine) await voiceUp(stage.model);
    if (control.signal.aborted) return;
    const key = stage.key ? useProviderStore.getState().entries[LOCALAI]?.credentials[stage.key] : undefined;
    await speakText(stage, { text: said, language }, key, { ...liveVoiceDeps, fetch: (input, init) => fetch(input, init), clock: realClock }, control.signal, (pcm) => {
      if (control.signal.aborted) return;
      if (queue.clears !== mine) { control.abort(new Error('another clip took its place')); return; }
      if (lineBlocked()) { control.abort(); audio.playback.stopReplay(); return; }
      useLineVoiceStore.setState({ line: id, phase: 'playing' });
      audio.playback.line(pcm);
    });
    if (control.signal.aborted) return;
    // Heard to its end: the replay queue says when nothing of it is left.
    await new Promise<void>((resolve) => {
      if (queue.pending === 0) { resolve(); return; }
      const off = queue.subscribe(() => { if (queue.pending === 0 || control.signal.aborted) { off(); resolve(); } });
      control.signal.addEventListener('abort', () => { off(); resolve(); }, { once: true });
    });
  } catch (error) {
    if (control.signal.aborted) return;
    reportWarning('LineVoice', `A line could not be said: ${describeCause(error)}`, { cause: error, dedupeKey: 'lineVoice:failed' });
    useLineVoiceStore.setState({ line: null, phase: 'idle', failed: id });
  } finally {
    done?.();
    if (current === control) {
      current = null;
      if (useLineVoiceStore.getState().line === id) useLineVoiceStore.setState({ line: null, phase: 'idle' });
    }
  }
}

/** Keeps `ready` on the stage's settings and its engine's downloads, from now on. Returns the way to stop. */
export function watchLineVoice(): () => void {
  const speakOf = (state: ReturnType<typeof useProviderStore.getState>) => (state.entries[LOCALAI]?.settings as { speak?: VoiceChoice } | undefined)?.speak;
  const apply = () => {
    const choice = voiceChoiceNow();
    const ready = voiceReady(choice);
    const languages = voiceLanguages(choice);
    const now = useLineVoiceStore.getState();
    if (now.ready !== ready || (now.languages ?? []).join() !== (languages ?? []).join() || (now.languages === null) !== (languages === null)) useLineVoiceStore.setState({ ready, languages });
  };
  apply();
  const stops = [
    useProviderStore.subscribe((state, before) => { if (speakOf(state) !== speakOf(before)) apply(); }),
    useNativeVoiceStore.subscribe((state) => `${state.status.engine}|${Object.entries(state.status.models).map(([id, m]) => `${id}:${m.state}`).join(',')}`, apply),
  ];
  return () => { for (const stop of stops) stop(); };
}
