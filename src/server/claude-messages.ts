/**
 * Anthropic Messages inbound (/v1/messages + /v1/messages/count_tokens) for Claude Code.
 *
 * Translate-and-replay (devlog/260711_claude_inbound/010): the Anthropic request is
 * converted to a /v1/responses body and replayed through handleResponses on an
 * internal Request, so routing/OAuth/account-pool/failover/sidecars are inherited
 * unchanged. The Responses output (SSE or JSON) is converted back to Anthropic shape.
 */
import { FORWARD_HEADERS } from "../adapters/openai-responses";
import { enforceAnthropicImageLimits } from "../adapters/anthropic-image-guard";
import { normalizeAnthropicImages } from "../adapters/anthropic-image-normalize";
import { AnthropicRequestError, anthropicToResponsesTranslation, extractOcxRouteDirective, resolveInboundModel, type ClaudeCacheKeySource } from "../claude/inbound";
import { resolveDesktop3pAlias } from "../claude/desktop-3p";
import { recordDesktopRequest } from "../claude/desktop-health";
import { stripOneMillionMarker } from "../claude/context-windows";
import { captureClaudeInbound } from "../claude/inbound-debug";
import { isTransientUpstreamStatus } from "../lib/upstream-retry";
import {
  anthropicErrorBody,
  anthropicErrorResponse,
  collectAnthropicMessage,
  responsesJsonToAnthropicMessage,
  responsesSseToAnthropicSse,
} from "../claude/outbound";
import { clearableDeadline, idleDeadline } from "../lib/abort";
import { estimateTokens } from "../lib/token-estimate";
import { routeModel } from "../router";
import type { OcxConfig } from "../types";
import { readJsonRequestBody } from "./request-decompress";
import { addFinalRequestLog, httpStatusForTerminalStatus, recordFirstOutput, type RequestLogContext, type RequestLogEntry } from "./request-log";
import { responseWithDeferredRequestLog } from "./relay";
import { handleResponses } from "./responses";

type Rec = Record<string, unknown>;

function isRec(v: unknown): v is Rec {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Resolve Claude-only sidecar overrides without mutating the shared server config. */
export function buildClaudeReplayConfig(config: OcxConfig): OcxConfig {
  return {
    ...config,
    webSearchSidecar: {
      ...config.webSearchSidecar,
      ...config.claudeCode?.webSearchSidecar,
    },
    visionSidecar: {
      ...config.visionSidecar,
      ...config.claudeCode?.visionSidecar,
    },
  };
}

function claudeInboundDisabled(config: OcxConfig): Response | null {
  if (config.claudeCode?.enabled === false) {
    return anthropicErrorResponse(403, "Claude inbound is disabled (GUI: Claude ON toggle / config.claudeCode.enabled)", "permission_error");
  }
  return null;
}

async function readAnthropicBody(req: Request): Promise<unknown> {
  try {
    return await readJsonRequestBody(req);
  } catch (err) {
    throw new AnthropicRequestError(err instanceof Error && err.message ? err.message : "Invalid JSON body");
  }
}

// ── Native Anthropic passthrough (subscription OAuth pierce) ──────────────────────
// When Claude Code runs with ONLY ANTHROPIC_BASE_URL set (subscription mode — the
// connectors warning stays off), it sends its OWN claude.ai OAuth Bearer to us.
// Requests for genuine claude/anthropic models that no alias/modelMap claims are
// forwarded VERBATIM to api.anthropic.com with the caller's credential and all
// end-to-end headers, so betas/thinking signatures/billing identity stay native.
// (Evidence: teamclaude --no-mitm + Vercel gateway docs, devlog 003/060.)

const PASSTHROUGH_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer",
  "proxy-authenticate", "proxy-authorization", "host", "content-length",
  "accept-encoding", "x-opencodex-api-key", "origin",
]);

function hasAnthropicNativeCredential(req: Request): boolean {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ?? "";
  const apiKey = req.headers.get("x-api-key")?.trim() ?? "";
  return bearer.startsWith("sk-ant-") || apiKey.startsWith("sk-ant-");
}

function wantsNativePassthrough(req: Request, config: OcxConfig, model: unknown): model is string {
  if (config.claudeCode?.nativePassthrough === false) return false;
  if (typeof model !== "string" || !/^(claude|anthropic)/i.test(model)) return false;
  if (!hasAnthropicNativeCredential(req)) return false;
  // An alias or modelMap hit means the user asked for a ROUTED model: translate instead.
  return resolveInboundModel(model, config.claudeCode) === model;
}

/** Format a 32-hex cache key as a uuid-shaped session id (version/variant nibbles forced). */
function uuidFromHex(hex32: string): string {
  const h = (hex32 + "0".repeat(32)).slice(0, 32);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function anthropicUsageToOcx(usage: Rec | undefined): { inputTokens: number; outputTokens: number; cachedInputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number } | undefined {
  if (!usage) return undefined;
  const num = (v: unknown) => typeof v === "number" ? v : 0;
  const hasCache = usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined;
  const read = num(usage.cache_read_input_tokens);
  const write = num(usage.cache_creation_input_tokens);
  // Anthropic input_tokens excludes cache read/write; normalize to the canonical
  // inclusive convention (types.ts OcxUsage / devlog 070). cached = READS only.
  return {
    inputTokens: num(usage.input_tokens) + read + write,
    outputTokens: num(usage.output_tokens),
    ...(hasCache ? {
      cachedInputTokens: read,
      cacheReadInputTokens: read,
      cacheCreationInputTokens: write,
    } : {}),
  };
}

/** Body-occupancy guard for the native passthrough (devlog 260716_passthrough_followups/010). */
export interface PassthroughBodyGuard {
  /** Idle window in ms — raw upstream-byte inactivity while a read is pending. 0 disables. */
  stallMs: number;
  /** Cumulative body byte cap. 0 disables. */
  maxBytes: number;
  /** Client request signal for deterministic cancel classification. */
  reqSignal?: AbortSignal;
}

type PassthroughCloseReason = "terminal" | "client_cancel" | "body_stall" | "body_overflow";

/**
 * Tap an Anthropic-vocabulary SSE stream for the request log (usage + terminal),
 * bounding body occupancy: idle (silence-only, timed ONLY while a reader.read() is
 * pending so downstream backpressure never counts as upstream inactivity) and a
 * cumulative byte cap. On stall/overflow it appends a protocol-compatible Anthropic
 * `event: error` terminal frame after a blank-line boundary, closes, and cancels the
 * upstream reader — never a total-wall-clock bound (slow-but-alive streams live).
 * Exported for deterministic unit tests.
 */
export function tapAnthropicSseForLog(
  upstream: ReadableStream<Uint8Array>,
  logCtx: RequestLogContext,
  finalize: (status: number, meta: { closeReason: PassthroughCloseReason }) => void,
  guard?: PassthroughBodyGuard,
): ReadableStream<Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";
  let usageAcc: Rec = {};
  const inspect = (chunk: Uint8Array) => {
    buffer += decoder.decode(chunk, { stream: true });
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split("\n").filter(l => l.startsWith("data: ")).map(l => l.slice(6)).join("");
      if (!dataLine) continue;
      let data: unknown;
      try { data = JSON.parse(dataLine); } catch { continue; }
      if (!isRec(data)) continue;
      if (data.type === "message_start" && isRec(data.message) && isRec(data.message.usage)) {
        usageAcc = { ...usageAcc, ...data.message.usage };
      } else if (data.type === "message_delta" && isRec(data.usage)) {
        usageAcc = { ...usageAcc, ...data.usage };
      }
    }
  };
  const reader = upstream.getReader();
  let settled = false;
  let bodyBytes = 0;
  let tapController: ReadableStreamDefaultController<Uint8Array> | undefined;

  const recordUsage = () => {
    logCtx.usage = anthropicUsageToOcx(Object.keys(usageAcc).length > 0 ? usageAcc : undefined);
  };
  const failBody = (closeReason: "body_stall" | "body_overflow", errType: string, message: string) => {
    if (settled) return;
    settled = true;
    idle.cancel();
    detachAbort();
    recordUsage();
    finalize(200, { closeReason });
    const payload = JSON.stringify({ type: "error", error: { type: errType, message } });
    try {
      // Leading blank line terminates any partial SSE block so the frame parses cleanly
      // (relaySseWithFailedTail policy, Anthropic wire shape).
      tapController?.enqueue(encoder.encode(`\n\nevent: error\ndata: ${payload}\n\n`));
      tapController?.close();
    } catch { /* client already torn down */ }
    reader.cancel(new DOMException(message, closeReason === "body_stall" ? "TimeoutError" : "QuotaExceededError")).catch(() => {});
  };
  const idle = idleDeadline(guard?.stallMs ?? 0, () => {
    failBody(
      "body_stall",
      "timeout_error",
      `anthropic passthrough body stalled: no upstream bytes for ${Math.round((guard?.stallMs ?? 0) / 1000)}s`,
    );
  });
  // Deterministic client-cancel classification: Bun may surface a client abort as a
  // reader.read() rejection OR a resolved done (src/lib/abort.ts cancelBodyOnAbort
  // rationale), so the listener performs first-wins settlement itself instead of
  // relying on which shape the read takes.
  const onClientAbort = () => {
    if (settled) return;
    settled = true;
    idle.cancel();
    detachAbort();
    finalize(499, { closeReason: "client_cancel" });
    try { tapController?.close(); } catch { /* downstream already torn down */ }
    reader.cancel(guard?.reqSignal?.reason).catch(() => {});
  };
  const detachAbort = (() => {
    const signal = guard?.reqSignal;
    if (!signal) return () => {};
    if (signal.aborted) {
      queueMicrotask(onClientAbort);
      return () => {};
    }
    signal.addEventListener("abort", onClientAbort, { once: true });
    return () => signal.removeEventListener("abort", onClientAbort);
  })();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      tapController = controller;
    },
    async pull(controller) {
      if (settled) return;
      try {
        idle.reset();
        const { done, value } = await reader.read();
        idle.pause();
        if (settled) return; // stall/overflow/abort won the race while we awaited
        if (done) {
          settled = true;
          idle.cancel();
          detachAbort();
          recordUsage();
          finalize(200, { closeReason: "terminal" });
          controller.close();
          return;
        }
        if (value.byteLength > 0) {
          bodyBytes += value.byteLength;
          if (guard && guard.maxBytes > 0 && bodyBytes > guard.maxBytes) {
            failBody(
              "body_overflow",
              "api_error",
              `anthropic passthrough body exceeded ${guard.maxBytes} bytes`,
            );
            return;
          }
        }
        inspect(value);
        controller.enqueue(value);
      } catch (err) {
        if (settled) return;
        settled = true;
        idle.cancel();
        detachAbort();
        recordUsage();
        finalize(200, { closeReason: "terminal" });
        try { controller.error(err); } catch { /* torn down */ }
      }
    },
    cancel(reason) {
      if (!settled) {
        settled = true;
        idle.cancel();
        detachAbort();
        finalize(499, { closeReason: "client_cancel" });
      }
      reader.cancel(reason).catch(() => {});
    },
  });
}

async function anthropicNativePassthrough(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  logIds: { requestId: string; start: number } | undefined,
  body: Rec,
  pathname: string,
): Promise<Response> {
  const model = typeof body.model === "string" ? body.model : "unknown";
  logCtx.model = model;
  logCtx.provider = "anthropic-native";
  logCtx.requestedModel = model;
  let logged = false;
  const finalize = (status: number, meta: { closeReason: PassthroughCloseReason | "non_stream" }) => {
    if (!logIds || logged) return;
    logged = true;
    addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, meta);
  };

  const base = (config.claudeCode?.anthropicBaseUrl ?? "https://api.anthropic.com").replace(/\/$/, "");
  const search = new URL(req.url).search;
  // Native passthrough bypasses the anthropic adapter, so the generous image pipeline
  // (devlog/260714_image_normalization_pipeline/040) must run here: tier-normalize then
  // guard the already-Anthropic-wire messages before serialization. Applies to
  // count_tokens too — counts must match what the real send will contain, and the 32MB
  // body cap applies to it equally. Non-message bodies pass through untouched.
  if (Array.isArray(body.messages)) {
    await normalizeAnthropicImages(body.messages);
    enforceAnthropicImageLimits(body.messages);
  }
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    if (!PASSTHROUGH_STRIP_HEADERS.has(name.toLowerCase())) headers.set(name, value);
  });
  headers.set("content-type", "application/json");

  const result = await fetchWithHeaderDeadline(
    `${base}${pathname}${search}`,
    { method: "POST", headers, body: JSON.stringify(body) },
    config.connectTimeoutMs ?? 200_000,
    req.signal,
  );
  if (result.kind === "timeout") {
    finalize(504, { closeReason: "non_stream" });
    return anthropicErrorResponse(504, "anthropic passthrough timed out waiting for response headers", "timeout_error");
  }
  if (result.kind === "error") {
    const err = result.error;
    finalize(502, { closeReason: "non_stream" });
    return anthropicErrorResponse(502, `anthropic passthrough failed: ${err instanceof Error ? err.message : String(err)}`, "api_error");
  }
  const upstream = result.upstream;

  const contentType = upstream.headers.get("content-type") ?? "application/json";
  const bodyGuard = resolvePassthroughBodyGuard(config, req.signal);
  if (upstream.ok && contentType.includes("text/event-stream") && upstream.body) {
    return new Response(tapAnthropicSseForLog(upstream.body, logCtx, finalize, bodyGuard), {
      status: upstream.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  }
  // Non-stream (count_tokens, errors, stream:false): relay verbatim under the same
  // idle/size bounds — headers are NOT yet sent here, so real statuses are available.
  const bodyResult = await readBoundedPassthroughBody(upstream, bodyGuard);
  if (bodyResult.kind === "client_cancel") {
    finalize(499, { closeReason: "client_cancel" });
    return anthropicErrorResponse(499, "client closed request during anthropic passthrough", "api_error");
  }
  if (bodyResult.kind === "stall") {
    finalize(504, { closeReason: "body_stall" });
    return anthropicErrorResponse(504, `anthropic passthrough body stalled: no upstream bytes for ${Math.round(bodyGuard.stallMs / 1000)}s`, "timeout_error");
  }
  if (bodyResult.kind === "overflow") {
    finalize(502, { closeReason: "body_overflow" });
    return anthropicErrorResponse(502, `anthropic passthrough body exceeded ${bodyGuard.maxBytes} bytes`, "api_error");
  }
  const text = bodyResult.text;
  if (upstream.ok) {
    try {
      const parsed = JSON.parse(text) as { usage?: Rec };
      if (isRec(parsed?.usage)) logCtx.usage = anthropicUsageToOcx(parsed.usage);
    } catch { /* count_tokens etc. */ }
  }
  finalize(upstream.status, { closeReason: "non_stream" });
  const retryAfter = upstream.headers.get("retry-after");
  return new Response(text, {
    status: upstream.status,
    headers: { "Content-Type": contentType, ...(retryAfter ? { "Retry-After": retryAfter } : {}) },
  });
}

const DEFAULT_BODY_STALL_SEC = 90;
const DEFAULT_BODY_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Normalize the claudeCode body-guard config (devlog 260716_passthrough_followups/010).
 * Policy: exactly 0 disables; finite positive values are honored (stall clamped to
 * min 1s); negative/non-finite/absent values fall back to the defaults.
 */
export function resolvePassthroughBodyGuard(config: OcxConfig, reqSignal?: AbortSignal): PassthroughBodyGuard {
  const rawSec = config.claudeCode?.bodyStallSec;
  const stallSec = rawSec === 0
    ? 0
    : typeof rawSec === "number" && Number.isFinite(rawSec) && rawSec > 0
      ? Math.max(1, rawSec)
      : DEFAULT_BODY_STALL_SEC;
  const rawBytes = config.claudeCode?.bodyMaxBytes;
  const maxBytes = rawBytes === 0
    ? 0
    : typeof rawBytes === "number" && Number.isFinite(rawBytes) && rawBytes > 0
      ? Math.floor(rawBytes)
      : DEFAULT_BODY_MAX_BYTES;
  return { stallMs: stallSec * 1000, maxBytes, ...(reqSignal ? { reqSignal } : {}) };
}

type BoundedPassthroughBody =
  | { kind: "ok"; text: string }
  | { kind: "stall" }
  | { kind: "overflow" }
  | { kind: "client_cancel" };

/**
 * Bounded replacement for `await upstream.text()` on the non-stream passthrough
 * branch: same idle-only + size-cap semantics as the SSE tap. NOTE: reader.cancel()
 * resolves a pending read as done rather than rejecting, so the stalled flag is
 * re-checked after every read settlement (audit round 3).
 */
export async function readBoundedPassthroughBody(
  upstream: Response,
  guard: PassthroughBodyGuard,
): Promise<BoundedPassthroughBody> {
  if (!upstream.body) return { kind: "ok", text: await upstream.text() };
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let stalled = false;
  let aborted = false;
  const idle = idleDeadline(guard.stallMs, () => {
    stalled = true;
    reader.cancel(new DOMException("anthropic passthrough body stalled", "TimeoutError")).catch(() => {});
  });
  // Deterministic client-abort classification (audit round 4): Bun may surface the
  // abort as a read rejection OR a resolved done, so we cancel the reader ourselves
  // and classify via the flag rather than the read's settlement shape.
  const signal = guard.reqSignal;
  const onAbort = () => {
    aborted = true;
    reader.cancel(signal?.reason).catch(() => {});
  };
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (true) {
      idle.reset();
      let result: Awaited<ReturnType<typeof reader.read>>;
      try {
        result = await reader.read();
      } catch (err) {
        if (aborted) return { kind: "client_cancel" };
        if (stalled) return { kind: "stall" };
        throw err;
      } finally {
        idle.pause();
      }
      if (aborted) return { kind: "client_cancel" };
      if (stalled) return { kind: "stall" };
      if (result.done) break;
      if (result.value.byteLength === 0) continue;
      bytes += result.value.byteLength;
      if (guard.maxBytes > 0 && bytes > guard.maxBytes) {
        reader.cancel(new DOMException("anthropic passthrough body exceeded byte cap", "QuotaExceededError")).catch(() => {});
        return { kind: "overflow" };
      }
      text += decoder.decode(result.value, { stream: true });
    }
    text += decoder.decode();
    return { kind: "ok", text };
  } finally {
    idle.cancel();
    signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * Header-phase fetch guarded by a clearable deadline (PR #136 follow-up hardening).
 *
 * The deadline covers ONLY the wait for response headers; once `fetch` settles —
 * fulfilled OR rejected — the timer must die. The `finally` block guarantees
 * `clear()` on every path (success, upstream reject, deadline expiry), fixing the
 * timer leak where a rejected fetch left the deadline running until expiry.
 * `didExpire()` stays truthful after `clear()` (see src/lib/abort.ts), so timeout
 * classification inside the catch is unaffected by the finally cleanup.
 *
 * `makeDeadline`/`fetchImpl` are injectable for deterministic unit tests.
 */
export type HeaderDeadlineFetchResult =
  | { kind: "response"; upstream: Response }
  | { kind: "timeout" }
  | { kind: "error"; error: unknown };

export async function fetchWithHeaderDeadline(
  input: string | URL,
  init: RequestInit,
  timeoutMs: number,
  parent?: AbortSignal,
  makeDeadline: typeof clearableDeadline = clearableDeadline,
  fetchImpl: typeof fetch = fetch,
): Promise<HeaderDeadlineFetchResult> {
  const deadline = makeDeadline(timeoutMs, parent);
  try {
    const upstream = await fetchImpl(input, { ...init, signal: deadline.signal });
    return { kind: "response", upstream };
  } catch (error) {
    if (deadline.didExpire()) return { kind: "timeout" };
    return { kind: "error", error };
  } finally {
    deadline.clear();
  }
}

export async function handleClaudeMessages(
  req: Request,
  config: OcxConfig,
  logCtx: RequestLogContext,
  logIds?: { requestId: string; start: number },
): Promise<Response> {
  logCtx.surface = "claude";
  const disabled = claudeInboundDisabled(config);
  if (disabled) {
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, 403, { closeReason: "non_stream" });
    return disabled;
  }

  let anthropicBody: unknown;
  let internalBody: Rec;
  let cacheKeySource: ClaudeCacheKeySource = null;
  try {
    anthropicBody = await readAnthropicBody(req);
    // Defensive [1m] strip (devlog 138): clients normally remove the context-variant
    // marker themselves; the 1M signal we act on is the anthropic-beta header.
    // Case-insensitive — the CLI matches /\[1m\]/i (audit 021 #7).
    if (isRec(anthropicBody) && typeof anthropicBody.model === "string") {
      anthropicBody.model = stripOneMillionMarker(anthropicBody.model);
    }
    // ocx-route override (devlog 072): injected agent bodies pin their model via a
    // system-prompt directive because 2.1.207 ignores custom ids in agent
    // frontmatter. Must run BEFORE the native-passthrough branch — the CLI sends
    // these subagent turns under a fallback claude model id.
    if (isRec(anthropicBody)) {
      const routeOverride = extractOcxRouteDirective(anthropicBody);
      if (routeOverride && typeof anthropicBody.model === "string") {
        anthropicBody.model = stripOneMillionMarker(routeOverride);
      }
    }
    // Debug capture (opt-in allowlist scalars) BEFORE the passthrough branch so
    // native, routed, and disabled-alias paths are all observable (devlog 130 B1).
    captureClaudeInbound(
      "messages",
      anthropicBody,
      isRec(anthropicBody) && typeof anthropicBody.model === "string"
        ? resolveInboundModel(anthropicBody.model, config.claudeCode)
        : undefined,
      req.headers.get("anthropic-beta") ?? undefined,
    );
    // Client surface discrimination: Desktop 3P aliases resolve through the
    // desktop registry; Code uses readable aliases or direct model names.
    if (isRec(anthropicBody) && typeof anthropicBody.model === "string" && resolveDesktop3pAlias(anthropicBody.model)) {
      logCtx.surface = "claude-desktop";
      recordDesktopRequest();
    }
    if (isRec(anthropicBody) && wantsNativePassthrough(req, config, anthropicBody.model)) {
      return await anthropicNativePassthrough(req, config, logCtx, logIds, anthropicBody, "/v1/messages");
    }
    const translation = anthropicToResponsesTranslation(anthropicBody, config.claudeCode);
    internalBody = translation.body;
    cacheKeySource = translation.cacheKeySource;
  } catch (err) {
    const status = err instanceof AnthropicRequestError ? 400 : 500;
    if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, { closeReason: "non_stream" });
    return anthropicErrorResponse(status, err instanceof Error ? err.message : String(err));
  }

  const requestedModel = (anthropicBody as Rec).model as string;
  const stream = internalBody.stream === true;
  // Routed adapters only support streamed turns; always stream internally and fold
  // the translated Anthropic SSE into a message JSON for non-streaming clients.
  internalBody.stream = true;

  // Native ChatGPT passthrough (openai-responses forward) accepts only Codex-shaped
  // bodies: it 400s on sampling params ("Unsupported parameter: max_output_tokens",
  // verified live 2026-07-11). Strip them for that route; routed providers keep them.
  let nativeRoute = false;
  try {
    const route = routeModel(config, internalBody.model as string);
    if (route.provider.adapter === "openai-responses") {
      nativeRoute = true;
      delete internalBody.max_output_tokens;
      delete internalBody.temperature;
      delete internalBody.top_p;
      delete internalBody.stop;
      delete internalBody.user;
    }
    // Estimated-usage adapters (cursor/kiro) report no per-turn input tokens; stash a
    // request-side estimate so the log's in:0 rows get a floor. NEVER set this for
    // accurate-usage adapters — the request-log merge is max(reported, estimate) and
    // would overwrite real usage (audit 133 R1#7).
    if (route.provider.adapter === "cursor" || route.provider.adapter === "kiro") {
      const raw = anthropicBody as Rec;
      const parts: string[] = [];
      if (raw.system !== undefined) parts.push(typeof raw.system === "string" ? raw.system : JSON.stringify(raw.system));
      if (raw.messages !== undefined) parts.push(JSON.stringify(raw.messages));
      if (raw.tools !== undefined) parts.push(JSON.stringify(raw.tools));
      logCtx.usageLogInputTokens = Math.max(1, estimateTokens(parts.join("\n"), requestedModel));
    }
    // Effort safety valve (devlog 136 B6, audit 139 R2#2): opus-shaped aliases make
    // every routed model look like a reasoning model to Claude clients, so a forced
    // effort (CLAUDE_CODE_ALWAYS_ENABLE_EFFORT) would leak reasoning params to routes
    // that affirmatively expose NO effort control. Strip only on a definitive [] from
    // supportedLadderFor; unknown (undefined) passes through untouched.
    if (internalBody.reasoning !== undefined) {
      const { supportedLadderFor } = await import("./effort-policy");
      const ladder = supportedLadderFor({ provider: route.provider, modelId: route.modelId });
      if (ladder !== undefined && ladder.length === 0) delete internalBody.reasoning;
    }
  } catch { /* unknown model: let handleResponses shape the 404 */ }

  const headers = new Headers({ "content-type": "application/json" });
  for (const name of FORWARD_HEADERS) {
    // The caller's bearer is the proxy admission token (ocx claude placeholder), never a
    // ChatGPT credential — forwarding it upstream turns into {"detail":"Unauthorized"}.
    if (name === "authorization") continue;
    const value = req.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!nativeRoute) {
    // Routed replays need main ChatGPT auth so OpenAI-backed sidecars remain reachable.
    const { getMainAccountToken } = await import("../codex/main-account");
    const token = getMainAccountToken();
    if (token) {
      headers.set("authorization", `Bearer ${token.accessToken}`);
      headers.set("chatgpt-account-id", token.chatgptAccountId);
    }
  }
  if (nativeRoute) {
    // No forwarded ChatGPT auth exists on this surface. Attach the main codex login
    // (read-only auth.json token); account-pool rotation still overrides downstream.
    const { getMainAccountToken } = await import("../codex/main-account");
    const token = getMainAccountToken();
    if (token) {
      headers.set("authorization", `Bearer ${token.accessToken}`);
      headers.set("chatgpt-account-id", token.chatgptAccountId);
    }
    // ChatGPT-backend prompt-cache affinity rides the session_id HEADER (codex
    // clients always send their session uuid; devlog 090 follow-up: body-level
    // prompt_cache_key alone still yielded cached_tokens:0). Claude Code never sends
    // the header, so synthesize a stable per-session uuid from the same cache key —
    // but ONLY for a real per-session key (metadata.user_id). The system-hash fallback
    // key is shared across Desktop conversations, and a shared session_id's backend
    // semantics are unproven (audit 133 R2#3): body prompt_cache_key only there.
    if (cacheKeySource === "metadata" && !headers.has("session_id") && typeof internalBody.prompt_cache_key === "string") {
      headers.set("session_id", uuidFromHex(internalBody.prompt_cache_key));
    }
  }
  const internalReq = new Request("http://localhost/v1/responses", {
    method: "POST",
    headers,
    body: JSON.stringify(internalBody),
  });

  // Request-log wiring mirrors the /v1/responses route: native passthrough finalizes
  // via the terminal callbacks; routed streams get the Responses-vocabulary log tap
  // BEFORE translation (the translated Anthropic stream has no response.completed
  // frame, so tapping it records a bogus 502 with no usage/cache detail).
  let nativeLogged = false;
  const finalizeNativeLog = (status: number, meta: { terminalStatus?: RequestLogEntry["terminalStatus"]; closeReason: "terminal" | "client_cancel" }) => {
    if (!logIds || nativeLogged) return;
    nativeLogged = true;
    addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, meta);
  };
  const upstream = await handleResponses(internalReq, buildClaudeReplayConfig(config), logCtx, {
    abortSignal: req.signal,
    ...(logIds ? { onFirstOutput: () => recordFirstOutput(logCtx, logIds.start) } : {}),
    onNativePassthroughTerminal: status => finalizeNativeLog(httpStatusForTerminalStatus(status), { terminalStatus: status, closeReason: "terminal" }),
    onNativePassthroughCancel: () => finalizeNativeLog(499, { closeReason: "client_cancel" }),
  });
  const response = logIds ? responseWithDeferredRequestLog(upstream, logIds.requestId, logIds.start, logCtx) : upstream;

  if (!response.ok) {
    // Re-shape the OpenAI-style error envelope into the Anthropic one, preserving status.
    let message = `upstream error (${response.status})`;
    try {
      const text = await response.text();
      try {
        const parsed = JSON.parse(text) as { error?: { message?: string; type?: string } | string; message?: string };
        const nested = typeof parsed?.error === "object" && parsed.error ? parsed.error.message : undefined;
        const flat = typeof parsed?.error === "string" ? parsed.error : parsed?.message;
        message = nested || flat || (text ? `upstream error (${response.status}): ${text.slice(0, 400)}` : message);
      } catch {
        if (text) message = `upstream error (${response.status}): ${text.slice(0, 400)}`;
      }
    } catch { /* keep fallback message */ }
    const retryAfter = response.headers.get("retry-after");
    // Transient upstream 5xx (already retried pre-stream, 010): reclassify as Anthropic
    // 529 overloaded_error so the Claude Code client applies its built-in backoff retry
    // instead of dying on a fatal api_error (260716 sol-builder incident). The request
    // log keeps the upstream status (captured in the deferred-log closure before this
    // rewrite): log = upstream truth, client = retry signal.
    const transient = isTransientUpstreamStatus(response.status);
    const outStatus = transient ? 529 : response.status;
    const out = new Response(JSON.stringify(anthropicErrorBody(outStatus, message)), {
      status: outStatus,
      headers: {
        "Content-Type": "application/json",
        ...(retryAfter ? { "Retry-After": retryAfter } : (transient ? { "Retry-After": "2" } : {})),
      },
    });
    return out;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream") && response.body) {
    const anthropicSse = responsesSseToAnthropicSse(response.body, requestedModel);
    if (stream) {
      return new Response(anthropicSse, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
        },
      });
    }
    const message = await collectAnthropicMessage(anthropicSse, requestedModel);
    const isError = (message as Rec).type === "error";
    return new Response(JSON.stringify(message), {
      status: isError ? 502 : 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Defensive: some passthrough paths may answer JSON despite stream:true.
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return anthropicErrorResponse(502, "internal replay returned a non-JSON response", "api_error");
  }
  const status = (json as Rec)?.status;
  if (status === "failed") {
    const error = (json as { error?: { message?: string } }).error;
    return anthropicErrorResponse(502, error?.message ?? "upstream request failed", "api_error");
  }
  const message = responsesJsonToAnthropicMessage(json, requestedModel);
  if (!stream) {
    return new Response(JSON.stringify(message), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  // Streaming client + JSON upstream: synthesize a minimal valid Anthropic stream.
  const encoder = new TextEncoder();
  const frames: string[] = [];
  const emit = (name: string, data: Rec) => frames.push(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  emit("message_start", { type: "message_start", message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } });
  const blocks = Array.isArray((message as Rec).content) ? (message as Rec).content as Rec[] : [];
  blocks.forEach((block, index) => {
    emit("content_block_start", { type: "content_block_start", index, content_block: block });
    emit("content_block_stop", { type: "content_block_stop", index });
  });
  emit("message_delta", { type: "message_delta", delta: { stop_reason: (message as Rec).stop_reason ?? "end_turn", stop_sequence: null }, usage: (message as Rec).usage ?? {} });
  emit("message_stop", { type: "message_stop" });
  return new Response(encoder.encode(frames.join("")), {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache" },
  });
}

/** Documented approximation: serialize system+messages+tools, run the char estimator. */
export async function handleClaudeCountTokens(req: Request, config: OcxConfig): Promise<Response> {
  const disabled = claudeInboundDisabled(config);
  if (disabled) return disabled;

  let body: unknown;
  try {
    body = await readAnthropicBody(req);
  } catch (err) {
    if (err instanceof AnthropicRequestError) return anthropicErrorResponse(400, err.message);
    return anthropicErrorResponse(500, err instanceof Error ? err.message : String(err));
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return anthropicErrorResponse(400, "request body must be a JSON object");
  }
  const raw = body as Rec;
  if (typeof raw.model !== "string" || raw.model.length === 0) {
    return anthropicErrorResponse(400, "model is required");
  }
  let model = raw.model;
  // Case-insensitive [1m] strip (audit 021 #7 — the CLI matches /\[1m\]/i).
  const stripped = stripOneMillionMarker(model);
  if (stripped !== model) {
    model = stripped;
    raw.model = model;
  }
  // ocx-route override (devlog 072): keep count_tokens consistent with messages.
  const countRoute = extractOcxRouteDirective(raw);
  if (countRoute) {
    model = stripOneMillionMarker(countRoute);
    raw.model = model;
  }
  captureClaudeInbound("count_tokens", raw, resolveInboundModel(model, config.claudeCode), req.headers.get("anthropic-beta") ?? undefined);
  if (wantsNativePassthrough(req, config, model)) {
    return await anthropicNativePassthrough(req, config, { model, provider: "anthropic-native", surface: "claude" }, undefined, raw, "/v1/messages/count_tokens");
  }
  const parts: string[] = [];
  if (raw.system !== undefined) parts.push(typeof raw.system === "string" ? raw.system : JSON.stringify(raw.system));
  if (raw.messages !== undefined) parts.push(JSON.stringify(raw.messages));
  if (raw.tools !== undefined) parts.push(JSON.stringify(raw.tools));
  const inputTokens = Math.max(1, estimateTokens(parts.join("\n"), model));
  return new Response(JSON.stringify({ input_tokens: inputTokens }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
