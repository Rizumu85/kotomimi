/**
 * Fork: the reading aids' two switches, drawn at the foot of the display
 * popover of both the panel and the subtitle — the popover's own switch
 * (`ToggleSwitch`), so they read as part of it. Marked `reading-aid-toggle`,
 * by which the popover's tests tell them from its own.
 */
import { useTranslation } from 'react-i18next';
import ToggleSwitch from '../Settings/shared/ToggleSwitch';
import { useAnnotationStore } from '../../stores/annotationStore';

export function ReadingAidToggles() {
  const { t } = useTranslation();
  const furigana = useAnnotationStore((s) => s.furigana);
  const romanization = useAnnotationStore((s) => s.romanization);
  const setFurigana = useAnnotationStore((s) => s.setFurigana);
  const setRomanization = useAnnotationStore((s) => s.setRomanization);
  return (
    <div className="field reading-aid-toggles">
      <ToggleSwitch className="reading-aid-toggle" checked={furigana} onChange={() => void setFurigana(!furigana)} label={t('fork.furigana', 'Furigana over kanji (Japanese)')} />
      <ToggleSwitch className="reading-aid-toggle" checked={romanization} onChange={() => void setRomanization(!romanization)} label={t('fork.romanization', 'Romanization (Japanese, Korean, Russian)')} />
    </div>
  );
}
