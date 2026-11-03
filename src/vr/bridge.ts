// src/vr/bridge.ts
/** Fork: the headset pages' one way to the app: the main window's preload, which these pages load too. */
import type { VrCommand, VrSurface } from './types';

export interface Bridge {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  receive(channel: string, fn: (...args: unknown[]) => void): void;
}

export const bridge = (window as unknown as { electron?: Bridge }).electron;

export const surface: VrSurface = window.location.hash === '#strip' ? 'strip' : 'wrist';

export const send = (command: VrCommand): void => { void bridge?.invoke('vr:command', command); };

/** A word with its placeholders filled: `{name}` in `template`. */
export const fill = (template: string, values: Record<string, string | number>): string =>
  template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? String(values[key]) : all));
