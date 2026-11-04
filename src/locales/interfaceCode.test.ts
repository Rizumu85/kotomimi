import { describe, expect, it } from 'vitest';
import { interfaceCodeOf } from './index';

describe('the interface language of a system language (fork)', () => {
  it('is the catalog of the region where there is one', () => {
    expect(interfaceCodeOf('zh-CN')).toBe('zh_CN');
    expect(interfaceCodeOf('zh-TW')).toBe('zh_TW');
    expect(interfaceCodeOf('zh-HK')).toBe('zh_TW');
    expect(interfaceCodeOf('zh-Hant-TW')).toBe('zh_TW');
    expect(interfaceCodeOf('zh')).toBe('zh_CN');
    expect(interfaceCodeOf('pt-PT')).toBe('pt_PT');
    expect(interfaceCodeOf('pt-BR')).toBe('pt_BR');
    expect(interfaceCodeOf('pt')).toBe('pt_BR');
  });

  it('is the language alone otherwise, old codes mended', () => {
    expect(interfaceCodeOf('ja-JP')).toBe('ja');
    expect(interfaceCodeOf('en-US')).toBe('en');
    expect(interfaceCodeOf('tl-PH')).toBe('fil');
    expect(interfaceCodeOf('iw')).toBe('he');
  });
});
