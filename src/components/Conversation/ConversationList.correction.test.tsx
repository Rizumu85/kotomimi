import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import type { Row } from '../../lib/projection/types';
import type { DisplayItem } from '../../lib/view/filter';
import { ConversationList } from './ConversationList';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }),
}));

const ANSWER = 'I went to school yesterday.\nPast tense.';
const answerRow = (over: Partial<Row> = {}): Row => ({
  key: 'a:0', segmentId: 'a', side: 'translation', start: 0, end: ANSWER.length, text: ANSWER, final: true, language: 'en', ...over,
});
const item = (row: Row, answers?: { said: string; saidLanguage?: string; answer: string }): DisplayItem => ({
  kind: 'row', row, leg: 'speaker', languages: { source: 'en', target: 'ja' }, t: 0, header: false, endsSegment: true, ...(answers ? { answers } : {}),
});
const draw = (items: DisplayItem[]) =>
  render(<ConversationList items={items} lit={new Map()} replaying={null} replayLegs={new Set()} canReplay={() => false} onReplay={() => {}} compact={false} fontSize={14} empty="" />).container;

// Fork: grammar feedback that changes something is drawn as the sentence said, marked (the user, 2026-10-23).
describe('ConversationList — grammar feedback', () => {
  it('draws the answer as the sentence said with what goes struck and what comes written in, and the reason under it', () => {
    const container = draw([item(answerRow(), { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER })]);
    expect(container.querySelector('.kt-fix__gone')?.textContent).toBe('goes');
    expect(container.querySelector('.kt-fix__added')?.textContent).toBe('went');
    expect(container.querySelector('.kt-fix__why')?.textContent).toBe('Past tense.');
  });

  it('draws the answer as written where it is a translation, in another language than the sentence', () => {
    const container = draw([item(answerRow({ text: '昨日学校に行きました。', language: 'ja' }), { said: 'I went to school yesterday.', saidLanguage: 'en', answer: '昨日学校に行きました。' })]);
    expect(container.querySelector('.kt-fix')).toBeNull();
    expect(container.querySelector('.row-text.tr')?.textContent).toBe('昨日学校に行きました。');
  });

  it('draws nothing more for the answer’s later rows, which the marked sentence already holds', () => {
    const answers = { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER };
    const container = draw([
      item(answerRow({ key: 'a:0', end: 28, text: 'I went to school yesterday.\n' }), answers),
      item(answerRow({ key: 'a:1', start: 28, text: 'Past tense.' }), answers),
    ]);
    expect(container.querySelectorAll('.conversation-row')).toHaveLength(1);
  });
});
