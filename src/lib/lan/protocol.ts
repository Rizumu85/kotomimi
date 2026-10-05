/**
 * Fork: what a Kotomimi sharing its models says of itself — the model lists
 * another Kotomimi (or anything that speaks OpenAI's wire) reads to learn
 * what is here. Pure.
 *
 * The lists are OpenAI's in shape, with three things of this server's own,
 * each read by the client's check (`src/providers/openai/localai.ts`):
 * every model is `owned_by: 'kotomimi'`, which is how a client knows what it
 * is talking to; a recognizer's capability is LocalAI's `transcript`; and a
 * translation model's is `translate` — it is no chat model, and is told the
 * pair it translates.
 */

/**
 * Whether the system's firewall lets another device reach the shared port
 * (`electron/lan-firewall.js`): `unknown` where it cannot be asked — any
 * system but Windows. `public` says a network Windows calls public is among
 * those it is shut on.
 */
export interface LanFirewall {
  state: 'unknown' | 'allowed' | 'blocked';
  public: boolean;
}

export const FIREWALL_UNKNOWN: LanFirewall = { state: 'unknown', public: false };

/** The main process's answer, held to its shape: anything else is `unknown`. */
export function firewallAnswer(value: unknown): LanFirewall {
  const answer = value as Partial<LanFirewall> | null;
  if (!answer || (answer.state !== 'allowed' && answer.state !== 'blocked')) return FIREWALL_UNKNOWN;
  return { state: answer.state, public: answer.state === 'blocked' && answer.public === true };
}

/** Where the server listens unless told otherwise. */
export const LAN_DEFAULT_PORT = 8790;

/** The owner every shared model names: the client's mark of another Kotomimi. */
export const LAN_OWNER = 'kotomimi';

/**
 * The pipeline's name: what a client dials the socket with, and what it asks
 * over chat when it leaves the choice of model to this computer.
 */
export const LAN_PIPELINE = 'kotomimi';

export interface SharedModel {
  id: string;
  kind: 'asr' | 'translate';
  /** The languages it takes, as the catalog codes them; empty: any. */
  languages: readonly string[];
}

/** `GET /v1/models`: the pipeline first, then every model shared. */
export function modelList(models: readonly SharedModel[]): { object: 'list'; data: Array<{ id: string; object: 'model'; owned_by: string }> } {
  return { object: 'list', data: [LAN_PIPELINE, ...models.map((m) => m.id)].map((id) => ({ id, object: 'model', owned_by: LAN_OWNER })) };
}

/** `GET /v1/models/capabilities`: what each is for. The pipeline has no capability of its own, as LocalAI's has none. */
export function capabilityList(models: readonly SharedModel[]): { object: 'list'; data: Array<{ id: string; capabilities: string[] | null; languages?: readonly string[] }> } {
  return {
    object: 'list',
    data: [
      { id: LAN_PIPELINE, capabilities: null },
      ...models.map((m) => ({ id: m.id, capabilities: [m.kind === 'asr' ? 'transcript' : 'translate'], languages: m.languages })),
    ],
  };
}

/** An error as OpenAI words one, for an HTTP body or a socket's `error` event. */
/**
 * A failure's words as another device may read them: a file of this computer
 * is not named. An engine's own message often carries one — a model's file
 * under the user's folder, with the user's name in it — and the device needs
 * to know that it failed, not where things are kept here.
 */
export function withoutPaths(message: string): string {
  return message
    .replace(/file:\/\/[^\s"'<>)]+/gi, '…')
    .replace(/[A-Za-z]:[\\/][^\s"'<>|)]+/g, '…')
    .replace(/(^|[\s"'(=:])\/(?:Users|home|var|tmp|private|opt|usr|Applications|Library|Volumes|mnt)\/[^\s"'<>)]*/g, '$1…');
}

export function wireError(code: string, message: string): { message: string; type: 'invalid_request_error'; code: string } {
  return { message: withoutPaths(message), type: 'invalid_request_error', code };
}

/** What the catalog calls a language: its base (`zh-CN` → `zh`), lower-cased; '' for none. */
export function baseLanguage(code: unknown): string {
  return typeof code === 'string' ? code.trim().toLowerCase().split(/[-_]/)[0] : '';
}
