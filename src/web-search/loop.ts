import type { ProviderAdapter } from "../adapters/base";
import type { AdapterEvent, OcxMessage, OcxParsedRequest, OcxProviderConfig } from "../types";
import { namespacedToolName } from "../types";
import { bridgeToResponsesSSE } from "../bridge";
import { runWebSearch, type SidecarSettings } from "./executor";
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
export function scanEventsForWebSearch(events: AdapterEvent[]): { calls: WebSearchCall[]; passthrough: AdapterEvent[] } {
  const calls: WebSearchCall[] = [];
  const passthrough: AdapterEvent[] = [];
  let pending: { name: string; id: string; argsBuf: string; events: AdapterEvent[] } | null = null;
  const flushPending = (): void => {
    if (pending && pending.name !== WEB_SEARCH_TOOL_NAME) passthrough.push(...pending.events);
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
      }
      pending = null;
    } else {
      passthrough.push(e);
    }
  }
  flushPending();
  return { calls, passthrough };
}

async function* replay(events: AdapterEvent[]): AsyncGenerator<AdapterEvent> {
  for (const e of events) yield e;
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
  incomingHeaders: Headers;
  settings: SidecarSettings;
  maxSearches: number;
}

/**
 * Run the main (non-OpenAI) model in a small agentic loop. Each iteration is a NON-streaming adapter
 * call; if the model invokes web_search, run it via the gpt-mini sidecar, inject the answer as a
 * tool_result, and loop (bounded by `maxSearches`). Otherwise bridge the final events to Codex as a
 * streamed Responses SSE. web_search calls are executed internally and never relayed to Codex.
 */
export async function runWithWebSearch(deps: WebSearchLoopDeps): Promise<Response> {
  const { parsed, adapter, incomingHeaders, forwardProvider, hostedTool, settings, maxSearches } = deps;
  if (!adapter.parseResponse) return jsonError(500, "web-search sidecar requires a non-streaming adapter");

  const messages: OcxMessage[] = [...parsed.context.messages];
  let finalEvents: AdapterEvent[] = [];

  for (let i = 0; i <= maxSearches; i++) {
    const iterParsed: OcxParsedRequest = { ...parsed, stream: false, context: { ...parsed.context, messages } };
    const request = adapter.buildRequest(iterParsed, { headers: incomingHeaders });
    let resp: Response;
    try {
      resp = await fetch(request.url, { method: request.method, headers: request.headers, body: request.body });
    } catch (e) {
      return jsonError(502, `Provider unreachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return jsonError(resp.status, `Provider error ${resp.status}: ${t.slice(0, 400)}`);
    }
    const events = await adapter.parseResponse(resp);
    const { calls, passthrough } = scanEventsForWebSearch(events);
    if (calls.length === 0 || i === maxSearches) {
      finalEvents = passthrough;
      break;
    }
    const now = Date.now();
    for (const call of calls) {
      const outcome = call.query
        ? await runWebSearch(call.query, hostedTool, forwardProvider, incomingHeaders, settings)
        : { text: "", sources: [], error: "the model called web_search with an empty query" };
      messages.push({
        role: "assistant",
        content: [{ type: "toolCall", id: call.id, name: WEB_SEARCH_TOOL_NAME, arguments: { query: call.query } }],
        timestamp: now,
      });
      messages.push({
        role: "toolResult", toolCallId: call.id, toolName: WEB_SEARCH_TOOL_NAME,
        content: formatWebSearchResult(call.query, outcome), isError: !!outcome.error, timestamp: now,
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
  const sse = bridgeToResponsesSSE(replay(finalEvents), parsed.modelId, toolNsMap, freeform, toolSearch);
  return new Response(sse, { headers: SSE_HEADERS });
}
