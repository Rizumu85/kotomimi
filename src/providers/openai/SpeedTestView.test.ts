import { describe, expect, it } from 'vitest';
import { dateOf } from './SpeedTestView';

describe('dateOf', () => {
  it('reads a catalog name as a language tag, and falls back on one Intl refuses', () => {
    const at = Date.UTC(2026, 9, 24, 6, 30);
    expect(() => dateOf(at, 'zh_CN')).not.toThrow();
    expect(dateOf(at, 'zh_CN')).toBe(new Date(at).toLocaleString('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
    expect(() => dateOf(at, 'not a tag!')).not.toThrow();
  });
});
