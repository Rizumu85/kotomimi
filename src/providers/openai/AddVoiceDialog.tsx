/**
 * Fork: a voice of the user's own, added for a cloning voice model to speak in — one of two ways. Recorded here: a
 * sentence is shown to be read aloud, so the words of the recording are known, and the voice is cloned at its best.
 * Or imported: a recording they have (one a GPT-SoVITS voice was trained from, say), with its words where they care
 * to type them — or a voice someone handed over as a file. Each can be heard before it is kept.
 *
 * A recording is in a language, chosen here: the user's own at first. In that language the model speaks on from the
 * recording, accent and all; in every other it takes only the sound of the voice. So someone sure of their Japanese
 * reads once more in Japanese, and Japanese is then read from that recording.
 *
 * The language is chosen in the dialog, so the dialog keeps a recording for each language chosen and read: changing
 * the language begins another, it does not replace the one made. The first is the voice's own (a long sentence);
 * each one more is only ever spoken on from, so a short sentence does and its words must be known. All of them are
 * kept as one voice — or added to the voice the dialog was opened for (`into`).
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Play, Square, Upload, X } from 'lucide-react';
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

/** One recording made or chosen in the dialog: its language, its sound, and its words where they are known. */
interface Take {
  language: string;
  clip: Int16Array;
  text: string;
  /** Chosen from a file: its words are the user's to type. */
  imported: boolean;
}

/** A voice someone handed over: added as it is, with no recording to look at here. */
const PACK = /\.kotovoice$/i;
/** A reading longer than this is not what was asked for: the recording ends by itself, still short enough to be kept. */
const RECORD_MOST_MS = CLIP_MOST_WITH_WORDS_S * 1000;

export function AddVoiceDialog({ open, language, languages, into = null, suggest = [], onClose, onAdded }: {
  open: boolean;
  /** The voice these are more recordings of, each in another language. Absent: a new voice. */
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
  /** The language of the recording being made: what is read aloud is in it, and so is what an imported one says. */
  const [spoken, setSpoken] = useState(first);
  const [way, setWay] = useState<Way>('record');
  const [recording, setRecording] = useState<ClipRecording | null>(null);
  const [level, setLevel] = useState(0);
  /** What has been made so far, a language each, in the order made: the first is a new voice's own. */
  const [takes, setTakes] = useState<readonly Take[]>([]);
  const [name, setName] = useState('');
  const [fault, setFault] = useState<Fault | null>(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const player = useRef<{ audio: HTMLAudioElement; url: string } | null>(null);
  const live = useRef<ClipRecording | null>(null);
  /** Counts every fresh start (a close, a switch, another try): what was asked before one is let go when it comes. */
  const turn = useRef(0);
  const current = takes.find((one) => one.language === spoken);
  /**
   * A new voice's first recording is also what every other language is read from the sound of: it is the long
   * sentence, and no shorter than a voice takes. Every other is only spoken on from.
   */
  const leads = (code: string, made: readonly Take[] = takes): boolean => !into && (made.length === 0 || made[0].language === code);
  const leastOf = (code: string, made: readonly Take[] = takes): number => (leads(code, made) ? CLIP_LEAST_S : CLIP_LEAST_MORE_S);
  const sentence = readAloud(spoken, leads(spoken) ? 'long' : 'short');

  const quiet = () => {
    const on = player.current;
    player.current = null;
    if (on) { on.audio.pause(); URL.revokeObjectURL(on.url); }
    setPlaying(false);
  };
  /** Whatever is going on ends — a reading, a file being read, a sample — and what has been made is kept. */
  const halt = () => {
    turn.current += 1;
    live.current?.cancel();
    live.current = null;
    quiet();
    setRecording(null);
    setLevel(0);
    setFault(null);
    setBusy(false);
  };
  // Opened, or closed: nothing of the last time is left, no microphone held, nothing playing.
  useEffect(() => { halt(); setWay('record'); setTakes([]); setName(''); setSpoken(first); }, [open, into?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { turn.current += 1; live.current?.cancel(); const on = player.current; if (on) { on.audio.pause(); URL.revokeObjectURL(on.url); } }, []);

  // The meter, and the end of a reading that ran on.
  useEffect(() => {
    if (!recording) return undefined;
    const meter = window.setInterval(() => setLevel(recording.level()), 80);
    const end = window.setTimeout(() => { void stop(); }, RECORD_MOST_MS);
    return () => { window.clearInterval(meter); window.clearTimeout(end); };
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * What was read or chosen, looked at as it would be kept: a recording that will not do says why, and is not kept.
   * One that will takes its language's place among what has been made.
   */
  const take = (pcm: Int16Array, text: string, imported: boolean) => {
    const ready = prepared(pcm, !imported);
    const problem = clipProblem(ready, !imported, leastOf(spoken));
    setFault(problem);
    if (problem) return;
    const made: Take = { language: spoken, clip: ready, text, imported };
    setTakes((before) => (before.some((one) => one.language === spoken) ? before.map((one) => (one.language === spoken ? made : one)) : [...before, made]));
  };

  const start = async () => {
    halt();
    setWay('record');
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
    const words = sentence.text;
    try {
      const pcm = await mine.stop();
      if (turn.current === asked) take(pcm, words, false);
    } catch {
      if (turn.current === asked) setFault('unreadable');
    }
  };

  const choose = async (file: File | undefined) => {
    if (!file) return;
    halt();
    setWay('import');
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
      if (!into && !name) setName(file.name.replace(/\.[^./\\]+$/, '').slice(0, 40));
      take(pcm, '', true);
    } catch {
      if (turn.current === asked) setFault('unreadable');
    }
  };

  const hear = () => {
    if (playing) { quiet(); return; }
    if (!current) return;
    const url = URL.createObjectURL(new Blob([clipWav(current.clip).buffer as ArrayBuffer], { type: 'audio/wav' }));
    const audio = new Audio(url);
    player.current = { audio, url };
    const over = () => { if (player.current?.audio === audio) quiet(); };
    audio.addEventListener('ended', over);
    audio.addEventListener('error', over);
    setPlaying(true);
    void audio.play().catch(over);
  };

  /** Another language, or one made already: what is going on ends, what has been made stays. */
  const turnTo = (code: string) => { if (code !== spoken) { halt(); setSpoken(code); } };
  const drop = (code: string) => { halt(); setTakes((before) => before.filter((one) => one.language !== code)); };
  const retype = (text: string) => setTakes((before) => before.map((one) => (one.language === spoken ? { ...one, text: text.slice(0, 400) } : one)));

  /**
   * Why what has been made of a language cannot be kept as it is. Words typed after an imported recording was looked
   * at make it one that is read through, which it may be too long for. One that is not the voice's own is spoken on
   * from, which takes its words. And the voice's own may be one made as another's, once the first was taken away.
   */
  const wrong = (one: Take): ClipProblem | 'wordless' | null => {
    const typed = one.text.trim();
    const problem = clipProblem(one.clip, typed !== '', leastOf(one.language));
    if (problem) return problem;
    return typed === '' && !leads(one.language) ? 'wordless' : null;
  };
  const amiss = current ? wrong(current) : null;
  const blocked = takes.length === 0 || takes.some((one) => wrong(one) !== null);
  const voiceName = into?.name ?? (name.trim() || t('fork.voice.myVoice', 'My voice'));

  const save = async () => {
    if (blocked) return;
    setBusy(true);
    quiet();
    let voice: LibraryVoice | null = null;
    let whose = into?.id;
    for (const one of takes) {
      // The first of a new voice makes it; every other is one more recording of it.
      const added = await useVoiceLibraryStore.getState().add({ name: voiceName, text: one.text.trim(), language: one.language, wav: clipWav(one.clip), ...(whose ? { to: whose } : {}) });
      if (added.ok) { voice = added.voice; whose = added.voice.id; } else if (!whose) break;
    }
    setBusy(false);
    if (voice) { onAdded(voice); onClose(); } else setFault('failed');
  };

  const said: Record<Fault, string> = {
    too_short: t('fork.voice.clipTooShort', { seconds: leastOf(spoken), defaultValue: 'Too short: at least {{seconds}} seconds.' }),
    too_long: t('fork.voice.clipTooLong', { seconds: CLIP_MOST_WITH_WORDS_S, defaultValue: 'Too long: no more than {{seconds}} seconds with its words.' }),
    silent: t('fork.voice.clipSilent', 'No voice was heard.'),
    microphone: t('fork.voice.micDenied', 'The microphone could not be opened.'),
    unreadable: t('fork.voice.clipUnreadable', 'This file could not be read.'),
    failed: t('fork.voice.clipFailed', 'The voice could not be added.'),
  };
  const shown: Fault | null = fault ?? (amiss && amiss !== 'wordless' ? amiss : null);
  const wordsLabel = current && !leads(current.language) ? t('fork.voice.clipWordsNeeded', 'What is said in it') : t('fork.voice.clipWords', 'What is said in it (optional)');

  return (
    <Modal isOpen={open} onClose={onClose} title={into ? t('fork.voice.addTake', { name: into.name, defaultValue: 'Add a language to {{name}}' }) : t('fork.voice.addVoice', 'Add a voice')}>
      <div className="kt-addvoice">
        <div className="kt-addvoice__top">
          <div className="kt-seg" role="group" aria-label={t('fork.voice.addVoice', 'Add a voice')}>
            {(['record', 'import'] as const).map((one) => (
              <button key={one} type="button" className={`kt-seg__option${one === way ? ' is-active' : ''}`} aria-pressed={one === way} onClick={() => { if (one !== way) { halt(); setWay(one); } }} disabled={busy}>
                {one === 'record' ? t('fork.voice.wayRecord', 'Record now') : t('fork.voice.wayImport', 'Import a recording')}
              </button>
            ))}
          </div>
          <select
            className="select-dropdown" value={spoken} disabled={busy || recording !== null} aria-label={t('fork.voice.clipLanguage', 'Language of the recording')} title={t('fork.voice.clipLanguage', 'Language of the recording')}
            onChange={(e) => turnTo(e.target.value)}
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
                <span>{recording ? t('fork.voice.stopRecording', 'Stop') : current ? t('fork.voice.recordAgain', 'Record again') : t('fork.voice.record', 'Read it aloud')}</span>
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
            {current?.imported && (
              <textarea
                className="kt-input kt-addvoice__words" rows={2} value={current.text} onChange={(e) => retype(e.target.value)}
                aria-label={wordsLabel} placeholder={wordsLabel} disabled={busy}
              />
            )}
          </>
        )}

        {shown && <p className="kt-note kt-note--todo" role="status">{said[shown]}</p>}

        {(takes.length > 0 || (into?.languages.length ?? 0) > 0) && (
          // What the voice will have: the languages it has already, then each made here — the one being looked at
          // marked, each to be gone back to or taken away.
          <div className="kt-addvoice__takes">
            {(into?.languages ?? []).filter((code) => !takes.some((one) => one.language === code)).map((code) => <span key={code} className="kt-myvoices__lang">{languageLabel(code, i18n.language)}</span>)}
            {takes.map((one) => {
              const label = languageLabel(one.language, i18n.language);
              const remove = t('fork.voice.removeTake', { name: voiceName, language: label, defaultValue: 'Remove the {{language}} recording of {{name}}' });
              return (
                <span key={one.language} className={`kt-addvoice__take${one.language === spoken ? ' is-current' : ''}${wrong(one) ? ' is-amiss' : ''}`}>
                  <button type="button" onClick={() => turnTo(one.language)} aria-pressed={one.language === spoken} disabled={busy || recording !== null}>
                    {label}<span>{t('fork.voice.clipSeconds', { seconds: secondsOf(one.clip).toFixed(1), defaultValue: '{{seconds}} s' })}</span>
                  </button>
                  <button type="button" onClick={() => drop(one.language)} aria-label={remove} title={remove} disabled={busy || recording !== null}><X size={10} /></button>
                </span>
              );
            })}
          </div>
        )}

        {takes.length > 0 && (
          <div className="kt-addvoice__keep">
            <button type="button" className="kt-voice__sample" onClick={hear} aria-label={t('fork.voice.sample', 'Play a sample')} title={t('fork.voice.sample', 'Play a sample')} aria-pressed={playing} disabled={!current}>
              {playing ? <Square size={11} fill="currentColor" /> : <Play size={13} />}
            </button>
            {into ? <span className="kt-addvoice__whose">{into.name}</span> : (
              <input
                type="text" className="kt-input" value={name} onChange={(e) => setName(e.target.value.slice(0, 40))} spellCheck={false} disabled={busy}
                aria-label={t('fork.voice.voiceName', 'Name')} placeholder={t('fork.voice.myVoice', 'My voice')}
              />
            )}
            <button type="button" className="kt-addvoice__save" onClick={() => { void save(); }} disabled={busy || blocked}>{t('fork.voice.saveVoice', 'Save')}</button>
          </div>
        )}
      </div>
    </Modal>
  );
}
