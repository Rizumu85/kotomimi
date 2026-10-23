import { create } from 'zustand';

/**
 * Fork: whether what answers the user's own sentences is grammar feedback — the Kotomimi provider with its feedback
 * switched on, which coaches the speaker. Kept from the provider store (`watchCoachingFromStores`), so that what
 * draws a conversation reads one boolean, not the provider store and all it brings with it.
 */
export const useCoachingStore = create<{ coached: boolean }>(() => ({ coached: false }));
