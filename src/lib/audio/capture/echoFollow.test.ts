import { describe, expect, it } from 'vitest';
import { createEchoFollower } from './echoFollow';

const chunk = (db: number) => new Int16Array(80).fill(Math.round(32768 * 10 ** (db / 20)));

describe('createEchoFollower', () => {
  it('has no say until audible playout and distinguishes speech from its echo', () => {
    const follower = createEchoFollower(() => 0);
    const echo = chunk(-64);
    expect(follower.voiced(echo)).toBeNull();
    follower.played(chunk(-56));
    expect(follower.voiced(echo)).toBeNull();
    follower.played(chunk(-30));
    expect(follower.voiced(echo)).toBe(false);
    expect(follower.voiced(chunk(-30))).toBe(true);
  });

  it('follows the loudest recent chunk and keeps the room floor active through a pause', () => {
    let time = 0;
    const follower = createEchoFollower(() => time);
    follower.played(chunk(-20));
    time = 100;
    follower.played(chunk(-40));
    time = 600;
    expect(follower.voiced(chunk(-35))).toBe(false);
    time = 999;
    expect(follower.voiced(chunk(-35))).toBe(false);
    time = 1000;
    expect(follower.voiced(chunk(-35))).toBe(true);
    time = 1599;
    follower.played(chunk(-65));
    expect(follower.voiced(chunk(-64))).toBe(false);
    time = 1600;
    expect(follower.voiced(chunk(-64))).toBeNull();
  });

  it('learns the louder echo among speech and forgets the room and playout on reset', () => {
    let time = 0;
    const follower = createEchoFollower(() => time);
    const room = chunk(-72), echo = chunk(-41), speech = chunk(-25), played = chunk(-30);
    // A quiet stretch keeps the floor below the echo, so only the coupling can reject it.
    for (let i = 0; i < 200; i++) follower.voiced(room);
    follower.played(played);
    expect(follower.voiced(echo)).toBe(true);
    for (let i = 0; i < 200; i++) {
      time += 80;
      follower.played(played);
      follower.voiced(i % 2 === 0 ? echo : speech);
    }
    expect(follower.voiced(echo)).toBe(false);
    expect(follower.voiced(speech)).toBe(true);
    follower.reset();
    expect(follower.voiced(room)).toBeNull();
    follower.played(played);
    expect(follower.voiced(echo)).toBe(true);
    time += 1100;
    expect(follower.voiced(chunk(-50))).toBe(false);
  });

  it('learns the floor from the hundredth microphone chunk and ages old levels out', () => {
    const follower = createEchoFollower(() => 0);
    const room = chunk(-75), probe = chunk(-50);
    follower.played(chunk(-48));
    for (let i = 0; i < 98; i++) follower.voiced(room);
    expect(follower.voiced(probe)).toBe(false);
    expect(follower.voiced(probe)).toBe(true);
    for (let i = 0; i < 1500; i++) follower.voiced(probe);
    expect(follower.voiced(probe)).toBe(false);
  });

  describe('onsets', () => {
    /** Playout that begins on a quiet microphone, `back` dB under it in the microphone; then a silence. Returns whether any of its echo passed. */
    const sentence = (follower: ReturnType<typeof createEchoFollower>, clock: { at: number }, back: number | null, before = -70) => {
      let passed = false;
      for (let i = 0; i < 8; i++, clock.at += 85) follower.voiced(chunk(before));
      for (let i = 0; i < 20; i++, clock.at += 85) {
        follower.played(chunk(-15));
        if (follower.voiced(chunk(back === null ? before : -15 + back)) === true) passed = true;
      }
      return passed;
    };
    const setup = () => {
      const clock = { at: 0 };
      const follower = createEchoFollower(() => clock.at);
      for (let i = 0; i < 100; i++, clock.at += 85) follower.voiced(chunk(-70));
      return { follower, clock };
    };

    it('holds an echo as loud as speech once three onsets have shown it', () => {
      const { follower, clock } = setup();
      // -26 dBFS against the starting guess of -35: the first sentences pass.
      expect(sentence(follower, clock, -11)).toBe(true);
      sentence(follower, clock, -11);
      sentence(follower, clock, -11);
      expect(sentence(follower, clock, -11)).toBe(false);
      // The user's voice at the echo's level cannot pass either while playout sounds, and passes once it is idle.
      follower.played(chunk(-15));
      expect(follower.voiced(chunk(-24))).toBe(false);
      clock.at += 1500;
      expect(follower.voiced(chunk(-24))).toBeNull();
    });

    it('measures from the loud sound, not from a murmur that leads into it', () => {
      const { follower, clock } = setup();
      for (let n = 0; n < 4; n++) {
        for (let i = 0; i < 8; i++, clock.at += 85) follower.voiced(chunk(-70));
        for (let i = 0; i < 9; i++, clock.at += 85) { follower.played(chunk(-53)); follower.voiced(chunk(-70)); }
        for (let i = 0; i < 20; i++, clock.at += 85) { follower.played(chunk(-15)); follower.voiced(chunk(-26)); }
      }
      follower.played(chunk(-15));
      expect(follower.voiced(chunk(-24))).toBe(false);
    });

    it('counts onsets on a noise-suppressed microphone: silent, but for a residue far over its floor', () => {
      const clock = { at: 0 };
      const follower = createEchoFollower(() => clock.at);
      for (let i = 0; i < 100; i++, clock.at += 85) follower.voiced(chunk(-110));
      for (let i = 0; i < 4; i++) sentence(follower, clock, -11, i % 2 ? -110 : -70);
      follower.played(chunk(-15));
      expect(follower.voiced(chunk(-24))).toBe(false);
    });

    it('does not learn from an onset the user was talking at, or a switched-off microphone', () => {
      const { follower, clock } = setup();
      for (let i = 0; i < 6; i++) sentence(follower, clock, -11, -30);
      for (let i = 0; i < 6; i++) sentence(follower, clock, null, -120);
      follower.played(chunk(-15));
      expect(follower.voiced(chunk(-26))).toBe(true);
    });

    it('is outvoted where most onsets bring nothing back, and forgotten on reset', () => {
      const { follower, clock } = setup();
      for (let i = 0; i < 4; i++) sentence(follower, clock, null);
      // The user begins to talk at two onsets among them.
      for (let i = 0; i < 2; i++) sentence(follower, clock, -5);
      for (let i = 0; i < 3; i++) sentence(follower, clock, null);
      follower.played(chunk(-15));
      expect(follower.voiced(chunk(-24))).toBe(true);

      const loud = setup();
      for (let i = 0; i < 4; i++) sentence(loud.follower, loud.clock, -11);
      loud.follower.played(chunk(-15));
      expect(loud.follower.voiced(chunk(-24))).toBe(false);
      loud.follower.reset();
      loud.follower.played(chunk(-15));
      expect(loud.follower.voiced(chunk(-24))).toBe(true);
    });

    it('takes float chunks at full scale 1', () => {
      const follower = createEchoFollower(() => 0);
      follower.played(new Float32Array(240).fill(10 ** (-30 / 20)));
      expect(follower.voiced(chunk(-64))).toBe(false);
      expect(follower.voiced(chunk(-30))).toBe(true);
    });
  });
});
