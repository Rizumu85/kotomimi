/**
 * The translated-speech switches and each side's volume. The monitor
 * switch and original-voice passthrough live in `audioStore`.
 */
import { create } from 'zustand';
import { persistSetting } from '../services/persistSetting';
import { ServiceFactory } from '../services/ServiceFactory';

const MEETING = 'settings.routing.meeting';
const MEETING_DEVICE = 'settings.routing.meetingDevice';
const PARTICIPANT_SPEECH = 'settings.routing.participantSpeech';
const MINE = 'settings.routing.speechVolumeMine';
const THEIRS = 'settings.routing.speechVolumeTheirs';

const clampVolume = (value: number) => Math.max(0, Math.min(1, value));

/**
 * Whether the participant-speech switch shows. The owner's choice of
 * 2026-10-01: hidden, and participant speech kept off, until the translated
 * audio's playback is reworked — an application capture that widens to the
 * whole system mid-run would still play Other's translation on the real
 * device. While off, `load()` does not read the saved choice, so one saved
 * while the switch showed cannot turn speech on unseen; the saved value is
 * left as it was, not rewritten. Showing it again is this line.
 */
export const PARTICIPANT_SPEECH_SHOWN = false;

interface RoutingStore {
  meeting: boolean;
  meetingDevice: string | null;
  setMeetingDevice(id: string | null): void;
  participantSpeech: boolean;
  speechVolumeMine: number;
  speechVolumeTheirs: number;
  setSpeechVolumeMine(value: number): void;
  setSpeechVolumeTheirs(value: number): void;
  load(): Promise<void>;
  setMeeting(on: boolean): void;
  setParticipantSpeech(on: boolean): void;
}

export const useRoutingStore = create<RoutingStore>()((set) => ({
  meeting: true,
  meetingDevice: null,
  participantSpeech: false,
  speechVolumeMine: 0.5,
  speechVolumeTheirs: 1,
  async load() {
    const settings = ServiceFactory.getSettingsService();
    const [meeting, meetingDevice, participantSpeech, mine, theirs] = await Promise.all([
      settings.getSetting(MEETING, true),
      settings.getSetting<unknown>(MEETING_DEVICE, null),
      PARTICIPANT_SPEECH_SHOWN ? settings.getSetting(PARTICIPANT_SPEECH, false) : false,
      settings.getSetting(MINE, 0.5),
      settings.getSetting(THEIRS, 1),
    ]);
    set({
      meeting: typeof meeting === 'boolean' ? meeting : true,
      meetingDevice: typeof meetingDevice === 'string' && meetingDevice.length > 0 ? meetingDevice : null,
      participantSpeech: typeof participantSpeech === 'boolean' ? participantSpeech : false,
      speechVolumeMine: Number.isFinite(mine) ? clampVolume(mine) : 0.5,
      speechVolumeTheirs: Number.isFinite(theirs) ? clampVolume(theirs) : 1,
    });
  },
  setMeeting(on) {
    set({ meeting: on });
    void persistSetting(MEETING, on);
  },
  setMeetingDevice(id) {
    set({ meetingDevice: id });
    void persistSetting(MEETING_DEVICE, id);
  },
  setSpeechVolumeMine(value) {
    const mine = clampVolume(value);
    set({ speechVolumeMine: mine });
    void persistSetting(MINE, mine);
  },
  setSpeechVolumeTheirs(value) {
    const theirs = clampVolume(value);
    set({ speechVolumeTheirs: theirs });
    void persistSetting(THEIRS, theirs);
  },
  setParticipantSpeech(on) {
    set({ participantSpeech: on });
    void persistSetting(PARTICIPANT_SPEECH, on);
  },
}));
