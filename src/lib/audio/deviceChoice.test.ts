import { describe, it, expect } from 'vitest';
import type { AudioDevice } from '../../stores/audioStore';
import { chooseInput, chooseOutput, pickDefaultInputDevice } from './deviceChoice';

const real = (deviceId: string, label = deviceId): AudioDevice => ({ deviceId, label, isVirtual: false });
const virtualMic: AudioDevice = { deviceId: 'virtual', label: 'Sokuji_Virtual_Mic', isVirtual: true };
const loopback: AudioDevice = { deviceId: 'loop', label: 'Monitor of Built-in Audio', isVirtual: false };

describe('chooseInput', () => {
  it('picks the saved device when it is listed, over the current one: this is what switches back', () => {
    const devices = [real('b'), real('a')];
    expect(chooseInput({ devices, savedId: 'a', currentId: 'b' })?.deviceId).toBe('a');
  });

  it('keeps the current device when the saved one is gone', () => {
    expect(chooseInput({ devices: [real('c'), real('b')], savedId: 'a', currentId: 'b' })?.deviceId).toBe('b');
  });

  it('falls back to the first real input, skipping virtual and loopback inputs, when both are gone', () => {
    expect(chooseInput({ devices: [virtualMic, loopback, real('c')], savedId: 'a', currentId: 'b' })?.deviceId).toBe('c');
  });

  it('never restores a saved virtual device', () => {
    expect(chooseInput({ devices: [virtualMic, real('c')], savedId: 'virtual', currentId: null })?.deviceId).toBe('c');
  });

  it('skips inputs marked unusable, the saved and the current one included', () => {
    const devices = [real('a'), real('b'), real('c')];
    expect(chooseInput({ devices, savedId: 'a', currentId: 'b', unusable: new Set(['a', 'b']) })?.deviceId).toBe('c');
  });

  it('returns null — the waiting state — when only virtual and loopback inputs are left', () => {
    expect(chooseInput({ devices: [virtualMic, loopback], savedId: 'a', currentId: 'a' })).toBeNull();
    expect(chooseInput({ devices: [], savedId: null, currentId: null })).toBeNull();
  });
});

describe('chooseOutput', () => {
  const virtualSpeaker: AudioDevice = { deviceId: 'vs', label: 'Sokuji_Virtual_Speaker', isVirtual: true };

  it.each(['BlackHole 2ch', 'Soundflower (2ch)', 'Loopback Audio', 'Voicemeeter AUX Input'])('does not monitor %s automatically, but honors an explicit pick', (label) => {
    const loop = { ...real('loop', label), isDefault: true };
    const devices = [loop, real('speakers')];
    expect(chooseOutput({ devices, savedId: null, currentId: 'loop' })).toBe(devices[1]);
    expect(chooseOutput({ devices, savedId: 'loop', currentId: 'speakers' })).toBe(loop);
  });

  it('picks the saved output, then the current one, then the first non-virtual, then any', () => {
    expect(chooseOutput({ devices: [real('b'), real('a')], savedId: 'a', currentId: 'b' })?.deviceId).toBe('a');
    expect(chooseOutput({ devices: [real('b')], savedId: 'a', currentId: 'b' })?.deviceId).toBe('b');
    expect(chooseOutput({ devices: [virtualSpeaker, real('c')], savedId: 'a', currentId: 'b' })?.deviceId).toBe('c');
    expect(chooseOutput({ devices: [virtualSpeaker], savedId: null, currentId: null })?.deviceId).toBe('vs');
    expect(chooseOutput({ devices: [], savedId: null, currentId: null })).toBeNull();
  });

  it('with none saved, is the output the system plays on, wherever it stands in the list, and follows it', () => {
    const hdmi = real('hdmi', 'Capture card (HDMI)');
    const speakers: AudioDevice = { ...real('spk', 'Speakers'), isDefault: true };
    expect(chooseOutput({ devices: [hdmi, speakers], savedId: null, currentId: null })?.deviceId).toBe('spk');
    // The system moved to a headset: so does the monitor, though another device is the current one.
    expect(chooseOutput({ devices: [hdmi, real('spk'), { ...real('headset'), isDefault: true }], savedId: null, currentId: 'spk' })?.deviceId).toBe('headset');
    // A device the user picked stays theirs.
    expect(chooseOutput({ devices: [hdmi, speakers], savedId: 'hdmi', currentId: null })?.deviceId).toBe('hdmi');
    // The system plays on a virtual cable: monitoring there would go back into the meeting.
    expect(chooseOutput({ devices: [{ ...virtualSpeaker, isDefault: true }, hdmi], savedId: null, currentId: null })?.deviceId).toBe('hdmi');
  });
});

describe('pickDefaultInputDevice', () => {
  it('is still exported from the audio store, for its existing callers', async () => {
    const store = await import('../../stores/audioStore');
    expect(store.pickDefaultInputDevice).toBe(pickDefaultInputDevice);
  });
});
