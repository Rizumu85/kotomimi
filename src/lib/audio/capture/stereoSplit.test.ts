import { describe, expect, it } from 'vitest';
import { createParticipantSplit, createVideoJudge, type Hearing } from './stereoSplit';

const RATE = 24000;
const tone = (length: number, hz: number, amp: number, from = 0) =>
  Int16Array.from({ length }, (_, i) => Math.round(amp * Math.sin((2 * Math.PI * hz * (from + i)) / RATE)));
const add = (a: Int16Array, b: Int16Array) => a.map((v, i) => v + b[i]);
const avg = (a: Int16Array, b: Int16Array) => a.map((v, i) => (v + b[i]) >> 1);
const rms = (a: Int16Array, skip = 0) => {
  let sum = 0;
  for (let i = skip; i < a.length; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (a.length - skip));
};
/** Feeds `seconds` of left/right in chunks of 4096; returns what the leg heard, what was shared, and the hearings. */
function run(split = createParticipantSplit(RATE), left: Int16Array, right: Int16Array, shared = false) {
  const heard: number[] = [];
  const both: number[] = [];
  const hearings: Hearing[] = [];
  const offs = [split.onHearing((h) => hearings.push(h))];
  if (shared) offs.push(split.onShared((pcm) => both.push(...pcm)));
  for (let at = 0; at + 4096 <= left.length; at += 4096) {
    const l = left.slice(at, at + 4096), r = right.slice(at, at + 4096);
    heard.push(...split.take({ mono: avg(l, r), left: l, right: r }));
  }
  offs.forEach((off) => off());
  return { heard: Int16Array.from(heard), shared: Int16Array.from(both), hearings };
}

describe('the participant split', () => {
  it('passes a chunk with one channel as it is', () => {
    const split = createParticipantSplit(RATE);
    split.setMode('people');
    const mono = tone(4096, 300, 5000);
    expect(split.take({ mono })).toBe(mono);
  });

  it('hears the average as usual, and left minus right for people: a sound the same in both is gone', () => {
    const video = tone(RATE * 2, 300, 8000);
    const voice = tone(RATE * 2, 700, 6000);
    const left = add(video, voice);
    const right = video;
    const split = createParticipantSplit(RATE);
    expect(rms(run(split, left, right).heard)).toBeGreaterThan(5000);
    split.setMode('people');
    const people = run(split, left, right).heard;
    // Only the voice is left: as loud as it is in the left channel.
    expect(rms(people)).toBeCloseTo(rms(voice.slice(0, people.length)), -2);
    expect(split.mode()).toBe('people');
  });

  it('says every half second how loud the average, the difference and what is shared are', () => {
    const video = tone(RATE * 2, 300, 8000);
    const { hearings } = run(createParticipantSplit(RATE), video, video);
    expect(hearings).toHaveLength(3);
    for (const h of hearings) {
      expect(h.side).toBe(-120);
      expect(h.mid).toBeCloseTo(h.shared, 5);
      expect(h.mid).toBeGreaterThan(-20);
    }
  });

  it('remembers sound with a direction: the sound is in stereo at all', () => {
    const split = createParticipantSplit(RATE);
    const same = tone(RATE, 300, 8000);
    run(split, same, same);
    expect(split.spatialSeen()).toBe(false);
    run(split, tone(RATE, 500, 8000), new Int16Array(RATE));
    expect(split.spatialSeen()).toBe(true);
  });

  it('shares what the two have in common, and leaves out what is in one only', () => {
    const video = tone(RATE * 2, 312.5, 8000);
    const voice = tone(RATE * 2, 1500, 8000);
    const { shared } = run(createParticipantSplit(RATE), add(video, voice), video, true);
    // Past the filter's own start, the video comes through whole, 256 samples late, and the voice hardly at all.
    const skip = 2048;
    const expected = video.slice(0, shared.length);
    const residue = shared.map((v, i) => v - (expected[i - 256] ?? 0));
    expect(rms(shared, skip)).toBeCloseTo(rms(video), -2);
    expect(rms(residue, skip)).toBeLessThan(rms(video) / 10);
  });
});

describe('the video judge', () => {
  const alone: Hearing = { mid: -40, side: -120, shared: -40 };
  const talk: Hearing = { mid: -30, side: -32, shared: -45 };
  const front: Hearing = { mid: -30, side: -75, shared: -30 };
  const silence: Hearing = { mid: -120, side: -120, shared: -120 };

  it('takes the video out after six half seconds of it alone, once the sound has been heard in stereo', () => {
    const judge = createVideoJudge();
    for (let i = 0; i < 10; i++) expect(judge.hear(alone, false)).toBeNull();
    expect(judge.hear(alone, true)).toBe('apart');
  });

  it('never takes a voice from straight ahead for the video', () => {
    const judge = createVideoJudge();
    for (let i = 0; i < 100; i++) expect(judge.hear(i % 2 ? front : talk, true)).toBeNull();
  });

  it('counts only the last 30 s', () => {
    const judge = createVideoJudge();
    for (let i = 0; i < 5; i++) judge.hear(alone, true);
    for (let i = 0; i < 60; i++) judge.hear(talk, true);
    expect(judge.hear(alone, true)).toBeNull();
  });

  it('says the video is over after 10 s with nothing shared, or 30 s without it alone, once', () => {
    const quietly = createVideoJudge();
    for (let i = 0; i < 6; i++) quietly.hear(alone, true);
    for (let i = 0; i < 19; i++) expect(quietly.hear(silence, true)).toBeNull();
    expect(quietly.hear(silence, true)).toBe('over');
    expect(quietly.hear(silence, true)).toBeNull();

    const talking = createVideoJudge();
    for (let i = 0; i < 6; i++) talking.hear(alone, true);
    for (let i = 0; i < 59; i++) expect(talking.hear(front, true)).toBeNull();
    expect(talking.hear(front, true)).toBe('over');
  });

  it('is not over while the video is still heard alone between the talk', () => {
    const judge = createVideoJudge();
    for (let i = 0; i < 6; i++) judge.hear(alone, true);
    for (let i = 0; i < 200; i++) expect(judge.hear(i % 40 === 0 ? alone : talk, true)).toBeNull();
  });
});
