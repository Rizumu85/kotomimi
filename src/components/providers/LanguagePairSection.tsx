import { ArrowLeftRight, Languages } from 'lucide-react';
import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import Tooltip from '../Tooltip/Tooltip';
import { pairSentence } from '../SetupWizard/languageSentence';
import { normalizePair, swapped } from '../../lib/provider/languages';
import type { AnyProvider, LanguageContext, LanguageOption, LanguagePair } from '../../lib/provider/types';
import type { AudioMode } from '../../stores/audioStore';
import { useLanguageLabel } from '../../lib/language/useLanguageLabel';
import { orderLanguages, pinnedLanguages, PIN_SEPARATOR, type OrderContext } from '../../lib/language/order';
import { effectiveTextOnly } from '../../utils/effectiveTextOnly';
import { useLanguageMenu } from './LanguageMenu';

const SEPARATOR = '──────────';

interface LanguagePairSectionProps {
  provider: AnyProvider;
  settings: unknown;
  pair: LanguagePair;
  onChange(pair: LanguagePair): void;
  disabled?: boolean;
  /**
   * Today's sentence (ruling 4): "I speak / they hear", or the mode-aware
   * labels `pairSentence` returns, plus the "both" mirror line. Absent: the
   * plain `settings.sourceLanguage` / `settings.targetLanguage` labels.
   */
  sentence?: { mode: AudioMode; textOnly: boolean };
  /** Whether a run would speak (Stage 2 Volcengine AST2, choice 1): the lists are the offer for it. Absent: the provider's widest offer. */
  context?: LanguageContext;
  /**
   * Fork: the other side is heard, and their language can be left to be
   * detected: "Detect the language" is then the first choice of their
   * language. While it is chosen the language they mostly speak — the pair's —
   * is chosen in a row under the pair: what the speaker's own words are
   * translated into, and what a translation that must be told a language is
   * told. Absent: not offered.
   */
  detect?: { on: boolean; set(on: boolean): void };
  /**
   * Fork: the two selects are named for whose language they hold — "my
   * language", "their language" — whatever the mode, and nothing is written
   * under them. Named for what the run does with them ("I read / they
   * speak"), one select had two names, and the user's own language read as
   * one that could be "detected". Lines that spelled out what the run does
   * were tried and taken out again: more to read than they were worth.
   */
  owners?: boolean;
}

/** The choice that is no language: the other side's is left to be detected. */
const DETECT = '\u0000detect';

/**
 * Any provider's language pair (spec: "Languages are two functions"): the
 * lists are its `sources` and `targets`, and the swap is the generic one,
 * allowed whenever the provider supports the reversed pair. Markup is
 * LanguageSection's translation-languages block.
 */
export function LanguagePairSection({ provider, settings, pair, onChange, disabled, sentence, context, detect, owners }: LanguagePairSectionProps) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const label = useLanguageLabel();
  const sources = provider.languages.sources(settings, context);
  const targets = provider.languages.targets(pair.source, settings, context);
  const reversed = swapped(provider, settings, pair, context);
  // Display only: the dropdowns use the app-wide order, while the provider's own
  // order still decides normalizePair's first option.
  const ui = i18n?.language ?? 'en';
  const browser = typeof navigator !== 'undefined' ? navigator.languages ?? [] : [];
  const browserKey = browser.join(',');
  const ctx: OrderContext = useMemo(() => ({ ui, browser }), [ui, browserKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const sourceOptions = useMemo(
    () => ({ pinned: pinnedLanguages(sources, pair, ctx), ordered: orderLanguages(sources, ctx) }),
    [sources, pair, ctx],
  );
  const targetOptions = useMemo(
    () => ({ pinned: pinnedLanguages(targets, pair, ctx), ordered: orderLanguages(targets, ctx) }),
    [targets, pair, ctx],
  );
  const options = ({ pinned, ordered }: { pinned: LanguageOption[]; ordered: LanguageOption[] }) => (
    <>
      {pinned.map((o) => <option key={`pin:${o.value}`} value={o.value}>{label(o.value)}</option>)}
      {pinned.length > 0 && <option key="pin-separator" value={PIN_SEPARATOR} disabled>{SEPARATOR}</option>}
      {ordered.map((o) => <option key={o.value} value={o.value}>{label(o.value)}</option>)}
    </>
  );

  // The capability maps the definition's `speech` onto the sentence's
  // text-only capability: a provider that always speaks is never text-only,
  // one that never speaks is always text-only, and 'optional' honours the toggle.
  const resolved = sentence && pairSentence({
    mode: sentence.mode,
    textOnly: effectiveTextOnly({ speakerLegRuns: sentence.mode !== 'participant', textOnly: sentence.textOnly }),
    capability: provider.speech === 'always' ? 'never' : provider.speech === 'never' ? 'always' : 'optional',
    source: pair.source,
    target: pair.target,
  });
  const sourceLabel = owners ? t('fork.languageMenu.mine') : resolved ? t(resolved.my.key, resolved.my.fallback) : t('settings.sourceLanguage');
  const targetLabel = owners ? t('fork.languageMenu.theirs') : resolved ? t(resolved.their.key, resolved.their.fallback) : t('settings.targetLanguage');
  // Fork: pressing a select opens the app's own list — every language with a pin at its right, the pinned ones first.
  const sourceMenu = useLanguageMenu({
    ordered: sourceOptions.ordered,
    suggested: sourceOptions.pinned,
    value: pair.source,
    onPick: (source) => onChange(normalizePair(provider, settings, { source, target: pair.target }, context)),
    label,
    disabled,
  });
  const detecting = detect?.on === true;
  /** Their language was chosen: a language, which is the pair's, or its detection. */
  const pickTheirs = (target: string) => {
    if (target === DETECT) { detect?.set(true); return; }
    if (detecting) detect?.set(false);
    if (target !== pair.target) onChange({ source: pair.source, target });
  };
  const targetMenu = useLanguageMenu({
    ordered: targetOptions.ordered,
    suggested: targetOptions.pinned,
    value: detecting ? DETECT : pair.target,
    onPick: pickTheirs,
    label,
    disabled,
    ...(detect ? { first: { code: DETECT, name: t('fork.languageMenu.detect') } } : {}),
  });
  // While their language is detected: the one they mostly speak, which the pair still names.
  const mostlyMenu = useLanguageMenu({
    ordered: targetOptions.ordered,
    suggested: targetOptions.pinned,
    value: pair.target,
    onPick: (target) => onChange({ source: pair.source, target }),
    label,
    disabled,
  });

  return (
    <div className="config-section" id="languages-section">
      <h3>
        <Languages size={18} />
        <span>{t('simpleConfig.translationLanguages')}</span>
        <Tooltip
          content={t('simpleConfig.translationLanguagesDesc')}
          position="top"
          icon="help"
        />
      </h3>
      <div className="language-pair-row">
        <div className="language-select-group">
          <label htmlFor={`${id}-source`}>{sourceLabel}</label>
          <select
            id={`${id}-source`}
            className="language-select"
            value={pair.source}
            onChange={(e) => onChange(normalizePair(provider, settings, { source: e.target.value, target: pair.target }, context))}
            disabled={disabled}
            {...sourceMenu.selectProps}
          >
            {options(sourceOptions)}
          </select>
          {sourceMenu.list}
        </div>
        <div className="language-arrow">
          <button
            type="button"
            className="language-swap-btn"
            onClick={() => reversed && onChange(reversed)}
            disabled={disabled || !reversed}
            title={t('simpleConfig.swapLanguages')}
          >
            <ArrowLeftRight size={18} />
          </button>
        </div>
        <div className="language-select-group">
          <label htmlFor={`${id}-target`}>{targetLabel}</label>
          <select
            id={`${id}-target`}
            className="language-select"
            value={detecting ? DETECT : pair.target}
            onChange={(e) => pickTheirs(e.target.value)}
            disabled={disabled}
            {...targetMenu.selectProps}
          >
            {detect && <option value={DETECT}>{t('fork.languageMenu.detect')}</option>}
            {options(targetOptions)}
          </select>
          {targetMenu.list}
        </div>
        {detecting && (
          // In the pair's own grid, a row of its own: what it is for at the left, the choice under their language.
          <>
            <label className="language-mostly-label" htmlFor={`${id}-mostly`}>{t('fork.languageMenu.mostly')}</label>
            <div className="language-select-group language-select-group--mostly">
              <select
                id={`${id}-mostly`}
                className="language-select"
                value={pair.target}
                onChange={(e) => onChange({ source: pair.source, target: e.target.value })}
                disabled={disabled}
                {...mostlyMenu.selectProps}
              >
                {options(targetOptions)}
              </select>
              {mostlyMenu.list}
            </div>
          </>
        )}
      </div>
      {resolved?.showMirror && !owners && (
        <div className="language-mirror-line" data-testid="language-mirror-line">
          {t('settings.langSentence.mirror', 'They speak {{their}} → I read {{mine}}', {
            their: label(pair.target),
            mine: label(pair.source),
          })}
        </div>
      )}
    </div>
  );
}
