import { describe, expect, it } from 'vitest';
import { BRAND, branded, brandPostProcessor } from './brand';

describe('the build\'s own name in user-facing text', () => {
  it('replaces the product\'s name where it stands as a word of its own', () => {
    expect(BRAND).toBe('Kotomimi');
    expect(branded('Set up Sokuji')).toBe('Set up Kotomimi');
    expect(branded("Sokuji's menus and buttons")).toBe("Kotomimi's menus and buttons");
    expect(branded('Sokuji 用什么语言和你交流？')).toBe('Kotomimi 用什么语言和你交流？');
    expect(branded('设置 Sokuji')).toBe('设置 Kotomimi');
    expect(branded('Sokuji, Kizuna AI, PulseAudio')).toBe('Kotomimi, Kizuna AI, PulseAudio');
  });

  it('keeps the name of what is still called that: the virtual audio devices, and anything inside an identifier, a host or a path', () => {
    for (const kept of [
      'The Sokuji_Virtual_Speaker is used for output',
      'choose "Sokuji Virtual Microphone" as your microphone',
      'Sokuji Virtual Audio driver',
      'SokujiVirtualAudio.driver',
      'https://sokuji.kizuna.ai/docs',
      'github.com/kizuna-ai-lab/Sokuji-notes',
    ]) expect(branded(kept), kept).toBe(kept);
    // Both in one string: the product renamed, its device not.
    expect(branded('The Sokuji_Virtual_Speaker is used by Sokuji to output audio')).toBe('The Sokuji_Virtual_Speaker is used by Kotomimi to output audio');
  });

  it('is an i18next post-processor that leaves what is not a string alone', () => {
    expect(brandPostProcessor).toMatchObject({ type: 'postProcessor', name: 'brand' });
    expect(brandPostProcessor.process('About Sokuji')).toBe('About Kotomimi');
    expect(brandPostProcessor.process(42)).toBe(42);
  });
});
