import { describe, it, expect } from 'vitest';
import { farFromModels } from './farSource';

describe('where the app\'s own models are not reached', () => {
  it('is told by the time zone the computer keeps: mainland China, and nowhere else', () => {
    expect(farFromModels('Asia/Shanghai')).toBe(true);
    expect(farFromModels('Asia/Urumqi')).toBe(true);
    // Hugging Face is reached from these.
    expect(farFromModels('Asia/Hong_Kong')).toBe(false);
    expect(farFromModels('Asia/Taipei')).toBe(false);
    expect(farFromModels('Asia/Tokyo')).toBe(false);
    expect(farFromModels('America/New_York')).toBe(false);
  });

  it('says nothing where the zone is not known', () => {
    expect(farFromModels(undefined)).toBe(false);
    expect(farFromModels('')).toBe(false);
  });
});
