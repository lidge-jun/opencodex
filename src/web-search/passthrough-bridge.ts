/**
 * Hosted-web-search bridge for the KEY-auth Responses passthrough (#3761).
 *
 * The Codex App always declares the hosted "{type:'web_search'}" tool. On the passthrough the
 * proxy reads that declaration as "the destination executes search itself" and relays it
 * unchanged, which is correct for the ChatGPT backend and for xAI. It is wrong for an
 * OpenAI-shaped KEY gateway that does not run the hosted tool: Ollama Cloud GLM answers with a
 * plain "{type:'function_call', name:'web_search'}", nothing on either side executes it, and the
 * undeclared-tool guard ends the turn because a hosted declaration never authorizes a client
 * function name.
 *
 * This module is the opt-in repair, armed only by "providers.<name>.webSearchBridge.enabled".
 * It intercepts that one call out of the upstream stream, runs the configured search backend
 * itself, feeds the call and its result back to the SAME upstream in a fresh POST, and shows
 * Codex the hosted "web_search_call" cell it already understands. The offending function_call
 * never reaches the client, and "web_search" is never added to the guard's allowed names --
 * doing that would authorize a call nobody can execute rather than removing it.
 *
 * Deliberate boundaries of this first slice:
 *   - Streaming SSE turns only. A non-streaming turn stays on the existing path.
 *   - A leg that mixes the search call with any OTHER client tool call fails closed with an
 *     explicit error. Answering both would need the raw mixed-tool continuation contract the
 *     2.47 track deferred (devlog/_plan/260907_track2_protocol/040_hosted_search_disposition.md),
 *     and silently half-doing it would drop the client's own tool call.
*   - Continuation legs use a direct send rather than the core recovery ladder: the first leg
*     still goes through it, and a KEY-auth destination has no OAuth refresh path to replay.
 *     The caller's outbound body ceiling is re-applied to every continuation body.
 *   - The client stream is renumbered (sequence_number and output_index) because events are both
 *     dropped and injected; a plain relay cannot preserve upstream numbering through that.
 *
 * The stream this module produces is ordinary Responses SSE and is handed back to the core relay,
 * so the undeclared-tool guard, the provider payload rewrites, terminal-outcome recording, and the
 * continuation cache all still apply to it. That is what keeps the guard's authority intact over
 * every OTHER call an upstream emits: the bridge removes only the web_search call it executes.
 */
import { nextSseBlock, sseDataPayload } from "../server/sse-payload-rewrite";
import { toolChoiceToolPredicate } from "../types";
import type { OcxParsedRequest, OcxProviderConfig, ProviderWebSearchBridgeBackend } from "../types";
import type { SidecarOutcome } from "./executor";
import { buildWebSearchTool, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";
import { safeWebSearchSources } from "./sources";
import { runOllamaWebSearch } from "./ollama-executor";

/** Canonical Ollama Cloud origin. The only origin the "ollama" backend derives on its own. */
export const OLLAMA_CLOUD_ORIGIN = "https://ollama.com";
const OLLAMA_WEB_SEARCH_PATH = "/api/web_search";

const DEFAULT_BRIDGE_MAX_SEARCHES = 3;
const DEFAULT_BRIDGE_TIMEOUT_MS = 60_000;
/** Queries honored from one call's "queries" array; the rest are ignored rather than billed. */
const MAX_QUERIES_PER_CALL = 3;
/** Hard ceiling on retained client-visible items before the terminal snapshot rewrite is skipped. */
const MAX_RETAINED_OUTPUT_ITEMS = 500;
/** Refuse to buffer an unbounded partial SSE event from a misbehaving upstream. */
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;

export const WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE = "web_search_bridge_mixed_tools";
export const WEB_SEARCH_BRIDGE_ERROR_CODE = "web_search_bridge_failed";

/** Item types whose calls the CLIENT has to execute; any of them alongside a search is mixed. */
const CLIENT_EXECUTED_ITEM_TYPES = new Set([
  "function_call",
  "custom_tool_call",
  "local_shell_call",
  "tool_search_call",
  "computer_call",
]);

export interface PassthroughWebSearchBridgePlan {
  /** Resolved executor id. Only "ollama" has a shipped executor today. */
  backend: ProviderWebSearchBridgeBackend;
  /** Absolute search-API URL the executor posts to. */
  endpoint: string;
  /** Searches actually executed per turn before further calls are refused. */
  maxSearches: number;
  /** Per-search deadline in milliseconds. */
  timeoutMs: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function originOf(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the search endpoint for the "ollama" backend.
 *
 * An explicit "endpoint" is the operator's own authorization: they are naming the destination
 * that receives this provider's API key. Without one, the origin must be canonical Ollama Cloud
 * -- a renamed row pointing at an arbitrary host must not silently receive the key just because
 * its adapter happens to be openai-responses.
 */
export function resolveOllamaWebSearchEndpoint(
  provider: OcxProviderConfig,
): string | undefined {
  const configured = provider.webSearchBridge?.endpoint;
  if (configured !== undefined) {
    return originOf(configured) === undefined ? undefined : configured;
  }
  return originOf(provider.baseUrl) === OLLAMA_CLOUD_ORIGIN
    ? OLLAMA_CLOUD_ORIGIN + OLLAMA_WEB_SEARCH_PATH
    : undefined;
}

/**
 * Decide whether this passthrough turn may run the web-search bridge.
 *
 * Fails closed on every axis. In particular it never arms for "authMode: 'forward'": that is the
 * ChatGPT backend speaking Codex's own protocol with the caller's own credential, and it executes
 * hosted search upstream. A provider that runs hosted search itself (xAI) also stays on the
 * existing relay, because arming here would replace a real provider-side search with ours.
 *
 * This is a NEW planner rather than a relaxation of "isPassthrough" in planWebSearch: the sidecar
 * rewrites normalized messages, while this path must preserve the raw Responses conversation.
 */
export function planPassthroughWebSearchBridge(
  parsed: OcxParsedRequest,
  provider: OcxProviderConfig,
  options: { isPassthrough: boolean; stream: boolean },
): PassthroughWebSearchBridgePlan | undefined {
  if (!options.isPassthrough || !options.stream) return undefined;
  if (!parsed._webSearch) return undefined;
  // Never spend a forwarded ChatGPT credential on a proxy-run search, and never pre-empt a
  // provider that executes the hosted tool itself.
  if (provider.authMode !== "key") return undefined;
  const bridge = provider.webSearchBridge;
  if (!bridge || bridge.enabled !== true) return undefined;
  // A tool_choice that excludes web search excludes the bridge too; the model may not search.
  if (!toolChoiceToolPredicate(parsed.options.toolChoice)(buildWebSearchTool())) return undefined;
  // Explicit-only, and inert for every backend whose executor has not shipped.
  if (bridge.backend !== "ollama") return undefined;
  const endpoint = resolveOllamaWebSearchEndpoint(provider);
  if (!endpoint) return undefined;
  const maxSearches = Number.isInteger(bridge.maxSearches)
    && bridge.maxSearches! >= 1
    && bridge.maxSearches! <= 10
    ? bridge.maxSearches!
    : DEFAULT_BRIDGE_MAX_SEARCHES;
  const timeoutMs = Number.isInteger(bridge.timeoutMs)
    && bridge.timeoutMs! >= 1_000
    && bridge.timeoutMs! <= 600_000
    ? bridge.timeoutMs!
    : DEFAULT_BRIDGE_TIMEOUT_MS;
  return { backend: "ollama", endpoint, maxSearches, timeoutMs };
}

/** One intercepted search call, carried from the upstream stream into the next request body. */
export interface InterceptedSearchCall {
  callId: string;
  argumentsText: string;
  /** Upstream item id of the call this bridge answered; replayed on the continuation item. */
  sourceItemId?: string;
  /** Client-facing hosted cell opened in place of the intercepted call. */
  cellItemId: string;
  cellOutputIndex: number;
  /** Slot reserved in the terminal snapshot so the cell keeps its streamed position. */
  retainedSlot?: number;
}

export type PassthroughWebSearchBridgeExecutor = (
  queries: string[],
  signal?: AbortSignal,
) => Promise<SidecarOutcome>;

export interface PassthroughWebSearchBridgeStreamOptions {
  plan: PassthroughWebSearchBridgePlan;
  /** The already-open first upstream leg, obtained through the normal core send path. */
  firstLeg: ReadableStream<Uint8Array>;
  /** The exact outbound body that produced the first leg; continuation legs extend it. */
  requestBody: string;
  /** Sends one continuation leg and resolves with its response. */
  send: (body: string) => Promise<Response>;
  execute: PassthroughWebSearchBridgeExecutor;
  /**
   * Re-applies the caller's outbound body ceiling to a continuation body. Returns a refusal
   * message when the extended body may not be sent, or undefined when it is admitted.
   */
  checkOutboundBody?: (body: string) => string | undefined;
  signal?: AbortSignal;
}

function parseQueries(argumentsText: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    // A non-JSON argument blob is still a search intent; treat the raw text as the query.
    const trimmed = argumentsText.trim();
    return trimmed.length > 0 ? [trimmed.slice(0, 1_000)] : [];
  }
  if (!isRecord(parsed)) return [];
  const queries: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value !== "string") return;
    const trimmed = value.trim();
    if (trimmed.length === 0 || queries.includes(trimmed)) return;
    if (queries.length < MAX_QUERIES_PER_CALL) queries.push(trimmed.slice(0, 1_000));
  };
  push(parsed.query);
  if (Array.isArray(parsed.queries)) for (const entry of parsed.queries) push(entry);
  return queries;
}

function isWebSearchCallItem(item: unknown): boolean {
  if (!isRecord(item)) return false;
  if (item.type !== "function_call" && item.type !== "custom_tool_call") return false;
  // A namespaced "ns__web_search" is a different tool identity that the client declared and
  // executes itself; intercepting it would steal a call the client owns.
  if (typeof item.namespace === "string") return false;
  return item.name === WEB_SEARCH_TOOL_NAME;
}

function isClientExecutedItem(item: unknown): boolean {
  return isRecord(item) && typeof item.type === "string" && CLIENT_EXECUTED_ITEM_TYPES.has(item.type);
}

/** Yield complete SSE event blocks. */
async function* readSseBlocks(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ block: string }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const drain = function* (): Generator<{ block: string }> {
    let next: ReturnType<typeof nextSseBlock>;
    while ((next = nextSseBlock(buffer))) {
      buffer = next.rest;
      yield { block: next.block };
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        yield* drain();
        if (buffer.length > 0) {
          yield { block: buffer };
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > MAX_SSE_BUFFER_CHARS) {
        throw new Error("upstream SSE event exceeded the web-search bridge buffer bound");
      }
      yield* drain();
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}
interface LegDecision {
  kind: "end" | "continue" | "fail";
  searches: InterceptedSearchCall[];
  message?: string;
  code?: string;
}

/** One client-executed call event held until the leg's fate is known. */
interface HeldCallEvent {
  payload: Record<string, unknown>;
  upstreamIndex?: number;
}

/**
 * Stateful client-stream builder for one bridged turn.
 *
 * Owns the two numbering spaces the client sees. Upstream indices are per-leg and include items
 * this bridge removes or injects, so every emitted event is remapped onto one monotonic client
 * sequence. Client output_index is assigned at EMIT time, which is what keeps a held call's index
 * consistent with the order the client actually receives.
 */
class BridgeStreamState {
  /** Client-facing sequence_number, rewritten on every emitted payload. */
  private sequence = 0;
  /** Next unused client output_index. */
  private outputIndex = 0;
  /** Client-visible finished items, used to rebuild the terminal snapshot after an injection. */
  private readonly retainedItems: unknown[] = [];
  private retainedItemsComplete = true;
  private injected = false;

  /** Per-leg upstream output_index -> client output_index. */
  private indexMap = new Map<number, number>();
  /** Upstream output_index -> the intercepted call that owns it, so parallel calls stay distinct. */
  private suppressedSearches = new Map<number, InterceptedSearchCall>();
  /** Item ids of intercepted calls, for events that carry item_id but no output_index. */
  private suppressedItemIds = new Map<string, InterceptedSearchCall>();
  private searches: InterceptedSearchCall[] = [];
  /**
   * Client-executed calls are withheld until the leg's fate is known. Emitting one and THEN
   * failing the turn would let Codex start running a tool for a turn that never completes.
   */
  private heldCalls: HeldCallEvent[] = [];
  private heldIndexes = new Set<number>();
  private heldItemIds = new Set<string>();
  private terminalPayload: Record<string, unknown> | undefined;

  beginLeg(): void {
    this.indexMap = new Map();
    this.suppressedSearches = new Map();
    this.suppressedItemIds = new Map();
    this.searches = [];
    this.heldCalls = [];
    this.heldIndexes = new Set();
    this.heldItemIds = new Set();
    this.terminalPayload = undefined;
  }

  get sawClientExecutedCall(): boolean {
    return this.heldCalls.length > 0;
  }

  private clientIndexFor(upstreamIndex: number): number {
    const existing = this.indexMap.get(upstreamIndex);
    if (existing !== undefined) return existing;
    const assigned = this.outputIndex++;
    this.indexMap.set(upstreamIndex, assigned);
    return assigned;
  }

  /** Reserve a retained-snapshot slot so an item injected later keeps its streamed position. */
  private reserveRetainedSlot(): number | undefined {
    if (!this.retainedItemsComplete) return undefined;
    if (this.retainedItems.length >= MAX_RETAINED_OUTPUT_ITEMS) {
      this.retainedItemsComplete = false;
      return undefined;
    }
    return this.retainedItems.push(undefined) - 1;
  }

  private retain(item: unknown, slot?: number): void {
    if (!this.retainedItemsComplete) return;
    if (slot !== undefined) {
      this.retainedItems[slot] = item;
      return;
    }
    if (this.retainedItems.length >= MAX_RETAINED_OUTPUT_ITEMS) {
      this.retainedItemsComplete = false;
      return;
    }
    this.retainedItems.push(item);
  }

  private render(type: string, data: Record<string, unknown>): string {
    return "event: " + type + "\n"
      + "data: " + JSON.stringify({ ...data, type, sequence_number: this.sequence++ });
  }

  failureFrames(code: string, message: string): string[] {
    const failure = { type: "upstream_error", code, message };
    return [
      this.render("response.failed", {
        response: { status: "failed", error: failure, last_error: failure },
      }),
      "data: [DONE]",
    ];
  }

  searchEndFrames(call: InterceptedSearchCall, queries: string[], outcome: SidecarOutcome): string[] {
    const sources = safeWebSearchSources(outcome.sources);
    const first = queries[0] ?? "";
    const item = {
      type: "web_search_call",
      id: call.cellItemId,
      status: outcome.error ? "failed" : "completed",
      action: { type: "search", query: first, queries: queries.length > 0 ? queries : [first] },
      ...(sources.length > 0 ? { sources } : {}),
    };
    this.retain(item, call.retainedSlot);
    return [this.render("response.output_item.done", { output_index: call.cellOutputIndex, item })];
  }

  /**
   * Translate one upstream block into the blocks the client should receive now.
   *
   * Search-call events are replaced in place by the hosted cell's opening frame. Client-executed
   * call events are withheld. The terminal is held: whether it ends the turn is only decided once
   * the whole leg has been read.
   */
  consume(block: string, isFirstLeg: boolean): string[] {
    const data = sseDataPayload(block);
    if (data === null) return [block];
    if (data === "[DONE]") return [];
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return [block];
    }
    if (!isRecord(payload) || typeof payload.type !== "string") return [block];

    // A continuation leg opens its own response lifecycle; the client already has one.
    if ((payload.type === "response.created" || payload.type === "response.in_progress") && !isFirstLeg) {
      return [];
    }
    if (payload.type === "response.completed"
      || payload.type === "response.incomplete"
      || payload.type === "response.failed") {
      this.terminalPayload = payload;
      return [];
    }

    const upstreamIndex = typeof payload.output_index === "number" ? payload.output_index : undefined;
    const itemId = typeof payload.item_id === "string" ? payload.item_id : undefined;

    if (payload.type === "response.output_item.added" && isRecord(payload.item)) {
      const item = payload.item;
      if (isWebSearchCallItem(item)) {
        // Open the hosted cell exactly where the intercepted call stood, so a search that is not
        // the last item of the turn keeps its position instead of being appended after it.
        const cellOutputIndex = this.outputIndex++;
        const intercepted: InterceptedSearchCall = {
          callId: typeof item.call_id === "string" ? item.call_id : "",
          sourceItemId: typeof item.id === "string" ? item.id : undefined,
          argumentsText: typeof item.arguments === "string" ? item.arguments : "",
          cellItemId: "ws_" + crypto.randomUUID(),
          cellOutputIndex,
          retainedSlot: this.reserveRetainedSlot(),
        };
        if (upstreamIndex !== undefined) this.suppressedSearches.set(upstreamIndex, intercepted);
        if (intercepted.sourceItemId) this.suppressedItemIds.set(intercepted.sourceItemId, intercepted);
        this.searches.push(intercepted);
        this.injected = true;
        return [this.render("response.output_item.added", {
          output_index: cellOutputIndex,
          item: { type: "web_search_call", id: intercepted.cellItemId, status: "in_progress" },
        })];
      }
      if (isClientExecutedItem(item)) {
        if (upstreamIndex !== undefined) this.heldIndexes.add(upstreamIndex);
        if (typeof item.id === "string") this.heldItemIds.add(item.id);
        this.heldCalls.push({ payload, ...(upstreamIndex === undefined ? {} : { upstreamIndex }) });
        return [];
      }
    }

    const pending = (upstreamIndex === undefined ? undefined : this.suppressedSearches.get(upstreamIndex))
      ?? (itemId === undefined ? undefined : this.suppressedItemIds.get(itemId));
    if (pending) {
      // Argument deltas and the matching done frame belong to a call the client never sees;
      // the done frame still carries the authoritative complete arguments.
      if (payload.type === "response.output_item.done" && isRecord(payload.item)) {
        const args = payload.item.arguments;
        if (typeof args === "string" && args.length > 0) pending.argumentsText = args;
      }
      if (payload.type === "response.function_call_arguments.done" && typeof payload.arguments === "string") {
        if (payload.arguments.length > 0) pending.argumentsText = payload.arguments;
      }
      return [];
    }

    if ((upstreamIndex !== undefined && this.heldIndexes.has(upstreamIndex))
      || (itemId !== undefined && this.heldItemIds.has(itemId))) {
      this.heldCalls.push({ payload, ...(upstreamIndex === undefined ? {} : { upstreamIndex }) });
      return [];
    }

    const rewritten: Record<string, unknown> = { ...payload };
    if (upstreamIndex !== undefined) rewritten.output_index = this.clientIndexFor(upstreamIndex);
    if (payload.type === "response.output_item.done") this.retain(payload.item);
    return [this.render(payload.type, rewritten)];
  }

  /** Release the withheld client tool calls once the turn is known to end here. */
  flushHeldCalls(): string[] {
    const blocks: string[] = [];
    for (const held of this.heldCalls) {
      const rewritten: Record<string, unknown> = { ...held.payload };
      if (held.upstreamIndex !== undefined) {
        rewritten.output_index = this.clientIndexFor(held.upstreamIndex);
      }
      if (held.payload.type === "response.output_item.done") this.retain(held.payload.item);
      blocks.push(this.render(String(held.payload.type), rewritten));
    }
    this.heldCalls = [];
    return blocks;
  }

  /** Decide what the leg's terminal means once the whole leg has been read. */
  decide(remainingLegs: number): LegDecision {
    if (this.searches.length === 0) return { kind: "end", searches: [] };
    if (this.sawClientExecutedCall) {
      return {
        kind: "fail",
        searches: this.searches,
        code: WEB_SEARCH_BRIDGE_MIXED_TOOLS_ERROR_CODE,
        message: "routed provider requested web_search alongside another client tool in one turn; "
          + "the web-search bridge cannot answer both without dropping the client's call",
      };
    }
    const terminalType = this.terminalPayload?.type;
    if (terminalType === "response.failed" || terminalType === "response.incomplete") {
      return { kind: "end", searches: [] };
    }
    if (remainingLegs <= 0) {
      return {
        kind: "fail",
        searches: this.searches,
        code: WEB_SEARCH_BRIDGE_ERROR_CODE,
        message: "web-search bridge exhausted its continuation budget for this turn",
      };
    }
    return { kind: "continue", searches: this.searches };
  }

  /**
   * Flush the held terminal. When searches were injected the snapshot is rebuilt from the items
   * the client actually received, so response.output matches the streamed turn instead of
   * showing only the final leg.
   */
  terminalFrames(): string[] {
    const held = this.terminalPayload;
    if (!held) return ["data: [DONE]"];
    const payload: Record<string, unknown> = { ...held };
    if (this.injected && this.retainedItemsComplete && isRecord(payload.response)) {
      payload.response = {
        ...payload.response,
        output: this.retainedItems.filter(item => item !== undefined),
      };
    }
    return [this.render(String(held.type), payload), "data: [DONE]"];
  }
}

/** Append one executed search turn to the raw Responses body for the next leg. */
export function appendBridgeSearchTurn(
  requestBody: string,
  turns: readonly { call: InterceptedSearchCall; output: string }[],
): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(requestBody);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.input)) return undefined;
  const input = [...parsed.input];
  for (const turn of turns) {
    input.push({
      type: "function_call",
      ...(turn.call.sourceItemId ? { id: turn.call.sourceItemId } : {}),
      call_id: turn.call.callId,
      name: WEB_SEARCH_TOOL_NAME,
      arguments: turn.call.argumentsText || "{}",
    });
    input.push({
      type: "function_call_output",
      call_id: turn.call.callId,
      output: turn.output,
    });
  }
  return JSON.stringify({ ...parsed, input, stream: true });
}

/**
 * Bind the shipped executor for a plan. Each query in one call is a separate upstream search;
 * their digests are merged so the model receives a single tool result for the call it made.
 */
export function createOllamaBridgeExecutor(
  plan: PassthroughWebSearchBridgePlan,
  apiKey: string,
): PassthroughWebSearchBridgeExecutor {
  return async (queries, signal) => {
    const texts: string[] = [];
    const sources: SidecarOutcome["sources"] = [];
    const errors: string[] = [];
    for (const query of queries) {
      if (signal?.aborted) break;
      const outcome = await runOllamaWebSearch(query, apiKey, plan.endpoint, plan.timeoutMs, signal);
      if (outcome.error) {
        errors.push(outcome.error);
        continue;
      }
      texts.push(queries.length > 1 ? "Results for \"" + query + "\":\n" + outcome.text : outcome.text);
      for (const source of outcome.sources) {
        if (!sources.some(existing => existing.url === source.url)) sources.push(source);
      }
    }
    if (texts.length === 0) {
      return { text: "", sources: [], error: errors[0] ?? "web search produced no results" };
    }
    return { text: texts.join("\n\n"), sources };
  };
}

/**
 * Run one bridged turn as a client-facing SSE stream.
 *
 * The first leg is already open -- it came through the core send path with its full recovery,
 * circuit, and body-size handling. Every later leg is a direct re-POST of the same outbound body
 * extended with the executed search, which is exactly what a KEY-auth Responses continuation is.
 */
async function* bridgeStreamBlocks(
  options: PassthroughWebSearchBridgeStreamOptions,
  aborted: () => boolean,
): AsyncGenerator<string> {
  const state = new BridgeStreamState();
  let requestBody = options.requestBody;
  let leg: ReadableStream<Uint8Array> = options.firstLeg;
  let isFirstLeg = true;
  let searchesExecuted = 0;
  // One continuation leg per allowed search, plus one final leg for the answer itself.
  let legsRemaining = options.plan.maxSearches + 1;

  const emit = function* (blocks: readonly string[]): Generator<string> {
    for (const block of blocks) yield block + "\n\n";
  };

  for (;;) {
    state.beginLeg();
    try {
      for await (const { block } of readSseBlocks(leg)) {
        yield* emit(state.consume(block, isFirstLeg));
        if (aborted()) return;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield* emit(state.failureFrames(
        WEB_SEARCH_BRIDGE_ERROR_CODE,
        "web-search bridge upstream read failed: " + message,
      ));
      return;
    }
    isFirstLeg = false;
    if (aborted()) return;

    const decision = state.decide(legsRemaining);
    if (decision.kind === "fail") {
      // Close any cell this leg opened, or Codex keeps a "Searching the web" spinner running
      // under a failed turn (the same reason src/bridge.ts closes a dangling search on teardown).
      for (const call of decision.searches) {
        yield* emit(state.searchEndFrames(call, [], {
          text: "",
          sources: [],
          error: decision.message!,
        }));
      }
      // The withheld client call is deliberately dropped: the turn is ending as failed, and
      // releasing a tool call Codex would start executing is exactly what must not happen.
      yield* emit(state.failureFrames(decision.code!, decision.message!));
      return;
    }
    if (decision.kind === "end") {
      yield* emit(state.flushHeldCalls());
      yield* emit(state.terminalFrames());
      return;
    }

    const turns: { call: InterceptedSearchCall; output: string }[] = [];
    for (const call of decision.searches) {
      const queries = parseQueries(call.argumentsText);
      let outcome: SidecarOutcome;
      if (aborted()) return;
      if (searchesExecuted >= options.plan.maxSearches) {
        outcome = {
          text: "",
          sources: [],
          error: "no further web searches are available for this turn",
        };
      } else if (queries.length === 0) {
        outcome = { text: "", sources: [], error: "web_search was called without a usable query" };
      } else {
        searchesExecuted += 1;
        outcome = await options.execute(queries, options.signal);
      }
      yield* emit(state.searchEndFrames(call, queries, outcome));
      turns.push({
        call,
        // The model needs a readable result either way; an executor error is reported as the
        // tool result rather than as a turn failure, so it can still answer without the search.
        output: outcome.error ? "Web search failed: " + outcome.error : outcome.text,
      });
    }

    const nextBody = appendBridgeSearchTurn(requestBody, turns);
    if (nextBody === undefined) {
      yield* emit(state.failureFrames(
        WEB_SEARCH_BRIDGE_ERROR_CODE,
        "web-search bridge could not extend the outbound request body",
      ));
      return;
    }
    // The first leg was admitted by the caller's outbound ceiling; appending a search result can
    // push the continuation past it, so re-check rather than sending an unbounded body.
    const refusal = options.checkOutboundBody?.(nextBody);
    if (refusal) {
      yield* emit(state.failureFrames(WEB_SEARCH_BRIDGE_ERROR_CODE, refusal));
      return;
    }
    requestBody = nextBody;
    legsRemaining -= 1;
    if (aborted()) return;

    let next: Response;
    try {
      next = await options.send(requestBody);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      yield* emit(state.failureFrames(
        WEB_SEARCH_BRIDGE_ERROR_CODE,
        "web-search bridge continuation send failed: " + message,
      ));
      return;
    }
    if (!next.ok || !next.body || aborted()) {
      next.body?.cancel().catch(() => {});
      if (aborted()) return;
      yield* emit(state.failureFrames(
        WEB_SEARCH_BRIDGE_ERROR_CODE,
        "web-search bridge continuation returned HTTP " + next.status,
      ));
      return;
    }
    leg = next.body;
  }
}

/**
 * Build the client-facing SSE body for a bridged turn.
 *
 * Pull-driven so a slow client applies backpressure to the upstream leg instead of letting the
 * proxy buffer the whole turn. Cancelling the client stream latches a local abort, so no further
 * search is billed and no further continuation is sent once the consumer is gone.
 */
export function createPassthroughWebSearchBridgeStream(
  options: PassthroughWebSearchBridgeStreamOptions,
): ReadableStream<Uint8Array> {
  let cancelled = false;
  const aborted = (): boolean => cancelled || options.signal?.aborted === true;
  const iterator = bridgeStreamBlocks(options, aborted)[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(next.value));
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) {
      cancelled = true;
      void iterator.return?.(reason);
    },
  });
}
