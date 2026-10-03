/**
 * Fork: this build's own name. Kotomimi (ことみみ, 言葉 + 耳) is a fork of
 * Sokuji, and the catalogs, written upstream, say "Sokuji" in some thirty
 * strings of each of thirty languages. Rather than edit nine hundred lines
 * that every upstream release would conflict with, the name is put in where
 * a string is shown: an i18next post-processor rewrites the product's name
 * and nothing else.
 *
 * What keeps the upstream name, because it names a thing that is still
 * called that: the virtual audio devices (`Sokuji_Virtual_Speaker`, "Sokuji
 * Virtual Microphone", "Sokuji Virtual Audio"), and anything inside a URL,
 * a path or an identifier.
 */
export const BRAND = 'Kotomimi';

/** The product's name as a word of its own: not part of an identifier, a host or a path, and not the first word of a virtual device's name. */
const UPSTREAM_NAME = /(?<![\w.-])Sokuji(?![\w.-]| Virtual)/g;

/** A user-facing string with the product named as this build is. */
export function branded(text: string): string {
  return text.replace(UPSTREAM_NAME, BRAND);
}

/** `branded`, as i18next applies it to every string it hands out (`src/locales/index.ts`). */
export const brandPostProcessor = {
  type: 'postProcessor' as const,
  name: 'brand',
  process: (value: unknown) => (typeof value === 'string' ? branded(value) : value) as string,
};
