// Fork: what a device is shown of a hypothesis that may still rewrite itself.
import { describe, expect, it } from 'vitest';
import { agreed } from './transcriber';

/** What a device would have been sent, hypothesis after hypothesis: each delta, as the transcriber makes them. */
function shown(hypotheses: readonly string[]): string[] {
  const deltas: string[] = [];
  let sent = '';
  let last = '';
  for (const text of hypotheses) {
    const settled = agreed(last, text);
    last = text;
    if (!settled.startsWith(sent) || settled === sent) continue;
    deltas.push(settled.slice(sent.length));
    sent = settled;
  }
  return deltas;
}

describe('what two hypotheses in a row agree on', () => {
  it('is what they have in common from the start, without the mark it ends with', () => {
    expect(agreed('', 'こんにちは。')).toBe('');
    expect(agreed('こんにちは。', 'こんにちは。今日は')).toBe('こんにちは');
    expect(agreed('Привет. Сегодня очень.', 'Привет. Сегодня очень хорошая погода.')).toBe('Привет. Сегодня очень');
    expect(agreed('今天天气', '今日天气')).toBe('今');
    expect(agreed('same', 'same')).toBe('same');
  });

  it('never ends on half a character', () => {
    // Two characters outside the basic plane that share their first unit.
    expect(agreed('𠮷野家', '𠮸野家')).toBe('');
    expect(agreed('a𠮷', 'a𠮷b')).toBe('a𠮷');
  });

  it('keeps a recognizer that rewrites the end of what it wrote live for the device', () => {
    // Qwen3-ASR in the native engine, read again as the stretch grows: each reading ends with a full stop the next takes back.
    expect(shown([
      'ゲームワールド行こうと。',
      'ゲームワールド行こうと思ってるんですけど。',
      'ゲームワールド行こうと思ってるんですけど、なんか一つ。',
      'ゲームワールド行こうと思ってるんですけど、なんか一つジェットスキーみたいな。',
    ])).toEqual(['ゲームワールド行こうと', '思ってるんですけど', '、なんか一つ']);
  });

  it('is one hypothesis behind for a recognizer that only ever adds', () => {
    expect(shown(['今天', '今天天气', '今天天气很', '今天天气很好'])).toEqual(['今天', '天气', '很']);
  });

  it('sends nothing more once what was sent is written otherwise: the final carries the whole', () => {
    expect(shown(['Привет.', 'Привет. Сегодня очень.', 'Привет. Сегодня очень холодно.', 'Привет, сегодня очень хорошая погода.', 'Привет, сегодня очень хорошая погода. Я из'])).toEqual(['Привет', '. Сегодня очень']);
  });
});
