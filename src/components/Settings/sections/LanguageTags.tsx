import React from 'react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../../Tooltip/Tooltip';
import { languageNameFor } from '../engine/languageName';

/** The catalogs' "any language" markers — the WASM manifest's `multilingual`,
 *  the native catalog's `multi` (Whisper) — a single entry that carries no
 *  list of its own; its tooltip just says so. */
const MULTI_MARKERS = new Set(['multilingual', 'multi']);

/** Fork: a model of this few languages names them on its chip, not just "Multi": where it stops shows at a glance. */
const NAMED_UP_TO = 5;

/** Fork: a language's chip name: its first character where the UI writes names in Han (中, 粤, 英, 日, 韩), else its code. */
function shortName(code: string, ui: string): string {
  return /^(zh|ja)/i.test(ui) ? Array.from(languageNameFor(code))[0] ?? code : code.toUpperCase();
}

/**
 * A model card's language tags (decision 2026-09-03): one supported language
 * shows as before, a single chip with its code; two or more collapse into one
 * chip whose hover tooltip lists every language by name, so a 99-language ASR
 * model no longer stacks rows of chips under its name. Fork: the chip says how
 * many ("30 种语言"), or — five or fewer — which ("中 粤 英 日 韩"). A bare
 * "multilingual" marker is a "Multi" chip with a one-word tooltip. Shared by
 * the native and WASM library cards.
 */
export const LanguageTags: React.FC<{ languages: readonly string[] }> = ({ languages }) => {
  const { t, i18n } = useTranslation();
  const codes = Array.from(new Set(languages.filter((l) => typeof l === 'string' && l.trim() !== '')));
  if (codes.length === 0) return null;

  const multiLabel = t('models.multiLanguage', 'Multi');
  const multiChip = <span className="model-card__lang-tag model-card__lang-tag--multi">{multiLabel}</span>;
  const listed = codes.filter((c) => !MULTI_MARKERS.has(c));

  if (listed.length === 0) {
    // Only markers: nothing to list, the tooltip states what the chip means.
    return (
      <Tooltip content={t('models.multilingual', 'Multilingual')} position="top">
        {multiChip}
      </Tooltip>
    );
  }
  if (codes.length === 1) {
    return <span className="model-card__lang-tag">{codes[0]}</span>;
  }

  // Fork: how many, or — few — which, on the chip itself.
  const chipText = listed.length <= NAMED_UP_TO
    ? listed.map((code) => shortName(code, i18n?.language ?? 'en')).join(' ')
    : t('models.languagesCount', '{{count}} languages', { count: listed.length });
  const content = (
    <div className="model-card__lang-list">
      <div className="model-card__lang-list-count">
        {t('models.languagesCount', '{{count}} languages', { count: listed.length })}
      </div>
      <div>{listed.map(languageNameFor).join(', ')}</div>
    </div>
  );
  return (
    <Tooltip content={content} position="top" maxWidth={320}>
      <span className="model-card__lang-tag model-card__lang-tag--multi">{chipText}</span>
    </Tooltip>
  );
};

export default LanguageTags;
