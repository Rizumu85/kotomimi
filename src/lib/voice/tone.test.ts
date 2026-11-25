import { describe, expect, it } from 'vitest';
import { toneOf } from './tone';

describe('the tone a sentence takes from its recording', () => {
  it.each([
    ['laugh', '哈哈，鞋穿反了。', 'My shoes are on the wrong feet.'],
    ['laugh', 'The stamp is upside down.', 'はんこが逆だったｗｗｗ'],
    ['laugh', 'That was my alarm 😂', ''],
    ['laugh', '이번엔 내 양말이네 ㅋㅋ', ''],
    ['laugh', 'また同じ席、草。', ''],
    ['laugh', 'Lol, the timer was for my tea.', ''],
    ['angry', '气死我了！', 'I missed the bus!'],
    ['angry', 'ふざけないで！', ''],
    ['angry', '아, 짜증 나.', ''],
    ['angry', 'Can you shut up for a minute?', ''],
    ['gentle', '辛苦了！', 'You worked hard!'],
    ['gentle', 'I left you some tea.', 'お疲れさま。お茶をどうぞ。'],
    ['gentle', '괜찮아, 내일 다시 해 보자.', ''],
    ['gentle', 'Take care on your way home.', ''],
    ['lively', '好耶，赶上末班车了。', ''],
    ['lively', 'やった、席が空いてる。', ''],
    ['lively', '내일 소풍이라 신난다.', ''],
    ['lively', 'The parcel is here!', ''],
    ['serious', '关门前必须拔掉插头。', ''],
    ['serious', '小心，危险！', ''],
    ['serious', '', 'Warning! Be careful!'],
    ['serious', '足元に注意してね。', ''],
    ['serious', '계단에서는 조심하세요.', ''],
    ['serious', 'The bottom step is loose.', 'Be careful on the stairs.'],
    ['angry', 'Verdammt, der Bus ist weg.', ''],
    ['gentle', 'Merci pour le thé.', ''],
    ['serious', 'Осторожно, ступенька скользкая.', ''],
    ['gentle', 'Boa noite, até amanhã.', ''],
    ['gentle', 'Gracias por la taza.', ''],
    ['lively', 'Evviva, il pacco è qui.', ''],
    ['', 'I put mustard in the sandwiches.', 'サンドイッチにマスタードを入れた。'],
    ['', 'The address is www.example.com.', '鉢に生えたのは雑草。'],
  ])('%s for "%s" / "%s"', (tone, said, translated) => {
    expect(toneOf(said, translated)).toBe(tone);
  });

  it('gives the same precedence to cues in the words said and in the translation', () => {
    for (const [first, second, tone] of [
      ['Damn!', '哈哈，是我按的。', 'laugh'],
      ['Thanks for looking.', '可恶，又找错了。', 'angry'],
      ['Sorry about the wait.', 'やった！', 'gentle'],
      ['The gate is open!', '足元に注意して。', 'serious'],
      ['Yay, the gate is open!', '足元に注意して。', 'lively'],
    ]) {
      expect(toneOf(first, second)).toBe(tone);
      expect(toneOf(second, first)).toBe(tone);
    }
  });
});
