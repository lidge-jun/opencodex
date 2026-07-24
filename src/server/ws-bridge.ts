import type { ServerWebSocket } from "bun";
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import type { CodexAuthContext } from "../codex/auth-context";
import { headersForCodexAuthContext } from "../codex/auth-context";
import type { ResponsesTerminalStatus } from "../bridge";

const OPEN = 1;
type ResponsesTerminalReporter = (status: ResponsesTerminalStatus) => void;
type ResponsesPayloadObserver = (payload: string) => void;
const SAFE_RESPONSE_HEADER_EXACT = new Set([
  "retry-after",
  "x-request-id",
  "openai-request-id",
  "x-codex-turn-state",
  "openai-model",
  "x-models-etag",
  "x-reasoning-included",
]);

export interface WsData {
  headers?: Headers; // base inbound forward headers only; per-turn auth refresh injects current pool tokens
  authContext?: CodexAuthContext; // last resolved account decision for observability/registry cleanup
  cancel?: () => void; // cancels the in-flight stream reader/fetch
  turnId?: number; // monotonically increasing per socket; prevents stale frames after replacement turns
  /** Discriminator: Responses reframing vs transparent live/realtime sideband relay. */
  kind?: "responses" | "live-sideband";
  liveUpstream?: WebSocket;
  liveUpstreamUrl?: string;
  liveUpstreamHeaders?: Record<string, string>;
  livePending?: Array<string | Buffer>;
  liveOpened?: boolean;
}

export class WsSendDroppedError extends Error {
  constructor() {
    super("websocket send dropped the message");
  }
}

export function selectForwardHeaders(
  headers: Headers,
  codexOverride?: { accessToken: string; chatgptAccountId: string },
): Headers {
  const selected = new Headers();
  for (const name of FORWARD_HEADERS) {
    const value = headers.get(name);
    if (value) selected.set(name, value);
  }
  if (codexOverride) {
    selected.set("authorization", `Bearer ${codexOverride.accessToken}`);
    selected.set("chatgpt-account-id", codexOverride.chatgptAccountId);
  }
  return selected;
}

export function selectForwardHeadersForAuthContext(headers: Headers, ctx: CodexAuthContext): Headers {
  return headersForCodexAuthContext(headers, ctx);
}

export function safeResponseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (
      SAFE_RESPONSE_HEADER_EXACT.has(lower) ||
      lower.startsWith("x-ratelimit-") ||
      /^x-codex(?:-[a-z0-9-]+)?-(primary|secondary|tertiary)-(used-percent|window-minutes|reset-at)$/.test(lower) ||
      /^x-codex(?:-[a-z0-9-]+)?-limit-name$/.test(lower)
    ) {
      out[lower] = value;
    }
  }
  return out;
}

export function buildWarmupCompletionFrames(frame: Record<string, unknown>): string[] {
  const createdAt = Math.floor(Date.now() / 1000);
  const baseResponse: Record<string, unknown> = {
    id: "",
    object: "response",
    created_at: createdAt,
    model: typeof frame.model === "string" ? frame.model : undefined,
    output: [],
  };
  return [
    JSON.stringify({
      type: "response.created",
      sequence_number: 0,
      response: { ...baseResponse, status: "in_progress" },
    }),
    JSON.stringify({
      type: "response.completed",
      sequence_number: 1,
      response: { ...baseResponse, status: "completed" },
    }),
  ];
}

export function sendTextFrame(ws: ServerWebSocket<WsData>, payload: string): void {
  if (ws.readyState !== OPEN) throw new WsSendDroppedError();
  const result = ws.send(payload);
  if (result === 0) throw new WsSendDroppedError();
  // Bun returns -1 when queued with backpressure. That is accepted; a later 0 is the hard failure.
}

export function sendJsonFrame(ws: ServerWebSocket<WsData>, payload: Record<string, unknown>): void {
  sendTextFrame(ws, JSON.stringify(payload));
}

export function buildWsErrorFrame(
  status: number,
  error: Record<string, unknown>,
  headers?: Headers,
): Record<string, unknown> {
  return {
    type: "error",
    status,
    error,
    headers: headers ? safeResponseHeaders(headers) : {},
  };
}

function parseSseBlock(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  return data.length > 0 ? data.join("\n") : null;
}

function nextSseBlock(buffer: string): { block: string; rest: string } | null {
  const match = buffer.match(/\r?\n\r?\n/);
  if (!match || match.index === undefined) return null;
  return {
    block: buffer.slice(0, match.index),
    rest: buffer.slice(match.index + match[0].length),
  };
}

function payloadType(payload: string): string | null {
  try {
    const json = JSON.parse(payload) as { type?: unknown };
    return typeof json.type === "string" ? json.type : null;
  } catch {
    return null;
  }
}

function terminalStatusFromType(type: string): ResponsesTerminalStatus | null {
  switch (type) {
    case "response.completed":
      return "completed";
    case "response.failed":
      return "failed";
    case "response.incomplete":
      return "incomplete";
    default:
      return null;
  }
}

function protocolError(message: string): Record<string, unknown> {
  return {
    type: "protocol_error",
    code: "websocket_protocol_error",
    message,
  };
}

function sendProtocolError(ws: ServerWebSocket<WsData>, status: number, message: string): void {
  sendJsonFrame(ws, buildWsErrorFrame(status, protocolError(message)));
}

export async function pumpResponsesSseToWebSocket(
  ws: ServerWebSocket<WsData>,
  sseStream: ReadableStream<Uint8Array>,
  options: {
    isCurrent?: () => boolean;
    onTerminal?: ResponsesTerminalReporter;
    onSsePayload?: ResponsesPayloadObserver;
  } = {},
): Promise<void> {
  const reader = sseStream.getReader();
  const isCurrent = options.isCurrent ?? (() => true);
  let clientCancelled = false;
  let terminalReported = false;
  const reportTerminal = (status: ResponsesTerminalStatus) => {
    if (terminalReported || clientCancelled || !isCurrent()) return;
    terminalReported = true;
    options.onTerminal?.(status);
  };
  const cancel = () => {
    clientCancelled = true;
    void reader.cancel().catch(() => {});
  };
  ws.data.cancel = cancel;

  const decoder = new TextDecoder();
  let buffer = "";
  let terminalSeen = false;

  const handlePayload = (payload: string): boolean => {
    if (!isCurrent()) return true;
    if (payload === "[DONE]") return false;
    try {
      options.onSsePayload?.(payload);
    } catch {
      /* payload observation must not affect WebSocket delivery */
    }
    const type = payloadType(payload);
    if (!type) {
      reportTerminal("incomplete");
      sendProtocolError(ws, 502, "Invalid JSON payload in upstream SSE frame");
      terminalSeen = true;
      void reader.cancel().catch(() => {});
      return true;
    }
    if (terminalSeen) return true;
    sendTextFrame(ws, payload);
    const terminalStatus = terminalStatusFromType(type);
    if (terminalStatus) {
      reportTerminal(terminalStatus);
      terminalSeen = true;
      void reader.cancel().catch(() => {});
      return true;
    }
    return false;
  };

  try {
    while (!terminalSeen) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let next: { block: string; rest: string } | null;
      while ((next = nextSseBlock(buffer))) {
        buffer = next.rest;
        const payload = parseSseBlock(next.block);
        if (payload && handlePayload(payload)) break;
      }
    }
    buffer += decoder.decode();
    if (!terminalSeen && buffer.trim()) {
      const payload = parseSseBlock(buffer);
      if (payload) handlePayload(payload);
    }
    if (!terminalSeen && isCurrent() && !clientCancelled) {
      reportTerminal("incomplete");
      sendProtocolError(ws, 502, "Upstream stream ended before response terminal event");
    }
  } catch (err) {
    if (!terminalSeen && isCurrent() && ws.readyState === OPEN) {
      if (!(err instanceof WsSendDroppedError)) reportTerminal("incomplete");
      sendProtocolError(ws, 502, err instanceof Error ? err.message : String(err));
    }
  } finally {
    if (ws.data.cancel === cancel) ws.data.cancel = undefined;
  }
}

export function sendResponsesJsonAsEvents(
  ws: ServerWebSocket<WsData>,
  response: Record<string, unknown>,
  onTerminal?: ResponsesTerminalReporter,
  onPayload?: ResponsesPayloadObserver,
): void {
  const sendObservedFrame = (payload: Record<string, unknown>) => {
    const text = JSON.stringify(payload);
    try {
      onPayload?.(text);
    } catch {
      /* payload observation must not affect WebSocket delivery */
    }
    sendTextFrame(ws, text);
  };
  const output = Array.isArray(response.output) ? response.output : [];
  sendObservedFrame({
    type: "response.created",
    response: { ...response, status: "in_progress", output: [] },
  });
  output.forEach((item, outputIndex) => {
    sendObservedFrame({
      type: "response.output_item.done",
      output_index: outputIndex,
      item,
    });
  });
  const finalStatus = response.status === "failed" || response.status === "incomplete"
    ? response.status
    : "completed";
  sendObservedFrame({
    type: `response.${finalStatus}` as "response.completed" | "response.failed" | "response.incomplete",
    response: { ...response, status: finalStatus },
  });
  onTerminal?.(finalStatus);
}

function errorPayloadFromText(text: string): Record<string, unknown> {
  try {
    const json = JSON.parse(text) as { error?: unknown };
    if (json.error && typeof json.error === "object" && !Array.isArray(json.error)) {
      return json.error as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {
    type: "upstream_error",
    message: text ? text.slice(0, 500) : "Upstream request failed",
  };
}

export async function sendResponseToWebSocket(
  ws: ServerWebSocket<WsData>,
  response: Response,
  isCurrent: () => boolean,
  options: {
    onTerminal?: ResponsesTerminalReporter;
    onSsePayload?: ResponsesPayloadObserver;
  } = {},
): Promise<void> {
  if (!isCurrent()) {
    await response.body?.cancel().catch(() => {});
    return;
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    if (!isCurrent()) return;
    sendJsonFrame(ws, buildWsErrorFrame(response.status, errorPayloadFromText(text), response.headers));
    return;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!response.body) {
    options.onTerminal?.("incomplete");
    sendJsonFrame(ws, buildWsErrorFrame(502, {
      type: "protocol_error",
      code: "websocket_protocol_error",
      message: `Unexpected successful upstream response without a body (${response.status})`,
    }, response.headers));
    return;
  }

  if (contentType.includes("text/event-stream")) {
    await pumpResponsesSseToWebSocket(ws, response.body, {
      isCurrent,
      onTerminal: options.onTerminal,
      onSsePayload: options.onSsePayload,
    });
    return;
  }

  if (contentType.includes("application/json")) {
    const text = await response.text();
    if (!isCurrent()) return;
    const json = JSON.parse(text) as Record<string, unknown>;
    sendResponsesJsonAsEvents(ws, json, options.onTerminal, options.onSsePayload);
    return;
  }

  const { prefix, stream } = await readBoundedPrefix(response.body);
  if (!isCurrent()) {
    await stream.cancel().catch(() => {});
    return;
  }
  if (looksLikeSse(prefix)) {
    await pumpResponsesSseToWebSocket(ws, stream, {
      isCurrent,
      onTerminal: options.onTerminal,
      onSsePayload: options.onSsePayload,
    });
    return;
  }

  const text = await new Response(stream).text();
  if (!isCurrent()) return;
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed) as Record<string, unknown>;
    sendResponsesJsonAsEvents(ws, json, options.onTerminal, options.onSsePayload);
    return;
  }

  options.onTerminal?.("incomplete");
  sendJsonFrame(ws, buildWsErrorFrame(502, {
    type: "protocol_error",
    code: "websocket_protocol_error",
    message: `Unexpected successful non-SSE upstream response (${contentType || "missing content-type"})`,
  }, response.headers));
}

export async function readBoundedPrefix(
  body: ReadableStream<Uint8Array>,
  maxBytes = 4096,
): Promise<{ prefix: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let remainder: Uint8Array | undefined;
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    const take = Math.min(value.byteLength, maxBytes - total);
    if (take > 0) {
      chunks.push(value.slice(0, take));
      total += take;
    }
    if (take < value.byteLength) {
      remainder = value.slice(take);
      break;
    }
  }
  const prefix = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    prefix.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      if (prefix.byteLength > 0) controller.enqueue(prefix);
      if (remainder && remainder.byteLength > 0) controller.enqueue(remainder);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { prefix, stream };
}

export function looksLikeSse(prefix: Uint8Array): boolean {
  const text = new TextDecoder().decode(prefix);
  return /^\s*(event:|data:)/.test(text);
}
