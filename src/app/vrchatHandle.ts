// src/app/vrchatHandle.ts
/**
 * Fork: the page's VRChat controller as the views reach it (`vrchat.ts` builds it), and whether this page runs
 * where VRChat can. Apart from the controller's module, so that a view importing it pulls in none of the stores and
 * the app session that one reads.
 */
import type { VRChatController } from './vrchat';

let current: VRChatController | null = null;

/** The controller once it exists, for a button's press; null before, and where VRChat cannot run. */
export const vrchatController = (): VRChatController | null => current;

export function setVRChatController(controller: VRChatController | null): void {
  current = controller;
}

/** Whether this page runs where VRChat can: the desktop app, on Windows. */
export function vrchatOffered(): boolean {
  if (typeof window === 'undefined' || !(window as unknown as { electron?: unknown }).electron) return false;
  return /Windows/i.test(navigator.userAgent);
}
