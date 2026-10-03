/**
 * Fork: the reading aids' two switches, drawn at the foot of the display
 * popover of both the panel and the subtitle. Plain checkboxes of their own,
 * so the popover's own toggles — and the tests that count them — stay as
 * they are.
 */
import { useTranslation } from 'react-i18next';
import { useAnnotationStore } from '../../stores/annotationStore';

export function ReadingAidToggles() {
  const { t } = useTranslation();
  const furigana = useAnnotationStore((s) => s.furigana);
  const romanization = useAnnotationStore((s) => s.romanization);
  const setFurigana = useAnnotationStore((s) => s.setFurigana);
  const setRomanization = useAnnotationStore((s) => s.setRomanization);
  return (
    <div className="field reading-aid-toggles">
      <label className="reading-aid-toggle">
        <input type="checkbox" checked={furigana} onChange={(e) => void setFurigana(e.target.checked)} />
        <span>{t('fork.furigana', 'Furigana over kanji (Japanese)')}</span>
      </label>
      <label className="reading-aid-toggle">
        <input type="checkbox" checked={romanization} onChange={(e) => void setRomanization(e.target.checked)} />
        <span>{t('fork.romanization', 'Romanization (Japanese, Korean, Russian)')}</span>
      </label>
    </div>
  );
}
