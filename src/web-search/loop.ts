import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig, OcxThinkingContent } from "../types";
import { namespacedToolName } from "../types";
import { bridgeToResponsesSSE } from "../bridge";
import { runWebSearch, type SidecarOutcome, type SidecarOutcomeRecorder, type SidecarSettings } from "./executor";
import { runAnthropicWebSearch } from "./anthropic-executor";
import { clearableDeadline } from "../lib/abort";
import { readBoundedResponseBody } from "../lib/bounded-body";
import { fetchWithResetRetry, applyUpstreamRecoveryHeaders } from "../lib/upstream-retry";
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
} {
  const calls: WebSearchCall[] = [];
  const passthrough: AdapterEvent[] = [];
  let hasRealToolCall = false;
  let pending: { name: string; id: string; argsBuf: string; events: AdapterEvent[] } | null = null;
  const flushPending = (): void => {
    if (pending && pending.name !== WEB_SEARCH_TOOL_NAME) {
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
      if (pending.name === WEB_SEARCH_TOOL_NAME) {
        calls.push({ id: pending.id, queries: parseQueries(pending.argsBuf) });
      } else {
        passthrough.push(...pending.events);
        hasRealToolCall = true;
      }
      pending = null;
    } else {
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
 * Collect the thinking block that preceded a web_search call in this iteration's events, so the
 * replayed assistant turn can carry it. Anthropic extended thinking REQUIRES the assistant
 * message that contains tool_use to start with its signed thinking/redacted_thinking blocks —
 * replaying a bare toolCall 400s ("Expected `thinking` or `redacted_thinking`, but found
 * `tool_use`"). The signature validity gate stays in the anthropic adapter; other adapters
 * ignore or serialize the part harmlessly.
 */
function extractIterationThinking(events: AdapterEvent[]): OcxThinkingContent | null {
  let thinking = "";
  let signature: string | undefined;
  const redacted: string[] = [];
  for (const e of events) {
    if (e.type === "thinking_delta") thinking += e.thinking;
    else if (e.type === "thinking_signature") signature = e.signature;
    else if (e.type === "redacted_thinking") redacted.push(e.data);
  }
  if (!thinking && !signature && redacted.length === 0) return null;
  return {
    type: "thinking",
    thinking,
    ...(signature ? { signature } : {}),
    ...(redacted.length > 0 ? { redacted } : {}),
  };
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

export interface WebSearchLoopDeps {
  parsed: OcxParsedRequest;
  adapter: ProviderAdapter;
  /** Which executor runs searches. Defaults to "openai" so existing callers keep the ChatGPT path (audit F4). */
  backend?: "openai" | "anthropic";
  /** Required for the openai backend; unused (and typically undefined) for the anthropic backend. */
  forwardProvider?: OcxProviderConfig;
  /** Required for the anthropic backend: the stored-OAuth provider that runs web_search_20250305. */
  anthropicSidecar?: { providerName: string; provider: OcxProviderConfig };
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
  /** One-shot TTFT callback: first non-empty model output observed (WP4). */
  onFirstOutput?: () => void;
  /**
   * 429 key-failover hook: rotate the provider's active pool key and return a rebuilt adapter,
   * or null when the pool is exhausted (same semantics as the normal routed path).
   */
  on429?: (retryAfterHeader: string | null) => ProviderAdapter | null;
}

/**
 * Run the main (non-OpenAI) model in a small agentic loop. Each upstream iteration is streamed and
 * fully buffered internally so raw byte progress is observable without leaking a synthetic tool or
 * preliminary assistant output. If the model invokes web_search, run it via the hosted sidecar,
 * inject the answer as a tool_result, and loop (bounded by `maxSearches`).
 */
export async function runWithWebSearch(deps: WebSearchLoopDeps): Promise<Response> {
  const { parsed, selectedForwardHeaders, forwardProvider, hostedTool, settings, maxSearches, abortSignal, recordSidecarOutcome } = deps;
  const backend = deps.backend ?? "openai";
  const anthropicSidecar = deps.anthropicSidecar;
  // Mutable: 429 key-failover (deps.on429) can swap in a rebuilt adapter mid-loop.
  let adapter = deps.adapter;

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
  type IterationSplit = ReturnType<typeof scanEventsForWebSearch>;

  // Acquire one iteration's final response headers. The first call is drained eagerly so an initial
  // connect/header/HTTP failure stays a non-2xx JSON response. Its successful BODY is deliberately
  // left unread until the downstream Responses SSE bridge exists.
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
    const headerDeadline = clearableDeadline(connectTimeoutMs, signal);
    try {
      const fetchOnce = async (requestAdapter: ProviderAdapter): Promise<IterationResponse> => {
        const request = await requestAdapter.buildRequest(iterParsed, {
          headers: selectedForwardHeaders,
          abortSignal: headerDeadline.signal,
        });
        const response = requestAdapter.fetchResponse
          ? await requestAdapter.fetchResponse(request, {
              abortSignal: headerDeadline.signal,
              timeoutMs: connectTimeoutMs,
              returnRawErrors: true,
              stream: true,
            })
          : await fetchWithResetRetry(
              recovery => {
                const h = applyUpstreamRecoveryHeaders(request.headers, recovery);
                if (!h.has("accept-encoding")) h.set("accept-encoding", "identity");
                return fetch(request.url, {
                  method: request.method,
                  headers: h,
                  body: request.body,
                  signal: headerDeadline.signal,
                });
              },
              { abortSignal: headerDeadline.signal, label: "web-search-loop" },
            );
        return { response, responseAdapter: requestAdapter };
      };

      let prepared = await fetchOnce(adapter);
      // 429 key-failover parity with the normal routed path: rotate pool keys until one responds
      // or the pool is exhausted (deps.on429 returns null — cooldown map guarantees termination).
      while (prepared.response.status === 429 && deps.on429) {
        const rotated = deps.on429(prepared.response.headers.get("retry-after"));
        if (!rotated) break;
        // Never let a broken body's cancel promise outlive the cumulative header deadline. Observe
        // it, but proceed immediately to the rotated fetch under the SAME deadline signal.
        try { void prepared.response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
        adapter = rotated;
        // Stall-watchdog seam between bounded retry fetches (audit 011 B3).
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

  // Consume and validate one successful response body under a resettable raw-byte inactivity guard.
  // Only invisible heartbeat events escape while semantic output remains buffered for safe scanning.
  const consumeIterationEvents = async function* (prepared: IterationResponse): AsyncGenerator<AdapterEvent, IterationSplit> {
    const events: AdapterEvent[] = [];
    try {
      const parse = prepared.responseAdapter.parseStream.bind(prepared.responseAdapter);
      for await (const event of parseStreamWithProgress(prepared.response, parse, {
        signal,
        inactivityTimeoutMs: routedModelStallTimeoutMs,
      })) {
        if (event.type === "heartbeat") yield event;
        else events.push(event);
      }
    } catch (error) {
      if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
      if (error instanceof RoutedModelInactivityError) throw new LoopError(504, error.message);
      if (error instanceof WebSearchStreamProtocolError) throw new LoopError(502, error.message);
      throw new LoopError(502, `Provider stream error: ${error instanceof Error ? error.message : String(error)}`);
    }

    const terminalIndexes = events.flatMap((event, index) => event.type === "done" || event.type === "error" ? [index] : []);
    if (terminalIndexes.length !== 1 || terminalIndexes[0] !== events.length - 1) {
      throw new LoopError(502, `Web-search adapter stream protocol error: expected one final terminal event, received ${terminalIndexes.length}`);
    }
    const terminal = events[terminalIndexes[0]!];
    if (terminal.type === "error") throw new LoopError(502, terminal.message);
    return scanEventsForWebSearch(events);
  };

  // Execute one model-requested web_search call. The call may batch several queries (native
  // `action.search.queries`); each query runs as its own sidecar search (budget-aware), but they are
  // paired as ONE assistant toolCall + ONE aggregated toolResult so function-call pairing stays
  // valid, and surface as ONE search cell carrying every attempted query. A real search (one that
  // hits the sidecar) shows the spinner WHILE the batch runs. Empty/limit/repeat placeholders never
  // emit a cell (matching the prior single-query behavior).
  async function* runSearchCall(call: WebSearchCall, precedingThinking?: OcxThinkingContent | null): AsyncGenerator<AdapterEvent> {
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
        outcome = backend === "anthropic" && anthropicSidecar
          ? await runAnthropicWebSearch(query, anthropicSidecar.providerName, anthropicSidecar.provider, settings, signal)
          : await runWebSearch(query, hostedTool, forwardProvider!, selectedForwardHeaders, settings, signal, recordSidecarOutcome);
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
        // Signed thinking must precede tool_use on replay (Anthropic extended thinking).
        ...(precedingThinking ? [precedingThinking] : []),
        { type: "toolCall" as const, id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: callArgs },
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

  const toolNsMap = new Map<string, { namespace: string; name: string }>();
  const freeform = new Set<string>();
  const toolSearch = new Set<string>();
  for (const t of parsed.context.tools ?? []) {
    if (t.namespace) toolNsMap.set(namespacedToolName(t.namespace, t.name), { namespace: t.namespace, name: t.name });
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
            if (executedSearchCount > 0) {
              const failedCount = failedQueries.size;
              console.warn(
                `[web-search-loop] done — ${executedSearchCount} search${executedSearchCount > 1 ? "es" : ""}`
                + (failedCount > 0 ? ` (${failedCount} failed)` : "")
                + `, ${i + 1} iteration${i > 0 ? "s" : ""}, ${Date.now() - loopT0}ms`,
              );
            }
            yield* replay(split.passthrough);
            return;
          }
          // The thinking that led to the search belongs to the FIRST call's assistant replay turn.
          const iterationThinking = extractIterationThinking(split.passthrough);
          for (const [callIndex, call] of split.calls.entries()) {
            yield* runSearchCall(call, callIndex === 0 ? iterationThinking : null);
          }
        } catch (e) {
          yield { type: "error", message: e instanceof LoopError ? e.message : (e instanceof Error ? e.message : String(e)) };
          return;
        }
      }
    } finally {
      if (abortSignal) abortSignal.removeEventListener("abort", linkAbort);
    }
  }

  const sse = bridgeToResponsesSSE(
    produce(), parsed.modelId, toolNsMap, freeform, toolSearch, () => {
      const elapsed = Date.now() - loopT0;
      if (executedSearchCount > 0 || searchesExecuted > 0) {
        console.warn(`[web-search-loop] cancelled — ${executedSearchCount} real searches, ${searchesExecuted - executedSearchCount} placeholders, ${elapsed}ms`);
      }
      internalAbort.abort("client closed responses stream");
    }, undefined,
    {
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
      ...(deps.stallTimeoutSec !== undefined ? { stallTimeoutSec: deps.stallTimeoutSec } : {}),
      ...(deps.onFirstOutput ? { onFirstOutput: deps.onFirstOutput } : {}),
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}
