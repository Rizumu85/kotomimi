/**
 * Fork: a voice of the user's own, added for a cloning voice model to speak in — one of two ways. Recorded here: a
 * sentence is shown to be read aloud, so the words of the recording are known, and the voice is cloned at its best.
 * Or imported: a recording they have (one a GPT-SoVITS voice was trained from, say), with its words where they care
 * to type them — or a voice someone handed over as a file. Each can be heard before it is kept.
 *
 * A recording is in a language, chosen here: the user's own at first. In that language the model speaks on from the
 * recording, accent and all; in every other it takes only the sound of the voice. So someone sure of their Japanese
 * adds to their voice (`into`) a recording read in Japanese, and Japanese is then read from that one. Such a
 * recording is only ever spoken on from, so a short sentence does, and its words must be known.
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Play, Square, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal/Modal';
import { CLIP_LEAST_MORE_S, CLIP_LEAST_S, CLIP_MOST_WITH_WORDS_S, clipProblem, clipWav, prepared, readAloud, secondsOf, type ClipProblem } from '../../lib/voice/clip';
import { FILE_MOST_BYTES, fileClip, recordClip, type ClipRecording } from '../../lib/voice/recordClip';
import useAudioStore from '../../stores/audioStore';
import { useVoiceLibraryStore, type LibraryVoice } from '../../stores/voiceLibraryStore';
import { languageLabel } from '../../lib/language/label';
import './AddVoiceDialog.scss';

type Way = 'record' | 'import';
type Fault = ClipProblem | 'microphone' | 'unreadable' | 'failed';

/** A voice someone handed over: added as it is, with no recording to look at here. */
const PACK = /\.kotovoice$/i;
/** A reading longer than this is not what was asked for: the recording ends by itself, still short enough to be kept. */
const RECORD_MOST_MS = CLIP_MOST_WITH_WORDS_S * 1000;

export function AddVoiceDialog({ open, language, languages, into = null, suggest = [], onClose, onAdded }: {
  open: boolean;
  /** The voice this is one more recording of, in another language. Absent: a new voice. */
  into?: LibraryVoice | null;
  /** The languages the run reads: where a voice has no recording in one of them, that is the one offered first. */
  suggest?: readonly string[];
  /** The language the user reads in at first: their own. */
  language: string;
  /** The languages a recording may be in: those the voice model speaks, by base code. */
  languages: readonly string[];
  onClose(): void;
  onAdded(voice: LibraryVoice): void;
}) {
  const { t, i18n } = useTranslation();
  const own = language.toLowerCase().split(/[-_]/)[0];
  const base = (code: string) => code.toLowerCase().split(/[-_]/)[0];
  const first = into
    ? [...suggest.map(base), ...languages].find((code) => languages.includes(code) && !into.languages.includes(code)) ?? languages[0] ?? 'en'
    : languages.includes(own) ? own : languages.includes('en') ? 'en' : languages[0] ?? 'en';
  /** The shortest that will do: a voice's first recording is also what every other language is read from the sound of. */
  const least = into ? CLIP_LEAST_MORE_S : CLIP_LEAST_S;
  /** The language of the recording: what is read aloud is in it, and so is what an imported one says. */
  const [spoken, setSpoken] = useState(first);
  const [way, setWay] = useState<Way>('record');
  const [recording, setRecording] = useState<ClipRecording | null>(null);
  const [level, setLevel] = useState(0);
  const [clip, setClip] = useState<Int16Array | null>(null);
  const [words, setWords] = useState('');
  const [name, setName] = useState('');
  const [fault, setFault] = useState<Fault | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const player = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const live = useRef<ClipRecording | null>(null);
  /** Counts every fresh start (a close, a switch, another try): what was asked before one is let go when it comes. */
  const turn = useRef(0);
  const sentence = readAloud(spoken, into ? 'short' : 'long');

  const quiet = () => {
    const on = player.current;
    player.current = null;
    if (on) { on.audio.pause(); URL.revokeObjectURL(on.url); }
    setPlaying(false);
  };
  const reset = (next: Way = way) => {
    turn.current += 1;
    live.current?.cancel();
    live.current = null;
    quiet();
    setWay(next);
    setRecording(null);
    setLevel(0);
    setClip(null);
    setWords('');
    setName('');
    setFault(null);
    setBusy(false);
  };
  // Closed, nothing of it goes on: no microphone held, nothing playing.
  useEffect(() => { reset('record'); setSpoken(first); }, [open, into?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { turn.current += 1; live.current?.cancel(); const on = player.current; if (on) { on.audio.pause(); URL.revokeObjectURL(on.url); } }, []);

  // The meter, and the end of a reading that ran on.
  useEffect(() => {
    if (!recording) return undefined;
    const meter = window.setInterval(() => setLevel(recording.level()), 80);
    const end = window.setTimeout(() => { void stop(); }, RECORD_MOST_MS);
    return () => { window.clearInterval(meter); window.clearTimeout(end); };
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  /** What was read or chosen, looked at as it would be kept: a recording that will not do says why, and is not kept. */
  const take = (pcm: Int16Array, withWords: boolean) => {
    const ready = prepared(pcm, withWords);
    const problem = clipProblem(ready, withWords, least);
    setFault(problem);
    setClip(problem ? null : ready);
  };

  const start = async () => {
    reset('record');
    const mine = turn.current;
    try {
      const begun = await recordClip(useAudioStore.getState().selectedInputDevice?.deviceId);
      // Closed, switched or asked again while the microphone was opening: not held.
      if (turn.current !== mine) { begun.cancel(); return; }
      live.current = begun;
      setRecording(begun);
    } catch {
      if (turn.current === mine) setFault('microphone');
    }
  };
  const stop = async () => {
    const mine = live.current;
    if (!mine) return;
    live.current = null;
    setRecording(null);
    setLevel(0);
    const asked = turn.current;
    try {
      const pcm = await mine.stop();
      if (turn.current === asked) take(pcm, true);
    } catch {
      if (turn.current === asked) setFault('unreadable');
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    reset('import');
    const asked = turn.current;
    if (!into && PACK.test(file.name)) {
      // A voice is a few megabytes: anything far larger is not one, and is not read into memory to find out.
      if (file.size > FILE_MOST_BYTES) { setFault('unreadable'); return; }
      setBusy(true);
      const added = await useVoiceLibraryStore.getState().addPack(new Uint8Array(await file.arrayBuffer()));
      if (turn.current !== asked) { if (added.ok) onAdded(added.voice); return; }
      setBusy(false);
      if (added.ok) { onAdded(added.voice); onClose(); } else setFault('unreadable');
      return;
    }
    try {
      const pcm = await fileClip(file);
      if (turn.current !== asked) return;
      setName(file.name.replace(/\.[^./\\]+$/, '').slice(0, 40));
      take(pcm, false);
    } catch {
      if (turn.current === asked) setFault('unreadable');
    }
  };

  const hear = () => {
    if (playing) { quiet(); return; }
    if (!clip) return;
    const url = URL.createObjectURL(new Blob([clipWav(clip).buffer as ArrayBuffer], { type: 'audio/wav' }));
    const audio = new Audio(url);
    player.current = { audio, url };
    const over = () => { if (player.current?.audio === audio) quiet(); };
    audio.addEventListener('ended', over);
    audio.addEventListener('error', over);
    setPlaying(true);
    void audio.play().catch(over);
  };

  const typed = way === 'import' ? words.trim() : sentence.text;
  // Typed after the recording was looked at: with its words it may be too long to keep.
  const tooLong = way === 'import' && clip !== null && typed !== '' && clipProblem(clip, true, least) === 'too_long';
  /** A recording more is spoken on from, which takes its words. */
  const wordless = into !== null && typed === '';
  const save = async () => {
    if (!clip || tooLong || wordless) return;
    setBusy(true);
    quiet();
    const added = await useVoiceLibraryStore.getState().add({
      name: name.trim() || t('fork.voice.myVoice', 'My voice'),
      text: typed,
      language: spoken,
      wav: clipWav(clip),
      ...(into ? { to: into.id } : {}),
    });
    setBusy(false);
    if (added.ok) { onAdded(added.voice); onClose(); } else setFault('failed');
  };

  const said: Record<Fault, string> = {
    too_short: t('fork.voice.clipTooShort', { seconds: least, defaultValue: 'Too short: at least {{seconds}} seconds.' }),
    too_long: t('fork.voice.clipTooLong', { seconds: CLIP_MOST_WITH_WORDS_S, defaultValue: 'Too long: no more than {{seconds}} seconds with its words.' }),
    silent: t('fork.voice.clipSilent', 'No voice was heard.'),
    microphone: t('fork.voice.micDenied', 'The microphone could not be opened.'),
    unreadable: t('fork.voice.clipUnreadable', 'This file could not be read.'),
    failed: t('fork.voice.clipFailed', 'The voice could not be added.'),
  };
  const shown: Fault | null = tooLong ? 'too_long' : fault;

  return (
    <Modal isOpen={open} onClose={onClose} title={into ? t('fork.voice.addTake', { name: into.name, defaultValue: 'Add a language to {{name}}' }) : t('fork.voice.addVoice', 'Add a voice')}>
      <div className="kt-addvoice">
        <div className="kt-addvoice__top">
          <div className="kt-seg" role="group" aria-label={t('fork.voice.addVoice', 'Add a voice')}>
            {(['record', 'import'] as const).map((one) => (
              <button key={one} type="button" className={`kt-seg__option${one === way ? ' is-active' : ''}`} aria-pressed={one === way} onClick={() => { if (one !== way) reset(one); }} disabled={busy}>
                {one === 'record' ? t('fork.voice.wayRecord', 'Record now') : t('fork.voice.wayImport', 'Import a recording')}
              </button>
            ))}
          </div>
          <select
            className="select-dropdown" value={spoken} disabled={busy || recording !== null} aria-label={t('fork.voice.clipLanguage', 'Language of the recording')} title={t('fork.voice.clipLanguage', 'Language of the recording')}
            // Read aloud in another language, what was read is no longer what is shown: begun again.
            onChange={(e) => { if (way === 'record') reset('record'); setSpoken(e.target.value); }}
          >
            {languages.map((code) => <option key={code} value={code}>{languageLabel(code, i18n.language)}</option>)}
          </select>
        </div>

        {way === 'record' && (
          <>
            <p className="kt-addvoice__read" lang={sentence.language}>{sentence.text}</p>
            <div className="kt-addvoice__capture">
              <button type="button" className={`kt-addvoice__record${recording ? ' is-recording' : ''}`} onClick={() => { void (recording ? stop() : start()); }} disabled={busy} aria-pressed={recording !== null}>
                {recording ? <Square size={14} fill="currentColor" /> : <Mic size={16} />}
                <span>{recording ? t('fork.voice.stopRecording', 'Stop') : clip ? t('fork.voice.recordAgain', 'Record again') : t('fork.voice.record', 'Read it aloud')}</span>
              </button>
              <span className="kt-addvoice__meter" aria-hidden><span style={{ width: `${Math.round(Math.min(1, level * 1.6) * 100)}%` }} /></span>
            </div>
          </>
        )}

        {way === 'import' && (
          <>
            <input ref={picker} type="file" accept={into ? 'audio/*' : 'audio/*,.kotovoice'} hidden onChange={(e) => { void choose(e.target.files?.[0]); e.target.value = ''; }} />
            <div className="kt-addvoice__capture">
              <button type="button" className="kt-addvoice__record" onClick={() => picker.current?.click()} disabled={busy}>
                <Upload size={15} />
                <span>{t('fork.voice.chooseFile', 'Choose a file')}</span>
              </button>
            </div>
            {clip && (
              <textarea
                className="kt-input kt-addvoice__words" rows={2} value={words} onChange={(e) => setWords(e.target.value.slice(0, 400))}
                aria-label={into ? t('fork.voice.clipWordsNeeded', 'What is said in it') : t('fork.voice.clipWords', 'What is said in it (optional)')}
                placeholder={into ? t('fork.voice.clipWordsNeeded', 'What is said in it') : t('fork.voice.clipWords', 'What is said in it (optional)')} disabled={busy}
              />
            )}
          </>
        )}

        {shown && <p className="kt-note kt-note--todo" role="status">{said[shown]}</p>}

        {clip && (
          <div className="kt-addvoice__keep">
            <button type="button" className="kt-voice__sample" onClick={hear} aria-label={t('fork.voice.sample', 'Play a sample')} title={t('fork.voice.sample', 'Play a sample')} aria-pressed={playing}>
              {playing ? <Square size={11} fill="currentColor" /> : <Play size={13} />}
            </button>
            <span className="kt-addvoice__length">{t('fork.voice.clipSeconds', { seconds: secondsOf(clip).toFixed(1), defaultValue: '{{seconds}} s' })}</span>
            {into ? <span className="kt-addvoice__whose">{into.name}</span> : (
              <input
                type="text" className="kt-input" value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} spellCheck={false} disabled={busy}
                aria-label={t('fork.voice.voiceName', 'Name')} placeholder={t('fork.voice.myVoice', 'My voice')}
              />
            )}
            <button type="button" className="kt-addvoice__save" onClick={() => { void save(); }} disabled={busy || tooLong || wordless}>{t('fork.voice.saveVoice', 'Save')}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}
