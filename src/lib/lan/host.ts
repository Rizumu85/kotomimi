/**
 * Fork: this computer's models, shared on the local network. The main
 * process holds the listening socket (`electron/lan-server.js`) and hands
 * every request and every socket message here, to the page, where the
 * models run; this module answers them — the model lists itself, a
 * translation through `LanTranslator`, a Realtime socket through one
 * `LanTranscriber` each.
 *
 * To the other device this is a server that speaks the wire the Kotomimi
 * provider already speaks to a LocalAI (`FORK.md`), so nothing new is needed
 * there: the address goes where a LocalAI's would.
 *
 * Everything it touches is handed in — the bridge to the main process, the
 * engines, what is downloaded — so its tests run with none of them.
 */
import type { Clock } from '../contract/clock';
import { LanTranscriber, type Recognizer } from './transcriber';
import { LanTranslator, type Translator } from './translator';
import { capabilityList, modelList, wireError, type SharedModel } from './protocol';

/** The page's side of the main process's door: calls up, and events down. */
export interface LanBridge {
  invoke(channel: string, data?: unknown): Promise<unknown>;
  /** Returns the unsubscribe. */
  on(channel: string, listener: (payload: never) => void): () => void;
}

/** What this computer can share right now, and how a request picks among it. */
export interface LanModels {
  /** Every recognizer and translation model ready to run. */
  shared(): SharedModel[];
  recognizer(language: string, wanted: string): { modelId: string; streaming: boolean } | null;
  translator(source: string, target: string, wanted: string): string | null;
}

export interface LanHostDeps {
  bridge: LanBridge;
  models: LanModels;
  engines: { recognizer(model: { modelId: string; streaming: boolean }): Recognizer; translator(): Translator };
  clock: Clock;
  /** How many sockets are open changed: the settings show it. */
  onClients?(count: number): void;
}

export type LanStart = { ok: true; port: number; addresses: string[] } | { ok: false; code: string | null; message: string };

interface WireRequest { id: string; method: string; path: string; body: unknown }

export interface LanHost {
  start(o: { port: number; key: string }): Promise<LanStart>;
  stop(): Promise<void>;
}

export function createLanHost(deps: LanHostDeps): LanHost {
  const { bridge, models, clock } = deps;
  const sockets = new Map<string, LanTranscriber>();
  let translator: LanTranslator | null = null;
  let unsubscribe: Array<() => void> = [];
  let sessions = 0;

  const clients = () => deps.onClients?.(sockets.size);

  const answer = async (request: WireRequest): Promise<void> => {
    let reply: { status: number; body: unknown; contentType?: string };
    try {
      if (request.path === '/v1/models') reply = { status: 200, body: modelList(models.shared()) };
      else if (request.path === '/v1/models/capabilities') reply = { status: 200, body: capabilityList(models.shared()) };
      else if (request.path === '/v1/chat/completions' && translator) reply = await translator.complete(request.body);
      else reply = { status: 404, body: { error: wireError('not_found', `Kotomimi shares no ${request.path}.`) } };
    } catch (cause) {
      reply = { status: 500, body: { error: wireError('server_error', cause instanceof Error ? cause.message : String(cause)) } };
    }
    await bridge.invoke('lan:reply', { id: request.id, ...reply });
  };

  const drop = () => {
    for (const off of unsubscribe) off();
    unsubscribe = [];
    for (const socket of sockets.values()) socket.dispose();
    sockets.clear();
    translator?.dispose();
    translator = null;
    clients();
  };

  return {
    async start({ port, key }) {
      drop();
      const started = (await bridge.invoke('lan:start', { port, key })) as LanStart;
      if (!started.ok) return started;
      translator = new LanTranslator({ translator: deps.engines.translator, resolve: models.translator, clock });
      unsubscribe = [
        bridge.on('lan:request', (request: WireRequest) => { void answer(request); }),
        bridge.on('lan:socket-open', ({ id, model }: { id: string; model: string }) => {
          const socket = new LanTranscriber({
            recognizer: deps.engines.recognizer,
            resolve: models.recognizer,
            send: (event) => { void bridge.invoke('lan:send', { id, data: JSON.stringify(event) }); },
            close: (code, reason) => { void bridge.invoke('lan:close-socket', { id, code, reason }); },
            clock,
          }, `sess_${++sessions}`, model);
          sockets.set(id, socket);
          socket.open();
          clients();
        }),
        bridge.on('lan:socket-message', ({ id, data }: { id: string; data: string }) => sockets.get(id)?.receive(data)),
        bridge.on('lan:socket-close', ({ id }: { id: string }) => {
          sockets.get(id)?.dispose();
          sockets.delete(id);
          clients();
        }),
      ];
      return started;
    },
    async stop() {
      drop();
      await bridge.invoke('lan:stop');
    },
  };
}
