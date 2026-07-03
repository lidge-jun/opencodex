import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../types";
import { namespacedToolName } from "../types";
import { bridgeToResponsesSSE } from "../bridge";
import { runWebSearch, type SidecarOutcome, type SidecarOutcomeRecorder, type SidecarSettings } from "./executor";
import { cancelBodyOnAbort } from "../abort";
import { fetchWithResetRetry } from "../upstream-retry";
import { formatWebSearchResults } from "./format-result";
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
  forwardProvider: OcxProviderConfig;
  hostedTool: Record<string, unknown>;
  selectedForwardHeaders: Headers;
  settings: SidecarSettings;
  maxSearches: number;
  forceEmptyResponseId?: boolean;
  abortSignal?: AbortSignal;
  recordSidecarOutcome?: SidecarOutcomeRecorder;
}

/**
 * Run the main (non-OpenAI) model in a small agentic loop. Each iteration is a NON-streaming adapter
 * call; if the model invokes web_search, run it via the gpt-mini sidecar, inject the answer as a
 * tool_result, and loop (bounded by `maxSearches`). Otherwise bridge the final events to Codex as a
 * streamed Responses SSE. web_search calls are executed internally and never relayed to Codex.
 */
export async function runWithWebSearch(deps: WebSearchLoopDeps): Promise<Response> {
  const { parsed, adapter, selectedForwardHeaders, forwardProvider, hostedTool, settings, maxSearches, abortSignal, recordSidecarOutcome } = deps;
  if (!adapter.parseResponse) return jsonError(500, "web-search sidecar requires a non-streaming adapter");

  const messages: OcxMessage[] = [...parsed.context.messages];
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

  // Run one model iteration: build the request, fetch it, parse to adapter events. Returns the
  // scanned split. Throws `LoopError` on a hard provider/parse failure so the EAGER first call can
  // turn it into a non-200 jsonError (preserving the status contract), while later iterations —
  // already inside the 200 SSE — surface it as an in-stream error event.
  const runIteration = async (forceAnswer: boolean): Promise<{ calls: WebSearchCall[]; passthrough: AdapterEvent[]; hasRealToolCall: boolean }> => {
    // On the forced-answer pass the synthetic web_search tool is gone, so the model MUST answer
    // from the results already in `messages`. A weak model can still produce a thin answer that
    // ignores what the search found, which reads to the user as "the search did nothing". Nudge it
    // (iteration-locally — never mutate the shared `messages`) to actually use the gathered results.
    // Only when a REAL search ran (executedSearchCount, not empty-query/limit/repeat placeholders).
    const iterMessages: OcxMessage[] = forceAnswer && executedSearchCount > 0
      ? [...messages, forcedAnswerNudge()]
      : messages;
    const iterParsed: OcxParsedRequest = {
      ...parsed, stream: false,
      context: { ...parsed.context, messages: iterMessages, tools: forceAnswer ? toolsNoWebSearch : allTools },
    };
    const request = await adapter.buildRequest(iterParsed, { headers: selectedForwardHeaders });
    let resp: Response;
    try {
      resp = adapter.fetchResponse
        ? await adapter.fetchResponse(request, { abortSignal: signal })
        : await fetchWithResetRetry(
            () => fetch(request.url, {
              method: request.method,
              headers: request.headers,
              body: request.body,
              signal,
            }),
            { abortSignal: signal, label: "web-search-loop" },
          );
    } catch (e) {
      throw new LoopError(502, `Provider unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new LoopError(resp.status, `Provider error ${resp.status}: ${t.slice(0, 400)}`);
    }
    // The fetch above carries `signal`; when the turn is superseded/cancelled, Bun aborts the
    // response body stream. If parseResponse hasn't attached a reader yet, the body's pending read is
    // orphaned off the awaited path and surfaces as `unhandledRejection: TypeError: null is not an
    // object` (native-only stack). Proactively cancel the body on abort so WE settle it, and guard
    // the drain so a mid-decode abort/stream error ends cleanly instead of throwing.
    const detachBodyGuard = cancelBodyOnAbort(resp.body, signal);
    let events: AdapterEvent[];
    try {
      events = await adapter.parseResponse!(resp);
    } catch (e) {
      await resp.body?.cancel().catch(() => {});
      if (signal.aborted) throw new LoopError(499, "client closed request during web-search");
      throw new LoopError(502, `Provider stream error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      detachBodyGuard();
    }
    return scanEventsForWebSearch(events);
  };

  // Execute one model-requested web_search call. The call may batch several queries (native
  // `action.search.queries`); each query runs as its own sidecar search (budget-aware), but they are
  // paired as ONE assistant toolCall + ONE aggregated toolResult so function-call pairing stays
  // valid, and surface as ONE search cell carrying every attempted query. A real search (one that
  // hits the sidecar) shows the spinner WHILE the batch runs. Empty/limit/repeat placeholders never
  // emit a cell (matching the prior single-query behavior).
  async function* runSearchCall(call: WebSearchCall): AsyncGenerator<AdapterEvent> {
    const results: { query: string; outcome: SidecarOutcome }[] = [];
    let beganCell = false;
    if (call.queries.length === 0) {
      // The model called web_search with neither query nor queries — count it against the budget
      // (loop-bounding) exactly as the old empty-query placeholder did, but emit no cell.
      searchesExecuted++;
      results.push({ query: "", outcome: { text: "", sources: [], error: "the model called web_search with an empty query" } });
    }
    for (const query of call.queries) {
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
        outcome = await runWebSearch(query, hostedTool, forwardProvider, selectedForwardHeaders, settings, signal, recordSidecarOutcome);
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
      content: [{ type: "toolCall", id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: callArgs }],
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

  // Eagerly run the FIRST iteration so a hard provider failure becomes a non-200 jsonError before any
  // streaming starts (the status contract Codex relies on). Later iterations run live inside the SSE.
  let first: { calls: WebSearchCall[]; passthrough: AdapterEvent[]; hasRealToolCall: boolean };
  try {
    first = await runIteration(false);
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
    let split = first;
    for (let i = 0; i < HARD_CAP; i++) {
      const forceAnswer = searchesExecuted >= maxSearches;
      // First loop turn reuses the eager result; subsequent turns run a fresh iteration here.
      if (i > 0) {
        try {
          split = await runIteration(forceAnswer);
        } catch (e) {
          yield { type: "error", message: e instanceof LoopError ? e.message : (e instanceof Error ? e.message : String(e)) };
          return;
        }
      }
      // Loop (search + re-ask) ONLY when the model's actionable output is purely web_search. A real
      // tool call (e.g. shell/apply_patch) means this turn is terminal for Codex — finalize so those
      // calls reach Codex. forceAnswer also finalizes.
      const shouldLoop = split.calls.length > 0 && !split.hasRealToolCall && !forceAnswer;
      if (!shouldLoop) {
        yield* replay(split.passthrough);
        return;
      }
      for (const call of split.calls) {
        yield* runSearchCall(call);
      }
    }
  }

  const sse = bridgeToResponsesSSE(
    produce(), parsed.modelId, toolNsMap, freeform, toolSearch,
    () => internalAbort.abort("client closed responses stream"), undefined,
    {
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}
