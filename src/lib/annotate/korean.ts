import { romanize } from 'es-hangul';

/** Korean in Latin letters: Revised Romanization, by pronunciation (백마 → baengma), not letter by letter. What is not Hangul is kept. */
export function romanizeKorean(text: string): string {
  return romanize(text);
}
