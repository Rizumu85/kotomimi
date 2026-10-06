import { useAnalytics } from '../../lib/analytics';
import type { AnyProvider } from '../../lib/provider/types';
import { languageContext } from '../../lib/session/shape';
import type { AudioMode } from '../../stores/audioStore';
import { useProviderStore } from '../../stores/providerStore';
import { LanguagePairSection } from './LanguagePairSection';
import { useSelectedProvider } from './useSelectedProvider';

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
  if (!selection?.entry) return null;
  const { provider, entry } = selection;
  const { setPair, updateSettings } = useProviderStore.getState();
  // Fork: the Kotomimi provider's pair is the user's language and the other side's, named so; and the other side's
  // can be left to be detected — a choice of their language, made while they are heard at all. Where what hears
  // cannot tell languages apart the choice stays and the pair's language is the one heard (`detectsOther`).
  const kotomimi = (provider.id as string) === 'localai';
  const detect = kotomimi && legs.includes('participant')
    ? { on: (entry.settings as { asrDetectOther?: boolean }).asrDetectOther === true, set: (on: boolean) => updateSettings(provider, { asrDetectOther: on }) }
    : undefined;

  return (
    <LanguagePairSection
      provider={provider}
      settings={entry.settings}
      pair={entry.pair}
      disabled={disabled}
      sentence={sentence}
      context={languageContext(provider, legs, speech)}
      detect={detect}
      owners={kotomimi}
      onChange={(pair) => {
        if (pair.source !== entry.pair.source) trackEvent('language_changed', { to_language: pair.source, language_type: 'source' });
        if (pair.target !== entry.pair.target) trackEvent('language_changed', { to_language: pair.target, language_type: 'target' });
        setPair(provider, pair);
      }}
    />
  );
}
