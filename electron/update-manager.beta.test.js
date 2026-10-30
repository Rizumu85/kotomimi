// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';

function manager(version) {
  const handlers = new Map();
  const updater = { setFeedURL: vi.fn(), on: vi.fn(), checkForUpdates: vi.fn().mockResolvedValue({}) };
  const send = vi.fn();
  const context = {
    module: { exports: {} }, process, console, setTimeout: vi.fn(),
    require: (id) => {
      if (id === 'electron-updater') return { autoUpdater: updater };
      if (id === 'electron') return { app: { getVersion: () => version }, ipcMain: { handle: (key, fn) => handlers.set(key, fn) } };
      if (id === 'fs') return fs;
      if (id === 'path') return path;
      return {};
    },
  };
  vm.runInNewContext(fs.readFileSync(new URL('./update-manager.js', import.meta.url), 'utf8'), context);
  const instance = new context.module.exports.UpdateManager({ isDestroyed: () => false, webContents: { send } });
  return { instance, handlers, updater, context };
}

describe('private beta update isolation', () => {
  it.each(['update-check', 'update-download', 'update-install'])('blocks %s before reaching the stable updater', async (channel) => {
    const { handlers, updater } = manager('0.43.133-beta.1');
    expect((await handlers.get(channel)()).success).toBe(false);
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
  });

  it('blocks menu and scheduled checks', async () => {
    const { instance, updater, context } = manager('0.43.133-beta.1');
    await instance.checkForUpdates();
    instance.checkAfterDelay();
    expect(updater.checkForUpdates).not.toHaveBeenCalled();
    expect(context.setTimeout).not.toHaveBeenCalled();
  });

  it('keeps stable update checks working', async () => {
    const { instance, handlers, updater } = manager('0.43.133');
    expect((await handlers.get('update-check')()).success).toBe(true);
    await instance.checkForUpdates();
    expect(updater.checkForUpdates).toHaveBeenCalledTimes(2);
  });
});
