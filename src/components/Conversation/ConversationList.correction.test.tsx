import { useCoachingStore } from '../../stores/coachingStore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
const item = (row: Row, answers?: { said: string; saidLanguage?: string; answer: string }): Extract<DisplayItem, { kind: 'row' }> => ({
  kind: 'row', row, leg: 'speaker', languages: { source: 'ja', target: 'en' }, t: 0, header: false, endsSegment: true, ...(answers ? { answers } : {}),
});
const draw = (items: DisplayItem[]) =>
  render(<ConversationList items={items} lit={new Map()} replaying={null} replayLegs={new Set()} canReplay={() => false} onReplay={() => {}} compact={false} fontSize={14} empty="" />).container;

// Fork: grammar feedback that changes something is drawn as the sentence said, marked (the user, 2026-10-23).
describe('ConversationList — grammar feedback', () => {
  beforeEach(() => useCoachingStore.setState({ coached: true }));
  it('draws the answer as the sentence said with what goes struck and what comes written in, and the reason under it', () => {
    const container = draw([item(answerRow(), { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER })]);
    expect(container.querySelector('.kt-fix__gone')?.textContent).toBe('goes');
    expect(container.querySelector('.kt-fix__added')?.textContent).toBe('went');
    expect(container.querySelector('.kt-fix__why')?.textContent).toBe('Past tense.');
  });

  it('draws the answer as written where the leg is not coached: the other side’s translation', () => {
    const container = draw([{ ...item(answerRow({ text: 'I went to school yesterday.', language: 'en' }), { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: 'I went to school yesterday.' }), leg: 'participant' } as DisplayItem]);
    expect(container.querySelector('.kt-fix')).toBeNull();
    expect(container.querySelector('.row-text.tr')?.textContent).toBe('I went to school yesterday.');
  });

  it('draws nothing more for the answer’s later rows, which the marked sentence already holds', () => {
    const answers = { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER };
    const container = draw([
      item(answerRow({ key: 'a:0', end: 28, text: 'I went to school yesterday.\n' }), answers),
      item(answerRow({ key: 'a:1', start: 28, text: 'Past tense.' }), answers),
    ]);
    expect(container.querySelectorAll('.conversation-row')).toHaveLength(1);
  });

  it('shows a native-language sentence as a translation while coaching is enabled', () => {
    const answer = 'Le restaurant est excellent.';
    const container = draw([{ ...item(answerRow({ text: answer, language: 'fr' }), {
      said: 'The restaurant is excellent.', saidLanguage: 'en', answer,
    }), languages: { source: 'en', target: 'fr' } }]);
    expect(container.querySelector('.kt-fix')).toBeNull();
    expect(container.querySelector('.row-text.tr')?.textContent).toBe(answer);
  });

  it('keeps a practice correction when the answer is labelled with the explanation language', () => {
    const container = draw([{ ...item(answerRow({ language: 'fr' }), { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER }), languages: { source: 'fr', target: 'en' } }]);
    expect(container.querySelector('.kt-fix__gone')?.textContent).toBe('goes');
  });

  it('draws explicit feedback separately and never marks an explicit translation as a correction', () => {
    const answers = { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER };
    const container = draw([
      item(answerRow({ key: 'translation:0', segmentId: 'translation', purpose: 'translation' }), answers),
      item(answerRow({ key: 'feedback:0', segmentId: 'feedback', purpose: 'feedback', language: 'ja' }), answers),
    ]);
    expect(container.querySelector('[data-purpose="translation"] .kt-fix')).toBeNull();
    expect(container.querySelector('[data-purpose="translation"] .row-text')?.textContent).toBe(ANSWER);
    expect(container.querySelector('[data-purpose="feedback"] .kt-fix__gone')?.textContent).toBe('goes');
    expect(container.querySelector('[data-purpose="feedback"] .kt-fix__added')?.textContent).toBe('went');
    expect(container.querySelectorAll('.conversation-row')).toHaveLength(2);
  });

  it('keeps saved explicit feedback recognizable when coaching is currently disabled', () => {
    useCoachingStore.setState({ coached: false });
    const container = draw([item(answerRow({ purpose: 'feedback', language: 'ja' }), { said: 'I goes to school yesterday.', saidLanguage: 'en', answer: ANSWER })]);
    expect(container.querySelector('.kt-fix__gone')?.textContent).toBe('goes');
  });
});
