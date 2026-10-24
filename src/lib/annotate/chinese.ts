/**
 * Chinese with pinyin over each Han character, in tone marks — as upstream
 * draws it (kizuna-ai-lab/sokuji#632). The whole line is read at once so a
 * character of several readings takes the one its words give it (银行 yín háng,
 * 行走 xíng zǒu); tone changes in speech (一下 yí xià) are kept, since that is
 * how the line is said. What is not a Han character stays as it is.
 */
import { pinyin } from 'pinyin-pro';
import type { RubyPart } from './types';

export function annotateChinese(line: string): RubyPart[] {
  const parts: RubyPart[] = [];
  for (const item of pinyin(line, { type: 'all' })) {
    if (item.isZh && item.pinyin) {
      parts.push({ text: item.origin, ruby: item.pinyin });
      continue;
    }
    // Runs of what is not Chinese are kept as one part.
    const last = parts[parts.length - 1];
    if (last && last.ruby === undefined) last.text += item.origin;
    else parts.push({ text: item.origin });
  }
  return parts;
}
