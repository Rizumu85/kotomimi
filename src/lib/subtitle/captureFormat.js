/** Shared file/IPC boundary. No renderer, store, or Electron dependencies. */
export const CAPTURE_FORMAT = 'kotomimi-subtitle';
export const CAPTURE_VERSION = 1;
export const CAPTURE_WINDOW_MS = 60_000;
export const CAPTURE_MAX_BYTES = 16 * 1024 * 1024;
export const CAPTURE_MAX_FRAMES = 12_000;

const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string';
const number = (v) => typeof v === 'number' && Number.isFinite(v);
const bool = (v) => typeof v === 'boolean';
const one = (...values) => (v) => values.includes(v);
const array = (check) => (v) => Array.isArray(v) && v.every(check);
const optional = (check) => (v) => v === undefined || check(v);
const nullable = (check) => (v) => v === null || check(v);
const shape = (fields) => (v) => object(v) && Object.keys(v).every((k) => Object.prototype.hasOwnProperty.call(fields, k))
  && Object.entries(fields).every(([k, check]) => check(v[k]));
const params = optional((v) => object(v) && Object.values(v).every((x) => string(x) || number(x)));
const leg = one('speaker', 'participant');
const pair = shape({ source: string, target: string });
const row = shape({ key: string, segmentId: string, side: one('source', 'translation'),
  purpose: optional(one('translation', 'feedback')), accompaniesTranslation: optional(one(true)),
  start: number, end: number, text: string, final: bool, language: optional(string) });
const entry = (v) => object(v) && (v.kind === 'exchange'
  ? shape({ kind: one('exchange'), id: string, leg, languages: pair, pairing: one('stated', 'inferred', 'none'),
    source: array(row), translation: array(row), feedback: optional(array(row)), t: number, lane: optional(one('video')) })(v)
  : shape({ kind: one('notice'), id: string, leg, severity: one('error', 'warning', 'info'), message: string,
    code: optional(string), params, lifetime: optional(one('transient')), at: number })(v));
const notice = shape({ code: string, message: string, params });
const idle = (v) => object(v) && (v.kind === 'failed'
  ? shape({ kind: one('failed'), notice })(v)
  : v.kind === 'unready'
    ? shape({ kind: one('unready'), message: string, code: optional(string), params, unsure: optional(one(true)) })(v)
    : shape({ kind: one('ready', 'ended', 'starting') })(v));
const session = nullable(shape({ phase: one('idle', 'starting', 'running', 'stopping'), since: nullable(number),
  legs: array(leg), pair: nullable(pair), holdToTalk: bool, canStart: bool, idle }));
const displayMode = one('source', 'translation', 'both', 'none');
const settings = shape({ fontSize: number, compactMode: bool, bgOpacity: number, bgColor: string,
  sourceTextColor: string, translationTextColor: string, newItemHighlightEnabled: bool,
  alwaysOnTop: bool, positionLocked: bool, speakerDisplayMode: displayMode, participantDisplayMode: displayMode });
const look = shape({ look: one('panel', 'soft', 'light', 'dark'), shadow: number, align: one('left', 'center') });
const annotation = shape({ furigana: bool, romanization: bool, romanizationOff: array(one('ja', 'ko', 'ru', 'uk')),
  pinyin: bool, jyutping: bool, sourceItalic: bool });
const positive = (v) => number(v) && v > 0;
const stateFields = { entries: array(entry), session,
  lit: array((v) => Array.isArray(v) && v.length === 2 && string(v[0]) && number(v[1])),
  settings, look, annotation, viewport: shape({ width: positive, height: positive, dpr: positive }),
  surface: one('electron', 'extension-overlay'), held: shape({ speaker: optional(string), participant: optional(string) }) };
const state = shape(stateFields);
const patch = shape(Object.fromEntries(Object.entries(stateFields).map(([key, check]) => [key, optional(check)])));

/** Returns an English diagnostic, or null. Unknown fields are rejected (captures contain no audio). */
export function captureError(value) {
  if (!object(value) || value.format !== CAPTURE_FORMAT) return 'This is not a Kotomimi subtitle capture.';
  if (value.version !== CAPTURE_VERSION) return `Unsupported subtitle capture format version: ${value.version}. Expected ${CAPTURE_VERSION}.`;
  const valid = shape({ format: one(CAPTURE_FORMAT), version: one(CAPTURE_VERSION), appVersion: string,
    platform: string, language: string, startedAt: number, durationMs: number, truncated: bool,
    frames: array(shape({ at: number, state: patch })) })(value);
  if (!valid) return 'Invalid subtitle capture data.';
  if (value.durationMs < 0 || value.durationMs > CAPTURE_WINDOW_MS || !value.frames.length
    || value.frames.length > CAPTURE_MAX_FRAMES || value.frames[0].at !== 0) return 'Invalid subtitle capture timeline.';
  if (!state(value.frames[0].state)) return 'The subtitle capture is missing its initial state.';
  let previous = 0;
  for (const frame of value.frames) {
    if (frame.at < previous || frame.at > value.durationMs) return 'Invalid subtitle capture frame time.';
    previous = frame.at;
  }
  return null;
}
