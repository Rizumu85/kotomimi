/**
 * Fork: one answer from a text model over OpenAI's chat-completions wire —
 * the protocol LocalAI, Ollama, LM Studio, llama.cpp's server and most
 * hosted APIs speak. Streamed when the server streams, so a translation
 * shows as it is written; a server that answers whole is read whole. Pure
 * but for the `fetch` and the clock it is handed.
 */
import type { Clock } from '../../lib/contract/clock';

/** How long one answer may take, from the request to its last token. */
export const TEXT_TIMEOUT_MS = 60_000;

export interface TextRequest {
  /** The chat-completions URL (`chatUrl`). */
  url: string;
  model: string;
  /** Sent as a Bearer token when present; never framed or worded. */
  key?: string;
  system: string;
  /** Worked examples, sent as earlier turns of the chat: what was said, and the answer shown as the model's own. */
  shots?: ReadonlyArray<{ said: string; answer: string }>;
  user: string;
}

export interface TextDeps {
  fetch: typeof fetch;
  clock: Clock;
  /** Aborts the request: the session stopped. */
  signal: AbortSignal;
  /** The answer so far, each time it grows: what is shown, reasoning already taken out. */
  onText?(text: string): void;
}

export interface TextAnswer {
  text: string;
  /** From the request to the first visible text; absent when none came before the end. */
  firstMs?: number;
  totalMs: number;
}

/** An OpenAI-style base URL as its chat-completions URL: `http://host:11434/v1` → `http://host:11434/v1/chat/completions`. A URL that already names the path is kept. */
export function chatUrl(baseUrl: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  return /\/chat\/completions$/.test(base) ? base : `${base}/chat/completions`;
}

/** The base URL of the text models a Realtime server serves beside its socket: `ws://host:8080/v1/realtime` → `http://host:8080/v1`. */
export function httpBaseOf(realtimeEndpoint: string): string {
  return realtimeEndpoint.replace(/^ws/, 'http').replace(/\/realtime$/, '');
}

/**
 * What of an answer is shown: a reasoning model's `<think>…</think>` is not,
 * nor one still open at the end (it is mid-thought), and the rest is
 * trimmed.
 */
export function visibleText(raw: string): string {
  return raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
}

interface Chunk { choices?: Array<{ delta?: { content?: unknown }; message?: { content?: unknown } }>; error?: { message?: unknown } }

/** The server's own words for a refusal, when it sent any. */
async function refusal(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as Chunk | null;
  const said = typeof body?.error?.message === 'string' ? body.error.message : '';
  return `HTTP ${response.status}${said ? `: ${said}` : ''}`;
}

export async function completeText(request: TextRequest, deps: TextDeps): Promise<TextAnswer> {
  const { clock, signal } = deps;
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
  const started = clock.now();
  const controller = new AbortController();
  let timedOut = false;
  const cancelTimer = clock.setTimeout(() => { timedOut = true; controller.abort(); }, TEXT_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal.reason);
  signal.addEventListener('abort', onAbort, { once: true });
  let raw = '';
  let shown = '';
  let firstMs: number | undefined;
  const grow = (piece: string) => {
    raw += piece;
    const now = visibleText(raw);
    if (now === shown) return;
    shown = now;
    if (firstMs === undefined && shown) firstMs = clock.now() - started;
    deps.onText?.(shown);
  };
  try {
    const response = await deps.fetch(request.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(request.key ? { Authorization: `Bearer ${request.key}` } : {}) },
      body: JSON.stringify({
        model: request.model,
        stream: true,
        messages: [
          { role: 'system', content: request.system },
          ...(request.shots ?? []).flatMap((shot) => [{ role: 'user', content: shot.said }, { role: 'assistant', content: shot.answer }]),
          { role: 'user', content: request.user },
        ],
      }),
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await refusal(response));
    if (!(response.headers.get('content-type') ?? '').includes('text/event-stream') || !response.body) {
      // A server that does not stream: the whole answer in one body.
      const body = (await response.json()) as Chunk;
      const content = body.choices?.[0]?.message?.content;
      if (typeof content === 'string') grow(content);
    } else {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          const data = line.startsWith('data:') ? line.slice(5).trim() : '';
          if (!data || data === '[DONE]') continue;
          let chunk: Chunk;
          try { chunk = JSON.parse(data) as Chunk; } catch { continue; }
          if (typeof chunk.error?.message === 'string') throw new Error(chunk.error.message);
          const piece = chunk.choices?.[0]?.delta?.content;
          if (typeof piece === 'string' && piece) grow(piece);
        }
      }
    }
    return { text: shown, ...(firstMs !== undefined ? { firstMs } : {}), totalMs: clock.now() - started };
  } catch (error) {
    if (timedOut) throw new Error(`The model did not finish within ${TEXT_TIMEOUT_MS / 1000} s.`);
    throw error;
  } finally {
    cancelTimer();
    signal.removeEventListener('abort', onAbort);
  }
}
