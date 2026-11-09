/**
 * Fork: the other side's language lit beside their main one (`MoreLanguages.lit`): heard as well, and the user's speech
 * translated into it too. Undefined where none is lit, or it is "any language" (no language to name).
 */
import { useProviderStore } from '../stores/providerStore';
import { getProvider } from '../providers/registry';

export function litLanguageOf(state: ReturnType<typeof useProviderStore.getState>): string | undefined {
  const { selected, entries, models } = state;
  const entry = selected ? entries[selected] : undefined;
  const provider = selected ? getProvider(selected) : undefined;
  if (!entry || !provider) return undefined;
  const lit = provider.languages.more?.(entry.settings, models[selected!] ?? [], entry.pair).theirs?.lit;
  return lit && lit !== 'auto' ? lit : undefined;
}

export function useLitLanguage(): string | undefined {
  return useProviderStore(litLanguageOf);
}
