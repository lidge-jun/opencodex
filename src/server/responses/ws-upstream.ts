// Upstream WebSocket transport for the ChatGPT Codex backend.
//
// Why this exists: the Codex backend serves the responses_websockets path from
// a measurably faster queue than the plain SSE POST path. Measured 2026-08-12
// KST (same account, same payload, strictly sequential): gpt-5.6-luna TTFT p50
// ~1.0s over WS vs ~3.9s over SSE. Codex CLI itself defaults to the WS
// transport; opencodex previously always POSTed SSE, which is where its extra
// 2-3s of TTFT came from.
//
// The wrapper only swaps the transport. It dials wss:// with the same headers,
// sends the JSON body as a single `response.create` frame, and re-encodes the
// returned event frames as an SSE byte stream, so every downstream consumer
// (passthrough relay, adapter parsers, usage sniffing) is unchanged.

import { compareBunVersions } from "../../lib/bun-stream-caps";
import { resolveProxyRoute } from "../../lib/proxy-env";
import type { CodexWsQuotaObserver } from "./codex-ws-metadata";
import { CODEX_RESPONSES_HTTP_URL, CODEX_RESPONSES_WS_URL, prepareCodexHttpInit, prepareCodexWsRequest } from "./codex-ws-request";
import { codexWsExchange } from "./codex-ws-exchange";
import { CodexWsSession } from "./codex-ws-session";
import { codexWsPool, codexWsReuseIdentity } from "./codex-ws-pool";
import { codexWsCreateFrameExceedsLimit } from "./codex-ws-wire";
export { CODEX_WS_RESPONSE_PRELUDE_TIMEOUT_MS, MAX_CODEX_WS_FRAME_BYTES, MAX_CODEX_WS_QUEUE_BYTES,
  MAX_CODEX_WS_CREATE_FRAME_BYTES, CODEX_WS_CREATE_FRAME_LIMIT_BYTES, codexWsCreateFrameExceedsLimit,
  isCodexWsQuotaObservedResponse, isCodexWsUpstreamResponse } from "./codex-ws-wire";
export const MIN_BOUNDED_CODEX_WS_BUN_VERSION = "1.4.0";

/**
 * Dial URL for a request URL. The canonical ChatGPT backend keeps its constant;
 * an operator-opted OpenAI-compatible upstream swaps https for wss on the same
 * path so gateways that serve the Responses WebSocket protocol on their
 * /v1/responses path get the same fast lane. Plain HTTP remains on SSE because
 * a provider WS handshake would otherwise send credentials and request data
 * without transport encryption.
 */
function wsUpstreamUrlFor(httpUrl: string): string {
  if (httpUrl === CODEX_RESPONSES_HTTP_URL) return CODEX_RESPONSES_WS_URL;
  return httpUrl.replace(/^http(s?):/, "ws$1:");
}

/**
 * An operator-opted OpenAI-compatible upstream only joins the WS lane for
 * Responses endpoints: the WebSocket path speaks the Responses event protocol,
 * and every downstream consumer (adapter parsers, usage sniffing, SSE relay)
 * assumes that wire. Other paths (chat completions, images, search) stay HTTP.
 */
function isResponsesWebsocketEligibleUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === "https:"
    && parsed.pathname.endsWith("/responses");
}
export type BunRuntimeIdentity = {
  version: string;
  versionWithSha: string;
};

export type BunRuntimeGateInput = string | BunRuntimeIdentity;

export function currentBunRuntimeIdentity(): BunRuntimeIdentity {
  return {
    version: Bun.version,
    versionWithSha: Bun.version_with_sha,
  };
}

function boundedRelayVersion(input: BunRuntimeGateInput): string | null {
  if (typeof input === "string") return input.trim() || null;
  const numericVersion = input.version.trim();
  const numericMatch = /^(\d+\.\d+\.\d+)$/.exec(numericVersion);
  const detailedMatch = /^v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\s+\([0-9a-fA-F]+\)$/.exec(
    input.versionWithSha.trim(),
  );
  if (!numericMatch || !detailedMatch) return null;
  const detailedNumeric = /^(\d+\.\d+\.\d+)/.exec(detailedMatch[1])?.[1];
  return detailedNumeric === numericMatch[1] ? detailedMatch[1] : null;
}

/**
 * Bun 1.3.14 does not propagate a stalled HTTP response socket back to a JS
 * ReadableStream producer on Windows. A real raw-TCP slow-client probe drained
 * the entire upstream despite the eager relay queue; Bun 1.4.0-canary.1 stopped
 * below one MiB. Prereleases still fail closed; release builds before 1.4.0
 * fall back to HTTP SSE.
 */
export function bunSupportsBoundedCodexWsRelay(
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
): boolean {
  const version = boundedRelayVersion(runtime);
  if (!version) return false;
  if (/^\d+\.\d+\.\d+-/.test(version.trim())) return false;
  const comparison = compareBunVersions(version, MIN_BOUNDED_CODEX_WS_BUN_VERSION);
  return comparison !== null && comparison >= 0;
}

export function shouldUseCodexWsUpstream(
  url: string,
  init?: RequestInit,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  upstreamWebsocketConfigured = false,
): boolean {
  if (!bunSupportsBoundedCodexWsRelay(runtime)) return false;
  if (url !== CODEX_RESPONSES_HTTP_URL && !upstreamWebsocketConfigured) return false;
  if (upstreamWebsocketConfigured && !isResponsesWebsocketEligibleUrl(url)) return false;
  if ((init?.method ?? "GET").toUpperCase() !== "POST") return false;
  const body = init?.body;
  if (typeof body !== "string") return false;
  // Only root-level stream:true selects WS: JSON-mode calls keep the HTTP path
  // because the WS path only speaks the event protocol, and a nested
  // {"metadata":{"stream":true}} must not flip the transport. Parsing (not
  // substring matching) also keeps whitespace-formatted bodies routable.
  try {
    const parsed = JSON.parse(body) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      && (parsed as Record<string, unknown>).stream === true;
  } catch {
    return false;
  }
}

export function codexWsUpstreamFetch(
  url: string,
  init: RequestInit,
  sseFallback: typeof globalThis.fetch,
  runtime: BunRuntimeGateInput = currentBunRuntimeIdentity(),
  onQuota?: CodexWsQuotaObserver,
  beforeDispatch?: (headers: Headers) => void,
): Promise<Response> {
  const prepared = prepareCodexWsRequest(url, init);
  if (!prepared) return sseFallback(url, prepareCodexHttpInit(url, init));
  init = prepared.httpInit;
  if (!bunSupportsBoundedCodexWsRelay(runtime)) {
    return sseFallback(url, init);
  }
  const signal = init.signal ?? undefined;
  if (signal?.aborted) {
    return Promise.reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
  }

  const { frameText, headers } = prepared;

  // Decide before dialing. Once the socket is open the caller already holds a
  // streaming Response, so the oversized close can only be surfaced as a stream
  // error — and a resend at that point could double-generate. Measuring the
  // frame we are about to send keeps the whole failure mode unreachable.
  if (codexWsCreateFrameExceedsLimit(frameText)) {
    return sseFallback(url, init);
  }

  const wsUrl = wsUpstreamUrlFor(url);
  const proxyRoute = resolveProxyRoute(new URL(wsUrl));
  if (proxyRoute.kind === "fallback") return sseFallback(url, init);
  const proxy = proxyRoute.kind === "proxy" ? proxyRoute.proxy : undefined;
  // A genuine caller `originator` is already in these headers via the forward
  // set. Never fabricate one here: pool/forward traffic must not impersonate
  // Codex CLI, per the metadata-integrity contract. (The backend's fast lane
  // keys on WS + originator, so callers without the tag simply keep their own
  // provenance and scheduling.)

  // A local refusal is not a failed upgrade and must never enter the SSE fallback path.
  try {
    beforeDispatch?.(new Headers(headers));
  } catch (error) {
    return Promise.reject(error);
  }
  let session: CodexWsSession;
  try {
    const identity = codexWsReuseIdentity(url, headers, frameText, proxy);
    session = (identity ? codexWsPool.acquire(identity, wsUrl, headers, proxy) : null)
      ?? new CodexWsSession(wsUrl, headers, false, undefined, proxy);
    if (!session.busy && !session.reserve()) {
      session.dispose();
      return sseFallback(url, init);
    }
  } catch {
    return sseFallback(url, init);
  }
  return codexWsExchange({ session, url, init, prepared, sseFallback, onQuota, beforeDispatch });
}
