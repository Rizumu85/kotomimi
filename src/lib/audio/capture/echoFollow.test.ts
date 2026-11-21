import { describe, expect, it } from 'vitest';
import { createEchoFollower } from './echoFollow';

const chunk = (db: number) => new Int16Array(80).fill(Math.round(32768 * 10 ** (db / 20)));

describe('createEchoFollower', () => {
  it('passes a quiet microphone until audible playout and distinguishes speech from its echo', () => {
    const follower = createEchoFollower(() => 0);
    const echo = chunk(-64);
    expect(follower.voiced(echo)).toBe(true);
    follower.played(chunk(-56));
    expect(follower.voiced(echo)).toBe(true);
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
    expect(follower.voiced(chunk(-64))).toBe(true);
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
    expect(follower.voiced(room)).toBe(true);
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
});
