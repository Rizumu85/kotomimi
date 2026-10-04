/**
 * Fork: whether the provider chosen is the managed one — the only one an
 * account is for. A hook of its own, as `useBalanceShortfall` is: the lookup
 * reaches the registry, which the account button's tests do not load.
 */
import { selectedFromStores } from '../../lib/session/appShape';
import { useProviderStore } from '../../stores/providerStore';

export function useManagedSelected(): boolean {
  // Subscribed to what the provider lookup reads, so the answer follows a selection or a load.
  useProviderStore((s) => s.selected);
  useProviderStore((s) => s.entries);
  return selectedFromStores()?.provider.kind === 'managed';
}
