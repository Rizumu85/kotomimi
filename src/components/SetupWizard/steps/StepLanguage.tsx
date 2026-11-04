import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react';
import { INTERFACE_LANGUAGES } from '../../Settings/sections/interfaceLanguages';
import { changeLanguageWithLoad } from '../../../locales';
import { useSetUILanguage } from '../../../stores/settingsStore';

// The one setting applied DURING the wizard (spec §1.2 step 0): the rest of it
// has to be read in the chosen language.
const StepLanguage: React.FC = () => {
  // i18n.language is the language actually in effect — what the detector chose
  // on a first run, or what a previous change set. settingsStore.uiLanguage is
  // only ever written (by this step and by Help); reading it here would show
  // every first-run user "English" no matter what they see on screen.
  const { t, i18n } = useTranslation();
  const setUILanguage = useSetUILanguage();

  // Each pick loads a catalogue over the network, and a native <select> fires
  // change once per option while the user arrows through the list — so several
  // loads can be in flight at once and they do not finish in order. Only the
  // most recent pick is allowed to write; the rest resolve into nothing.
  const pick = useRef(0);
  const onChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const next = e.target.value;
    const mine = ++pick.current;
    try {
      await changeLanguageWithLoad(next);
      if (mine !== pick.current) return;
      await setUILanguage(next);
    } catch (err) {
      console.error('[SetupWizard] Could not change the interface language:', err);
    }
  };

  return (
    <section className="setup-step">
      {/* Fork: the page says what it is in more than the language it is shown in. A first run shows the system's
          language, which is not always one the person reads, and then the page said nothing they could read about
          being the place to change it (a friend, 2026-11-04). */}
      <p className="setup-step__polyglot" aria-hidden="true"><Globe size={16} /><span>{POLYGLOT}</span></p>
      <h2>{t('setup.steps.language.title', 'Which language should Sokuji speak to you in?')}</h2>
      <p>{t('setup.steps.language.desc', 'This is the language of menus and buttons. You choose the languages to translate between later.')}</p>
      <label className="setup-field">
        <span>{t('setup.steps.language.label', 'Interface language')}</span>
        <select value={i18n.language} onChange={onChange} aria-label={t('setup.steps.language.label', 'Interface language')}>
          {INTERFACE_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
        </select>
      </label>
    </section>
  );
};

/** "Language" in the languages most people who open this read, in their own words. */
const POLYGLOT = 'Language · 语言 · 語言 · 言語 · 언어 · Idioma · Langue · Sprache · Язык';

export default StepLanguage;
