/**
 * Fork: the voices of the voice stage, in its card — one row for each language the run speaks: the voice it is
 * spoken in, chosen from what the place offers, and a button that says a sample in it. A place that is not asked
 * what voices it has (an API, a model of the other device's this build does not know) gets one typed name for every language. A language the place cannot speak says so in its row.
 * A cloning model speaks in the user's own voices: its rows offer those, and under them they are listed, with the
 * way to add one (`AddVoiceDialog`), hand one to someone else, or remove it. A voice may have recordings in other
 * tones than its plain one (`tone.ts`): each tone is then a row of its own, with the languages it was read in.
 */
import { Fragment, useEffect, useRef, useState } from 'react';
import { Download, Loader, Plus, Square, Trash2, Upload, Volume2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { filterVoicesByLanguage, getEdgeTtsVoices } from '../../lib/edge-tts/voiceList';
import type { Voice } from '../../lib/edge-tts/edgeTts';
import { languageLabel } from '../../lib/language/label';
import { previewSampleFor } from '../../lib/tts/previewSample';
import { useLineVoiceStore } from '../../stores/lineVoiceStore';
import { useVoiceLibraryStore, type LibraryVoice } from '../../stores/voiceLibraryStore';
import { AddVoiceDialog } from './AddVoiceDialog';
import { PACK_MOST_BYTES } from '../../lib/voice/recordClip';
import { TONES } from '../../lib/voice/tone';
import { chosenVoice, voiceBook, voiceSource, voiceSpeaks, withVoice, withoutVoice, type VoiceChoice } from './localaiVoice';
import type { LocalAIModel } from './localaiModels';
import { nativeVoicesFor } from './nativeVoices';

const baseOf = (code: string): string => code.split('-')[0].toLowerCase();

/** An Edge voice as its menu names it: the name without the locale and "Neural", and the locale where the language has several. */
function edgeName(voice: Voice, several: boolean): string {
  const name = voice.ShortName.split('-').slice(2).join('-').replace(/Neural$/, '').replace(/Multilingual$/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return several ? `${name} · ${voice.Locale}` : name;
}

const mark = (gender: string): string => (/^f/i.test(gender) ? '♀' : '♂');

/** A sample sentence for the languages a voice is offered in that the app's own table has none for. */
const MORE_SAMPLES: Readonly<Record<string, string>> = {
  yue: '你好，呢個係呢把聲嘅簡短試聽。',
  da: 'Hej. Dette er en kort prøve på, hvordan denne stemme lyder.',
  cs: 'Dobrý den. Toto je krátká ukázka toho, jak tento hlas zní.',
};

/** Says a sample of a row's language in the voice the card shows now, whether or not it is kept yet. */
function SampleButton({ id, language, choice, disabled, quiet }: { id: string; language: string; choice: VoiceChoice; disabled?: boolean; /** Drawn as one of a voice's own buttons, with no box of its own. */ quiet?: boolean }) {
  const { t } = useTranslation();
  const phase = useLineVoiceStore((s) => (s.line === id ? s.phase : 'idle'));
  const on = phase !== 'idle';
  const label = on ? t('fork.voice.stopLine', 'Stop') : t('fork.voice.sample', 'Play a sample');
  const press = async () => {
    const { sayLine, stopLine } = await import('../../app/lineVoice');
    if (on) { stopLine(); return; }
    // In the row's own voice whatever the sentence: one of another language is still that voice's to read.
    void sayLine(id, MORE_SAMPLES[baseOf(language)] ?? previewSampleFor(baseOf(language)).text, language, { ...choice, on: true });
  };
  return (
    <button type="button" className={quiet ? 'kt-myvoices__act' : 'kt-voice__sample'} onClick={() => { void press(); }} aria-label={label} title={label} aria-pressed={on} disabled={disabled}>
      {phase === 'loading' ? <Loader size={13} className="kt-engine__spin" /> : phase === 'playing' ? <Square size={11} fill="currentColor" /> : <Volume2 size={14} />}
    </button>
  );
}

export function VoiceRows({ choice, lent = [], languages, ownLanguage = 'en', placeName, onChange, disabled, sampleDisabled, apiVoiceHint }: {
  choice: VoiceChoice;
  /** What the other device lists, where it speaks. */
  lent?: readonly LocalAIModel[];
  /** The languages the run speaks, the other side's main one first. */
  languages: readonly string[];
  /** The user's own language: what they read aloud in when they record a voice of theirs. */
  ownLanguage?: string;
  /** What speaks, as the card names it: for the row of a language it cannot speak. */
  placeName: string;
  onChange(next: VoiceChoice): void;
  /**
   * A session runs. A language's voice can still be chosen from its menu: the run goes on in it (`liveReads`). A
   * typed name cannot: every letter would be another voice.
   */
  disabled?: boolean;
  /** What speaks is not here yet (a model not downloaded): nothing can be sampled. */
  sampleDisabled?: boolean;
  /** A voice of the API's own to show where none is typed. */
  apiVoiceHint?: string;
}) {
  const { t, i18n } = useTranslation();
  const source = voiceSource(choice, lent);
  const edge = source.by === 'edge';
  const [edgeVoices, setEdgeVoices] = useState<Voice[] | null>(null);
  useEffect(() => {
    if (!edge || edgeVoices) return undefined;
    let gone = false;
    // Its own list, asked once the card shows Edge: without it the menu holds the one voice in use.
    void getEdgeTtsVoices().then((voices) => { if (!gone) setEdgeVoices(voices); }).catch(() => undefined);
    return () => { gone = true; };
  }, [edge, edgeVoices]);
  // The user's own voices, where the model speaks in those.
  const clones = source.by === 'catalog' && source.model.clones === true;
  const mine = useVoiceLibraryStore((s) => s.voices);
  const asked = useVoiceLibraryStore((s) => s.asked);
  /** The dialog a recording is added in: a new voice's (`into` null), or one more of a voice there is, in a tone. */
  const [adding, setAdding] = useState<{ into: LibraryVoice | null; tone?: string } | null>(null);
  /** A voice someone handed over as a file (what the download button of a voice makes): added as it is. */
  const packs = useRef<HTMLInputElement>(null);
  const [unread, setUnread] = useState(false);
  const takeIn = async (file: File | undefined) => {
    if (!file) return;
    setUnread(false);
    // A voice is a few megabytes: anything far larger is not one, and is not read into memory to find out.
    const added = file.size > PACK_MOST_BYTES ? { ok: false as const } : await useVoiceLibraryStore.getState().addPack(new Uint8Array(await file.arrayBuffer()));
    if (!added.ok) { setUnread(true); return; }
    // The first voice there is reads every language.
    if (!useVoiceLibraryStore.getState().voices.some((one) => one.id !== added.voice.id && one.id === choice.voices[voiceBook(choice, lent)]?.['*'])) onChange(withVoice(choice, '*', added.voice.id, lent));
  };
  /** The voice whose name is being typed over, and what is typed so far. */
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const renamed = (keep: boolean) => {
    const now = renaming;
    setRenaming(null);
    const name = now?.name.trim();
    if (keep && now && name && name !== mine.find((one) => one.id === now.id)?.name) void useVoiceLibraryStore.getState().rename(now.id, name);
  };
  useEffect(() => { if (clones && !asked) void useVoiceLibraryStore.getState().refresh(); }, [clones, asked]);

  if (source.by === 'typed') {
    const label = t('fork.voice.voice', 'Voice');
    // Sampled in a language of the run's that it speaks: the first, where nothing says which it does.
    const sampled = languages.find((language) => voiceSpeaks(choice, language, lent)) ?? languages[0] ?? 'en';
    return (
      <div className="kt-voice">
        <label className="kt-field">
          <span className="kt-field__label">{label}</span>
          <span className="kt-voice__row">
            <input type="text" className="kt-input" aria-label={label} value={choice.voices[voiceBook(choice, lent)]?.['*'] ?? ''} onChange={(e) => onChange(withVoice(choice, '*', e.target.value.trim(), lent))} placeholder={apiVoiceHint ?? ''} spellCheck={false} disabled={disabled} />
            <SampleButton id={`sample:${baseOf(sampled)}`} language={sampled} choice={choice} disabled={sampleDisabled || !voiceSpeaks(choice, sampled, lent)} />
          </span>
        </label>
      </div>
    );
  }

  const seen = new Set<string>();
  const rows = languages.filter((language) => { const base = baseOf(language); if (seen.has(base)) return false; seen.add(base); return true; });
  const book = voiceBook(choice, lent);
  /**
   * Removes a voice of the user's own, and every use of it once it is gone: one that could not be removed stays
   * chosen. Where it was the one that read, a voice that is left reads in its place.
   */
  const forget = async (id: string) => {
    await useVoiceLibraryStore.getState().remove(id);
    const left = useVoiceLibraryStore.getState().voices;
    if (left.some((one) => one.id === id)) return;
    const without = withoutVoice(choice, id);
    onChange(left[0] && !left.some((one) => one.id === without.voices[book]?.['*']) ? withVoice(without, '*', left[0].id, lent) : without);
  };
  // A cloning model's voices are the user's own, and they are the choice themselves: one voice is simply the one
  // that reads; of several, the one marked reads every language, and a language may be given another under them.
  const there = (id: string | undefined): string => (id && mine.some((one) => one.id === id) ? id : '');
  const spoken = rows.filter((language) => voiceSpeaks(choice, language, lent));
  /** The voice that reads whatever has none of its own. */
  const every = there(choice.voices[book]?.['*']) || there(chosenVoice(choice, spoken[0] ?? ownLanguage, lent));
  /** In this voice alone, every language. */
  const inVoice = (id: string): VoiceChoice => ({ ...choice, voices: { ...choice.voices, [book]: { '*': id } } });
  const picked = clones && (mine.length > 1 || (mine.length === 1 && !every));
  const perLanguage = clones && mine.length > 1 && spoken.length > 1;
  /** One more tone of a voice: the dialog opens on the first it has none of. */
  const addTone = (voice: LibraryVoice) => {
    const label = t('fork.voice.addTone', { name: voice.name, defaultValue: 'Add a tone to {{name}}' });
    return (
      <button type="button" className="kt-myvoices__more kt-myvoices__more--tone" onClick={() => setAdding({ into: voice, tone: TONES.find((one) => !voice.tones.some((had) => had.tone === one)) ?? TONES[0] })} disabled={disabled} aria-label={label} title={label}>
        <Plus size={11} />
        <span>{t('fork.voice.clipTone', 'Tone')}</span>
      </button>
    );
  };
  /** The user's own voices: each by its name, with what is done to it, the languages it has, and the ways to one more. */
  const library = clones && (
    <div className="kt-myvoices">
      <div className="kt-myvoices__top">
        <span className="kt-field__label">{t('fork.voice.voice', 'Voice')}</span>
        <span className="kt-myvoices__adds">
          <button type="button" className="kt-myvoices__add" onClick={() => { setUnread(false); setAdding({ into: null }); }} disabled={disabled} aria-label={t('fork.voice.addVoice', 'Add a voice')} title={t('fork.voice.addVoice', 'Add a voice')}>
            <Plus size={12} />
            <span>{t('fork.voice.addShort', 'Add')}</span>
          </button>
          <button type="button" className="kt-myvoices__add" onClick={() => packs.current?.click()} disabled={disabled} aria-label={t('fork.voice.importVoice', 'Import a voice file')} title={t('fork.voice.importVoice', 'Import a voice file')}>
            <Upload size={12} />
            <span>{t('fork.voice.importShort', 'Import')}</span>
          </button>
          <input ref={packs} type="file" accept=".kotovoice" hidden onChange={(e) => { void takeIn(e.target.files?.[0]); e.target.value = ''; }} />
        </span>
      </div>
      {mine.map((voice) => (
        // A voice: who it is and what is done with the whole of it, then the languages it has a recording in and
        // the way to one more.
        <div key={voice.id} className={`kt-myvoices__voice${picked && every === voice.id ? ' is-chosen' : ''}`}>
          <div className="kt-myvoices__head">
            {picked && (
              <button
                type="button" role="radio" aria-checked={every === voice.id} className="kt-myvoices__pick" onClick={() => { if (every !== voice.id) onChange(inVoice(voice.id)); }}
                aria-label={t('fork.voice.useVoice', { name: voice.name, defaultValue: 'Read in {{name}}' })} title={t('fork.voice.useVoice', { name: voice.name, defaultValue: 'Read in {{name}}' })}
              />
            )}
            {renaming?.id === voice.id ? (
              <input
                type="text" className="kt-myvoices__name" autoFocus value={renaming.name} maxLength={40} spellCheck={false}
                aria-label={t('fork.voice.voiceName', 'Name')} onChange={(e) => setRenaming({ id: voice.id, name: e.target.value })} onFocus={(e) => e.target.select()}
                // Kept on Enter or on leaving it; Escape leaves the name as it was.
                onBlur={() => renamed(true)} onKeyDown={(e) => { if (e.key === 'Enter') renamed(true); else if (e.key === 'Escape') renamed(false); }}
              />
            ) : (
              <button type="button" className="kt-myvoices__name" onClick={() => setRenaming({ id: voice.id, name: voice.name })} aria-label={t('fork.voice.renameVoice', { name: voice.name, defaultValue: 'Rename {{name}}' })} title={t('fork.voice.renameVoice', { name: voice.name, defaultValue: 'Rename {{name}}' })}>
                {voice.name}
              </button>
            )}
            {/* Heard in this voice whichever is chosen, in the first language the run reads. */}
            <SampleButton quiet id={`sample:voice:${voice.id}`} language={spoken[0] ?? ownLanguage} choice={inVoice(voice.id)} disabled={sampleDisabled} />
            <button type="button" className="kt-myvoices__act" onClick={() => { void useVoiceLibraryStore.getState().export(voice.id); }} aria-label={t('fork.voice.exportVoice', { name: voice.name, defaultValue: 'Save {{name}} as a file' })} title={t('fork.voice.exportVoice', { name: voice.name, defaultValue: 'Save {{name}} as a file' })}>
              <Download size={13} />
            </button>
            <button type="button" className="kt-myvoices__act" onClick={() => { void forget(voice.id); }} disabled={disabled} aria-label={t('fork.voice.removeVoice', { name: voice.name, defaultValue: 'Remove {{name}}' })} title={t('fork.voice.removeVoice', { name: voice.name, defaultValue: 'Remove {{name}}' })}>
              <Trash2 size={13} />
            </button>
          </div>
          {/* Its recordings: the plain ones, then a row for each tone it was read in once it has any. */}
          <div className={`kt-myvoices__takes${voice.tones.length > 0 ? ' has-tones' : ''}`}>
            {[{ tone: '', languages: voice.languages }, ...voice.tones].map((row) => {
              const toneName = t(`fork.voice.tones.${row.tone || 'plain'}`, row.tone || 'Plain');
              const more = `${t('fork.voice.addTake', { name: voice.name, defaultValue: 'Add a language to {{name}}' })}${row.tone ? ` · ${toneName}` : ''}`;
              return (
                <Fragment key={row.tone}>
                  {voice.tones.length > 0 && <span className="kt-myvoices__tone">{toneName}</span>}
                  <div className="kt-myvoices__langs">
                    {row.languages.map((code, i) => {
                      const said = languageLabel(code, i18n.language);
                      // The first plain one is what the voice is; any other can be taken away, and what it read is
                      // then read from what is left.
                      if (i === 0 && !row.tone) return <span key={code} className="kt-myvoices__lang">{said}</span>;
                      const label = row.tone
                        ? t('fork.voice.removeToneTake', { name: voice.name, language: said, tone: toneName, defaultValue: 'Remove the {{tone}} {{language}} recording of {{name}}' })
                        : t('fork.voice.removeTake', { name: voice.name, language: said, defaultValue: 'Remove the {{language}} recording of {{name}}' });
                      return (
                        <button key={code} type="button" className="kt-myvoices__lang" onClick={() => { void useVoiceLibraryStore.getState().removeTake(voice.id, code, row.tone); }} disabled={disabled} aria-label={label} title={label}>
                          {said}<X size={10} />
                        </button>
                      );
                    })}
                    <button type="button" className="kt-myvoices__more" onClick={() => setAdding({ into: voice, tone: row.tone })} disabled={disabled} aria-label={more} title={more}>
                      <Plus size={11} />
                    </button>
                    {voice.tones.length === 0 && addTone(voice)}
                  </div>
                </Fragment>
              );
            })}
            {voice.tones.length > 0 && voice.tones.length < TONES.length && <><span /><div className="kt-myvoices__langs">{addTone(voice)}</div></>}
          </div>
        </div>
      ))}
      {unread && <p className="kt-note kt-note--todo" role="status">{t('fork.voice.clipUnreadable', 'This file could not be read.')}</p>}
      <AddVoiceDialog
        open={adding !== null}
        into={adding?.into ?? null}
        tone={adding?.tone ?? ''}
        suggest={rows}
        language={ownLanguage}
        languages={source.by === 'catalog' ? source.model.languages : []}
        onClose={() => setAdding(null)}
        // The first voice added reads every language; a later one is chosen where it is wanted. A recording more of
        // a voice changes no choice: the voice is the same one.
        onAdded={(voice) => { if (!adding?.into && !mine.some((one) => one.id === choice.voices[book]?.['*'])) onChange(withVoice(choice, '*', voice.id, lent)); }}
      />
    </div>
  );
  return (
    <div className="kt-voice">
      {library}
      {rows.map((language) => {
        const name = languageLabel(baseOf(language), i18n.language);
        if (!voiceSpeaks(choice, language, lent)) {
          return <p key={language} className="kt-note kt-note--todo" role="status">{t('fork.voice.cannotSpeak', { name: placeName, language: name })}</p>;
        }
        // The user's own voices are chosen where they are listed; a language has a menu of its own only where there
        // is another voice to give it.
        if (clones && !perLanguage) return null;
        const kept = chosenVoice(choice, language, lent) ?? '';
        // A voice of the user's own that was removed is no voice chosen.
        const current = clones && !mine.some((voice) => voice.id === kept) ? '' : kept;
        const offered = clones ? mine.map((voice) => ({ id: voice.id, label: voice.name })) : edge
          ? filterVoicesByLanguage(edgeVoices ?? [], baseOf(language)).map((voice, _i, all) => ({ id: voice.ShortName, label: `${edgeName(voice, new Set(all.map((v) => v.Locale)).size > 1)} ${mark(voice.Gender)}` }))
          : nativeVoicesFor(source.model, language).map((voice) => ({ id: voice.id, label: voice.nameKey ? t(voice.nameKey) : `${voice.name} ${mark(voice.gender)}` }));
        // The voice in use is in the menu even before the list has come.
        const options = offered.some((voice) => voice.id === current) || !current ? offered : [{ id: current, label: current.split('-').slice(2).join('-').replace(/Neural$/, '') || current }, ...offered];
        const label = t('fork.voice.voiceOf', { language: name });
        return (
          <label key={language} className="kt-field">
            <span className="kt-field__label">{label}</span>
            <span className="kt-voice__row">
              <select className="select-dropdown" aria-label={label} value={current} onChange={(e) => onChange(withVoice(choice, language, e.target.value, lent))} disabled={options.length < 2 && !(clones && !current)}>
                {clones && !current && <option value="">{t('fork.voice.chooseVoice', 'Choose a voice')}</option>}
                {options.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
              </select>
              <SampleButton id={`sample:${baseOf(language)}`} language={language} choice={choice} disabled={sampleDisabled || (clones && !current)} />
            </span>
          </label>
        );
      })}
    </div>
  );
}
