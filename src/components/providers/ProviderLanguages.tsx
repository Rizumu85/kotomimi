import { useAnalytics } from '../../lib/analytics';
import type { AnyProvider, LanguagePair } from '../../lib/provider/types';
import { languageContext } from '../../lib/session/shape';
import type { AudioMode } from '../../stores/audioStore';
import { useNativeEngineStore } from '../../stores/nativeEngineStore';
import { useProviderStore } from '../../stores/providerStore';
import { LanguagePairSection } from './LanguagePairSection';
import { useSelectedProvider } from './useSelectedProvider';
import { useSettingsStore } from '../../stores/settingsStore';

interface ProviderLanguagesProps {
  providers: readonly AnyProvider[];
  /** Both selects and the swap are locked: a run is starting or stopping (a running one goes on in a new pair). */
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
/** A pair of two languages: one of one (Chinese to Chinese, to hear someone more clearly) has no other to speak. */
const pairDiffers = (pair: LanguagePair): boolean => pair.source.toLowerCase() !== pair.target.toLowerCase();

export function ProviderLanguages({ providers, disabled, sentence }: ProviderLanguagesProps) {
  const { trackEvent } = useAnalytics();
  const selection = useSelectedProvider(providers);
  const legs = useProviderStore((st) => st.legs);
  const speech = useProviderStore((st) => st.speech);
  // Read only to draw again when a recognizer downloads: whether a language can be detected may depend on it.
  useNativeEngineStore((st) => st.status);
  if (!selection?.entry) return null;
  const { provider, entry } = selection;
  const { setPair, updateSettings } = useProviderStore.getState();
  // Fork: the Kotomimi provider's pair is the user's language and the other side's, named so; and each side may speak
  // more than its main language where what hears it can tell them apart (`languages.more`): the user's own other
  // languages while they are heard, and the other side's while they are heard or translated into.
  const kotomimi = (provider.id as string) === 'localai';
  const more = provider.languages.more?.(entry.settings, selection.models, entry.pair);
  const bound = (side: NonNullable<typeof more>['mine']) => side && { ...side, set: (chosen: string[]) => updateSettings(provider, side.set(chosen)) };
  const mine = legs.includes('speaker') && pairDiffers(entry.pair) ? bound(more?.mine) : undefined;
  // Fork: the other side's languages switched by hand ("对方说"): a press writes their main one — the pair's target —
  // and the provider's row and light together.
  const side = more?.theirs;
  const theirs = side?.light ? {
    ...(side.hearer ? { hearer: side.hearer } : {}),
    main: entry.pair.target,
    row: side.chosen,
    lit: side.lit ?? '',
    two: side.most !== 0,
    any: side.any,
    apply: (next: { main: string; row: readonly string[]; lit: string }) => {
      if (next.main !== entry.pair.target) {
        trackEvent('language_changed', { to_language: next.main, language_type: 'target' });
        setPair(provider, { source: entry.pair.source, target: next.main });
      }
      updateSettings(provider, { ...side.set(next.row), ...side.light!(next.lit) });
    },
  } : undefined;

  return (
    <LanguagePairSection
      provider={provider}
      settings={entry.settings}
      pair={entry.pair}
      disabled={disabled}
      sentence={sentence}
      context={languageContext(provider, legs, speech)}
      {...(mine ? { more: { mine } } : {})}
      {...(theirs ? { theirs } : {})}
      onOpenHearing={() => useSettingsStore.getState().navigateToSettings('hearing')}
      owners={kotomimi}
      onChange={(pair) => {
        if (pair.source !== entry.pair.source) trackEvent('language_changed', { to_language: pair.source, language_type: 'source' });
        if (pair.target !== entry.pair.target) trackEvent('language_changed', { to_language: pair.target, language_type: 'target' });
        setPair(provider, pair);
      }}
    />
  );
}
