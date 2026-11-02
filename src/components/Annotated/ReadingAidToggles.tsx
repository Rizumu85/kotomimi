/**
 * Fork: how the conversation's text is read, at the foot of the display popover of both the panel and the subtitle.
 * Readings and the text's own look, each a group of buttons: as a stack of switches the five read as one long list
 * (the user, 2026-10-31). Each button's `title` says in full what it does. Under the romanization its languages, each
 * pressed or not: a reader of kana may still spell out Korean. Marked `reading-aid-toggle`, by which the popover's
 * tests find them.
 */
import { useTranslation } from 'react-i18next';
import { languageNameFor } from '../Settings/engine/languageName';
import { ROMANIZED_LANGUAGES } from '../../lib/annotate/types';
import { useAnnotationStore } from '../../stores/annotationStore';
import './ReadingAidToggles.scss';

function Aid({ on, onClick, words, title }: { on: boolean; onClick(): void; words: string; title?: string }) {
  return (
    <button type="button" className={`reading-aid-toggle${on ? ' is-on' : ''}`} aria-pressed={on} onClick={onClick} title={title}>
      {words}
    </button>
  );
}

export function ReadingAidToggles({ highlight }: { /** The subtitle's own: whether new text is marked as it comes. */ highlight?: { on: boolean; toggle(): void } }) {
  const { t } = useTranslation();
  const furigana = useAnnotationStore((s) => s.furigana);
  const romanization = useAnnotationStore((s) => s.romanization);
  const setFurigana = useAnnotationStore((s) => s.setFurigana);
  const setRomanization = useAnnotationStore((s) => s.setRomanization);
  const romanizationOff = useAnnotationStore((s) => s.romanizationOff);
  const setRomanized = useAnnotationStore((s) => s.setRomanized);
  const pinyin = useAnnotationStore((s) => s.pinyin);
  const setPinyin = useAnnotationStore((s) => s.setPinyin);
  const jyutping = useAnnotationStore((s) => s.jyutping);
  const setJyutping = useAnnotationStore((s) => s.setJyutping);
  const sourceItalic = useAnnotationStore((s) => s.sourceItalic);
  const setSourceItalic = useAnnotationStore((s) => s.setSourceItalic);
  return (
    <div className="field reading-aids">
      <div className="reading-aids__group" role="group" aria-label={t('fork.aids.readings')}>
        <span className="reading-aids__label">{t('fork.aids.readings')}</span>
        <div className="reading-aids__row">
          <Aid on={furigana} onClick={() => void setFurigana(!furigana)} words={t('fork.aids.furigana')} title={t('fork.furigana')} />
          <Aid on={pinyin} onClick={() => void setPinyin(!pinyin)} words={t('fork.aids.pinyin')} title={t('fork.pinyin')} />
          <Aid on={jyutping} onClick={() => void setJyutping(!jyutping)} words={t('fork.aids.jyutping')} title={t('fork.jyutping')} />
          <Aid on={romanization} onClick={() => void setRomanization(!romanization)} words={t('fork.aids.roman')} title={t('fork.romanization')} />
        </div>
        {romanization && (
          <div className="reading-aids__row reading-aid-languages" role="group" aria-label={t('fork.romanization')}>
            {ROMANIZED_LANGUAGES.map((language) => {
              const on = !romanizationOff.includes(language);
              return (
                <button key={language} type="button" className={`reading-aid-language${on ? ' is-on' : ''}`} aria-pressed={on} onClick={() => void setRomanized(language, !on)}>
                  {languageNameFor(language)}
                </button>
              );
            })}
          </div>
        )}
      </div>
      <div className="reading-aids__group" role="group" aria-label={t('fork.aids.text')}>
        <span className="reading-aids__label">{t('fork.aids.text')}</span>
        <div className="reading-aids__row">
          <Aid on={sourceItalic} onClick={() => void setSourceItalic(!sourceItalic)} words={t('fork.aids.italic')} title={t('fork.sourceItalic')} />
          {highlight && <Aid on={highlight.on} onClick={highlight.toggle} words={t('fork.aids.highlight')} title={t('subtitle.settings.newItemHighlight')} />}
        </div>
      </div>
    </div>
  );
}
