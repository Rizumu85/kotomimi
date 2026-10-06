import { useTranslation } from 'react-i18next';
import { useAnalytics } from '../../lib/analytics';
import { useLanguageLabel } from '../../lib/language/useLanguageLabel';
import type { AnyProvider } from '../../lib/provider/types';
import { languageContext } from '../../lib/session/shape';
import type { AudioMode } from '../../stores/audioStore';
import { useProviderStore } from '../../stores/providerStore';
import { LanguagePairSection } from './LanguagePairSection';
import { useSelectedProvider } from './useSelectedProvider';
import { canDetectOther } from '../../providers/openai/localaiDevice';

interface ProviderLanguagesProps {
  providers: readonly AnyProvider[];
  /** A run is not idle: both selects and the swap are locked. */
  disabled?: boolean;
  /** The language pair's sentence (ruling 4); the app passes it, the preview does not. */
  sentence?: { mode: AudioMode; textOnly: boolean };
}

/**
 * The selected provider's language pair, offered for the language context
 * the store holds — its legs and whether they speak (Stage 2 Volcengine
 * AST2, choice 1). Tracks each side that changed with today's
 * `language_changed` (ruling 14) before persisting the new pair.
 */
export function ProviderLanguages({ providers, disabled, sentence }: ProviderLanguagesProps) {
  const { trackEvent } = useAnalytics();
  const selection = useSelectedProvider(providers);
  const legs = useProviderStore((st) => st.legs);
  const speech = useProviderStore((st) => st.speech);
  const { t } = useTranslation();
  const label = useLanguageLabel();
  if (!selection?.entry) return null;
  const { provider, entry } = selection;
  const { setPair, updateSettings } = useProviderStore.getState();
  // Fork: the Kotomimi provider can leave the other side's language to be detected — a choice of their language, made
  // while they are heard at all. Where what hears cannot tell languages apart the choice stays, and the lines under
  // the pair say that the pair's language is assumed meanwhile.
  const kotomimi = (provider.id as string) === 'localai' ? (entry.settings as { asrDetectOther?: boolean; coach?: boolean; asrVia: string }) : null;
  const hearsThem = legs.includes('participant');
  const chosen = kotomimi?.asrDetectOther === true;
  const detect = kotomimi && hearsThem
    ? { on: chosen, set: (on: boolean) => updateSettings(provider, { asrDetectOther: on }) }
    : undefined;
  const detected = Boolean(detect) && chosen && canDetectOther(kotomimi as never, selection.models ?? []);
  // What this run does with the pair, a line for each side heard.
  const names = { mine: label(entry.pair.source), their: label(entry.pair.target) };
  const summary = kotomimi ? [
    ...(hearsThem ? [t(detected ? 'fork.languageMenu.sumTheirsAny' : 'fork.languageMenu.sumTheirs', names)] : []),
    ...(legs.includes('speaker') ? [t(kotomimi.coach ? 'fork.languageMenu.sumCoach' : 'fork.languageMenu.sumMine', names)] : []),
    // Chosen, and what hears cannot: said with what would make it possible, there where it hears.
    ...(detect && chosen && !detected ? [t(kotomimi.asrVia === 'server' ? 'fork.languageMenu.detectUnableServer' : 'fork.languageMenu.detectUnable', names)] : []),
  ] : undefined;

  return (
    <LanguagePairSection
      provider={provider}
      settings={entry.settings}
      pair={entry.pair}
      disabled={disabled}
      sentence={sentence}
      context={languageContext(provider, legs, speech)}
      detect={detect}
      summary={summary}
      onChange={(pair) => {
        if (pair.source !== entry.pair.source) trackEvent('language_changed', { to_language: pair.source, language_type: 'source' });
        if (pair.target !== entry.pair.target) trackEvent('language_changed', { to_language: pair.target, language_type: 'target' });
        setPair(provider, pair);
      }}
    />
  );
}
