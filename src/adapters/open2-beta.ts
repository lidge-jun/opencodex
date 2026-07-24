import { createHash, randomUUID } from "node:crypto";
import WebSocket, { type RawData } from "ws";
import { mapReasoningEffort } from "../reasoning-effort";
import type { AdapterEvent, OcxContentPart, OcxParsedRequest, OcxProviderConfig, OcxUsage } from "../types";
import type { ProviderAdapter } from "./base";
import { contentPartsToText } from "./image";

const OPEN2_PROTOCOL = "solar-chat.v1";
const OPEN2_DEFAULT_BASE_URL = "https://open2-beta.upstage.ai";
const OPEN2_DEFAULT_MODEL = "solar-open2";
const OPEN2_SESSION_COOKIE = "solar_session";
const OPEN2_READY_TIMEOUT_MS = 15_000;
const OPEN2_IDLE_TIMEOUT_MS = 60_000;
const OPEN2_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";

// Unofficial bridge for the free, anonymous Open2 beta web client. Keep assumptions about this
// private, unstable protocol isolated in this adapter because it may change or disappear.

/**
 * `/api/session` rotates `solar_session` on every successful read. Keep that refreshed value in
 * memory so a long-running proxy gets sliding sessions without writing browser credentials back to
 * config.json. The cache key is a hash; the original cookie is never duplicated as a Map key.
 */
const refreshedSessions = new Map<string, string>();

interface Open2WireMessage {
  role: "user" | "assistant";
  content: string;
}

interface Open2Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
}

interface Open2Event {
  type?: string;
  content?: string;
  status?: number;
  code?: string;
  error?: string;
  retryable?: boolean;
  data?: {
    usage?: Open2Usage;
    stop_reason?: string;
  };
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  cached_input_tokens?: number;
  reasoning_tokens?: number;
}

interface Open2Frame {
  type?: string;
  protocol?: string;
  seq?: number;
  code?: string;
  message?: string;
  retryable?: boolean;
  event?: Open2Event;
}

const OPEN2_USAGE_KEYS = [
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "cached_input_tokens",
  "reasoning_tokens",
] as const;

interface Open2SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (raw: RawData) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "close", listener: () => void): this;
}

interface Open2SocketOptions {
  handshakeTimeout: number;
  headers: Record<string, string>;
}

/** Injectable transport seams used by focused protocol-lifecycle tests. */
export interface Open2AdapterDependencies {
  fetch?: typeof fetch;
  createSocket?: (url: string, protocol: string, options: Open2SocketOptions) => Open2SocketLike;
  readyTimeoutMs?: number;
  idleTimeoutMs?: number;
  hasOutboundProxy?: (target: URL) => boolean;
}

/** Hash the upstream origin so the in-memory cache never duplicates a cookie as a Map key. */
function sessionCacheKey(baseUrl: string): string {
  return createHash("sha256").update(baseUrl).digest("hex");
}

/** Normalize a configured origin before constructing the HTTP and WebSocket endpoints. */
function normalizedBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl || OPEN2_DEFAULT_BASE_URL);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

/** Convert an Open2 HTTP origin into its fixed chat WebSocket endpoint. */
function websocketUrl(baseUrl: string): string {
  const url = new URL("/api/agent/chat/ws", normalizedBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

/** Extract only the Open2 session cookie value from a Set-Cookie response header. */
function refreshedSessionFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /(?:^|[,;]\s*)solar_session=([^;]+)/.exec(header);
  return match?.[1];
}

/** Clear cached anonymous sessions; exported for deterministic lifecycle tests. */
export function resetOpen2SessionCache(): void {
  refreshedSessions.clear();
}

/**
 * Create or rotate an anonymous Open2 web session. User-configured API keys are deliberately never
 * accepted here: they are unrelated credentials and must not be copied into a web-session cookie.
 */
export async function requestOpen2Session(
  baseUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const cacheKey = sessionCacheKey(baseUrl);
  const cached = refreshedSessions.get(cacheKey);
  const candidates: Array<string | undefined> = cached ? [cached, undefined] : [undefined];

  for (const candidate of candidates) {
    const headers: Record<string, string> = { "user-agent": OPEN2_BROWSER_USER_AGENT };
    if (candidate) headers.cookie = `${OPEN2_SESSION_COOKIE}=${candidate}`;
    const response = await fetchImpl(`${normalizedBaseUrl(baseUrl)}/api/session`, {
      headers,
      signal,
    });
    if (!response.ok) continue;
    const payload = await response.json() as { token?: unknown };
    if (typeof payload.token !== "string" || payload.token.length === 0) continue;
    const refreshed = refreshedSessionFromHeader(response.headers.get("set-cookie")) ?? candidate;
    if (!refreshed) continue;
    refreshedSessions.set(cacheKey, refreshed);
    return refreshed;
  }

  refreshedSessions.delete(cacheKey);
  throw new Error("Open2 Beta could not create an anonymous web session.");
}

/** Flatten supported text content without forwarding image payload bytes to the text-only wire. */
function textContent(content: string | OcxContentPart[]): string {
  return typeof content === "string" ? content : contentPartsToText(content);
}

/** Convert Codex history into the user/assistant-only wire accepted by Open2 Beta. */
export function open2Messages(parsed: OcxParsedRequest): Open2WireMessage[] {
  const messages: Open2WireMessage[] = [];
  const systemPrompt = parsed.context.systemPrompt?.filter(Boolean).join("\n\n") ?? "";

  for (const message of parsed.context.messages) {
    if (message.role === "user" || message.role === "developer") {
      const content = textContent(message.content);
      messages.push({ role: "user", content: message.role === "developer" ? `[Developer]\n${content}` : content });
      continue;
    }
    if (message.role === "assistant") {
      const content = message.content.flatMap(part => {
        if (part.type === "text") return [part.text];
        if (part.type === "thinking") return [];
        return [`[Tool call: ${part.name} ${JSON.stringify(part.arguments)}]`];
      }).join("\n");
      if (content) messages.push({ role: "assistant", content });
      continue;
    }
    messages.push({
      role: "user",
      content: `[Tool result: ${message.toolName}]\n${textContent(message.content)}`,
    });
  }

  if (systemPrompt) {
    const prefix = `[System]\n${systemPrompt}`;
    const firstUser = messages.find(message => message.role === "user");
    if (firstUser) firstUser.content = `${prefix}\n\n${firstUser.content}`;
    else messages.unshift({ role: "user", content: prefix });
  }

  return messages;
}

/** Map Codex reasoning labels onto the four values accepted by the beta web client. */
export function open2ReasoningEffort(parsed: OcxParsedRequest, provider: OcxProviderConfig): string {
  const mapped = mapReasoningEffort(provider, parsed.modelId, parsed.options.reasoning);
  if (mapped === "none" || mapped === "medium" || mapped === "high" || mapped === "max") return mapped;
  switch (parsed.options.reasoning) {
    case "none": return "none";
    case "high": return "high";
    case "xhigh": return "high";
    case "max": return "max";
    default: return "medium";
  }
}

/** Convert an Open2 token snapshot into OpenCodex usage fields. */
function open2Usage(usage: Open2Usage | undefined): OcxUsage | undefined {
  const normalized = normalizedOpen2Usage(usage);
  if (!normalized) return undefined;
  const inputTokens = normalized.input_tokens ?? 0;
  const outputTokens = normalized.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: normalized.total_tokens ?? inputTokens + outputTokens,
    ...(normalized.cached_input_tokens !== undefined ? { cachedInputTokens: normalized.cached_input_tokens } : {}),
    ...(normalized.reasoning_tokens !== undefined ? { reasoningOutputTokens: normalized.reasoning_tokens } : {}),
  };
}

/** Keep only finite numeric usage fields so partial snapshots cannot erase earlier counters. */
function normalizedOpen2Usage(usage: Open2Usage | undefined): Open2Usage | undefined {
  if (!usage) return undefined;
  const normalized: Open2Usage = {};
  for (const key of OPEN2_USAGE_KEYS) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value)) normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Read usage from either standalone top-level frames or the terminal nested payload. */
function open2UsageFromEvent(event: Open2Event): Open2Usage | undefined {
  const nested = normalizedOpen2Usage(event.data?.usage);
  const topLevel = normalizedOpen2Usage({
    input_tokens: event.input_tokens,
    output_tokens: event.output_tokens,
    total_tokens: event.total_tokens,
    cached_input_tokens: event.cached_input_tokens,
    reasoning_tokens: event.reasoning_tokens,
  });
  if (!nested && !topLevel) return undefined;
  return { ...(nested ?? {}), ...(topLevel ?? {}) };
}

/** Merge cumulative snapshots by replacement, never addition, so repeated usage frames do not double-count. */
function mergeOpen2Usage(current: Open2Usage | undefined, next: Open2Usage | undefined): Open2Usage | undefined {
  const normalizedNext = normalizedOpen2Usage(next);
  if (!current && !normalizedNext) return undefined;
  return { ...(current ?? {}), ...(normalizedNext ?? {}) };
}

/** True when a target host is explicitly exempted from the process proxy configuration. */
function open2NoProxyMatch(target: URL, rawNoProxy: string): boolean {
  const hostname = target.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const targetPort = target.port || (target.protocol === "wss:" ? "443" : "80");
  return rawNoProxy.split(",").some(rawEntry => {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) return false;
    if (entry === "*") return true;
    if (entry.includes("://")) {
      try {
        const parsed = new URL(entry);
        entry = parsed.host;
      } catch {
        return false;
      }
    }
    entry = entry.replace(/^\*\./, ".");
    let entryHost = entry;
    let entryPort = "";
    if (entry.startsWith("[")) {
      const close = entry.indexOf("]");
      if (close >= 0) {
        entryHost = entry.slice(1, close);
        entryPort = entry.slice(close + 1).replace(/^:/, "");
      }
    } else if (entry.indexOf(":") === entry.lastIndexOf(":")) {
      const colon = entry.lastIndexOf(":");
      if (colon > 0) {
        entryHost = entry.slice(0, colon);
        entryPort = entry.slice(colon + 1);
      }
    }
    entryHost = entryHost.replace(/^\./, "");
    if (entryPort && entryPort !== targetPort) return false;
    return hostname === entryHost || hostname.endsWith(`.${entryHost}`);
  });
}

/**
 * Detect an outbound proxy that the raw `ws` transport would bypass. The adapter fails closed in
 * that configuration unless the Open2 host is explicitly covered by NO_PROXY.
 */
export function open2HasUnsupportedProxy(target: URL, env: NodeJS.ProcessEnv = process.env): boolean {
  const proxy = target.protocol === "wss:"
    ? env.HTTPS_PROXY ?? env.https_proxy ?? env.ALL_PROXY ?? env.all_proxy ?? env.HTTP_PROXY ?? env.http_proxy
    : env.HTTP_PROXY ?? env.http_proxy ?? env.ALL_PROXY ?? env.all_proxy;
  if (!proxy?.trim()) return false;
  return !open2NoProxyMatch(target, env.NO_PROXY ?? env.no_proxy ?? "");
}

/** Map public Open2 stream events into OpenCodex's provider-neutral event stream. */
export function mapOpen2Event(event: Open2Event, accumulatedUsage?: OcxUsage): AdapterEvent[] {
  switch (event.type) {
    case "delta":
      return event.content ? [{ type: "text_delta", text: event.content }] : [];
    case "thinking_delta":
      return event.content ? [{ type: "thinking_delta", thinking: event.content }] : [];
    case "usage":
    case "metrics":
    case "progress":
    case "assessment":
    case "tool_call":
    case "tool_call_delta":
    case "tool_result":
      return [{ type: "heartbeat" }];
    case "complete":
      return [{
        type: "done",
        usage: accumulatedUsage ?? open2Usage(open2UsageFromEvent(event)),
        stopReason: event.data?.stop_reason,
        endTurn: true,
      }];
    case "error":
      return [{
        type: "error",
        message: event.error || "Open2 Beta returned an error.",
        status: event.status,
        code: event.code,
        retryable: event.retryable,
        ...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
      }];
    default:
      return [{ type: "heartbeat" }];
  }
}

/** Build the anonymous Open2 beta adapter with optional injected transport seams for tests. */
export function createOpen2BetaAdapter(
  provider: OcxProviderConfig,
  dependencies: Open2AdapterDependencies = {},
): ProviderAdapter {
  const fetchImpl = dependencies.fetch ?? fetch;
  const createSocket = dependencies.createSocket
    ?? ((url: string, protocol: string, options: Open2SocketOptions) => new WebSocket(url, protocol, options));
  const readyTimeoutMs = dependencies.readyTimeoutMs ?? OPEN2_READY_TIMEOUT_MS;
  const idleTimeoutMs = dependencies.idleTimeoutMs ?? OPEN2_IDLE_TIMEOUT_MS;
  const hasOutboundProxy = dependencies.hasOutboundProxy ?? open2HasUnsupportedProxy;
  return {
    name: "open2-beta",

    buildRequest() {
      return { url: websocketUrl(provider.baseUrl), method: "GET", headers: {}, body: "" };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Open2 Beta adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit) {
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Open2 Beta turn was aborted before start." });
        return;
      }

      const baseUrl = normalizedBaseUrl(provider.baseUrl || OPEN2_DEFAULT_BASE_URL);
      const target = new URL(websocketUrl(baseUrl));
      if (hasOutboundProxy(target)) {
        emit({
          type: "error",
          message: "Open2 Beta WebSockets cannot safely use the configured outbound proxy. Add open2-beta.upstage.ai to NO_PROXY or disable this provider.",
        });
        return;
      }
      let session: string;
      try {
        session = await requestOpen2Session(baseUrl, incoming.abortSignal, fetchImpl);
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      await new Promise<void>(resolve => {
        let completed = false;
        let expectedSeq = 1;
        let pendingUsage: Open2Usage | undefined;
        let readyTimeout: ReturnType<typeof setTimeout> | undefined;
        let idleTimeout: ReturnType<typeof setTimeout> | undefined;
        let socket: Open2SocketLike | undefined;
        const abort = () => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
          fail("Open2 Beta turn was aborted.");
          socket?.terminate();
        };
        const finish = () => {
          if (completed) return;
          completed = true;
          clearTimeout(readyTimeout);
          clearTimeout(idleTimeout);
          incoming.abortSignal?.removeEventListener("abort", abort);
          resolve();
        };
        const fail = (message: string, extra: Partial<Extract<AdapterEvent, { type: "error" }>> = {}) => {
          if (completed) return;
          emit({ type: "error", message, ...extra });
          finish();
        };
        const resetIdleTimeout = () => {
          clearTimeout(idleTimeout);
          idleTimeout = setTimeout(() => {
            fail("Open2 Beta WebSocket went idle before the turn completed.", { retryable: true });
            socket?.terminate();
          }, idleTimeoutMs);
        };
        try {
          socket = createSocket(websocketUrl(baseUrl), OPEN2_PROTOCOL, {
            handshakeTimeout: readyTimeoutMs,
            headers: {
              Cookie: `${OPEN2_SESSION_COOKIE}=${session}`,
              Origin: new URL(baseUrl).origin,
              "User-Agent": OPEN2_BROWSER_USER_AGENT,
            },
          });
        } catch (error) {
          fail(`Open2 Beta WebSocket setup failed: ${error instanceof Error ? error.message : String(error)}`);
          return;
        }
        readyTimeout = setTimeout(() => {
          fail("Open2 Beta WebSocket did not become ready in time.", { retryable: true });
          socket?.terminate();
        }, readyTimeoutMs);
        incoming.abortSignal?.addEventListener("abort", abort, { once: true });

        socket.on("message", (raw: RawData) => {
          let frame: Open2Frame;
          try {
            frame = JSON.parse(raw.toString()) as Open2Frame;
          } catch {
            fail("Open2 Beta returned an invalid WebSocket frame.");
            socket.terminate();
            return;
          }

          if (frame.type === "ready") {
            if (frame.protocol !== OPEN2_PROTOCOL) {
              fail("Open2 Beta returned an incompatible WebSocket protocol.");
              socket.terminate();
              return;
            }
            clearTimeout(readyTimeout);
            resetIdleTimeout();
            const wireMessages = open2Messages(parsed);
            socket.send(JSON.stringify({
              type: "start",
              request: {
                messages: wireMessages,
                reasoning_effort: open2ReasoningEffort(parsed, provider),
                last_input_tokens: null,
                model: parsed.modelId || provider.defaultModel || OPEN2_DEFAULT_MODEL,
                attachments: [],
                thread_id: parsed._clientThreadId || randomUUID(),
                message_id: randomUUID(),
                turn_index: wireMessages.filter(message => message.role === "user").length,
                locale: "en",
              },
            }));
            return;
          }

          if (frame.type === "event" && frame.event) {
            if (frame.seq !== expectedSeq) {
              fail(`Open2 Beta WebSocket sequence gap: expected ${expectedSeq}, got ${String(frame.seq)}.`);
              socket.terminate();
              return;
            }
            expectedSeq += 1;
            resetIdleTimeout();
            pendingUsage = mergeOpen2Usage(pendingUsage, open2UsageFromEvent(frame.event));
            const events = mapOpen2Event(frame.event, open2Usage(pendingUsage));
            for (const event of events) emit(event);
            if (frame.event.type === "complete" || frame.event.type === "error") {
              finish();
              socket.close(1000, "turn complete");
            }
            return;
          }

          if (frame.type === "ack") {
            resetIdleTimeout();
            return;
          }
          fail(frame.message || "Open2 Beta returned an unexpected WebSocket frame.", {
            code: frame.code,
            retryable: frame.retryable,
          });
          socket.terminate();
        });

        socket.on("error", error => {
          fail(`Open2 Beta WebSocket error: ${error.message}`, { retryable: true });
          socket?.terminate();
        });
        socket.on("close", () => {
          if (!completed) fail("Open2 Beta WebSocket closed before the turn completed.", { retryable: true });
        });
      });
    },
  };
}
