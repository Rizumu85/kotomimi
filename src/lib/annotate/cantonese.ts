/**
 * Fork: Cantonese with Jyutping over each Han character, tones as digits (nei5 sik6 zo2). The whole line is read at
 * once, so a character of several readings takes the one its words give it (銀行 ngan4 hong4, 行街 haang4 gaai1).
 * Its dictionary is CanCLID's `to-jyutping` (BSD-2-Clause), and reads both scripts: SenseVoice-Small writes
 * Cantonese in simplified characters, Qwen3-ASR in traditional ones. What is not a Han character stays as it is.
 */
import { getJyutpingList } from 'to-jyutping';
import { KANJI } from './script';
import type { RubyPart } from './types';

export function annotateCantonese(line: string): RubyPart[] {
  const parts: RubyPart[] = [];
  for (const [text, reading] of getJyutpingList(line)) {
    if (reading && KANJI.test(text)) {
      parts.push({ text, ruby: reading });
      continue;
    }
    // Runs of what is not Cantonese are kept as one part.
    const last = parts[parts.length - 1];
    if (last && last.ruby === undefined) last.text += text;
    else parts.push({ text });
  }
  return parts;
}
