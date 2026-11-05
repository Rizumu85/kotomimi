/**
 * Fork: how the model storage section writes a folder and a size (`modelStorage.ts`).
 */
import { describe, expect, it } from 'vitest';
import { shortPath, sizeText } from './modelStorage';

describe('a folder in one line', () => {
  it('is whole where it fits, else its drive and its last folders', () => {
    expect(shortPath(String.raw`D:\Kotomimi`)).toBe(String.raw`D:\Kotomimi`);
    expect(shortPath(String.raw`C:\Users\Rizum\AppData\Roaming\Kotomimi`)).toBe(String.raw`C:\…\Rizum\AppData\Roaming\Kotomimi`);
    expect(shortPath(String.raw`C:\Users\Rizum\AppData\Local\Temp\kt-storage-profile`)).toBe(String.raw`C:\…\Local\Temp\kt-storage-profile`);
    expect(shortPath('/Users/rizum/Library/Application Support/Kotomimi')).toBe('/…/Application Support/Kotomimi');
    // One folder too long for the line is still the folder, after its drive.
    expect(shortPath(String.raw`E:\a-folder-name-far-too-long-to-fit-in-one-line`)).toBe(String.raw`E:\…\a-folder-name-far-too-long-to-fit-in-one-line`);
  });
});

describe('a size', () => {
  it('is gigabytes to one place, megabytes under a tenth of one', () => {
    expect(sizeText(11 * 1024 ** 3)).toBe('11.0 GB');
    expect(sizeText(0.8 * 1024 ** 3)).toBe('0.8 GB');
    expect(sizeText(50 * 1024 ** 2)).toBe('50 MB');
  });
});
