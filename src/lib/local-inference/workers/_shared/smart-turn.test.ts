import { describe, expect, it } from 'vitest';
import { turnFeatures, TURN_BANDS, TURN_FRAMES, TURN_RATE } from './smart-turn';

describe('the sound Smart Turn is given (fork)', () => {
  // One second of two tones after seven of silence, and what Whisper's reference extractor (transformers'
  // WhisperFeatureExtractor, chunk_length 8, do_normalize) makes of it, at a few places.
  const tones = Float32Array.from({ length: TURN_RATE }, (_, n) => Math.fround(0.3 * Math.sin((2 * Math.PI * 440 * n) / TURN_RATE) + 0.1 * Math.sin((2 * Math.PI * 3000 * n) / TURN_RATE)));
  const REFERENCE: [band: number, frame: number, value: number][] = [
    [0, 0, -0.1217], [10, 750, 1.7888], [20, 750, -0.1217], [47, 750, -0.1217], [79, 750, -0.1217], [10, 699, 0.7997], [10, 700, 1.7083], [30, 799, 0.5078],
  ];

  it('is the reference extractor\'s features of the last eight seconds, silence before a shorter sound', () => {
    const features = turnFeatures(tones);
    expect(features).toHaveLength(TURN_BANDS * TURN_FRAMES);
    for (const [band, frame, value] of REFERENCE) expect(features[band * TURN_FRAMES + frame]).toBeCloseTo(value, 3);
  });

  it('keeps the end of a longer sound', () => {
    const long = new Float32Array(10 * TURN_RATE);
    long.set(tones, 9 * TURN_RATE);
    const features = turnFeatures(long);
    for (const [band, frame, value] of REFERENCE) expect(features[band * TURN_FRAMES + frame]).toBeCloseTo(value, 3);
  });
});
