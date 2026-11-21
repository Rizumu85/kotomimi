/**
 * Fork: the voices of the voice stage, in its card — one row for each language the run speaks: the voice it is
 * spoken in, chosen from what the place offers, and a button that says a sample in it. An API, which is not asked
 * what voices it has, gets one typed name for every language. A language the place cannot speak says so in its row.
 */
import { useEffect, useState } from 'react';
import { Loader, Square, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { filterVoicesByLanguage, getEdgeTtsVoices } from '../../lib/edge-tts/voiceList';
import type { Voice } from '../../lib/edge-tts/edgeTts';
import { languageLabel } from '../../lib/language/label';
import { previewSampleFor } from '../../lib/tts/previewSample';
import { useLineVoiceStore } from '../../stores/lineVoiceStore';
import { chosenVoice, speaksByEdge, voiceBook, voiceSpeaks, withVoice, type VoiceChoice } from './localaiVoice';
import { nativeVoice, nativeVoicesFor } from './nativeVoices';

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
function SampleButton({ id, language, choice, disabled }: { id: string; language: string; choice: VoiceChoice; disabled?: boolean }) {
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
    <button type="button" className="kt-voice__sample" onClick={() => { void press(); }} aria-label={label} title={label} aria-pressed={on} disabled={disabled}>
      {phase === 'loading' ? <Loader size={13} className="kt-engine__spin" /> : phase === 'playing' ? <Square size={11} fill="currentColor" /> : <Volume2 size={14} />}
    </button>
  );
}

export function VoiceRows({ choice, languages, placeName, onChange, disabled, sampleDisabled, apiVoiceHint }: {
  choice: VoiceChoice;
  /** The languages the run speaks, the other side's main one first. */
  languages: readonly string[];
  /** What speaks, as the card names it: for the row of a language it cannot speak. */
  placeName: string;
  onChange(next: VoiceChoice): void;
  disabled?: boolean;
  /** What speaks is not here yet (a model not downloaded): nothing can be sampled. */
  sampleDisabled?: boolean;
  /** A voice of the API's own to show where none is typed. */
  apiVoiceHint?: string;
}) {
  const { t, i18n } = useTranslation();
  const edge = speaksByEdge(choice);
  const [edgeVoices, setEdgeVoices] = useState<Voice[] | null>(null);
  useEffect(() => {
    if (!edge || edgeVoices) return undefined;
    let gone = false;
    // Its own list, asked once the card shows Edge: without it the menu holds the one voice in use.
    void getEdgeTtsVoices().then((voices) => { if (!gone) setEdgeVoices(voices); }).catch(() => undefined);
    return () => { gone = true; };
  }, [edge, edgeVoices]);

  if (choice.at === 'api' && !edge) {
    const label = t('fork.voice.voice', 'Voice');
    return (
      <div className="kt-voice">
        <label className="kt-field">
          <span className="kt-field__label">{label}</span>
          <span className="kt-voice__row">
            <input type="text" className="kt-input" aria-label={label} value={choice.voices[voiceBook(choice)]?.['*'] ?? ''} onChange={(e) => onChange(withVoice(choice, '*', e.target.value.trim()))} placeholder={apiVoiceHint ?? ''} spellCheck={false} disabled={disabled} />
            <SampleButton id={`sample:${baseOf(languages[0] ?? 'en')}`} language={languages[0] ?? 'en'} choice={choice} disabled={sampleDisabled} />
          </span>
        </label>
      </div>
    );
  }

  const seen = new Set<string>();
  const rows = languages.filter((language) => { const base = baseOf(language); if (seen.has(base)) return false; seen.add(base); return true; });
  return (
    <div className="kt-voice">
      {rows.map((language) => {
        const name = languageLabel(baseOf(language), i18n.language);
        if (!voiceSpeaks(choice, language)) {
          return <p key={language} className="kt-note kt-note--todo" role="status">{t('fork.voice.cannotSpeak', { name: placeName, language: name })}</p>;
        }
        const current = chosenVoice(choice, language) ?? '';
        const offered = edge
          ? filterVoicesByLanguage(edgeVoices ?? [], baseOf(language)).map((voice, _i, all) => ({ id: voice.ShortName, label: `${edgeName(voice, new Set(all.map((v) => v.Locale)).size > 1)} ${mark(voice.Gender)}` }))
          : nativeVoicesFor(nativeVoice(choice.nativeModel), language).map((voice) => ({ id: voice.id, label: voice.nameKey ? t(voice.nameKey) : `${voice.name} ${mark(voice.gender)}` }));
        // The voice in use is in the menu even before the list has come.
        const options = offered.some((voice) => voice.id === current) || !current ? offered : [{ id: current, label: current.split('-').slice(2).join('-').replace(/Neural$/, '') || current }, ...offered];
        const label = t('fork.voice.voiceOf', { language: name });
        return (
          <label key={language} className="kt-field">
            <span className="kt-field__label">{label}</span>
            <span className="kt-voice__row">
              <select className="select-dropdown" aria-label={label} value={current} onChange={(e) => onChange(withVoice(choice, language, e.target.value))} disabled={disabled || options.length < 2}>
                {options.map((voice) => <option key={voice.id} value={voice.id}>{voice.label}</option>)}
              </select>
              <SampleButton id={`sample:${baseOf(language)}`} language={language} choice={choice} disabled={sampleDisabled} />
            </span>
          </label>
        );
      })}
    </div>
  );
}
