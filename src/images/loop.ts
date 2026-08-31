/**
 * Media bridge agentic loop — supports both image and video generation sidecars.
 *
 * The routed (non-OpenAI) model runs in a bounded loop. Each iteration is streamed and fully
 * buffered internally. If the model calls an image-generation or video-generation tool, the
 * bridge fulfills it via the xAI sidecar, injects the result as a tool_result, and loops
 * (bounded by maxRounds). When the model produces a real tool call or the budget is exhausted,
 * the passthrough events are replayed to the bridge for final SSE output.
 *
 * Removed vs web-search: no sidecar backend selection, no forced-answer nudge, no failed-query
 * dedup, no describeImages/structuredOutput, no recordSidecarOutcome.
 */
import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../adapters/base";
import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { createAdapterEventQueue } from "../adapters/run-turn-queue";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderContinuationState, OcxProviderOpaqueToolCallMetadata, OcxRequestOptions, OcxThinkingContent, OcxUsage, RateLimitRetryPolicy } from "../types";
import { namespacedToolName, toolChoiceToolPredicate } from "../types";
import { cloneProviderOpaqueToolCallMetadata } from "../responses/provider-opaque-metadata";
import type { AttemptRecoveryKind } from "../usage/log";
import { bridgeToResponsesSSE } from "../bridge";
import { clearableDeadline, idleDeadline } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { applyUpstreamRecoveryInit, fetchWithResetRetry, prepareSameTarget429Wait } from "../lib/upstream-retry";
import { rateLimitRetryDelayMs } from "../providers/key-failover";
import {
  isTranslatorBudgetExceededError,
  TRANSLATOR_MAX_TURN_BYTES,
  TranslatorBudgetExceededError,
} from "../lib/translator-budget";
import { parseStreamWithProgress, RoutedModelInactivityError, WebSearchStreamProtocolError } from "../web-search/progress-stream";
import { fulfillImageCall } from "./fulfill";
import { parseVideoCallArgs, pollVideoWithHeartbeats, buildVideoResult, createVideoBudget } from "./fulfill-video";
import { submitVideoJob } from "./xai-video-client";
import { downloadVideoToArtifact, createImageBudget, pruneArtifacts } from "./artifacts";
import { IMAGE_GEN_TOOL_NAME, VIDEO_GEN_TOOL_NAME } from "./synthetic-tool";
import type { ImageBridgePlan, VideoBridgePlan } from "./types";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

const CONNECT_TIMEOUT_MS = 200_000;
const STALL_TIMEOUT_MS = 200_000;
export const DEFAULT_MAX_ROUNDS = 3;
/** Absolute ceiling so a hand-edited `images.maxRounds: 10000` cannot unbound paid xAI calls. */
export const MAX_ROUNDS_HARD_LIMIT = 10;
/** Cap paid xAI image fulfillments per turn (parallel calls in one round count separately). */
export const MAX_IMAGE_CALLS_PER_TURN = 10;
/** Cap paid xAI video fulfillments per turn (video is slower/costlier than image). */
export const MAX_VIDEO_CALLS_PER_TURN = 3;

/**
 * Clamp a configured maxRounds value to a safe integer in [0, MAX_ROUNDS_HARD_LIMIT].
 * Non-finite / non-number inputs fall back to DEFAULT_MAX_ROUNDS.
 */
export function clampImageMaxRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  return Math.max(0, Math.min(MAX_ROUNDS_HARD_LIMIT, Math.floor(value)));
}

/** Drop image/video-specific tool_choice when media tools are stripped for a forced-final pass. */
function stripMediaToolChoice(
  options: OcxRequestOptions,
  plan?: ImageBridgePlan,
  videoPlan?: VideoBridgePlan,
): OcxRequestOptions {
  const tc = options.toolChoice;
  if (!tc || typeof tc !== "object") return options;
  const isMediaTool = (name: string): boolean =>
    name === IMAGE_GEN_TOOL_NAME ||
    name === VIDEO_GEN_TOOL_NAME ||
    (plan?.toolNames.has(name) ?? false) ||
    (videoPlan?.toolNames.has(name) ?? false);
  if ("name" in tc && typeof tc.name === "string") {
    if (isMediaTool(tc.name)) {
      return { ...options, toolChoice: "auto" };
    }
    return options;
  }
  if ("allowedTools" in tc && Array.isArray(tc.allowedTools)) {
    const filtered = tc.allowedTools.filter(name => !isMediaTool(name));
    if (filtered.length === tc.allowedTools.length) return options;
    if (filtered.length === 0) return { ...options, toolChoice: "auto" };
    return { ...options, toolChoice: { ...tc, allowedTools: filtered } };
  }
  return options;
}

interface ImageCall {
  id: string;
  name: string;
  args: string;
  /**
   * Provider-opaque metadata from the originating part (issue #1735). Stored PER CALL: a
   * signature belongs to one specific part, so parallel calls must not share one value.
   */
  providerMetadata?: OcxProviderOpaqueToolCallMetadata;
}

/**
 * Split an iteration's adapter events into (a) the image-generation tool calls to intercept and
 * (b) the events to pass through to Codex. An image tool-call's own start/delta/end events are
 * dropped (Codex never sees the synthetic tool); every other event — text, thinking, real tool
 * calls, done — is preserved in order.
 */
function scanEventsForImageCall(events: AdapterEvent[], toolNames: Set<string>): {
  calls: ImageCall[];
  passthrough: AdapterEvent[];
  hasRealToolCall: boolean;
} {
  const calls: ImageCall[] = [];
  const passthrough: AdapterEvent[] = [];
  let hasRealToolCall = false;
  let pending: { name: string; id: string; argsBuf: string; events: AdapterEvent[]; providerMetadata?: OcxProviderOpaqueToolCallMetadata } | null = null;
  const flushPending = (): void => {
    if (!pending) return;
    if (toolNames.has(pending.name)) {
      // Unterminated image call still carries buffered args — fulfill so malformed JSON
      // becomes a normal tool_result error instead of silently vanishing.
      calls.push({ id: pending.id, name: pending.name, args: pending.argsBuf, providerMetadata: pending.providerMetadata });
    } else {
      passthrough.push(...pending.events);
      hasRealToolCall = true;
    }
    pending = null;
  };
  for (const e of events) {
    if (e.type === "tool_call_start") {
      flushPending();
      pending = { name: e.name, id: e.id, argsBuf: "", events: [e], providerMetadata: e.providerMetadata };
    } else if (e.type === "tool_call_delta" && pending) {
      pending.argsBuf += e.arguments;
      pending.events.push(e);
    } else if (e.type === "tool_call_end" && pending) {
      pending.events.push(e);
      if (toolNames.has(pending.name)) {
        calls.push({ id: pending.id, name: pending.name, args: pending.argsBuf, providerMetadata: pending.providerMetadata });
      } else {
        passthrough.push(...pending.events);
        hasRealToolCall = true;
      }
      pending = null;
    } else {
      flushPending();
      passthrough.push(e);
    }
  }
  flushPending();
  return { calls, passthrough, hasRealToolCall };
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const e of events) yield e;
}

/**
 * Collect thinking / redacted_thinking blocks that preceded an image tool call, preserving
 * stream order and per-block signatures. Anthropic extended thinking REQUIRES the assistant
 * message containing tool_use to start with its signed thinking blocks — flattening multiple
 * blocks into one signature 400s on replay.
 */
function extractIterationThinking(events: AdapterEvent[]): OcxThinkingContent[] {
  const parts: OcxThinkingContent[] = [];
  let thinking = "";
  let signature: string | undefined;
  let rawReasoning = "";

  const flushVisible = () => {
    if (!thinking && !signature) return;
    parts.push({
      type: "thinking",
      thinking,
      ...(signature ? { signature } : {}),
    });
    thinking = "";
    signature = undefined;
  };
  const flushRaw = () => {
    if (!rawReasoning) return;
    parts.push({ type: "thinking", thinking: rawReasoning });
    rawReasoning = "";
  };

  for (const e of events) {
    if (e.type === "thinking_delta") {
      flushRaw();
      thinking += e.thinking;
    } else if (e.type === "reasoning_raw_delta") {
      // OpenAI-compatible providers emit raw reasoning instead of signed
      // thinking; DeepSeek thinking mode requires it back alongside replayed
      // tool_calls (mirrors src/web-search/loop.ts, issue #950).
      flushVisible();
      rawReasoning += e.text;
    } else if (e.type === "thinking_signature") {
      signature = e.signature;
      flushVisible();
    } else if (e.type === "redacted_thinking") {
      flushVisible();
      flushRaw();
      parts.push({ type: "thinking", thinking: "", redacted: [e.data] });
    }
  }
  flushVisible();
  flushRaw();
  return parts;
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Hard provider/parse failure inside an iteration. The eager first iteration converts it to a
 *  non-2xx jsonError; later (already-streaming) iterations surface it as an in-stream error event. */
class LoopError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LoopError";
  }
}

/**
 * Dependencies for one image-bridge iteration: parsed request, active adapter, incoming
 * metadata, and the optional image/video bridge plans.
 */
export interface ImageBridgeDeps {
  parsed: OcxParsedRequest;
  adapter: ProviderAdapter;
  incomingMeta: IncomingMeta;
  plan?: ImageBridgePlan;
  videoPlan?: VideoBridgePlan;
  /** Per-video generation timeout (ms) including polling. */
  videoTimeoutMs?: number;
  /** Headers forwarded from the original request (e.g. Codex auth). Cloned per iteration. */
  forwardHeaders?: Headers;
  /** Called before each routed-model dispatch in the bridge loop, for attempt telemetry. Same-target 429 replays pass the `rate-limit-429` recovery kind. */
  onAttemptSend?: (recovery?: AttemptRecoveryKind) => void;
  /** Called after each upstream request is built (parity with web-search / normal path). */
  onRequestBuilt?: (request: AdapterRequest) => void;
  abortSignal?: AbortSignal;
  onFirstOutput?: () => void;
  /** Max image-generation rounds before forcing a final answer. Defaults to 3; clamped to [0, 10]. */
  maxRounds?: number;
  /** Connect / response-header budget for non-runTurn iterations. */
  connectTimeoutMs?: number;
  /** Stall budget (seconds) forwarded to bridgeToResponsesSSE; also bounds runTurn collect. */
  stallTimeoutSec?: number;
  /** Provider-specific fetch (e.g. xAI transport wrapper). Falls back to global fetch. */
  fetchImpl?: typeof globalThis.fetch;
  /** Reserve the routed provider's next request-start slot before each adapter dispatch. */
  waitForRequestSlot?: (signal?: AbortSignal) => Promise<void>;
  /** Raw adapter usage at the terminal event, pre wire-normalization (see bridgeToResponsesSSE onUsage). */
  onUsage?: (usage: OcxUsage | undefined) => void;
  /**
   * Optional 429 failover for the routed (non-xAI) model. Return a rebuilt adapter for the
   * rotated credential, or null when the pool is exhausted. Async hooks support OAuth refresh;
   * existing synchronous key-pool hooks remain valid.
   */
  on429?: (retryAfterHeader: string | null) => ProviderAdapter | null | Promise<ProviderAdapter | null>;
  /** Opt-in same-target 429 policy (key-auth providers). When present, 429 replays on the SAME key before on429 rotation. */
  retryOn429Policy?: Required<RateLimitRetryPolicy> | null;
  /** Called when the bridged Responses stream completes (parity with runTurn / routed paths). */
  onCompletedResponse?: (response: Record<string, unknown>, providerState?: OcxProviderContinuationState) => void;
  /** WebSocket Responses path only — leave response id empty for protocol compatibility. */
  forceEmptyResponseId?: boolean;
}

/**
 * Run the main (non-OpenAI) model in a small agentic loop. Each upstream iteration is streamed and
 * fully buffered internally so raw byte progress is observable without leaking the synthetic tool or
 * preliminary assistant output. If the model invokes image generation, run it via the xAI sidecar,
 * inject the answer as a tool_result, and loop (bounded by `maxRounds`).
 */
export async function runWithImageBridge(deps: ImageBridgeDeps): Promise<Response> {
  const translatorBudget = deps.incomingMeta.translatorBudget;
  const { parsed, plan, videoPlan, videoTimeoutMs, abortSignal } = deps;
  let adapter = deps.adapter;
  const maxRounds = clampImageMaxRounds(deps.maxRounds ?? DEFAULT_MAX_ROUNDS);
  const HARD_CAP = maxRounds + 1;
  const connectTimeoutMs = typeof deps.connectTimeoutMs === "number" && Number.isFinite(deps.connectTimeoutMs) && deps.connectTimeoutMs > 0
    ? Math.floor(deps.connectTimeoutMs)
    : CONNECT_TIMEOUT_MS;
  const stallTimeoutMs = typeof deps.stallTimeoutSec === "number" && Number.isFinite(deps.stallTimeoutSec) && deps.stallTimeoutSec > 0
    ? Math.floor(deps.stallTimeoutSec * 1000)
    : STALL_TIMEOUT_MS;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  let paidImageCalls = 0;
  let paidVideoCalls = 0;
  let hiddenUsage: OcxUsage | undefined;

  const addUsage = (a: OcxUsage | undefined, b: OcxUsage | undefined): OcxUsage | undefined => {
    if (!a) return b;
    if (!b) return a;
    return {
      inputTokens: a.inputTokens + b.inputTokens,
      outputTokens: a.outputTokens + b.outputTokens,
      ...(a.contextTotalTokens !== undefined || b.contextTotalTokens !== undefined
        ? { contextTotalTokens: Math.max(a.contextTotalTokens ?? 0, b.contextTotalTokens ?? 0) }
        : {}),
      ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
        ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }
        : {}),
      ...(a.cacheReadInputTokens !== undefined || b.cacheReadInputTokens !== undefined
        ? { cacheReadInputTokens: (a.cacheReadInputTokens ?? 0) + (b.cacheReadInputTokens ?? 0) }
        : {}),
      ...(a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined
        ? { cacheCreationInputTokens: (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0) }
        : {}),
      ...(a.reasoningOutputTokens !== undefined || b.reasoningOutputTokens !== undefined
        ? { reasoningOutputTokens: (a.reasoningOutputTokens ?? 0) + (b.reasoningOutputTokens ?? 0) }
        : {}),
      ...(a.estimated || b.estimated ? { estimated: true } : {}),
    };
  };
  const takeUsageFrom = (events: AdapterEvent[]): void => {
    for (const e of events) {
      if ((e.type === "done" || e.type === "incomplete") && e.usage) {
        hiddenUsage = addUsage(hiddenUsage, e.usage);
      }
    }
  };

  const messages: OcxMessage[] = [...parsed.context.messages];
  const allTools = parsed.context.tools ?? [];
  // Merge tool names from both plans for event scanning.
  const mediaToolNames = new Set<string>();
  if (plan) for (const n of plan.toolNames) mediaToolNames.add(n);
  if (videoPlan) for (const n of videoPlan.toolNames) mediaToolNames.add(n);
  // Forced-final must strip every image/video-generation alias the plans know about — not only
  // tools flagged `imageGeneration:true` or `videoGeneration:true`. Hosted `image_generation` /
  // function aliases would otherwise remain callable; scanEventsForImageCall would strip the
  // call while forceFinal blocks fulfillment, leaving the client an empty completion.
  const toolsNoMedia = allTools.filter(t => {
    if (t.imageGeneration) return false;
    if (t.videoGeneration) return false;
    if (plan && plan.toolNames.has(t.name)) return false;
    if (plan && t.namespace && plan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
    if (videoPlan && videoPlan.toolNames.has(t.name)) return false;
    return true;
  });
  const budget = createImageBudget();
  const vBudget = createVideoBudget();

  // Link an internal AbortController to the turn signal so a client cancel of the SSE body aborts
  // in-flight model fetches AND the sidecar.
  const internalAbort = new AbortController();
  const linkAbort = (): void => internalAbort.abort(abortSignal?.reason);
  if (abortSignal) {
    if (abortSignal.aborted) linkAbort();
    else abortSignal.addEventListener("abort", linkAbort, { once: true });
  }
  const signal = internalAbort.signal;

  interface IterationResponse {
    response: Response;
    responseAdapter: ProviderAdapter;
  }
  type IterationSplit = ReturnType<typeof scanEventsForImageCall>;

  // Same-target 429 budget is per REQUEST, not per model iteration: later image rounds inherit
  // what earlier rounds left of `attempts`, so a bounded multi-round turn can never exceed the
  // configured replay count in total (a per-round reset would multiply it by maxRounds).
  const rateLimitRetryPolicy = deps.retryOn429Policy ?? null;
  let rateLimitRetries = 0;

  // Acquire one iteration's final response headers. The first call is drained eagerly so an initial
  // connect/header/HTTP failure stays a non-2xx JSON response — except for runTurn adapters, which
  // have no HTTP status surface and must not block SSE headers behind queue.collect().
  /**
   * Fetch one image-bridge iteration's final response headers, applying the response-header
   * deadline and the same-target 429 retry policy (with awaited body release and deadline
   * restart) before the `on429` key rotation.
   */
  const prepareIterationEvents = async function* (forceFinal: boolean): AsyncGenerator<AdapterEvent, IterationResponse> {
    const iterParsed: OcxParsedRequest = {
      ...parsed,
      stream: true,
      context: { ...parsed.context, messages, tools: forceFinal ? toolsNoMedia : allTools },
      options: forceFinal ? stripMediaToolChoice(parsed.options, plan, videoPlan) : parsed.options,
    };

    // runTurn adapters (Cursor) own all upstream communication via an emit callback. They don't
    // expose buildRequest/fetchResponse/parseStream to the bridge, so collect their events through
    // an AdapterEventQueue and wrap them in a pseudo-response whose parseStream replays them.
    if (adapter.runTurn) {
      await deps.waitForRequestSlot?.(signal);
      const queue = createAdapterEventQueue({
        onBacklogExceeded: () => internalAbort.abort("runTurn backlog exceeded"),
      });
      // Attempt telemetry must fire at dispatch time (parity with fetchOnce), not after collect.
      deps.onAttemptSend?.();
      void adapter
        .runTurn(
          iterParsed,
          {
            headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
            abortSignal: signal,
            translatorBudget,
          },
          queue.push,
        )
        .then(() => queue.close())
        .catch(err => {
          queue.push({ type: "error", message: err instanceof Error ? err.message : String(err) });
          queue.close();
        });

      // Bound collect with a real *idle* deadline that resets on each emitted event.
      // A fixed wall-clock race would abort legitimate long Cursor turns that keep
      // producing tokens. Do NOT manufacture adapter heartbeats here — bridgeToResponsesSSE
      // treats those as upstream activity and would defeat the stall guard. SSE keepalives
      // come from the bridge heartbeat interval instead.
      //
      // On idle expiry: abort the runTurn signal AND close the queue so the consumer
      // unblocks even when adapter.runTurn ignores cancellation and never settles.
      let timedOut = false;
      const idle = idleDeadline(stallTimeoutMs, () => {
        timedOut = true;
        // Cancel the fire-and-forget runTurn so a well-behaved adapter can stop.
        internalAbort.abort(`runTurn inactivity timeout after ${stallTimeoutMs}ms`);
        // Independently unblock queue.stream() — do not wait for runTurn to observe abort.
        queue.close();
      });
      const events: AdapterEvent[] = [];
      try {
        idle.reset();
        for await (const event of queue.stream()) {
          if (timedOut) break;
          idle.reset();
          events.push(event);
        }
      } finally {
        idle.cancel();
      }
      if (timedOut) {
        throw new LoopError(504, `runTurn inactivity timeout after ${stallTimeoutMs}ms during image-bridge`);
      }

      // Preserve Cursor conversation continuity across image-loop iterations. runTurn mutates
      // iterParsed (shallow copy); copy the id back onto the shared parsed request.
      if (iterParsed._cursorConversationId) {
        parsed._cursorConversationId = iterParsed._cursorConversationId;
      }

      // runTurn adapters signal errors via {type:"error"} events, not HTTP status codes.
      const errorEvent = events.find(e => e.type === "error");
      if (errorEvent && errorEvent.type === "error") {
        if (errorEvent.code === "translation_buffer_limit") {
          throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
        }
        throw new LoopError(502, errorEvent.message);
      }

      const wrappedAdapter: ProviderAdapter = {
        ...adapter,
        async *parseStream() {
          for (const e of events) yield e;
        },
      };
      return { response: new Response(new Uint8Array(0), { status: 200 }), responseAdapter: wrappedAdapter };
    }

    let headerDeadline = clearableDeadline(connectTimeoutMs, signal);
    const paceThenResetHeaderDeadline = async (): Promise<void> => {
      headerDeadline.clear();
      await deps.waitForRequestSlot?.(signal);
      headerDeadline = clearableDeadline(connectTimeoutMs, signal);
    };
    try {
      /**
       * Build and fetch one image-bridge iteration on the given adapter, under the iteration
       * header deadline. The caller owns same-target 429 replays and key rotation around it.
       * The outbound request is cached per adapter so a same-target replay reuses the EXACT
       * URL, serialized body, and headers (builder runs once per target sequence).
       */
      let cachedRequest: AdapterRequest | undefined;
      let cachedAdapter: ProviderAdapter | undefined;
      /**
       * Build and fetch one image-bridge iteration on the given adapter, under the iteration
       * header deadline. The caller owns same-target 429 replays and key rotation around it.
       */
      const fetchOnce = async (requestAdapter: ProviderAdapter, recovery?: AttemptRecoveryKind): Promise<IterationResponse> => {
        let request: AdapterRequest;
        if (cachedRequest !== undefined && cachedAdapter === requestAdapter) {
          request = cachedRequest;
        } else {
          request = await requestAdapter.buildRequest(iterParsed, {
            headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
            abortSignal: headerDeadline.signal,
            translatorBudget,
          });
          try { deps.onRequestBuilt?.(request); } catch { /* diagnostics are best-effort */ }
          cachedRequest = request;
          cachedAdapter = requestAdapter;
        }
        let response: Response;
        try {
          if (requestAdapter.fetchResponse) {
            await paceThenResetHeaderDeadline();
            deps.onAttemptSend?.(recovery);
            response = await requestAdapter.fetchResponse(request, {
              abortSignal: headerDeadline.signal,
              timeoutMs: connectTimeoutMs,
              returnRawErrors: true,
              stream: true,
              executor: fetchImpl,
            });
          } else {
            response = await fetchWithResetRetry(
              async (retryRecovery) => {
                await paceThenResetHeaderDeadline();
                // Record every helper-driven send (the callback runs for the first attempt and
                // each connection-reset replay); preserve the caller's recovery kind
                // (rate-limit-429 / key-429) when the retry layer supplies none.
                deps.onAttemptSend?.(retryRecovery ?? recovery);
                const h = new Headers(request.headers);
                if (!h.has("accept-encoding")) h.set("accept-encoding", "identity");
                // Same reset-recovery parity as the web-search loop: the replay needs
                // `keepalive: false` to abandon the pooled socket, because Bun has ignored the
                // hop-by-hop header alone (oven-sh/bun#20492).
                return fetchImpl(request.url, applyUpstreamRecoveryInit({
                  method: request.method,
                  headers: h,
                  body: request.body,
                  signal: headerDeadline.signal,
                }, retryRecovery));
              },
              { abortSignal: headerDeadline.signal, label: "image-bridge-loop" },
            );
          }
        } finally {
          request.releaseBodyObservation?.();
        }
        return { response, responseAdapter: requestAdapter };
      };

      let prepared = await fetchOnce(adapter);
      // Same-target 429 wait-and-retry (opt-in `retryOn429`) BEFORE key rotation: a primary-key
      // rate-limit blip replays on the SAME key; rotation only runs after attempts exhaust.
      while (
        prepared.response.status === 429
        && rateLimitRetryPolicy !== null
        && rateLimitRetries < rateLimitRetryPolicy.attempts
      ) {
        rateLimitRetries += 1;
        // Release unread body + heartbeat-fed wait via the shared same-target helper.
        const retryAfterHeader = prepared.response.headers.get("retry-after");
        // The old header deadline must not stay armed across the deliberate wait: clear it
        // before sleeping so a stale expiry can never race the client-cancel path.
        headerDeadline.clear();
        try {
          yield* prepareSameTarget429Wait({
            body: prepared.response.body,
            signal,
            delayMs: rateLimitRetryDelayMs(rateLimitRetryPolicy, retryAfterHeader, Date.now()),
            heartbeatIntervalMs: Math.min(10_000, Math.max(250, stallTimeoutMs / 2)),
          });
        } catch {
          throw new LoopError(499, "client closed request during image-bridge");
        }
        // Client cancellation wins over any stale-deadline edge: re-check before telemetry/replay.
        if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
        // The deliberate backoff must not consume the cumulative response-header deadline:
        // start a fresh one so the replay gets a new connect budget (504 stays reserved for real
        // upstream latency).
        headerDeadline = clearableDeadline(connectTimeoutMs, signal);
        // Stall-watchdog seam between bounded retry fetches.
        yield { type: "heartbeat" };
        prepared = await fetchOnce(adapter, "rate-limit-429");
      }
      // 429 key-failover parity with web-search / normal routed path.
      while (prepared.response.status === 429 && deps.on429) {
        const rotated = await deps.on429(prepared.response.headers.get("retry-after"));
        if (!rotated) break;
        try { void prepared.response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        adapter = rotated;
        yield { type: "heartbeat" };
        prepared = await fetchOnce(adapter, "key-429");
      }

      // Final headers have arrived. Clear only the deadline timer before ANY body read.
      headerDeadline.clear();
      if (!prepared.response.ok) {
        let body: Awaited<ReturnType<typeof readBoundedResponseBody>>;
        try {
          body = await readBoundedResponseBody(prepared.response, { signal });
        } catch {
          if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
          throw new LoopError(prepared.response.status, `Provider error ${prepared.response.status}`);
        }
        let formatted = "";
        if (body.displaySafe && !body.truncated && body.text.trim() && prepared.responseAdapter.formatErrorBody) {
          try {
            formatted = prepared.responseAdapter.formatErrorBody(
              prepared.response.status,
              prepared.response.headers,
              body.text,
            ).trim();
          } catch { /* formatter hooks are best-effort */ }
        }
        const suffix = formatted ? `: ${formatted.slice(0, 400)}` : "";
        throw new LoopError(prepared.response.status, `Provider error ${prepared.response.status}${suffix}`);
      }
      return prepared;
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      if (headerDeadline.didExpire()) {
        throw new LoopError(504, `Provider response-header timeout after ${connectTimeoutMs}ms during image-bridge`);
      }
      if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
      if (error instanceof LoopError) throw error;
      throw new LoopError(502, `Provider unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      headerDeadline.clear();
    }
  };

  const prepareIterationDrained = async (forceFinal: boolean): Promise<IterationResponse> => {
    const it = prepareIterationEvents(forceFinal);
    let r = await it.next();
    while (!r.done) r = await it.next();
    return r.value;
  };

  // Consume and validate one successful response body. Only invisible heartbeat events escape while
  // semantic output remains buffered for safe scanning.
  const consumeIterationEvents = async function* (prepared: IterationResponse): AsyncGenerator<AdapterEvent, IterationSplit> {
    const events: AdapterEvent[] = [];
    try {
      const parse = prepared.responseAdapter.parseStream.bind(prepared.responseAdapter);
      for await (const event of parseStreamWithProgress(prepared.response, parse, {
        signal,
        inactivityTimeoutMs: stallTimeoutMs,
        translatorBudget,
      })) {
        if (event.type === "heartbeat") yield event;
        else events.push(event);
      }
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
      if (error instanceof RoutedModelInactivityError) throw new LoopError(504, error.message);
      if (error instanceof WebSearchStreamProtocolError) throw new LoopError(502, error.message);
      throw new LoopError(502, `Provider stream error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const terminalIndexes = events.flatMap((event, index) =>
      event.type === "done" || event.type === "incomplete" || event.type === "error" ? [index] : []);
    if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
      throw new LoopError(502, `Image-bridge adapter stream protocol error: expected one final terminal event, received ${terminalIndexes.length}`);
    }
    const terminal = events[terminalIndexes[0]!];
    if (terminal.type === "error") {
      if (terminal.code === "translation_buffer_limit") {
        throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
      }
      throw new LoopError(502, terminal.message);
    }
    return scanEventsForImageCall(events, mediaToolNames);
  };

  // Eagerly acquire only the FIRST iteration's final headers so connect/header/HTTP failures remain
  // non-2xx JSON. Skip for runTurn adapters: their "headers" are synthetic, and awaiting
  // queue.collect() before returning SSE starves clients of headers/heartbeats on slow first turns.
  const skipEagerDrain = !!adapter.runTurn;
  let firstPrepared: IterationResponse | undefined;
  if (!skipEagerDrain) {
    try {
      firstPrepared = await prepareIterationDrained(maxRounds <= 0);
    } catch (e) {
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
      if (e instanceof LoopError) return jsonError(e.status, e.message);
      throw e;
    }
  }

  const toolNsMap = new Map<string, { namespace: string; name: string; freeform?: true }>();
  const freeform = new Set<string>();
  const toolSearch = new Set<string>();
  const requestedTools = parsed.context.tools ?? [];
  const toolAllowed = toolChoiceToolPredicate(parsed.options.toolChoice, requestedTools);
  for (const t of requestedTools) {
    if (!toolAllowed(t)) continue;
    if (t.namespace) {
      toolNsMap.set(namespacedToolName(t.namespace, t.name), {
        namespace: t.namespace,
        name: t.name,
        ...(t.freeform ? { freeform: true } : {}),
      });
    }
    if (t.freeform) freeform.add(t.name);
    if (t.toolSearch) toolSearch.add(t.name);
  }

  // Drive the remaining iterations live. Image generation runs interleaved with the real sidecar
  // timing; the final answer's passthrough events come last.
  async function* produce(): AsyncGenerator<AdapterEvent> {
    let prepared = firstPrepared;
    try {
      for (let i = 0; i < HARD_CAP; i++) {
        const forceFinal = i >= maxRounds;
        try {
          // First loop turn reuses the eager HEADERS when present. runTurn (and later iterations)
          // acquire headers inside the live SSE stream so clients already have the response open.
          if (!prepared || i > 0) {
            yield { type: "heartbeat" };
            prepared = yield* prepareIterationEvents(forceFinal);
          }
          // Raw-byte progress heartbeats reach the bridge; semantic events remain buffered.
          const split = yield* consumeIterationEvents(prepared);
          prepared = undefined;

          // Loop (fulfill + re-ask) ONLY when the model's actionable output is purely image_gen. A
          // real tool call means this turn is terminal for Codex — finalize so those calls reach
          // Codex. forceFinal also finalizes.
          const shouldLoop = split.calls.length > 0 && !split.hasRealToolCall && !forceFinal;
          if (!shouldLoop) {
            if (hiddenUsage) {
              for (let i = split.passthrough.length - 1; i >= 0; i--) {
                const e = split.passthrough[i];
                if (e?.type === "done" || e?.type === "incomplete") {
                  split.passthrough[i] = { ...e, usage: addUsage(hiddenUsage, e.usage) };
                  break;
                }
              }
            }
            yield* replay(split.passthrough);
            return;
          }

          // Discarded iteration still contributed tokens — accumulate for the final onUsage.
          takeUsageFrom(split.passthrough);

          // Fulfill each image/video call, then inject ONE assistant turn (thinking once + all tool
          // calls) so Anthropic extended-thinking continuations stay valid across parallel calls.
          const iterationThinking = extractIterationThinking(split.passthrough);
          const fulfilled: Array<{ call: ImageCall; result: Awaited<ReturnType<typeof fulfillImageCall>>; args: Record<string, unknown> }> = [];
          for (const call of split.calls) {
            const isVideoCall = videoPlan?.toolNames.has(call.name) === true;
            if (isVideoCall) {
              yield { type: "heartbeat" };
              if (paidVideoCalls >= MAX_VIDEO_CALLS_PER_TURN) {
                const vResult = {
                  ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0,
                  error: `video call budget exhausted (max ${MAX_VIDEO_CALLS_PER_TURN} per turn)`,
                };
                let pArgs: Record<string, unknown> = {};
                try { const raw: unknown = JSON.parse(call.args || "{}"); if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) pArgs = raw as Record<string, unknown>; } catch { /* malformed args */ }
                fulfilled.push({ call, result: vResult, args: pArgs });
                continue;
              }
              const vArgs = parseVideoCallArgs(call.args);
              let vResult;
              if (!vArgs.ok) {
                vResult = { ok: false, model: videoPlan!.model, prompt: "", files: [], count: 0, error: vArgs.error };
              } else {
                paidVideoCalls += 1;
                const videoTimeout = videoTimeoutMs ?? 300_000;
                const deadlineSignal = AbortSignal.timeout(videoTimeout);
                try {
                  const videoDeadline = Date.now() + videoTimeout;
                  // Bind submit to the shared deadline so submit + poll fit one budget.
                  const linkedDeadline = signal
                    ? AbortSignal.any([signal, deadlineSignal])
                    : deadlineSignal;
                  const { requestId } = await submitVideoJob(
                    {
                      prompt: vArgs.prompt, model: videoPlan!.model,
                      ...(vArgs.duration != null ? { duration: vArgs.duration } : {}),
                      ...(vArgs.resolution != null ? { resolution: vArgs.resolution } : {}),
                      ...(vArgs.aspectRatio != null ? { aspectRatio: vArgs.aspectRatio } : {}),
                    },
                    videoPlan!.auth, linkedDeadline,
                  );
                  const remainingMs = videoDeadline - Date.now();
                  if (remainingMs <= 0) {
                    vResult = { ok: false, model: videoPlan!.model, prompt: vArgs.prompt, files: [], count: 0, error: `video generation timed out after ${Math.floor(videoTimeout / 1000)}s` };
                  } else {
                  const pollGen = pollVideoWithHeartbeats(requestId, videoPlan!.auth, linkedDeadline, remainingMs);
                  let pollResult: { ok: true; videoUrl: string } | { ok: false; error: string };
                  try {
                    for (;;) {
                      const { value, done } = await pollGen.next();
                      if (done) { pollResult = value; break; }
                      yield { type: "heartbeat" };
                    }
                  } finally {
                    await pollGen.return({ ok: false, error: "cancelled" }).catch(() => {});
                  }
                  if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
                  if (pollResult.ok) {
                    const dlPath = await downloadVideoToArtifact(pollResult.videoUrl, vBudget, signal);
                    vResult = buildVideoResult(dlPath, vArgs.prompt, videoPlan!.model);
                  } else {
                    vResult = { ok: false, model: videoPlan!.model, prompt: vArgs.prompt, files: [], count: 0, error: pollResult.error };
                  }
                  }
                } catch (e) {
                  if (deadlineSignal.aborted && !signal.aborted) {
                    vResult = { ok: false, model: videoPlan!.model, prompt: vArgs.prompt ?? "", files: [], count: 0, error: `video generation timed out after ${Math.floor(videoTimeout / 1000)}s` };
                  } else if (signal.aborted) {
                    throw new LoopError(499, "client closed request during video-bridge");
                  } else {
                    const error = e instanceof Error ? e.message : String(e);
                    vResult = { ok: false, model: videoPlan!.model, prompt: vArgs.prompt ?? "", files: [], count: 0, error };
                  }
                }
              }
              if (signal.aborted) throw new LoopError(499, "client closed request during video-bridge");
              let vParsedArgs: Record<string, unknown> = {};
              try { const raw: unknown = JSON.parse(call.args || "{}"); if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) vParsedArgs = raw as Record<string, unknown>; } catch { /* malformed args */ }
              fulfilled.push({ call, result: vResult, args: vParsedArgs });
            } else {
              yield { type: "heartbeat" };
              if (!plan) {
                fulfilled.push({ call, result: { ok: false, model: "", prompt: "", files: [], count: 0, error: "image bridge not configured" }, args: {} });
                continue;
              }
              let result: Awaited<ReturnType<typeof fulfillImageCall>>;
              if (paidImageCalls >= MAX_IMAGE_CALLS_PER_TURN) {
                result = {
                  ok: false,
                  model: plan.model,
                  prompt: "",
                  files: [],
                  count: 0,
                  error: `image call budget exhausted (max ${MAX_IMAGE_CALLS_PER_TURN} per turn)`,
                };
              } else {
                paidImageCalls += 1;
                result = await fulfillImageCall(
                  { id: call.id, name: call.name, arguments: call.args },
                  plan, budget, signal,
                );
              }
              if (signal.aborted) throw new LoopError(499, "client closed request during image-bridge");
              let parsedArgs: Record<string, unknown> = {};
              try {
                const raw: unknown = JSON.parse(call.args || "{}");
                if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
                  parsedArgs = raw as Record<string, unknown>;
                }
              } catch { /* malformed args */ }
              fulfilled.push({ call, result, args: parsedArgs });
            }
          }
          // Prune artifacts once after the entire batch so a tight keepCount
          // cannot delete a video from an earlier call in this same iteration.
          pruneArtifacts(videoPlan?.artifactsKeepCount ?? plan?.artifactsKeepCount);
          // Drop results whose artifact files were pruned — never hand the model a dead path.
          for (const f of fulfilled) {
            if (!f.result.ok || !f.result.files || f.result.files.length === 0) continue;
            const survivors = f.result.files.filter(p => existsSync(p));
            if (survivors.length === f.result.files.length) continue; // nothing pruned
            if (survivors.length === 0) {
              f.result = {
                ok: false, model: f.result.model, prompt: f.result.prompt ?? "",
                files: [], count: 0,
                error: "artifact was pruned before delivery (increase artifactsKeepCount)",
              } as typeof f.result;
            } else {
              // Some files survived — refresh from survivors
              f.result = { ...f.result, files: survivors, count: survivors.length };
              const primary = survivors[0]!;
              (f.result as { path?: string }).path = primary;
              if ("markdown" in f.result && f.result.markdown) {
                // Image markdown references the primary path; video uses pathToFileURL
                if (f.result.markdown.startsWith("![")) {
                  (f.result as { markdown: string }).markdown = `![image](${pathToFileURL(primary).href})`;
                } else {
                  (f.result as { markdown: string }).markdown = `[video](${pathToFileURL(primary).href})`;
                }
              }
            }
          }
          const now = Date.now();
          messages.push({
            role: "assistant",
            content: [
              ...iterationThinking,
              ...fulfilled.map(({ call, args }) => ({
                type: "toolCall" as const,
                id: call.id,
                name: call.name,
                arguments: args,
                // Clone per call: parallel media calls each keep their own signature.
                ...(cloneProviderOpaqueToolCallMetadata(call.providerMetadata)
                  ? { providerMetadata: cloneProviderOpaqueToolCallMetadata(call.providerMetadata) }
                  : {}),
              })),
            ],
            timestamp: now,
          });
          for (const { call, result } of fulfilled) {
            messages.push({
              role: "toolResult",
              toolCallId: call.id,
              toolName: call.name,
              content: JSON.stringify(result),
              isError: !result.ok,
              timestamp: now,
            });
          }
        } catch (e) {
          if (isTranslatorBudgetExceededError(e)) {
            yield {
              type: "error",
              status: 502,
              errorType: "upstream_error",
              code: e.code,
              message: "upstream translation buffer exceeded the safe limit",
              ...(hiddenUsage ? { usage: hiddenUsage } : {}),
            };
          } else {
            yield {
              type: "error",
              message: e instanceof LoopError ? e.message : (e instanceof Error ? e.message : String(e)),
              ...(e instanceof LoopError ? { status: e.status } : {}),
              ...(hiddenUsage ? { usage: hiddenUsage } : {}),
            };
          }
          return;
        }
      }
    } finally {
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    }
  }

  const sse = bridgeToResponsesSSE(
    produce(), parsed._responseModelId ?? parsed.modelId, toolNsMap, freeform, toolSearch, () => {
      internalAbort.abort("client closed responses stream");
    }, 2_000,
    {
      translatorBudget,
      replayCacheScope: parsed._reasoningReplayScope,
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      stallTimeoutSec: deps.stallTimeoutSec,
      ...(deps.onFirstOutput ? { onFirstOutput: deps.onFirstOutput } : {}),
      ...(deps.onUsage ? {
        // Terminal done/incomplete already includes hiddenUsage (merged above). Do not
        // add it again here or request logs double-count multi-iteration image turns.
        onUsage: (usage: OcxUsage | undefined) => deps.onUsage?.(usage),
      } : {}),
      ...(deps.onCompletedResponse ? { onCompletedResponse: deps.onCompletedResponse } : {}),
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}
