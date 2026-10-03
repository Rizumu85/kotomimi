import { describe, expect, it } from 'vitest';
import { englishLanguageName, languageLabel, uiLocale } from './label';

describe('uiLocale', () => {
  it("turns an i18next id into a BCP-47 locale, English when there is none", () => {
    expect(uiLocale('zh_TW')).toBe('zh-TW');
    expect(uiLocale('pt_BR')).toBe('pt-BR');
    expect(uiLocale('ja')).toBe('ja');
    expect(uiLocale(undefined)).toBe('en');
    expect(uiLocale('cimode')).toBe('en');
  });
});

describe('languageLabel', () => {
  // Never a pinned CLDR string: ICU differs between Node and Chromium versions.
  const named = (code: string, ui: string) => {
    const label = languageLabel(code, ui);
    expect(label, `${code} in ${ui}`).not.toBe('');
    expect(label, `${code} in ${ui}`).not.toBe(code);
    return label;
  };

  it('names a tag in the UI language', () => {
    for (const ui of ['en', 'ja', 'zh_CN', 'zh_TW', 'ko', 'es']) {
      named('zh-Hant', ui);
      named('yue', ui);
      named('mul', ui);
    }
  });

  // Fork: what the choice decides is the script, so the script is what it is called.
  it('names Chinese by how it is written, not by a region: Simplified and Traditional', () => {
    for (const ui of ['en', 'ja', 'zh_CN', 'zh_TW', 'ko', 'es']) {
      expect(named('zh-CN', ui)).toBe(named('zh-Hans', ui));
      expect(named('zh-TW', ui)).toBe(named('zh-Hant', ui));
      expect(named('zh-CN', ui)).not.toBe(named('zh-TW', ui));
      // Chinese with no script named, and other regions, are left as they are.
      expect(named('zh', ui)).not.toBe(named('zh-CN', ui));
      expect(named('zh-HK', ui)).not.toBe(named('zh-TW', ui));
    }
    expect(languageLabel('zh-CN', 'en')).not.toMatch(/China/);
    expect(languageLabel('zh-TW', 'en')).not.toMatch(/Taiwan/);
  });

  it('follows the UI language', () => {
    expect(languageLabel('ja', 'en')).not.toBe(languageLabel('ja', 'zh_CN'));
  });

  it('starts with a capital in the UI language', () => {
    const es = languageLabel('es', 'es');
    expect(es[0]).toBe(es[0].toLocaleUpperCase('es'));
  });

  it("names auto with the caller's words, and a pair as A ⇄ B", () => {
    expect(languageLabel('auto', 'en', 'Auto Detect')).toBe('Auto Detect');
    expect(languageLabel('zh+en', 'en')).toBe(`${languageLabel('zh', 'en')} ⇄ ${languageLabel('en', 'en')}`);
  });

  it('falls back to the code for anything it cannot name', () => {
    expect(languageLabel('zh_CN', 'en')).toBe('zh_CN');
    expect(languageLabel('', 'en')).toBe('');
  });

  it('names in English for the instructions', () => {
    expect(englishLanguageName('ja')).toBe(languageLabel('ja', 'en'));
    // Fork: a model's instructions keep CLDR's own names; only what a person reads is named by script.
    expect(englishLanguageName('zh-CN')).not.toBe(languageLabel('zh-CN', 'en'));
    expect(englishLanguageName('zh-CN')).toMatch(/China/);
  });
});
