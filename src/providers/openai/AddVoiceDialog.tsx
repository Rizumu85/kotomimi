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
 * And it is in a tone of voice (`tone.ts`): plain at first. The model takes a tone from how a recording sounds and
 * from nothing else, so whoever wants their laughter read as laughter reads a laughing sentence once — as many
 * tones or as few as they care for, in the languages they care for.
 *
 * Both are chosen in the dialog, so the dialog keeps a recording for each language and tone chosen and read:
 * changing either begins another, it does not replace the one made. A new voice's first plain recording is the
 * voice's own (a long sentence); every other takes a short one. All of them are kept as one voice — or added to the
 * voice the dialog was opened for (`into`).
 */
import { useEffect, useRef, useState } from 'react';
import { Mic, Play, Square, Upload, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Modal from '../../components/Modal/Modal';
import { CLIP_LEAST_LAUGH_S, CLIP_LEAST_MORE_S, CLIP_LEAST_S, CLIP_MOST_WITH_WORDS_S, clipProblem, clipWav, prepared, readAloud, secondsOf, type ClipProblem } from '../../lib/voice/clip';
import { PACK_MOST_BYTES, fileClip, recordClip, type ClipRecording } from '../../lib/voice/recordClip';
import { TONES } from '../../lib/voice/tone';
import useAudioStore from '../../stores/audioStore';
import { useVoiceLibraryStore, type LibraryVoice } from '../../stores/voiceLibraryStore';
import { languageLabel } from '../../lib/language/label';
import './AddVoiceDialog.scss';

type Way = 'record' | 'import';
type Fault = ClipProblem | 'microphone' | 'unreadable' | 'failed';

/** One recording made or chosen in the dialog: its language, its tone ('' plain), its sound, and its words where they are known. */
interface Take {
  language: string;
  tone: string;
  clip: Int16Array;
  text: string;
  /** Chosen from a file: its words are the user's to type. */
  imported: boolean;
}

/** A voice someone handed over: added as it is, with no recording to look at here. */
const PACK = /\.kotovoice$/i;
/** A reading longer than this is not what was asked for: the recording ends by itself, still short enough to be kept. */
const RECORD_MOST_MS = CLIP_MOST_WITH_WORDS_S * 1000;

export function AddVoiceDialog({ open, language, languages, into = null, suggest = [], tone: firstTone = '', onClose, onAdded }: {
  open: boolean;
  /** The voice these are more recordings of, each in another language or tone. Absent: a new voice. */
  into?: LibraryVoice | null;
  /** The languages the run reads: where a voice has no recording in one of them, that is the one offered first. */
  suggest?: readonly string[];
  /** The tone the dialog opens on, where it was opened for one of a voice's tones. */
  tone?: string;
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
  /** The languages the voice has a recording in, in a tone. */
  const has = (toneId: string): readonly string[] => (toneId ? into?.tones.find((one) => one.tone === toneId)?.languages : into?.languages) ?? [];
  // A voice's tone is read in its own language first: there it is spoken on from, and every other takes its sound.
  const first = into
    ? (firstTone ? [base(into.language), ...suggest.map(base), ...languages] : [...suggest.map(base), ...languages]).find((code) => languages.includes(code) && !has(firstTone).includes(code)) ?? languages[0] ?? 'en'
    : languages.includes(own) ? own : languages.includes('en') ? 'en' : languages[0] ?? 'en';
  /** The language of the recording being made: what is read aloud is in it, and so is what an imported one says. */
  const [spoken, setSpoken] = useState(first);
  /** And its tone. */
  const [tone, setTone] = useState(firstTone);
  const [way, setWay] = useState<Way>('record');
  const [recording, setRecording] = useState<ClipRecording | null>(null);
  const [level, setLevel] = useState(0);
  /** What has been made so far, a language and tone each, in the order made. */
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
  const same = (one: Pick<Take, 'language' | 'tone'>, code: string, toneId: string) => one.language === code && one.tone === toneId;
  const current = takes.find((one) => same(one, spoken, tone));
  /**
   * A new voice's first plain recording is also what every other language is read from the sound of: it is the long
   * sentence, and no shorter than a voice takes. Every other is short.
   */
  const leads = (code: string, toneId: string, made: readonly Take[] = takes): boolean => {
    if (into || toneId) return false;
    const plain = made.find((one) => !one.tone);
    return !plain || plain.language === code;
  };
  const leastOf = (code: string, toneId: string, made: readonly Take[] = takes): number => (leads(code, toneId, made) ? CLIP_LEAST_S : toneId === 'laugh' ? CLIP_LEAST_LAUGH_S : CLIP_LEAST_MORE_S);
  const sentence = readAloud(spoken, leads(spoken, tone) ? 'long' : 'short', tone);
  /** A tone is added to a voice: one there is, or the one being made once it has its own recording. */
  const tonesOffered = into !== null || takes.some((one) => !one.tone);

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
  useEffect(() => { halt(); setWay('record'); setTakes([]); setName(''); setSpoken(first); setTone(firstTone); }, [open, into?.id, firstTone]); // eslint-disable-line react-hooks/exhaustive-deps
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
   * One that will takes the place of its language and tone among what has been made.
   */
  const take = (pcm: Int16Array, text: string, imported: boolean) => {
    const ready = prepared(pcm, !imported);
    const problem = clipProblem(ready, !imported, leastOf(spoken, tone));
    setFault(problem);
    if (problem) return;
    const made: Take = { language: spoken, tone, clip: ready, text, imported };
    setTakes((before) => (before.some((one) => same(one, spoken, tone)) ? before.map((one) => (same(one, spoken, tone) ? made : one)) : [...before, made]));
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
      if (file.size > PACK_MOST_BYTES) { setFault('unreadable'); return; }
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

  /** Another language or tone, or one made already: what is going on ends, what has been made stays. */
  const turnTo = (code: string, toneId: string) => { if (code !== spoken || toneId !== tone) { halt(); setSpoken(code); setTone(toneId); } };
  const drop = (one: Take) => { halt(); setTakes((before) => before.filter((kept) => !same(kept, one.language, one.tone))); };
  const retype = (text: string) => setTakes((before) => before.map((one) => (same(one, spoken, tone) ? { ...one, text: text.slice(0, 400) } : one)));

  /**
   * Why what has been made cannot be kept as it is. Words typed after an imported recording was looked at make it
   * one that is read through, which it may be too long for. A plain recording in another language than the voice's
   * own is only ever spoken on from, which takes its words (one in a tone is of use by its sound alone). And the
   * voice's own may be one made as another's, once the first was taken away.
   */
  const wrong = (one: Take): ClipProblem | 'wordless' | null => {
    const typed = one.text.trim();
    const problem = clipProblem(one.clip, typed !== '', leastOf(one.language, one.tone));
    if (problem) return problem;
    return typed === '' && !one.tone && !leads(one.language, one.tone) ? 'wordless' : null;
  };
  const amiss = current ? wrong(current) : null;
  /** A new voice begins with a plain recording: a tone alone is no voice. */
  const ownless = !into && !takes.some((one) => !one.tone);
  const blocked = takes.length === 0 || ownless || takes.some((one) => wrong(one) !== null);
  const voiceName = into?.name ?? (name.trim() || t('fork.voice.myVoice', 'My voice'));
  const toneName = (toneId: string) => t(`fork.voice.tones.${toneId || 'plain'}`, toneId || 'Plain');
  const takeName = (code: string, toneId: string) => (toneId ? `${languageLabel(code, i18n.language)} · ${toneName(toneId)}` : languageLabel(code, i18n.language));

  const save = async () => {
    if (blocked) return;
    setBusy(true);
    quiet();
    let voice: LibraryVoice | null = null;
    let whose = into?.id;
    // A new voice is made by its own recording; every other is one more of it.
    const own1 = takes.find((one) => leads(one.language, one.tone));
    for (const one of own1 ? [own1, ...takes.filter((kept) => kept !== own1)] : takes) {
      const added = await useVoiceLibraryStore.getState().add({ name: voiceName, text: one.text.trim(), language: one.language, wav: clipWav(one.clip), ...(whose ? { to: whose, ...(one.tone ? { tone: one.tone } : {}) } : {}) });
      if (added.ok) { voice = added.voice; whose = added.voice.id; } else if (!whose) break;
    }
    setBusy(false);
    if (voice) { onAdded(voice); onClose(); } else setFault('failed');
  };

  const said: Record<Fault, string> = {
    too_short: t('fork.voice.clipTooShort', { seconds: leastOf(spoken, tone), defaultValue: 'Too short: at least {{seconds}} seconds.' }),
    too_long: t('fork.voice.clipTooLong', { seconds: CLIP_MOST_WITH_WORDS_S, defaultValue: 'Too long: no more than {{seconds}} seconds with its words.' }),
    silent: t('fork.voice.clipSilent', 'No voice was heard.'),
    microphone: t('fork.voice.micDenied', 'The microphone could not be opened.'),
    unreadable: t('fork.voice.clipUnreadable', 'This file could not be read.'),
    failed: t('fork.voice.clipFailed', 'The voice could not be added.'),
  };
  const shown: Fault | null = fault ?? (amiss && amiss !== 'wordless' ? amiss : null);
  const wordsLabel = current && !current.tone && !leads(current.language, current.tone) ? t('fork.voice.clipWordsNeeded', 'What is said in it') : t('fork.voice.clipWords', 'What is said in it (optional)');
  /** What the voice has already, not made again here: each language of its plain recordings, then of each tone. */
  const had = into ? [...into.languages.map((code) => ({ code, toneId: '' })), ...into.tones.flatMap((one) => one.languages.map((code) => ({ code, toneId: one.tone })))].filter((one) => !takes.some((made) => same(made, one.code, one.toneId))) : [];

  return (
    <Modal isOpen={open} onClose={onClose} title={!into ? t('fork.voice.addVoice', 'Add a voice') : firstTone ? t('fork.voice.addTone', { name: into.name, defaultValue: 'Add a tone to {{name}}' }) : t('fork.voice.addTake', { name: into.name, defaultValue: 'Add a language to {{name}}' })}>
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
            onChange={(e) => turnTo(e.target.value, tone)}
          >
            {languages.map((code) => <option key={code} value={code}>{languageLabel(code, i18n.language)}</option>)}
          </select>
          {tonesOffered && (
            <select
              className="select-dropdown" value={tone} disabled={busy || recording !== null} aria-label={t('fork.voice.clipTone', 'Tone')} title={t('fork.voice.clipTone', 'Tone')}
              onChange={(e) => turnTo(spoken, e.target.value)}
            >
              {['', ...TONES].map((toneId) => <option key={toneId} value={toneId}>{toneName(toneId)}</option>)}
            </select>
          )}
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

        {(takes.length > 0 || had.length > 0) && (
          // What the voice will have: what it has already, then each made here — the one being looked at marked,
          // each to be gone back to or taken away.
          <div className="kt-addvoice__takes">
            {had.map((one) => <span key={`${one.code}|${one.toneId}`} className="kt-myvoices__lang">{takeName(one.code, one.toneId)}</span>)}
            {takes.map((one) => {
              const label = takeName(one.language, one.tone);
              const remove = t('fork.voice.removeTake', { name: voiceName, language: label, defaultValue: 'Remove the {{language}} recording of {{name}}' });
              const on = same(one, spoken, tone);
              return (
                <span key={`${one.language}|${one.tone}`} className={`kt-addvoice__take${on ? ' is-current' : ''}${wrong(one) ? ' is-amiss' : ''}`}>
                  <button type="button" onClick={() => turnTo(one.language, one.tone)} aria-pressed={on} disabled={busy || recording !== null}>
                    {label}<span>{t('fork.voice.clipSeconds', { seconds: secondsOf(one.clip).toFixed(1), defaultValue: '{{seconds}} s' })}</span>
                  </button>
                  <button type="button" onClick={() => drop(one)} aria-label={remove} title={remove} disabled={busy || recording !== null}><X size={10} /></button>
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
