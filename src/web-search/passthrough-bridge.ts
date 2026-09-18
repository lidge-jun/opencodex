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
 *   - A leg that mixes the search call with a client-executed tool call ends the turn ON that
 *     leg: the intercepted searches still run proxy-side so the hosted cell completes, the
 *     held client calls are released for Codex to run, and the leg's own terminal closes the
 *     turn. No continuation is sent upstream, because the client's call is unanswered and the
 *     conversation owes the client a turn, not the gateway. When the leg's terminal already
 *     ended the turn (response.failed / response.incomplete) the searches are not run at all:
 *     the opened cells close unanswered and that terminal is relayed, because billing a search
 *     for a dead turn buys nothing. What is still not fixed: the
 *     gateway never receives the executed search result -- Codex replays the hosted
 *     web_search_call cell (query and sources, no result text) on the next turn and the
 *     gateway's own function_call/function_call_output pair is not reconstructed. Making it
 *     whole needs the outbound body rewritten before the first leg is dispatched, which lives
 *     in src/server/responses/core.ts and is out of this module's scope.
 *   - Assistant text is never treated as a search instruction. The bridge intercepts structured
 *     function_call / custom_tool_call items named web_search, not XML-like prose.
 *   - Non-Ollama backends reuse the sidecar executors and those executors' own credentials.
 *     The passthrough provider's API key is sent only to an ollama search endpoint the operator
 *     authorized. A backend whose credential is missing stays disarmed rather than falling
 *     through to a different paid search.
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
import type {
  OcxConfig,
  OcxParsedRequest,
  OcxProviderConfig,
  OcxWebSearchSidecarConfig,
  ProviderWebSearchBridgeBackend,
} from "../types";
import type { ResolvedOpenAiForwardSidecar } from "../providers/openai-sidecar";
import { runWebSearch, type SidecarOutcome, type SidecarSettings } from "./executor";
import { buildWebSearchTool, WEB_SEARCH_TOOL_NAME } from "./synthetic-tool";
import { safeWebSearchSources } from "./sources";
import { runOllamaWebSearch } from "./ollama-executor";
import { runAnthropicWebSearch } from "./anthropic-executor";
import { runXaiWebSearch, validateXaiSearchOptions } from "./xai-executor";
import { runGeminiWebSearch } from "./gemini-executor";
import { runExaWebSearch } from "./exa-executor";
import {
  findAnthropicSidecarProvider,
  findGeminiSidecarProvider,
  findXaiSidecarProvider,
  resolveSidecarBackend,
  xaiSearchOptionsFromConfig,
} from "./sidecar-providers";
import { providerDestinationConfigError } from "../lib/destination-policy";
import { redactSecretString } from "../lib/redact";
import { rememberBridgeSearchReplay } from "../responses/bridge-search-replay-cache";

/** Canonical Ollama Cloud origin. The only origin the "ollama" backend derives on its own. */
export const OLLAMA_CLOUD_ORIGIN = "https://ollama.com";
const OLLAMA_WEB_SEARCH_PATH = "/api/web_search";

/**
 * Providers already warned about a destination-refused bridge endpoint. The planner runs per
 * request, so without this a refused endpoint would warn on every turn. Keyed on provider plus
 * endpoint so that editing the config warns again; the key itself is never logged.
 */
const warnedRefusedBridgeEndpoints = new Set<string>();
/** Bound the dedupe set so a pathological config cannot grow it without limit. */
const MAX_WARNED_REFUSED_ENDPOINTS = 64;

/**
 * A refused endpoint disarms the bridge, and the refusal itself has to stay silent at the point of
 * use -- returning undefined is what keeps the key unspent. But silence alone made a real
 * configuration fail invisibly: a provider keyed under a CUSTOM name (say "my-ollama") pointing at
 * a loopback endpoint used to arm, and the destination policy now refuses it because only the
 * registry ids are local by default. The config file never reaches
 * "providerWebSearchBridgeConfigError", so nothing else would tell the operator. One warning per
 * provider and endpoint gives them the remedy without leaking the destination: the URL is
 * deliberately omitted and the provider name is redacted, because a provider key is
 * caller-controlled and can be token-shaped.
 */
function warnRefusedBridgeEndpointOnce(providerName: string, endpoint: string): void {
  const key = providerName + "\u0000" + endpoint;
  if (warnedRefusedBridgeEndpoints.has(key)) return;
  if (warnedRefusedBridgeEndpoints.size >= MAX_WARNED_REFUSED_ENDPOINTS) {
    warnedRefusedBridgeEndpoints.clear();
  }
  warnedRefusedBridgeEndpoints.add(key);
  console.warn(
    "[web-search] provider " + JSON.stringify(redactSecretString(providerName))
    + " webSearchBridge.endpoint was refused by destination policy, so the bridge stays disarmed."
    + " Set allowPrivateNetwork:true for an intentionally local endpoint, or key the provider under"
    + " its registry id (ollama, vllm, lm-studio, litellm).",
  );
}

/** Test seam: the dedupe is process-wide, so a test that asserts the warning must reset it. */
export function resetRefusedBridgeEndpointWarningsForTests(): void {
  warnedRefusedBridgeEndpoints.clear();
}

const DEFAULT_BRIDGE_MAX_SEARCHES = 3;
const DEFAULT_BRIDGE_TIMEOUT_MS = 60_000;
/** Queries honored from one call's "queries" array; the rest are ignored rather than billed. */
const MAX_QUERIES_PER_CALL = 3;
/** Hard ceiling on retained client-visible items before the terminal snapshot rewrite is skipped. */
const MAX_RETAINED_OUTPUT_ITEMS = 500;
/** Refuse to buffer an unbounded partial SSE event from a misbehaving upstream. */
const MAX_SSE_BUFFER_CHARS = 8 * 1024 * 1024;
/** UTF-16 code units in SSE data payloads, not a byte or total-heap measurement. */
const MAX_HELD_CALL_CHARS = 8 * 1024 * 1024;
/**
 * Derived from MAX_HELD_CALL_CHARS rather than picked, so the two bounds bind at the same
 * scale. The character budget is the real memory guard; this count only adds the per-event
 * object overhead the character budget cannot see. A fine-grained argument delta serializes
 * to roughly 128 code units -- an envelope of about 110 characters carrying the item id and
 * output index, plus a token-sized fragment -- so 8 MiB of them is 65,536 events. The count
 * therefore bites only for events smaller than that average. A flat 1,000 discarded a
 * legitimate client-executed tool call: a sizeable apply_patch streamed as fine-grained
 * deltas is ordinary, not exotic, and failing its leg trades one failure for another.
 */
export const MAX_HELD_CALL_EVENTS = MAX_HELD_CALL_CHARS / 128;

/** A proxy-side admission bound, never an upstream transport failure. */
class HeldCallBudgetExceededError extends Error {}

/**
 * Retained for importers that pinned the first slice's contract: a leg mixing the search with
 * a client-executed call used to fail with this code. Such legs now end the turn on the leg
 * instead of failing, so nothing emits it any more.
 */
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
  /** Resolved executor id. Absent credential for that backend leaves the bridge disarmed. */
  backend: ProviderWebSearchBridgeBackend;
  /** Absolute search-API URL for the ollama backend. Other backends ignore this. */
  endpoint?: string;
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
 *
 * Naming a destination is not the same as it being an allowed one. The endpoint therefore gets the
 * same literal destination assessment "baseUrl" already gets (#4519): metadata addresses are
 * refused outright, and loopback/private need the provider's "allowPrivateNetwork" opt-in or a
 * registry entry that is local by definition, so a local Ollama on 127.0.0.1 keeps working. This
 * is the ONLY reader of "webSearchBridge.endpoint" in the tree, which is what lets it act as the
 * authorization boundary for a config file the operator edited by hand -- that path never reaches
 * "providerWebSearchBridgeConfigError", so a value that survives file load simply cannot be spent.
 * The refusal returns undefined rather than an error, because disarming is what keeps the key
 * unspent -- but it is not silent: see warnRefusedBridgeEndpointOnce for why a custom-named local
 * provider has to be told, once, that its endpoint was refused and how to re-authorize it.
 */
export function resolveOllamaWebSearchEndpoint(
  providerName: string,
  provider: OcxProviderConfig,
): string | undefined {
  const configured = provider.webSearchBridge?.endpoint;
  if (configured !== undefined) {
    if (originOf(configured) === undefined) return undefined;
    if (providerDestinationConfigError(providerName, {
      baseUrl: configured,
      allowPrivateNetwork: provider.allowPrivateNetwork,
    })) {
      warnRefusedBridgeEndpointOnce(providerName, configured);
      return undefined;
    }
    return configured;
  }
  return originOf(provider.baseUrl) === OLLAMA_CLOUD_ORIGIN
    ? OLLAMA_CLOUD_ORIGIN + OLLAMA_WEB_SEARCH_PATH
    : undefined;
}

/** Credentials that may run a non-Ollama passthrough-bridge search. The key never rides the plan. */
export interface PassthroughWebSearchBridgeAuth {
  openAiSidecar?: ResolvedOpenAiForwardSidecar;
  anthropic?: { providerName: string; provider: OcxProviderConfig };
  xai?: { providerName: string; provider: OcxProviderConfig };
  gemini?: { providerName: string; provider: OcxProviderConfig };
  exaApiKey?: string;
}

/**
 * Resolve the credential handle for one explicit bridge backend. Only that backend is inspected,
 * so naming `exa` cannot spend a ChatGPT or Grok login, and naming `openai` cannot spend Exa.
 */
export function resolvePassthroughWebSearchBridgeAuth(
  backend: ProviderWebSearchBridgeBackend | undefined,
  config: OcxConfig,
  openAiSidecar?: ResolvedOpenAiForwardSidecar,
): PassthroughWebSearchBridgeAuth {
  switch (backend) {
    case "openai":
      return openAiSidecar ? { openAiSidecar } : {};
    case "anthropic": {
      const anthropic = findAnthropicSidecarProvider(config);
      return anthropic ? { anthropic } : {};
    }
    case "xai": {
      const xai = findXaiSidecarProvider(config);
      if (!xai) return {};
      if (validateXaiSearchOptions(xaiSearchOptionsFromConfig(config.webSearchSidecar ?? {}))) {
        return {};
      }
      return { xai };
    }
    case "gemini": {
      const gemini = findGeminiSidecarProvider(config);
      return gemini ? { gemini } : {};
    }
    case "exa": {
      const exaApiKey = config.webSearchSidecar?.exaApiKey;
      return typeof exaApiKey === "string" && exaApiKey.length > 0 ? { exaApiKey } : {};
    }
    default:
      return {};
  }
}

/** True when this passthrough turn may need the ChatGPT sidecar for an openai-backed bridge. */
export function shouldResolveOpenAiPassthroughWebSearchBridge(
  provider: OcxProviderConfig,
  parsed: OcxParsedRequest,
  isPassthrough: boolean,
): boolean {
  if (!isPassthrough || parsed.stream !== true || !parsed._webSearch) return false;
  if (provider.authMode !== "key") return false;
  if (provider.webSearchBridge?.enabled !== true || provider.webSearchBridge.backend !== "openai") {
    return false;
  }
  return toolChoiceToolPredicate(parsed.options.toolChoice)(buildWebSearchTool());
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
  options: {
    /**
     * Registry key for this provider. Required rather than optional: the destination assessment
     * consults the registry's local-by-default entries, and an absent name would silently pick a
     * different answer than the operator configured.
     */
    providerName: string;
    isPassthrough: boolean;
    stream: boolean;
    auth?: PassthroughWebSearchBridgeAuth;
  },
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
  // Explicit-only: an omitted backend never defaults to a paid sidecar search.
  const backend = bridge.backend;
  if (!backend) return undefined;
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
  if (backend === "ollama") {
    const endpoint = resolveOllamaWebSearchEndpoint(options.providerName, provider);
    if (!endpoint) return undefined;
    return { backend, endpoint, maxSearches, timeoutMs };
  }
  const auth = options.auth;
  if (backend === "openai" && auth?.openAiSidecar) return { backend, maxSearches, timeoutMs };
  if (backend === "anthropic" && auth?.anthropic) return { backend, maxSearches, timeoutMs };
  if (backend === "xai" && auth?.xai) return { backend, maxSearches, timeoutMs };
  if (backend === "gemini" && auth?.gemini) return { backend, maxSearches, timeoutMs };
  if (backend === "exa" && auth?.exaApiKey) return { backend, maxSearches, timeoutMs };
  return undefined;
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
   * Destination identity for the executed-search memo (#4587). When absent nothing is recorded,
   * and the next turn replays the hosted cell exactly as it does today.
   */
  destinationScope?: string;
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
  kind: "end" | "endAfterSearch" | "endWithoutSearch" | "continue" | "fail";
  searches: InterceptedSearchCall[];
  message?: string;
  code?: string;
  /**
   * Whether an endWithoutSearch leg may hand its withheld client-executed calls back.
   * Only `response.incomplete` may: the client can still act on that turn. A
   * `response.failed` terminal must not, for the same reason the fail path drops them.
   */
  releaseHeldCalls?: boolean;
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
  private heldCallChars = 0;
  private heldIndexes = new Set<number>();
  private heldItemIds = new Set<string>();
  private terminalPayload: Record<string, unknown> | undefined;

  beginLeg(): void {
    this.indexMap = new Map();
    this.suppressedSearches = new Map();
    this.suppressedItemIds = new Map();
    this.searches = [];
    this.dropHeldCalls();
    this.terminalPayload = undefined;
  }

  get sawClientExecutedCall(): boolean {
    return this.heldCalls.length > 0;
  }

  private holdCall(payload: Record<string, unknown>, dataChars: number, upstreamIndex?: number): void {
    if (this.heldCalls.length >= MAX_HELD_CALL_EVENTS
      || dataChars > MAX_HELD_CALL_CHARS - this.heldCallChars) {
      throw new HeldCallBudgetExceededError(
        "web-search bridge withheld more client tool events than its per-leg buffer bound allows",
      );
    }
    this.heldCalls.push({ payload, ...(upstreamIndex === undefined ? {} : { upstreamIndex }) });
    this.heldCallChars += dataChars;
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
        this.holdCall(payload, data.length, upstreamIndex);
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
      this.holdCall(payload, data.length, upstreamIndex);
      return [];
    }

    const rewritten: Record<string, unknown> = { ...payload };
    if (upstreamIndex !== undefined) rewritten.output_index = this.clientIndexFor(upstreamIndex);
    if (payload.type === "response.output_item.done") this.retain(payload.item);
    return [this.render(payload.type, rewritten)];
  }

  /** Release lazily so flushing does not allocate a second full set of serialized events. */
  *flushHeldCalls(): Generator<string> {
    try {
      for (const held of this.heldCalls) {
        const rewritten: Record<string, unknown> = { ...held.payload };
        if (held.upstreamIndex !== undefined) {
          rewritten.output_index = this.clientIndexFor(held.upstreamIndex);
        }
        if (held.payload.type === "response.output_item.done") this.retain(held.payload.item);
        yield this.render(String(held.payload.type), rewritten);
      }
    } finally {
      this.dropHeldCalls();
    }
  }

  /**
   * Discard the withheld client-executed calls without emitting them. Used when the turn is
   * ending in a state the client cannot act on, where releasing the call would start work
   * under a turn that is already over.
   */
  dropHeldCalls(): void {
    this.heldCalls = [];
    this.heldCallChars = 0;
    this.heldIndexes.clear();
    this.heldItemIds.clear();
  }

  /** Fail before executing this leg's searches, closing every cell already shown to the client. */
  *failLegFrames(code: string, message: string): Generator<string> {
    this.dropHeldCalls();
    for (const call of this.searches) {
      yield* this.searchEndFrames(call, [], { text: "", sources: [], error: message });
    }
    yield* this.failureFrames(code, message);
  }

  /** Decide what the leg's terminal means once the whole leg has been read. */
  decide(remainingLegs: number): LegDecision {
    if (this.searches.length === 0) return { kind: "end", searches: [] };
    const terminalType = this.terminalPayload?.type;
    if (terminalType === "response.failed" || terminalType === "response.incomplete") {
      // The upstream terminal already ended this leg, so running the intercepted searches now
      // would bill a search for a dead turn. The opened cells are closed unanswered instead.
      //
      // The two terminals differ in what happens to a withheld client-executed call, and
      // lumping them together released one under a failed turn. `response.incomplete` leaves a
      // turn the client can still act on, so its held call goes back. `response.failed` does
      // not, and handing Codex a tool call to start executing inside a dead turn is the exact
      // thing the fail path below refuses to do.
      return {
        kind: "endWithoutSearch",
        searches: this.searches,
        releaseHeldCalls: terminalType === "response.incomplete",
      };
    }
    if (this.sawClientExecutedCall) {
      // The client's own call is unanswered, so this leg cannot continue upstream: the
      // conversation owes the client a turn, not the gateway. The intercepted searches still
      // run so the hosted cell completes rather than dangling, then the held calls go back to
      // the client and the leg's own terminal ends the turn.
      return { kind: "endAfterSearch", searches: this.searches };
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
  return createPassthroughWebSearchBridgeExecutor(plan, { providerApiKey: apiKey });
}

/** Per-search credentials and sidecar settings. Secrets stay off the plan object. */
export interface PassthroughWebSearchBridgeExecutorContext {
  providerApiKey?: string;
  auth?: PassthroughWebSearchBridgeAuth;
  hostedTool?: Record<string, unknown>;
  describeImages?: boolean;
  sidecar?: Pick<OcxWebSearchSidecarConfig, "backend" | "model" | "reasoning" | "xSearch">;
}

const DEFAULT_OPENAI_BRIDGE_MODEL = "gpt-5.6-luna";
const DEFAULT_ANTHROPIC_BRIDGE_MODEL = "claude-sonnet-5";
const DEFAULT_XAI_BRIDGE_MODEL = "grok-4.6";
const DEFAULT_GEMINI_BRIDGE_MODEL = "gemini-3.8-flash";
const DEFAULT_BRIDGE_REASONING = "low";

/**
 * Search model each bridge backend runs when the global sidecar block was configured for a
 * DIFFERENT backend (see modelForBridgeBackend). Exhaustive over the backend union on purpose:
 * a seventh backend must decide its own default here rather than fall through to a ChatGPT model.
 * The `ollama` and `exa` rows are inert — runOllamaWebSearch takes no model argument and
 * runExaWebSearch reads only settings.timeoutMs — and must stay that way.
 */
const DEFAULT_BRIDGE_MODELS: Record<ProviderWebSearchBridgeBackend, string> = {
  ollama: DEFAULT_OPENAI_BRIDGE_MODEL,
  openai: DEFAULT_OPENAI_BRIDGE_MODEL,
  anthropic: DEFAULT_ANTHROPIC_BRIDGE_MODEL,
  xai: DEFAULT_XAI_BRIDGE_MODEL,
  gemini: DEFAULT_GEMINI_BRIDGE_MODEL,
  exa: DEFAULT_OPENAI_BRIDGE_MODEL,
};

/**
 * `sidecar` is the GLOBAL `config.webSearchSidecar` block, which carries the model chosen for
 * ITS backend. The bridge backend is the per-provider `webSearchBridge.backend` and the two are
 * configured independently, so the operator's model only means anything here when they agree:
 * a global {backend:"openai", model:"gpt-5.6-luna"} otherwise reaches runAnthropicWebSearch and
 * Anthropic rejects the model. On a mismatch the bridge falls back to the backend's own default.
 * The same reasoning already pins the backend first in planWebSearch.
 *
 * Only the model is gated. `reasoning` is a generic effort level, and `xSearch` is xai-only with
 * no per-backend default and no `webSearchBridge.xSearch` equivalent, so gating it would make an
 * openai sidecar plus an xai bridge plus x_search impossible to express at all.
 */
function modelForBridgeBackend(
  backend: ProviderWebSearchBridgeBackend,
  sidecar: Pick<OcxWebSearchSidecarConfig, "backend" | "model">,
): string {
  const backendDefault = DEFAULT_BRIDGE_MODELS[backend];
  if (resolveSidecarBackend(sidecar.backend) !== backend) return backendDefault;
  return sidecar.model ?? backendDefault;
}

/** The settings a bridge executor will run with. Exported for tests; the executor closes over it. */
export function sidecarSettingsForBridge(
  backend: ProviderWebSearchBridgeBackend,
  plan: PassthroughWebSearchBridgePlan,
  context: PassthroughWebSearchBridgeExecutorContext,
): SidecarSettings {
  const sidecar = context.sidecar ?? {};
  return {
    model: modelForBridgeBackend(backend, sidecar),
    reasoning: sidecar.reasoning ?? DEFAULT_BRIDGE_REASONING,
    timeoutMs: plan.timeoutMs,
    describeImages: context.describeImages === true,
  };
}

async function executeBridgeQueries(
  queries: string[],
  runOne: (query: string, signal?: AbortSignal) => Promise<SidecarOutcome>,
  signal?: AbortSignal,
): Promise<SidecarOutcome> {
  const texts: string[] = [];
  const sources: SidecarOutcome["sources"] = [];
  const errors: string[] = [];
  for (const query of queries) {
    if (signal?.aborted) break;
    const outcome = await runOne(query, signal);
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
}

/**
 * Bind the executor for a planned backend. Ollama spends this provider's API key on the planned
 * endpoint; every other backend spends the sidecar credential that armed the plan.
 */
export function createPassthroughWebSearchBridgeExecutor(
  plan: PassthroughWebSearchBridgePlan,
  context: PassthroughWebSearchBridgeExecutorContext,
): PassthroughWebSearchBridgeExecutor {
  const settings = sidecarSettingsForBridge(plan.backend, plan, context);
  return (queries, signal) => executeBridgeQueries(queries, async (query, querySignal) => {
    switch (plan.backend) {
      case "ollama":
        if (!plan.endpoint) {
          return { text: "", sources: [], error: "ollama web-search backend selected without an endpoint" };
        }
        return runOllamaWebSearch(
          query,
          context.providerApiKey ?? "",
          plan.endpoint,
          plan.timeoutMs,
          querySignal,
        );
      case "openai": {
        const sidecar = context.auth?.openAiSidecar;
        if (!sidecar) {
          return { text: "", sources: [], error: "openai web-search bridge selected without a ChatGPT sidecar" };
        }
        return runWebSearch(
          query,
          context.hostedTool ?? { type: "web_search" },
          sidecar.provider,
          sidecar.headers,
          settings,
          querySignal,
          sidecar.recordOutcome,
        );
      }
      case "anthropic": {
        const anthropic = context.auth?.anthropic;
        if (!anthropic) {
          return { text: "", sources: [], error: "anthropic web-search bridge selected without stored Anthropic OAuth" };
        }
        return runAnthropicWebSearch(
          query,
          anthropic.providerName,
          anthropic.provider,
          settings,
          querySignal,
        );
      }
      case "xai": {
        const xai = context.auth?.xai;
        if (!xai) {
          return { text: "", sources: [], error: "xai web-search bridge selected without stored Grok OAuth" };
        }
        return runXaiWebSearch(
          query,
          xai.providerName,
          xai.provider,
          settings,
          xaiSearchOptionsFromConfig(context.sidecar ?? {}),
          querySignal,
        );
      }
      case "gemini": {
        const gemini = context.auth?.gemini;
        if (!gemini) {
          return { text: "", sources: [], error: "gemini web-search bridge selected without stored Antigravity OAuth" };
        }
        return runGeminiWebSearch(
          query,
          gemini.providerName,
          gemini.provider,
          settings,
          querySignal,
        );
      }
      case "exa": {
        const exaApiKey = context.auth?.exaApiKey;
        if (!exaApiKey) {
          return { text: "", sources: [], error: "exa web-search bridge selected without an exaApiKey" };
        }
        return runExaWebSearch(query, exaApiKey, settings, querySignal);
      }
    }
  }, signal);
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

  const emit = function* (blocks: Iterable<string>): Generator<string> {
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
      if (aborted()) return;
      const message = error instanceof Error ? error.message : String(error);
      // A held-event overflow is this proxy's own bound. Attributing it to an upstream read
      // failure would blame the provider for a refusal the bridge made.
      yield* emit(state.failLegFrames(
        WEB_SEARCH_BRIDGE_ERROR_CODE,
        error instanceof HeldCallBudgetExceededError
          ? message
          : "web-search bridge upstream read failed: " + message,
      ));
      return;
    }
    isFirstLeg = false;
    if (aborted()) return;

    const decision = state.decide(legsRemaining);
    if (decision.kind === "fail") {
      yield* emit(state.failLegFrames(decision.code!, decision.message!));
      return;
    }
    if (decision.kind === "end") {
      yield* emit(state.flushHeldCalls());
      yield* emit(state.terminalFrames());
      return;
    }

    if (decision.kind === "endWithoutSearch") {
      // The upstream terminal already ended this leg, so billing a search now would pay for a
      // dead turn. The opened cells still have to close -- an in_progress web_search_call left
      // under a finished turn is the same dangling "Searching the web" spinner the failure path
      // above closes for. This also tightens the pre-existing non-mixed failed-leg path, which
      // used to drop the searches and leave the cell open.
      for (const call of decision.searches) {
        yield* emit(state.searchEndFrames(call, [], {
          text: "",
          sources: [],
          error: "the upstream turn ended before the web search could run",
        }));
      }
      // Only an incomplete terminal hands the withheld call back; a failed one drops it.
      if (decision.releaseHeldCalls) yield* emit(state.flushHeldCalls());
      else state.dropHeldCalls();
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
      // The model needs a readable result either way; an executor error is reported as the
      // tool result rather than as a turn failure, so it can still answer without the search.
      const output = outcome.error ? "Web search failed: " + outcome.error : outcome.text;
      turns.push({ call, output });
      // Record what a continuation leg WOULD put on the wire, whether or not this leg sends one
      // (#4587). The caller keeps the hosted cell and replays it next turn; the pre-dispatch
      // rewrite in the Responses adapter uses this to hand the destination back its own call and
      // result instead of an item type it never produced. Recording the same text that
      // appendBridgeSearchTurn would append is what keeps a replayed turn and a continued turn
      // showing the destination one consistent conversation.
      rememberBridgeSearchReplay(options.destinationScope, call.cellItemId, {
        callId: call.callId,
        sourceItemId: call.sourceItemId,
        name: WEB_SEARCH_TOOL_NAME,
        argumentsText: call.argumentsText,
        output,
      });
    }

    if (decision.kind === "endAfterSearch") {
      // A mixed leg ends here rather than continuing upstream: the client's own call is
      // unanswered, so the conversation owes the CLIENT a turn, not the gateway. The searches
      // completed their hosted cells above; now the held calls go back for Codex to run and
      // the leg's terminal closes the turn. No continuation is sent and no function_call_output
      // is fabricated for a call the bridge cannot execute.
      yield* emit(state.flushHeldCalls());
      yield* emit(state.terminalFrames());
      return;
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
