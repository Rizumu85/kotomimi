import { romanize, standardizePronunciation } from 'es-hangul';

const SYLLABLE = /[가-힣]/;

/**
 * Korean in Latin letters: Revised Romanization, by pronunciation (백마 → baeng-ma), not letter by letter. Syllable by
 * syllable as said, one to each block of the line above, joined by the system's own hyphen: run together, gangaji and
 * hangugeo left it to the reader whether ng ends a syllable, or n ends one and g begins the next (the user, 2026-10-31).
 * What is not Hangul is kept.
 */
export function romanizeKorean(text: string): string {
  const said = [...standardizePronunciation(text, { hardConversion: false })];
  let before = '';
  return said.map((block) => {
    if (!SYLLABLE.test(block)) { before = ''; return block; }
    const alone = romanize(block);
    // ㄹㄹ is ll: a syllable alone begins with r.
    const syllable = before.endsWith('l') && alone.startsWith('r') ? `l${alone.slice(1)}` : alone;
    const joined = before ? `-${syllable}` : syllable;
    before = alone;
    return joined;
  }).join('');
}
