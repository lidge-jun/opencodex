import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../types";
import { namespacedToolName } from "../types";
import { bridgeToResponsesSSE } from "../bridge";
import { runWebSearch, type SidecarOutcomeRecorder, type SidecarSettings } from "./executor";
import { cancelBodyOnAbort } from "../abort";
import { formatWebSearchResult } from "./format-result";
import { WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",
};

interface WebSearchCall {
  id: string;
  query: string;
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
        let query = "";
        try {
          const o: unknown = JSON.parse(pending.argsBuf || "{}");
          if (o && typeof o === "object" && typeof (o as { query?: unknown }).query === "string") {
            query = (o as { query: string }).query;
          }
        } catch { /* malformed args → empty query */ }
        calls.push({ id: pending.id, query });
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

function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: "upstream_error", code: null } }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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
  let finalEvents: AdapterEvent[] = [];
  // Queries whose search already failed this turn — repeats are short-circuited so a model that keeps
  // re-asking the same failing query doesn't burn the whole search budget on it.
  const failedQueries = new Set<string>();

  // Hard iteration bound (termination safety net); forceAnswer normally ends the loop sooner.
  const HARD_CAP = maxSearches + 2;
  for (let i = 0; i < HARD_CAP; i++) {
    const forceAnswer = searchesExecuted >= maxSearches;
    const iterParsed: OcxParsedRequest = {
      ...parsed, stream: false,
      context: { ...parsed.context, messages, tools: forceAnswer ? toolsNoWebSearch : allTools },
    };
    const request = await adapter.buildRequest(iterParsed, { headers: selectedForwardHeaders });
    let resp: Response;
    try {
      resp = adapter.fetchResponse
        ? await adapter.fetchResponse(request, { abortSignal })
        : await fetch(request.url, {
            method: request.method,
            headers: request.headers,
            body: request.body,
            signal: abortSignal,
          });
    } catch (e) {
      return jsonError(502, `Provider unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return jsonError(resp.status, `Provider error ${resp.status}: ${t.slice(0, 400)}`);
    }
    // The fetch above carries `abortSignal`; when the turn is superseded/cancelled, Bun aborts the
    // response body stream. If parseResponse hasn't attached a reader yet, the body's pending read is
    // orphaned off the awaited path and surfaces as `unhandledRejection: TypeError: null is not an
    // object` (native-only stack). Proactively cancel the body on abort so WE settle it, and guard
    // the drain so a mid-decode abort/stream error ends cleanly instead of throwing.
    const detachBodyGuard = cancelBodyOnAbort(resp.body, abortSignal);
    let events: AdapterEvent[];
    try {
      events = await adapter.parseResponse(resp);
    } catch (e) {
      await resp.body?.cancel().catch(() => {});
      if (abortSignal?.aborted) {
        return jsonError(499, "client closed request during web-search");
      }
      return jsonError(502, `Provider stream error: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      detachBodyGuard();
    }
    const { calls, passthrough, hasRealToolCall } = scanEventsForWebSearch(events);
    // Loop (search + re-ask) ONLY when the model's actionable output is purely web_search. A real
    // tool call (e.g. shell/apply_patch) means this turn is terminal for Codex — finalize so those
    // calls reach Codex instead of being discarded. forceAnswer also finalizes.
    const shouldLoop = calls.length > 0 && !hasRealToolCall && !forceAnswer;
    if (!shouldLoop) {
      finalEvents = passthrough;
      break;
    }
    const now = Date.now();
    for (const call of calls) {
      let outcome: { text: string; sources: { url: string; title?: string }[]; error?: string };
      if (call.query && failedQueries.has(normalizeQuery(call.query))) {
        // Already failed this turn — don't spend another real search on it.
        outcome = { text: "", sources: [], error: "this query already failed earlier in the turn — do not call web_search again for it; answer from existing context" };
      } else if (searchesExecuted >= maxSearches) {
        outcome = { text: "", sources: [], error: "web search limit reached for this turn — answer from results already gathered" };
      } else if (!call.query) {
        outcome = { text: "", sources: [], error: "the model called web_search with an empty query" };
        searchesExecuted++;
      } else {
        outcome = await runWebSearch(call.query, hostedTool, forwardProvider, selectedForwardHeaders, settings, abortSignal, recordSidecarOutcome);
        searchesExecuted++;
        if (outcome.error) failedQueries.add(normalizeQuery(call.query));
      }
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: { query: call.query } }],
        timestamp: now,
      });
      messages.push({
        role: "toolResult", toolCallId: call.id, toolName: WEB_SEARCH_TOOL_NAME,
        content: formatWebSearchResult(call.query, outcome, !!parsed._structuredOutput), isError: !!outcome.error, timestamp: now,
      });
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
  const sse = bridgeToResponsesSSE(
    replay(finalEvents), parsed.modelId, toolNsMap, freeform, toolSearch,
    undefined, undefined,
    {
      ...(deps.forceEmptyResponseId ? { responseId: "" } : {}),
      hideThinkingSummary: parsed.options.hideThinkingSummary,
    },
  );
  return new Response(sse, { headers: SSE_HEADERS });
}
