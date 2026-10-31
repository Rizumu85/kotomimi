import { useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { getSubtitleWindowHost, subscribeSubtitleWindowHost } from './surfaces/subtitleWindowHost';
import { SubtitleTakeover } from './SubtitleTakeover';

/** A second view of the existing session, without another audio/recognition pipeline. */
export function SubtitleWindow() {
  const host = useSyncExternalStore(subscribeSubtitleWindowHost, getSubtitleWindowHost);
  return host ? createPortal(<SubtitleTakeover />, host) : null;
}
