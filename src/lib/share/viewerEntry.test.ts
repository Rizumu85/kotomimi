// src/lib/share/viewerEntry.test.ts
import { describe, it, expect } from 'vitest';
import type { Entry } from '../projection/types';
import { toViewerEntry } from './viewerEntry';

const row = (key: string, text: string, final: boolean) => ({
  key, segmentId: key.slice(0, key.lastIndexOf(':')), side: 'source' as const, start: 0, end: text.length, text, final, language: 'ja',
});

describe('toViewerEntry', () => {
  it('keeps what a viewer reads and nothing else', () => {
    const entry: Entry = {
      kind: 'exchange', id: 'speaker:s:r1:speaker:1', leg: 'speaker', languages: { source: 'ja', target: 'zh-CN' },
      pairing: 'stated', t: 1000,
      source: [row('r1:speaker:1:0', 'こんにちは', true)],
      translation: [{ ...row('r1:speaker:2:0', '你好', false), side: 'translation' }],
    };
    expect(toViewerEntry(entry)).toEqual({
      id: 'speaker:s:r1:speaker:1', leg: 'speaker', t: 1000, languages: { source: 'ja', target: 'zh-CN' },
      source: [{ key: 'r1:speaker:1:0', text: 'こんにちは', final: true }],
      translation: [{ key: 'r1:speaker:2:0', text: '你好', final: false }],
    });
  });

  it('leaves notices with the host', () => {
    const notice: Entry = { kind: 'notice', id: 'speaker:n:1', leg: 'speaker', severity: 'error', message: 'x', at: 1 };
    expect(toViewerEntry(notice)).toBeNull();
  });

  it('keeps a combined translation visible while withholding explicit and legacy feedback', () => {
    const entry: Entry = {
      kind: 'exchange', id: 'both', leg: 'speaker', languages: { source: 'en', target: 'fr' }, pairing: 'stated', t: 0,
      source: [row('source:0', 'Je suis ici', true)],
      translation: [{ ...row('translation:0', 'I am here', true), side: 'translation', purpose: 'translation' }],
      feedback: [{ ...row('feedback:0', 'Private grammar explanation', true), side: 'translation', purpose: 'feedback' }],
    };
    expect(toViewerEntry(entry, true)?.translation).toEqual([{ key: 'translation:0', text: 'I am here', final: true }]);
    expect(JSON.stringify(toViewerEntry(entry, true))).not.toContain('Private grammar explanation');
    expect(toViewerEntry({ ...entry, translation: [{ ...row('legacy:0', 'Legacy feedback', true), side: 'translation' }] }, true)?.translation).toEqual([]);
  });
});
