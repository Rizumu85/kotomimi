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
   * Fork: the provider can tell the other side's language by itself. "Detect
   * the language" is then a choice of what they SPEAK: in the pair's second
   * select while that is what it says (the other side alone is heard), and in
   * the line under the pair — "they speak … → I read …" — while both sides
   * are, where the second select is what they read. Absent: not offered.
   */
  detect?: { on: boolean; set(on: boolean): void };
}

/** The choice that is no language: the other side's is left to be detected. */
const DETECT = '\u0000detect';
/** …and the one that is the pair's own language. */
const SAME = '\u0000same';

/**
 * Any provider's language pair (spec: "Languages are two functions"): the
 * lists are its `sources` and `targets`, and the swap is the generic one,
 * allowed whenever the provider supports the reversed pair. Markup is
 * LanguageSection's translation-languages block.
 */
export function LanguagePairSection({ provider, settings, pair, onChange, disabled, sentence, context, detect }: LanguagePairSectionProps) {
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
  const sourceLabel = resolved ? t(resolved.my.key, resolved.my.fallback) : t('settings.sourceLanguage');
  const targetLabel = resolved ? t(resolved.their.key, resolved.their.fallback) : t('settings.targetLanguage');
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
  // Where the choice is drawn: the line under the pair while both sides are heard; else the pair's second select.
  const inMirror = Boolean(detect) && resolved?.showMirror === true;
  const inSelect = Boolean(detect) && !inMirror;
  /** What the other side speaks was chosen: a language (the pair's), or its detection. */
  const pickTheirs = (target: string) => {
    if (target === DETECT) { detect?.set(true); return; }
    if (detecting && inSelect) detect?.set(false);
    if (target !== pair.target) onChange({ source: pair.source, target });
  };
  const targetMenu = useLanguageMenu({
    ordered: targetOptions.ordered,
    suggested: targetOptions.pinned,
    value: detecting && inSelect ? DETECT : pair.target,
    onPick: pickTheirs,
    label,
    disabled,
    ...(inSelect ? { first: { code: DETECT, name: t('fork.languageMenu.detect') } } : {}),
  });
  const sourceLanguageName = label(pair.source);
  const targetLanguageName = label(pair.target);

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
            value={detecting && inSelect ? DETECT : pair.target}
            onChange={(e) => pickTheirs(e.target.value)}
            disabled={disabled}
            {...targetMenu.selectProps}
          >
            {inSelect && <option value={DETECT}>{t('fork.languageMenu.detect')}</option>}
            {options(targetOptions)}
          </select>
          {targetMenu.list}
        </div>
      </div>
      {resolved?.showMirror && !inMirror && (
        <div className="language-mirror-line" data-testid="language-mirror-line">
          {t('settings.langSentence.mirror', 'They speak {{their}} → I read {{mine}}', {
            their: targetLanguageName,
            mine: sourceLanguageName,
          })}
        </div>
      )}
      {inMirror && (
        // Fork: the same sentence, with what they speak to choose: the pair's language, or whatever it turns out to be.
        <div className="language-mirror-line language-mirror-line--choice" data-testid="language-mirror-line">
          <label htmlFor={`${id}-theirs`}>{t('settings.langSentence.theySpeak', 'they speak')}</label>
          <select
            id={`${id}-theirs`}
            className="language-mirror-select"
            value={detecting ? DETECT : SAME}
            onChange={(e) => detect?.set(e.target.value === DETECT)}
            disabled={disabled}
          >
            <option value={SAME}>{targetLanguageName}</option>
            <option value={DETECT}>{t('fork.languageMenu.detect')}</option>
          </select>
          <span>{`→ ${t('settings.langSentence.iRead', 'I read')} ${sourceLanguageName}`}</span>
        </div>
      )}
    </div>
  );
}
