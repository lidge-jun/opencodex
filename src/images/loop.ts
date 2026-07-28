/**
 * Image bridge agentic loop — adapted from src/web-search/loop.ts but significantly simpler.
 *
 * The routed (non-OpenAI) model runs in a bounded loop. Each iteration is streamed and fully
 * buffered internally. If the model calls an image-generation tool, the bridge fulfills it via
 * the xAI sidecar, injects the result as a tool_result, and loops (bounded by maxRounds). When
 * the model produces a real tool call or the budget is exhausted, the passthrough events are
 * replayed to the bridge for final SSE output.
 *
 * Removed vs web-search: no sidecar backend selection, no forced-answer nudge, no failed-query
 * dedup, no describeImages/structuredOutput, no recordSidecarOutcome.
 */
import type { AdapterRequest, ProviderAdapter } from "../adapters/base";
import { createAdapterEventQueue } from "../adapters/run-turn-queue";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderContinuationState, OcxRequestOptions, OcxThinkingContent, OcxUsage } from "../types";
import { namespacedToolName } from "../types";
import { bridgeToResponsesSSE } from "../bridge";
import { clearableDeadline, idleDeadline } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { fetchWithResetRetry } from "../lib/upstream-retry";
import { parseStreamWithProgress, RoutedModelInactivityError, WebSearchStreamProtocolError } from "../web-search/progress-stream";
import { fulfillImageCall } from "./fulfill";
import { createImageBudget } from "./artifacts";
import { IMAGE_GEN_TOOL_NAME } from "./synthetic-tool";
import type { ImageBridgePlan } from "./types";

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
/** Cap paid xAI fulfillments per turn (parallel calls in one round count separately). */
export const MAX_IMAGE_CALLS_PER_TURN = 10;

/**
 * Clamp a configured maxRounds value to a safe integer in [0, MAX_ROUNDS_HARD_LIMIT].
 * Non-finite / non-number inputs fall back to DEFAULT_MAX_ROUNDS.
 */
export function clampImageMaxRounds(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_MAX_ROUNDS;
  return Math.max(0, Math.min(MAX_ROUNDS_HARD_LIMIT, Math.floor(value)));
}

/** Drop image-specific tool_choice when image tools are stripped for a forced-final pass. */
function stripImageToolChoice(
  options: OcxRequestOptions,
  plan: ImageBridgePlan,
): OcxRequestOptions {
  const tc = options.toolChoice;
  if (!tc || typeof tc !== "object") return options;
  if ("name" in tc && typeof tc.name === "string") {
    if (tc.name === IMAGE_GEN_TOOL_NAME || plan.toolNames.has(tc.name)) {
      return { ...options, toolChoice: "auto" };
    }
    return options;
  }
  if ("allowedTools" in tc && Array.isArray(tc.allowedTools)) {
    const filtered = tc.allowedTools.filter(
      (name) => name !== IMAGE_GEN_TOOL_NAME && !plan.toolNames.has(name),
    );
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
  let pending: { name: string; id: string; argsBuf: string; events: AdapterEvent[] } | null = null;
  const flushPending = (): void => {
    if (!pending) return;
    if (toolNames.has(pending.name)) {
      // Unterminated image call still carries buffered args — fulfill so malformed JSON
      // becomes a normal tool_result error instead of silently vanishing.
      calls.push({ id: pending.id, name: pending.name, args: pending.argsBuf });
    } else {
      passthrough.push(...pending.events);
      hasRealToolCall = true;
    }
    pending = null;
  };
  for (const e of events) {
    if (e.type === "tool_call_start") {
      flushPending();
      pending = { name: e.name, id: e.id, argsBuf: "", events: [e] };
    } else if (e.type === "tool_call_delta" && pending) {
      pending.argsBuf += e.arguments;
      pending.events.push(e);
    } else if (e.type === "tool_call_end" && pending) {
      pending.events.push(e);
      if (toolNames.has(pending.name)) {
        calls.push({ id: pending.id, name: pending.name, args: pending.argsBuf });
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

  for (const e of events) {
    if (e.type === "thinking_delta") {
      thinking += e.thinking;
    } else if (e.type === "thinking_signature") {
      signature = e.signature;
      flushVisible();
    } else if (e.type === "redacted_thinking") {
      flushVisible();
      parts.push({ type: "thinking", thinking: "", redacted: [e.data] });
    }
  }
  flushVisible();
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

export interface ImageBridgeDeps {
  parsed: OcxParsedRequest;
  adapter: ProviderAdapter;
  plan: ImageBridgePlan;
  /** Headers forwarded from the original request (e.g. Codex auth). Cloned per iteration. */
  forwardHeaders?: Headers;
  /** Called before each routed-model dispatch in the bridge loop, for attempt telemetry. */
  onAttemptSend?: () => void;
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
  /** Raw adapter usage at the terminal event, pre wire-normalization (see bridgeToResponsesSSE onUsage). */
  onUsage?: (usage: OcxUsage | undefined) => void;
  /**
   * Optional 429 key-failover for the routed (non-xAI) model. Return a rebuilt adapter for the
   * rotated key, or null when the pool is exhausted.
   */
  on429?: (retryAfterHeader: string | null) => ProviderAdapter | null;
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
  const { parsed, plan, abortSignal } = deps;
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
  // Forced-final must strip every image-generation alias the plan knows about — not only tools
  // flagged `imageGeneration:true`. Hosted `image_generation` / function aliases would otherwise
  // remain callable; scanEventsForImageCall would strip the call while forceFinal blocks fulfillment,
  // leaving the client an empty completion.
  const toolsNoImage = allTools.filter(t => {
    if (t.imageGeneration) return false;
    if (plan.toolNames.has(t.name)) return false;
    if (t.namespace && plan.toolNames.has(namespacedToolName(t.namespace, t.name))) return false;
    return true;
  });
  const budget = createImageBudget();

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

  // Acquire one iteration's final response headers. The first call is drained eagerly so an initial
  // connect/header/HTTP failure stays a non-2xx JSON response — except for runTurn adapters, which
  // have no HTTP status surface and must not block SSE headers behind queue.collect().
  const prepareIterationEvents = async function* (forceFinal: boolean): AsyncGenerator<AdapterEvent, IterationResponse> {
    const iterParsed: OcxParsedRequest = {
      ...parsed,
      stream: true,
      context: { ...parsed.context, messages, tools: forceFinal ? toolsNoImage : allTools },
      options: forceFinal ? stripImageToolChoice(parsed.options, plan) : parsed.options,
    };

    // runTurn adapters (Cursor) own all upstream communication via an emit callback. They don't
    // expose buildRequest/fetchResponse/parseStream to the bridge, so collect their events through
    // an AdapterEventQueue and wrap them in a pseudo-response whose parseStream replays them.
    if (adapter.runTurn) {
      const queue = createAdapterEventQueue({
        onBacklogExceeded: () => internalAbort.abort("runTurn backlog exceeded"),
      });
      // Attempt telemetry must fire at dispatch time (parity with fetchOnce), not after collect.
      deps.onAttemptSend?.();
      void adapter
        .runTurn(
          iterParsed,
          { headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(), abortSignal: signal },
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

    const headerDeadline = clearableDeadline(connectTimeoutMs, signal);
    try {
      const fetchOnce = async (requestAdapter: ProviderAdapter): Promise<IterationResponse> => {
        const request = await requestAdapter.buildRequest(iterParsed, {
          headers: deps.forwardHeaders ? new Headers(deps.forwardHeaders) : new Headers(),
          abortSignal: headerDeadline.signal,
        });
        try { deps.onRequestBuilt?.(request); } catch { /* diagnostics are best-effort */ }
        deps.onAttemptSend?.();
        const response = requestAdapter.fetchResponse
          ? await requestAdapter.fetchResponse(request, {
              abortSignal: headerDeadline.signal,
              timeoutMs: connectTimeoutMs,
              returnRawErrors: true,
              stream: true,
            })
          : await fetchWithResetRetry(
              () => {
                const h = new Headers(request.headers);
                if (!h.has("accept-encoding")) h.set("accept-encoding", "identity");
                return fetchImpl(request.url, {
                  method: request.method,
                  headers: h,
                  body: request.body,
                  signal: headerDeadline.signal,
                });
              },
              { abortSignal: headerDeadline.signal, label: "image-bridge-loop" },
            );
        return { response, responseAdapter: requestAdapter };
      };

      let prepared = await fetchOnce(adapter);
      // 429 key-failover parity with web-search / normal routed path.
      while (prepared.response.status === 429 && deps.on429) {
        const rotated = deps.on429(prepared.response.headers.get("retry-after"));
        if (!rotated) break;
        try { void prepared.response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        adapter = rotated;
        yield { type: "heartbeat" };
        prepared = await fetchOnce(adapter);
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
      })) {
        if (event.type === "heartbeat") yield event;
        else events.push(event);
      }
    } catch (error) {
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
    if (terminal.type === "error") throw new LoopError(502, terminal.message);
    return scanEventsForImageCall(events, plan.toolNames);
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

  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeform = new Set<string>();
  const toolSearch = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
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

          // Fulfill each image call, then inject ONE assistant turn (thinking once + all tool
          // calls) so Anthropic extended-thinking continuations stay valid across parallel calls.
          const iterationThinking = extractIterationThinking(split.passthrough);
          const fulfilled: Array<{ call: ImageCall; result: Awaited<ReturnType<typeof fulfillImageCall>>; args: Record<string, unknown> }> = [];
          for (const call of split.calls) {
            yield { type: "heartbeat" };
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
          yield {
            type: "error",
            message: e instanceof LoopError ? e.message : (e instanceof Error ? e.message : String(e)),
            ...(e instanceof LoopError ? { status: e.status } : {}),
            ...(hiddenUsage ? { usage: hiddenUsage } : {}),
          };
          return;
        }
      }
    } finally {
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    }
  }

  const sse = bridgeToResponsesSSE(
    produce(), parsed.modelId, toolNsMap, freeform, toolSearch, () => {
      internalAbort.abort("client closed responses stream");
    }, 2_000,
    {
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
