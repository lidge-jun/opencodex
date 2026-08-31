import type { AdapterRequest, IncomingMeta, ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxProviderOpaqueToolCallMetadata, OcxThinkingContent, OcxUsage, RateLimitRetryPolicy } from "../types";
import { namespacedToolName, toolChoiceToolPredicate } from "../types";
import { cloneProviderOpaqueToolCallMetadata } from "../responses/provider-opaque-metadata";
import type { AttemptRecoveryKind } from "../usage/log";
import { bridgeToResponsesSSE } from "../bridge";
import { runWebSearch, type SidecarOutcome, type SidecarOutcomeRecorder, type SidecarSettings } from "./executor";
import { runAnthropicWebSearch } from "./anthropic-executor";
import { runXaiWebSearch, type XaiSearchOptions } from "./xai-executor";
import { runGeminiWebSearch } from "./gemini-executor";
import { runExaWebSearch } from "./exa-executor";
import type { WebSearchBackendId } from "./index";
import { clearableDeadline } from "../lib/abort";
import { redactSecretString } from "../lib/redact";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { applyUpstreamRecoveryInit, fetchWithResetRetry, prepareSameTarget429Wait } from "../lib/upstream-retry";
import { rateLimitRetryDelayMs } from "../providers/key-failover";
import {
  isTranslatorBudgetExceededError,
  TRANSLATOR_MAX_TURN_BYTES,
  TranslatorBudgetExceededError,
} from "../lib/translator-budget";
import { formatWebSearchResults } from "./format-result";
import { parseStreamWithProgress, RoutedModelInactivityError, WebSearchStreamProtocolError } from "./progress-stream";
import { WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

interface WebSearchCall {
  id: string;
  // One or more queries the model batched into a single web_search call. Always length >= 0; an
  // empty array means the model called the tool with neither `query` nor `queries` (handled as an
  // empty-query placeholder).
  queries: string[];
  /**
   * Provider-opaque metadata from the originating part (issue #1735). Stored PER CALL so a
   * signature can never migrate to a different call when the model batches several.
   */
  providerMetadata?: OcxProviderOpaqueToolCallMetadata;
}

/**
 * Normalize a web_search tool call's raw JSON args into a canonical `queries[]`. Accepts native
 * plural `queries: string[]` or singular `query: string` (the model may send either). Non-string /
 * empty entries are dropped; malformed JSON yields `[]` (handled downstream as an empty-query call).
 */
function parseQueries(argsBuf: string): string[] {
  try {
    const o: unknown = JSON.parse(argsBuf || "{}");
    if (!o || typeof o !== "object") return [];
    const obj = o as { query?: unknown; queries?: unknown };
    if (Array.isArray(obj.queries)) {
      const qs = obj.queries.filter((q): q is string => typeof q === "string" && q.trim() !== "");
      if (qs.length > 0) return qs;
    }
    if (typeof obj.query === "string" && obj.query.trim() !== "") return [obj.query];
  } catch { /* malformed args → empty */ }
  return [];
}

/**
 * Split a non-streaming turn's adapter events into (a) the web_search calls to intercept and (b) the
 * events to pass through to Codex. A web_search tool-call's own start/delta/end events are dropped
 * (Codex never sees the synthetic tool); every other event — text, thinking, real tool calls, done —
 * is preserved in order.
 */
export function scanEventsForWebSearch(events: AdapterEvent[]): {
  calls: WebSearchCall[];
  passthrough: AdapterEvent[];
  hasRealToolCall: boolean;
  hasMalformedToolCall: boolean;
} {
  const calls: WebSearchCall[] = [];
  const passthrough: AdapterEvent[] = [];
  let hasRealToolCall = false;
  let hasMalformedToolCall = false;
  let pending: { name: string; id: string; argsBuf: string; closed: boolean; events: AdapterEvent[]; providerMetadata?: OcxProviderOpaqueToolCallMetadata } | null = null;
  const isBlank = (value: string): boolean => value.trim().length === 0;
  const flushPending = (): void => {
    // A pending call that never saw tool_call_end is structurally malformed.
    if (pending && !pending.closed) hasMalformedToolCall = true;
    if (pending && pending.name !== WEB_SEARCH_TOOL_NAME) {
      passthrough.push(...pending.events);
      if (pending.closed && !isBlank(pending.id) && !isBlank(pending.name)) hasRealToolCall = true;
    }
    pending = null;
  };
  for (const e of events) {
    if (e.type === "tool_call_start") {
      flushPending();
      if (isBlank(e.id) || isBlank(e.name)) hasMalformedToolCall = true;
      pending = { name: e.name, id: e.id, argsBuf: "", closed: false, events: [e], providerMetadata: e.providerMetadata };
    } else if (e.type === "tool_call_delta") {
      // Orphan delta (no open call) is malformed.
      if (!pending) hasMalformedToolCall = true;
      else {
        pending.argsBuf += e.arguments;
        pending.events.push(e);
      }
    } else if (e.type === "tool_call_end") {
      // Orphan end (no open call) is malformed.
      if (!pending) {
        hasMalformedToolCall = true;
      } else {
        pending.events.push(e);
        pending.closed = true;
        if (pending.name === WEB_SEARCH_TOOL_NAME) {
          calls.push({ id: pending.id, queries: parseQueries(pending.argsBuf), providerMetadata: pending.providerMetadata });
        } else {
          passthrough.push(...pending.events);
          if (!isBlank(pending.id) && !isBlank(pending.name)) hasRealToolCall = true;
        }
        pending = null;
      }
    } else {
      passthrough.push(e);
    }
  }
  flushPending();
  return { calls, passthrough, hasRealToolCall, hasMalformedToolCall };
}

/**
 * Visible final-answer text: a non-whitespace text_delta that is NOT commentary
 * (#1001). Commentary streams early for progress and must not satisfy the
 * forced-answer output check; thinking alone never counts either.
 */
export function hasVisibleAssistantText(events: AdapterEvent[]): boolean {
  return events.some(event =>
    event.type === "text_delta"
    && event.phase !== "commentary"
    && event.text.trim().length > 0);
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const e of events) yield e;
}

/**
 * Collect the thinking block that preceded a web_search call in this iteration's events, so the
 * replayed assistant turn can carry it. Anthropic extended thinking REQUIRES the assistant
 * message that contains tool_use to start with its signed thinking/redacted_thinking blocks —
 * replaying a bare toolCall 400s ("Expected `thinking` or `redacted_thinking`, but found
 * `tool_use`"). The signature validity gate stays in the anthropic adapter; other adapters
 * ignore or serialize the part harmlessly.
 *
 * Each signed block keeps its OWN signature and text, mirroring src/images/loop.ts: a signature
 * authenticates the exact block it closed, so flattening two blocks under the last signature
 * 400s on replay just as it does there.
 *
 * Raw reasoning (`reasoning_raw_delta`, what OpenAI-compatible providers emit instead of signed
 * thinking) accumulates into a SEPARATE UNSIGNED part. It must never join a signed block: the
 * anthropic serializer skips signature-less parts, while openai-chat serializes their text as
 * `reasoning_content` — which DeepSeek V4 thinking mode requires back alongside the replayed
 * tool_calls, and whose absence ended the turn as a provider 400 (issue #688).
 *
 * This assumes raw reasoning never interleaves INSIDE an unfinished signed block: Anthropic-family
 * adapters emit thinking_delta/signature and OpenAI-compatible ones emit reasoning_raw_delta, and
 * the two never share a stream. Honoring a genuinely mixed stream would need per-segment state,
 * not another accumulator.
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

/** Normalize a query for failed-query de-duplication (case/whitespace-insensitive). */
function normalizeQuery(q: string): string {
  return q.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Transient developer-role nudge appended ONLY to the forced-answer pass's request (never the
 * persisted `messages`). It tells the model to ground its final answer in the web results already
 * gathered this turn. Citation wording is conditional — a failed/empty search still wants an answer,
 * just without fabricated sources.
 */
function forcedAnswerNudge(): OcxMessage {
  return {
    role: "developer",
    content:
      "Answer the user's question now using the web search results already gathered above. " +
      "Ground your answer in what those results actually say, and reference the relevant sources " +
      "when they are available. Do not claim you lack information that the results contain, and do " +
      "not invent sources that were not returned.",
    timestamp: Date.now(),
  };
}

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Hard provider/parse failure inside an iteration. The eager first iteration converts it to a
 *  non-200 jsonError; later (already-streaming) iterations surface it as an in-stream error event. */
class LoopError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "LoopError";
  }
}

/**
 * Dependencies for one web-search loop iteration: parsed request, active adapter,
 * incoming metadata, and the configured search executor.
 */
export interface WebSearchLoopDeps {
  parsed: OcxParsedRequest;
  adapter: ProviderAdapter;
  incomingMeta: IncomingMeta;
  /**
   * Which executor runs searches. Defaults to "openai" so existing callers keep the ChatGPT path
   * (audit F4). The widened ids (xai/gemini/exa) cannot reach the loop yet: planWebSearch returns
   * no plan for them (inert 060 arms), and the dispatch below only branches on "anthropic".
   */
  backend?: WebSearchBackendId;
  /** Required for the openai backend; unused (and typically undefined) for the anthropic backend. */
  forwardProvider?: OcxProviderConfig;
  /** Required for the anthropic backend: the stored-OAuth provider that runs web_search_20250305. */
  anthropicSidecar?: { providerName: string; provider: OcxProviderConfig };
  /** Required for the xai backend: the stored Grok OAuth provider (L7). */
  xaiSidecar?: { providerName: string; provider: OcxProviderConfig };
  /** Required for the gemini backend: the stored Antigravity CCA provider (L8). */
  geminiSidecar?: { providerName: string; provider: OcxProviderConfig };
  /** Required for the exa backend: the operator key, read from config at plan unpack (L9). */
  exaApiKey?: string;
  /** Opt-in x_search options for the xai backend. */
  xaiSearchOptions?: XaiSearchOptions;
  hostedTool: Record<string, unknown>;
  selectedForwardHeaders: Headers;
  settings: SidecarSettings;
  maxSearches: number;
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  recordSidecarOutcome?: SidecarOutcomeRecorder;
  /** Cumulative per-iteration deadline for DNS/TCP/TLS and final response headers only. */
  connectTimeoutMs?: number;
  /** Continuous routed-model response-body raw-byte inactivity deadline. Default 200000ms. */
  routedModelStallTimeoutMs?: number;
  /**
   * Effective bridge stall deadline for this turn (seconds). Computed by planWebSearch
   * (webSearchStallTimeoutSec) to cover response-header wait, routed-model body inactivity, and one
   * sidecar search, so a legitimately slow-but-progressing unit never trips the bridge watchdog.
   */
  stallTimeoutSec?: number;
  /**
   * Opt-in: stream the routed model's leading text/thinking deltas live instead of holding the whole
   * iteration back. The live window closes at the first buffer-only event (tool calls above all) so
   * the web_search interception decision stays atomic; everything after replays in order at the end.
   */
  streamRoutedModelOutput?: boolean;
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  /** Raw adapter usage at the terminal event, pre wire-normalization (see bridgeToResponsesSSE onUsage). */
  onUsage?: (usage: OcxUsage | undefined) => void;
  /** Observe the exact adapter request selected for each routed-model iteration. */
  onRequestBuilt?: (request: AdapterRequest) => void;
  /** Called before each routed-model dispatch in the loop, for attempt telemetry. Same-target 429 replays pass the `rate-limit-429` recovery kind. */
  onAttemptSend?: (recovery?: AttemptRecoveryKind) => void;
  /**
   * 429 failover hook: rotate the provider's active credential and return a rebuilt adapter,
   * or null when the pool is exhausted. Async hooks support OAuth refresh; existing synchronous
   * key-pool hooks remain valid.
   */
  on429?: (retryAfterHeader: string | null) => ProviderAdapter | null | Promise<ProviderAdapter | null>;
  /** Opt-in same-target 429 policy (key-auth providers). When present, 429 replays on the SAME key before on429 rotation. */
  retryOn429Policy?: Required<RateLimitRetryPolicy> | null;
  /** Called only when the final bridged Responses stream reaches completed or incomplete. */
  onCompletedResponse?: (response: Record<string, unknown>) => void;
}

/**
 * Run the main (non-OpenAI) model in a small agentic loop. Each upstream iteration is streamed and
 * fully buffered internally so raw byte progress is observable without leaking a synthetic tool or
 * preliminary assistant output. If the model invokes web_search, run it via the hosted sidecar,
 * inject the answer as a tool_result, and loop (bounded by `maxSearches`).
 */
export async function runWithWebSearch(deps: WebSearchLoopDeps): Promise<Response> {
  const translatorBudget = deps.incomingMeta.translatorBudget;
  const routedProviderFetch = deps.incomingMeta.providerFetch ?? globalThis.fetch;
  const { parsed, selectedForwardHeaders, forwardProvider, hostedTool, settings, maxSearches, abortSignal, recordSidecarOutcome } = deps;
  const backend = deps.backend ?? "openai";
  const anthropicSidecar = deps.anthropicSidecar;
  // Mutable: 429 key-failover (deps.on429) can swap in a rebuilt adapter mid-loop.
  let adapter = deps.adapter;

  // Bridge stall budget (seconds of silence before upstream_stall_timeout); the retry backoff
  // heartbeat interval is derived from it so the watchdog is always fed during deliberate waits.
  const stallTimeoutMs = typeof deps.stallTimeoutSec === "number" && Number.isFinite(deps.stallTimeoutSec) && deps.stallTimeoutSec > 0
    ? Math.floor(deps.stallTimeoutSec * 1000)
    : 300_000;

  const messages: OcxMessage[] = [...parsed.context.messages];
  const loopT0 = Date.now();
  const allTools = parsed.context.tools ?? [];
  // For the forced-answer pass we drop the synthetic web_search tool so the model MUST answer from the
  // results already in `messages` (can't search again) — this guarantees a non-empty final answer.
  const toolsNoWebSearch = allTools.filter(t => !t.webSearch);
  let searchesExecuted = 0;
  let executedSearchCount = 0;
  // Queries whose search already failed this turn — repeats are short-circuited so a model that keeps
  // re-asking the same failing query doesn't burn the whole search budget on it.
  const failedQueries = new Set<string>();

  // Link an internal AbortController to the turn signal so a client cancel of the SSE body (bridge
  // `onCancel`) aborts in-flight model fetches AND the sidecar — the work now runs INSIDE the stream,
  // so without this a cancelled turn would leak fetches and keep draining tokens.
  const internalAbort = new AbortController();
  const linkAbort = (): void => internalAbort.abort(abortSignal?.reason);
  if (abortSignal) {
    if (abortSignal.aborted) linkAbort();
    else abortSignal.addEventListener("abort", linkAbort, { once: true });
  }
  const signal = internalAbort.signal;

  // Hard iteration bound (termination safety net); forceAnswer normally ends the loop sooner.
  const HARD_CAP = maxSearches + 2;
  const connectTimeoutMs = deps.connectTimeoutMs ?? 200_000;
  const routedModelStallTimeoutMs = deps.routedModelStallTimeoutMs ?? 200_000;

  interface IterationResponse {
    response: Response;
    responseAdapter: ProviderAdapter;
  }
  type IterationSplit = ReturnType<typeof scanEventsForWebSearch> & {
    /**
     * How many leading passthrough events were already delivered live this iteration. They are
     * exactly the first N passthrough entries (live delivery stops before the first event that
     * scanEventsForWebSearch could group or reorder), so the terminal replay skips them by count.
     */
    streamedPassthroughCount: number;
  };

  // Same-target 429 budget is per REQUEST, not per model iteration: later search rounds inherit
  // what earlier rounds left of `attempts`, so a bounded multi-round turn can never exceed the
  // configured replay count in total (a per-round reset would multiply it by maxSearches).
  const rateLimitRetryPolicy = deps.retryOn429Policy ?? null;
  let rateLimitRetries = 0;

  // Acquire one iteration's final response headers. The first call is drained eagerly so an initial
  // connect/header/HTTP failure stays a non-2xx JSON response. Its successful BODY is deliberately
  // left unread until the downstream Responses SSE bridge exists.
  /**
   * Fetch one web-search iteration's final response headers, applying the response-header
   * deadline and the same-target 429 retry policy (with awaited body release and deadline
   * restart) before the `on429` key rotation.
   */
  const prepareIterationEvents = async function* (forceAnswer: boolean): AsyncGenerator<AdapterEvent, IterationResponse> {
    // On the forced-answer pass the synthetic web_search tool is gone, so the model MUST answer
    // from the results already in `messages`. A weak model can still produce a thin answer that
    // ignores what the search found, which reads to the user as "the search did nothing". Nudge it
    // (iteration-locally — never mutate the shared `messages`) to actually use the gathered results.
    // Only when a REAL search ran (executedSearchCount, not empty-query/limit/repeat placeholders).
    const iterMessages: OcxMessage[] = forceAnswer && executedSearchCount > 0
      ? [...messages, forcedAnswerNudge()]
      : messages;
    const iterParsed: OcxParsedRequest = {
      ...parsed, stream: true,
      context: { ...parsed.context, messages: iterMessages, tools: forceAnswer ? toolsNoWebSearch : allTools },
    };
    // One cumulative header deadline spans every pool-key 429 rotation in this model iteration.
    // clear() stops only its timer after final headers; the direct turn signal remains attached to
    // the returned response body through AbortSignal.any().
    let headerDeadline = clearableDeadline(connectTimeoutMs, signal);
    try {
      /**
       * Build and fetch one web-search iteration on the given adapter, under the iteration
       * header deadline. The caller owns same-target 429 replays and key rotation around it.
       * The outbound request is cached per adapter so a same-target replay reuses the EXACT
       * URL, serialized body, and headers (builder runs once per target sequence).
       */
      let cachedRequest: AdapterRequest | undefined;
      let cachedAdapter: ProviderAdapter | undefined;
      /**
       * Build and fetch one web-search iteration on the given adapter, under the iteration
       * header deadline. The caller owns same-target 429 replays and key rotation around it.
       */
      const fetchOnce = async (requestAdapter: ProviderAdapter, recovery?: AttemptRecoveryKind): Promise<IterationResponse> => {
        let request: AdapterRequest;
        if (cachedRequest !== undefined && cachedAdapter === requestAdapter) {
          request = cachedRequest;
        } else {
          request = await requestAdapter.buildRequest(iterParsed, {
            ...deps.incomingMeta,
            headers: selectedForwardHeaders,
            abortSignal: headerDeadline.signal,
            translatorBudget,
          });
          try {
            deps.onRequestBuilt?.(request);
          } catch {
            // Diagnostics are best-effort and must never abort a web-search iteration.
          }
          cachedRequest = request;
          cachedAdapter = requestAdapter;
        }
        let response: Response;
        try {
          if (requestAdapter.fetchResponse) {
            deps.onAttemptSend?.(recovery);
            response = await requestAdapter.fetchResponse(request, {
              abortSignal: headerDeadline.signal,
              timeoutMs: connectTimeoutMs,
              returnRawErrors: true,
              stream: true,
              executor: routedProviderFetch,
            });
          } else {
            response = await fetchWithResetRetry(
              (retryRecovery) => {
                // Record every helper-driven send (the callback runs for the first attempt and
                // each connection-reset replay); preserve the caller's recovery kind
                // (rate-limit-429 / key-429) when the retry layer supplies none.
                deps.onAttemptSend?.(retryRecovery ?? recovery);
                const h = new Headers(request.headers);
                if (!h.has("accept-encoding")) h.set("accept-encoding", "identity");
                // A connection-reset replay must leave the half-closed pooled socket, not just
                // ask politely: Bun has ignored a bare `Connection: close` (oven-sh/bun#20492),
                // so the transport-level `keepalive: false` this helper adds is what actually
                // opens a new connection. Spending `retryRecovery` on telemetry alone left every
                // replay on this leg eligible for the same dead socket the reset came from.
                return routedProviderFetch(request.url, applyUpstreamRecoveryInit({
                  method: request.method,
                  headers: h,
                  body: request.body,
                  signal: headerDeadline.signal,
                }, retryRecovery));
              },
              { abortSignal: headerDeadline.signal, label: "web-search-loop" },
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
          throw new LoopError(499, "client closed request during web-search");
        }
        // Client cancellation wins over any stale-deadline edge: re-check before telemetry/replay.
        if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
        // The deliberate backoff must not consume the cumulative response-header deadline:
        // start a fresh one so the replay gets a new connect budget (504 stays reserved for real
        // upstream latency).
        headerDeadline = clearableDeadline(connectTimeoutMs, signal);
        // Stall-watchdog seam between bounded retry fetches.
        yield { type: "heartbeat" };
        prepared = await fetchOnce(adapter, "rate-limit-429");
      }
      // 429 key-failover parity with the normal routed path: rotate pool keys until one responds
      // or the pool is exhausted (deps.on429 returns null — cooldown map guarantees termination).
      while (prepared.response.status === 429 && deps.on429) {
        const rotated = await deps.on429(prepared.response.headers.get("retry-after"));
        if (!rotated) break;
        // Never let a broken body's cancel promise outlive the cumulative header deadline. Observe
        // it, but proceed immediately to the rotated fetch under the SAME deadline signal.
        try { void prepared.response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        adapter = rotated;
        // Stall-watchdog seam between bounded retry fetches (audit 011 B3).
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
          // The response status is authoritative even when its untrusted error body fails while
          // being read (including a synchronous getReader() failure). Never route that failure
          // through the adapter formatter or the generic transport error, which could expose its
          // raw message. A parent/client cancellation still owns the request lifecycle as 499.
          if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
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
          } catch { /* formatter hooks are best-effort; unsafe raw text is never the fallback */ }
        }
        const suffix = formatted ? `: ${formatted.slice(0, 400)}` : "";
        throw new LoopError(prepared.response.status, `Provider error ${prepared.response.status}${suffix}`);
      }
      return prepared;
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      if (headerDeadline.didExpire()) {
        throw new LoopError(504, `Provider response-header timeout after ${connectTimeoutMs}ms during web-search`);
      }
      if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
      if (error instanceof LoopError) throw error;
      throw new LoopError(502, `Provider unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      headerDeadline.clear();
    }
  };

  const prepareIterationDrained = async (forceAnswer: boolean): Promise<IterationResponse> => {
    const it = prepareIterationEvents(forceAnswer);
    let r = await it.next();
    while (!r.done) r = await it.next();
    return r.value;
  };

  // Event types that may leave the live window before the first tool-call boundary: pure
  // text/thinking output the native (sidecar-less) path would deliver identically. Everything
  // else — tool calls above all, and any type scanEventsForWebSearch could group or a future
  // adapter could add — closes the window so live delivery can never reorder against the replay.
  const LIVE_STREAMABLE = new Set<AdapterEvent["type"]>([
    "text_delta", "thinking_delta", "reasoning_raw_delta",
    "thinking_signature", "redacted_thinking", "kiro_redacted_reasoning",
  ]);

  // Consume and validate one successful response body under a resettable raw-byte inactivity guard.
  // By default only invisible heartbeat events escape while semantic output remains buffered for
  // safe scanning; with `streamRoutedModelOutput` the leading text/thinking deltas stream live and
  // the live window closes permanently at the first buffer-only event (see LIVE_STREAMABLE).
  const consumeIterationEvents = async function* (prepared: IterationResponse): AsyncGenerator<AdapterEvent, IterationSplit> {
    const events: AdapterEvent[] = [];
    let liveWindowOpen = deps.streamRoutedModelOutput === true;
    let streamedPassthroughCount = 0;
    try {
      const parse = prepared.responseAdapter.parseStream.bind(prepared.responseAdapter);
      for await (const event of parseStreamWithProgress(prepared.response, parse, {
        signal,
        inactivityTimeoutMs: routedModelStallTimeoutMs,
        translatorBudget,
      })) {
        if (event.type === "heartbeat") yield event;
        // Kiro's explicit-completion protocol marks ordinary assistant text as commentary while
        // it performs a bounded final-answer retry. That text is safe to surface immediately and
        // is exactly what the native Kiro transport streams. Keeping it in the search scanner made
        // Codex show only `Working` until both Kiro attempts had finished (often 30-40 seconds).
        // Tool events remain buffered below, so the decision to invoke the hosted sidecar is still
        // atomic and no search call can escape before its stream has validated successfully.
        else if (event.type === "text_delta" && event.phase === "commentary") yield event;
        else if (liveWindowOpen && LIVE_STREAMABLE.has(event.type)) {
          // Live events are ALSO buffered: the scanner still needs them for thinking extraction
          // and the forced-answer output check; only the terminal replay skips them (by count).
          yield event;
          streamedPassthroughCount++;
          events.push(event);
        } else {
          liveWindowOpen = false;
          events.push(event);
        }
      }
    } catch (error) {
      if (isTranslatorBudgetExceededError(error)) throw error;
      if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
      if (error instanceof RoutedModelInactivityError) throw new LoopError(504, error.message);
      if (error instanceof WebSearchStreamProtocolError) throw new LoopError(502, error.message);
      throw new LoopError(502, `Provider stream error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const terminalIndexes = events.flatMap((event, index) =>
      event.type === "done" || event.type === "incomplete" || event.type === "error" ? [index] : []);
    if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
      throw new LoopError(502, `Web-search adapter stream protocol error: expected one final terminal event, received ${terminalIndexes.length}`);
    }
    const terminal = events[terminalIndexes[0]!];
    if (terminal.type === "error") {
      if (terminal.code === "translation_buffer_limit") {
        throw new TranslatorBudgetExceededError("retained_collectors", TRANSLATOR_MAX_TURN_BYTES);
      }
      throw new LoopError(502, terminal.message);
    }
    return { ...scanEventsForWebSearch(events), streamedPassthroughCount };
  };

  // Execute one model-requested web_search call. The call may batch several queries (native
  // `action.search.queries`); each query runs as its own sidecar search (budget-aware), but they are
  // paired as ONE assistant toolCall + ONE aggregated toolResult so function-call pairing stays
  // valid, and surface as ONE search cell carrying every attempted query. A real search (one that
  // hits the sidecar) shows the spinner WHILE the batch runs. Empty/limit/repeat placeholders never
  // emit a cell (matching the prior single-query behavior).
  async function* runSearchCall(call: WebSearchCall, precedingThinking: OcxThinkingContent[] = []): AsyncGenerator<AdapterEvent> {
    const results: { query: string; outcome: SidecarOutcome }[] = [];
    let beganCell = false;
    if (call.queries.length === 0) {
      // The model called web_search with neither query nor queries — count it against the budget
      // (loop-bounding) exactly as the old empty-query placeholder did, but emit no cell.
      searchesExecuted++;
      results.push({ query: "", outcome: { text: "", sources: [], error: "the model called web_search with an empty query" } });
    }
    for (const query of call.queries) {
      // Stall-watchdog seam: batched queries run sequentially inside ONE begin/end cell, and
      // placeholder outcomes (repeat/limit) emit no cell at all — without this, consecutive
      // bounded units chain into one silent span past the stall deadline (audit 011 B1).
      yield { type: "heartbeat" };
      let outcome: SidecarOutcome;
      if (failedQueries.has(normalizeQuery(query))) {
        // Already failed this turn — don't spend another real search on it.
        outcome = { text: "", sources: [], error: "this query already failed earlier in the turn — do not call web_search again for it; answer from existing context" };
      } else if (searchesExecuted >= maxSearches) {
        outcome = { text: "", sources: [], error: "web search limit reached for this turn — answer from results already gathered" };
      } else {
        // Real sidecar search. Open the cell once, before the first real query runs.
        if (!beganCell) {
          beganCell = true;
          yield { type: "web_search_call_begin", id: call.id };
        }
        // F5: the anthropic sidecar authenticates with its own stored OAuth — it never touches the
        // ChatGPT forward headers and must NOT record a Codex/OpenAI pool outcome.
        // #398: the executors are "never throws", but enforce the contract defensively so a future
        // throw degrades to a failed tool result instead of aborting the whole turn. A genuine
        // parent abort MUST stay 499 — the executors catch abort and RETURN {error}, so check
        // signal.aborted both after the await and in the catch (a fulfilled {error} on an aborted
        // signal would otherwise look like an ordinary degradable failure).
        try {
          if (backend === "anthropic" && anthropicSidecar) {
            outcome = await runAnthropicWebSearch(query, anthropicSidecar.providerName, anthropicSidecar.provider, settings, signal);
          } else if (backend === "xai") {
            // L7: stored Grok OAuth to the pinned api.x.ai Responses endpoint; same
            // never-throws contract and no Codex/OpenAI pool outcome recording (F5 parity).
            // A missing xaiSidecar is an invariant violation — fail CLOSED with an error
            // outcome rather than falling through to the forward-header OpenAI executor
            // (review High: that fallthrough would be credential-sensitive).
            outcome = deps.xaiSidecar
              ? await runXaiWebSearch(query, deps.xaiSidecar.providerName, deps.xaiSidecar.provider, settings, deps.xaiSearchOptions ?? {}, signal)
              : { text: "", sources: [], error: "xai backend selected without a resolved Grok OAuth provider" };
          } else if (backend === "gemini") {
            // L8: Antigravity CCA grounding; same fail-closed invariant stance as xai.
            outcome = deps.geminiSidecar
              ? await runGeminiWebSearch(query, deps.geminiSidecar.providerName, deps.geminiSidecar.provider, settings, signal)
              : { text: "", sources: [], error: "gemini backend selected without a resolved Antigravity provider" };
          } else if (backend === "exa") {
            // L9: non-LLM lane; key comes from the loop deps, never the plan. Fail closed.
            outcome = deps.exaApiKey
              ? await runExaWebSearch(query, deps.exaApiKey, settings, signal)
              : { text: "", sources: [], error: "exa backend selected without an exaApiKey" };
          } else {
            outcome = await runWebSearch(query, hostedTool, forwardProvider!, selectedForwardHeaders, settings, signal, recordSidecarOutcome);
          }
          if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
        } catch (e) {
          if (e instanceof LoopError) throw e;
          if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
          // Unexpected executor throw: degrade this query to a failed tool result (redacted).
          outcome = { text: "", sources: [], error: `sidecar failed: ${redactSecretString(e instanceof Error ? e.message : String(e))}` };
        }
        searchesExecuted++;
        executedSearchCount++;
        if (outcome.error) failedQueries.add(normalizeQuery(query));
      }
      results.push({ query, outcome });
    }
    const now = Date.now();
    // Preserve the singular `{query}` arg shape for a single-query call (avoids prompt-history drift);
    // use `{queries}` only when the model actually batched several.
    const callArgs: Record<string, unknown> = call.queries.length > 1
      ? { queries: call.queries }
      : { query: call.queries[0] ?? "" };
    messages.push({
      role: "assistant",
      content: [
        // Signed thinking must precede tool_use on replay (Anthropic extended thinking), and
        // unsigned raw reasoning has to ride along for providers that require it back (#688).
        ...precedingThinking,
        {
          type: "toolCall" as const,
          id: call.id,
          name: WEB_SEARCH_TOOL_NAME,
          arguments: callArgs,
          // Re-attach the signature to the rebuilt call so a sidecar turn keeps Gemini
          // reasoning continuity instead of relying on the same-process replay cache.
          ...(cloneProviderOpaqueToolCallMetadata(call.providerMetadata)
            ? { providerMetadata: cloneProviderOpaqueToolCallMetadata(call.providerMetadata) }
            : {}),
        },
      ],
      timestamp: now,
    });
    // One aggregated tool result. isError only when EVERY query failed (a partial success is usable).
    const allFailed = results.every(r => !!r.outcome.error);
    messages.push({
      role: "toolResult", toolCallId: call.id, toolName: WEB_SEARCH_TOOL_NAME,
      content: formatWebSearchResults(results, !!parsed._structuredOutput),
      isError: allFailed, timestamp: now,
    });
    if (beganCell) {
      // The cell is "completed" if any query produced a usable result, else "failed". `queries`
      // carries every attempted query so Codex renders the native plural label.
      const anySuccess = results.some(r => !r.outcome.error);
      // Collect the citations backing this batch (dedup by URL), so the bridge can attach them as
      // url_citation annotations on the following assistant message → the app's Sources chip.
      const sources: { url: string; title?: string }[] = [];
      const seenSrc = new Set<string>();
      for (const r of results) {
        for (const s of r.outcome.sources) {
          if (seenSrc.has(s.url)) continue;
          seenSrc.add(s.url);
          sources.push(s.title ? { url: s.url, title: s.title } : { url: s.url });
        }
      }
      yield {
        type: "web_search_call_end", id: call.id,
        queries: call.queries,
        status: anySuccess ? "completed" : "failed",
        ...(sources.length > 0 ? { sources } : {}),
      };
    }
  }

  // Eagerly acquire only the FIRST iteration's final headers so connect/header/HTTP failures remain
  // non-2xx JSON. A successful body is consumed inside the bridge, where byte progress can keep the
  // downstream turn alive and body failures are correctly in-stream.
  let firstPrepared: IterationResponse;
  try {
    firstPrepared = await prepareIterationDrained(false);
  } catch (e) {
    if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    if (e instanceof LoopError) return jsonError(e.status, e.message);
    throw e;
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

  // Drive the remaining iterations live. Search cells (begin/end) are yielded interleaved with the
  // real sidecar timing, the final answer's passthrough events come last — matching native ordering
  // (search cell BEFORE the assistant message). Iteration 2+ failures surface as an in-stream error.
  async function* produce(): AsyncGenerator<AdapterEvent> {
    let prepared = firstPrepared;
    try {
      for (let i = 0; i < HARD_CAP; i++) {
        const forceAnswer = searchesExecuted >= maxSearches;
        try {
          // First loop turn reuses the eager HEADERS. Subsequent header acquisitions run here.
          if (i > 0) {
            yield { type: "heartbeat" };
            prepared = yield* prepareIterationEvents(forceAnswer);
          }
          // Raw-byte progress heartbeats reach the bridge; semantic events remain buffered.
          const split = yield* consumeIterationEvents(prepared);

          // Loop (search + re-ask) ONLY when the model's actionable output is purely web_search. A real
          // tool call (e.g. shell/apply_patch) means this turn is terminal for Codex — finalize so those
          // calls reach Codex. forceAnswer also finalizes.
          const shouldLoop = split.calls.length > 0 && !split.hasRealToolCall && !forceAnswer;
          if (!shouldLoop) {
            // #1001: a forced-answer pass that ends `done` must have produced
            // usable output — never a malformed tool call, and never silence.
            if (forceAnswer) {
              // An unterminated call flushes AFTER the terminal event, so find
              // the terminal rather than assuming it is last (#1001).
              const terminalEvent = split.passthrough.find(event => event.type === "done");
              if (terminalEvent?.type === "done"
                && (split.hasMalformedToolCall
                  || (!split.hasRealToolCall && !hasVisibleAssistantText(split.passthrough)))) {
                throw new LoopError(502, "forced-answer pass produced no usable assistant output");
              }
            }
            if (executedSearchCount > 0) {
              const failedCount = failedQueries.size;
              console.warn(
                `[web-search-loop] done — ${executedSearchCount} search${executedSearchCount > 1 ? "es" : ""}`
                + (failedCount > 0 ? ` (${failedCount} failed)` : "")
                + `, ${i + 1} iteration${i > 0 ? "s" : ""}, ${Date.now() - loopT0}ms`,
              );
            }
            // Live-streamed leading events are exactly the first N passthrough entries — replay
            // only the buffered tail so nothing reaches the client twice.
            yield* replay(split.passthrough.slice(split.streamedPassthroughCount));
            return;
          }
          // The thinking that led to the search belongs to the FIRST call's assistant replay turn.
          const iterationThinking = extractIterationThinking(split.passthrough);
          for (const [callIndex, call] of split.calls.entries()) {
            yield* runSearchCall(call, callIndex === 0 ? iterationThinking : []);
          }
        } catch (e) {
          if (isTranslatorBudgetExceededError(e)) {
            yield {
              type: "error",
              status: 502,
              errorType: "upstream_error",
              code: e.code,
              message: "upstream translation buffer exceeded the safe limit",
            };
          } else {
            yield { type: "error", message: e instanceof LoopError ? e.message : (e instanceof Error ? e.message : String(e)) };
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
      const elapsed = Date.now() - loopT0;
      if (executedSearchCount > 0 || searchesExecuted > 0) {
        console.warn(`[web-search-loop] cancelled — ${executedSearchCount} real searches, ${searchesExecuted - executedSearchCount} placeholders, ${elapsed}ms`);
      }
      internalAbort.abort("client closed responses stream");
    }, undefined,
    {
      translatorBudget,
      replayCacheScope: parsed._reasoningReplayScope,
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      ...(deps.stallTimeoutSec !== undefined ? { stallTimeoutSec: deps.stallTimeoutSec } : {}),
      ...(deps.onFirstOutput ? { onFirstOutput: deps.onFirstOutput } : {}),
      ...(deps.onUsage ? { onUsage: deps.onUsage } : {}),
      ...(deps.onCompletedResponse ? { onCompletedResponse: deps.onCompletedResponse } : {}),
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}
