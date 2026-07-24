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
const OPEN2_BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36";

/**
 * Unofficial bridge for the public Open2 beta web client. The beta currently issues free,
 * anonymous sessions, but this private web protocol is not a stable API contract and may change
 * or disappear without notice. Keep all protocol assumptions isolated in this adapter.
 */

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

function sessionCacheKey(baseUrl: string, session?: string): string {
  return createHash("sha256").update(baseUrl).update("\0").update(session || "<anonymous>").digest("hex");
}

function normalizedBaseUrl(baseUrl: string): string {
  const parsed = new URL(baseUrl || OPEN2_DEFAULT_BASE_URL);
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  parsed.hash = "";
  return parsed.toString().replace(/\/$/, "");
}

function websocketUrl(baseUrl: string): string {
  const url = new URL("/api/agent/chat/ws", normalizedBaseUrl(baseUrl));
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

function refreshedSessionFromHeader(header: string | null): string | undefined {
  if (!header) return undefined;
  const match = /(?:^|[,;]\s*)solar_session=([^;]+)/.exec(header);
  return match?.[1];
}

async function requestSession(baseUrl: string, initialSession: string | undefined, signal?: AbortSignal): Promise<string> {
  const cacheKey = sessionCacheKey(baseUrl, initialSession);
  const cached = refreshedSessions.get(cacheKey);
  const candidates: Array<string | undefined> = [];
  if (cached) candidates.push(cached);
  if (initialSession && initialSession !== cached) candidates.push(initialSession);
  candidates.push(undefined);

  for (const candidate of candidates) {
    const headers: Record<string, string> = { "user-agent": OPEN2_BROWSER_USER_AGENT };
    if (candidate) headers.cookie = `${OPEN2_SESSION_COOKIE}=${candidate}`;
    const response = await fetch(`${normalizedBaseUrl(baseUrl)}/api/session`, {
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

function open2Usage(usage: Open2Usage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  const inputTokens = usage.input_tokens ?? 0;
  const outputTokens = usage.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    totalTokens: usage.total_tokens ?? inputTokens + outputTokens,
    ...(usage.cached_input_tokens !== undefined ? { cachedInputTokens: usage.cached_input_tokens } : {}),
    ...(usage.reasoning_tokens !== undefined ? { reasoningOutputTokens: usage.reasoning_tokens } : {}),
  };
}

/** Map public Open2 stream events into OpenCodex's provider-neutral event stream. */
export function mapOpen2Event(event: Open2Event): AdapterEvent[] {
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
        usage: open2Usage(event.data?.usage),
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
      }];
    default:
      return [{ type: "heartbeat" }];
  }
}

export function createOpen2BetaAdapter(provider: OcxProviderConfig): ProviderAdapter {
  return {
    name: "open2-beta",

    buildRequest() {
      return { url: websocketUrl(provider.baseUrl), method: "GET", headers: {}, body: "" };
    },

    async *parseStream(): AsyncGenerator<AdapterEvent> {
      yield { type: "error", message: "Open2 Beta adapter uses runTurn; the fetch/parseStream path is disabled." };
    },

    async runTurn(parsed, incoming, emit) {
      const configuredSession = provider.apiKey?.trim();
      if (incoming.abortSignal?.aborted) {
        emit({ type: "error", message: "Open2 Beta turn was aborted before start." });
        return;
      }

      const baseUrl = normalizedBaseUrl(provider.baseUrl || OPEN2_DEFAULT_BASE_URL);
      let session: string;
      try {
        session = await requestSession(baseUrl, configuredSession, incoming.abortSignal);
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        return;
      }

      await new Promise<void>(resolve => {
        let completed = false;
        let expectedSeq = 1;
        const finish = () => {
          if (completed) return;
          completed = true;
          clearTimeout(readyTimeout);
          incoming.abortSignal?.removeEventListener("abort", abort);
          resolve();
        };
        const fail = (message: string, extra: Partial<Extract<AdapterEvent, { type: "error" }>> = {}) => {
          if (completed) return;
          emit({ type: "error", message, ...extra });
          finish();
        };
        const socket = new WebSocket(websocketUrl(baseUrl), OPEN2_PROTOCOL, {
          handshakeTimeout: OPEN2_READY_TIMEOUT_MS,
          headers: {
            Cookie: `${OPEN2_SESSION_COOKIE}=${session}`,
            Origin: new URL(baseUrl).origin,
            "User-Agent": OPEN2_BROWSER_USER_AGENT,
          },
        });
        const readyTimeout = setTimeout(() => {
          fail("Open2 Beta WebSocket did not become ready in time.", { retryable: true });
          socket.terminate();
        }, OPEN2_READY_TIMEOUT_MS);
        const abort = () => {
          if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "cancel" }));
          socket.terminate();
          fail("Open2 Beta turn was aborted.");
        };
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
            socket.send(JSON.stringify({
              type: "start",
              request: {
                messages: open2Messages(parsed),
                reasoning_effort: open2ReasoningEffort(parsed, provider),
                last_input_tokens: null,
                model: parsed.modelId || provider.defaultModel || OPEN2_DEFAULT_MODEL,
                attachments: [],
                thread_id: parsed._clientThreadId || randomUUID(),
                message_id: randomUUID(),
                turn_index: open2Messages(parsed).filter(message => message.role === "user").length,
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
            const events = mapOpen2Event(frame.event);
            for (const event of events) emit(event);
            if (frame.event.type === "complete" || frame.event.type === "error") {
              finish();
              socket.close(1000, "turn complete");
            }
            return;
          }

          if (frame.type === "ack") return;
          fail(frame.message || "Open2 Beta returned an unexpected WebSocket frame.", {
            code: frame.code,
            retryable: frame.retryable,
          });
          socket.terminate();
        });

        socket.on("error", error => fail(`Open2 Beta WebSocket error: ${error.message}`, { retryable: true }));
        socket.on("close", () => {
          if (!completed) fail("Open2 Beta WebSocket closed before the turn completed.", { retryable: true });
        });
      });
    },
  };
}
