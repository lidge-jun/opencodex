/**
 * Production seam for the Anthropic adapter's experimental `perMessageEffort` option (#6895).
 *
 * Off by default. With `providers.<name>.perMessageEffort: true` on an `anthropic`-adapter provider
 * that sends to `api.anthropic.com` with an API key, a Codex conversation that changes reasoning
 * effort keeps its top-level `output_config.effort` at the conversation's first value and carries
 * each change as an effort-only system message, `{role: "system", content: [], output_config: {effort}}`,
 * right before the user message of the turn that changed it, with the
 * `mid-conversation-output-config-2026-07-01` beta. Earlier change points are re-sent at the same
 * message index on every later turn, so the cached prefix stays byte-identical.
 *
 * The decision itself lives in `src/responses/effort-history.ts`. This file maps one request onto
 * it (scope, lineage, receipt, emitted fields), applies a "send" decision to the wire body, and
 * settles the pending slot when the turn completes or fails. Every request the module answers
 * "off" is sent byte-for-byte as it would be without the option.
 *
 * Owner: structure/providers/anthropic-per-message-effort.md.
 */
import { codexLineageScopeKey } from "../../codex/lineage";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { mergeAnthropicBetaHeader } from "../../providers/anthropic-fast";
import { SUMMARY_PREFIX } from "../../responses/compaction";
import {
  abandon,
  commit,
  createStore,
  decide,
  hash,
  kindOf,
  lineageFromMetadata,
  rejectUpstream,
  type EffortHistoryDecision,
  type EffortHistoryRequest,
  type EffortHistoryStore,
} from "../../responses/effort-history";
import type { OcxParsedRequest, OcxProviderConfig, PerMessageEffortTurn } from "../../types";
import type { IncomingMeta } from "../base";

export const PER_MESSAGE_EFFORT_BETA = "mid-conversation-output-config-2026-07-01";
const TURN_METADATA = "x-codex-turn-metadata";
// The only credential generation an API key has: a rotated key is a different credential hash.
const KEY_GENERATION = "key";
const NEW_INPUT_KINDS = new Set(["user", "tool_result", "developer", "configuration_update"]);

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => value !== null && typeof value === "object" && !Array.isArray(value);

let store: EffortHistoryStore = createStore();

/** The process store. Tests only. */
export function perMessageEffortStoreForTests(): EffortHistoryStore {
  return store;
}
/** Start from an empty store. Tests only. */
export function resetPerMessageEffortStoreForTests(): void {
  store = createStore();
}

/**
 * Whether Codex's own turn metadata for THIS request says the conversation is new
 * (`history_initialization: "New"`). Over HTTP that is the request's `x-codex-turn-metadata` header.
 * Over WebSocket only the frame's own `client_metadata` copy counts: the upgrade header describes
 * the turn that opened the socket, not this one.
 */
export function codexTurnStartsNewHistory(body: unknown, headers: Headers, transport?: "websocket"): boolean {
  if (transport === "websocket") {
    const client = isRec(body) && isRec(body.client_metadata) ? body.client_metadata : undefined;
    return client !== undefined && Object.hasOwn(client, TURN_METADATA) && lineageFromMetadata(client[TURN_METADATA]);
  }
  return lineageFromMetadata(headers.get(TURN_METADATA));
}

/** The raw input split into the history the client echoes and this turn's new input. */
export function splitTurnInput(input: readonly unknown[]): { parent: unknown[]; suffix: unknown[] } {
  let start = input.length;
  while (start > 0 && NEW_INPUT_KINDS.has(kindOf(input[start - 1]))) start--;
  return { parent: input.slice(0, start), suffix: input.slice(start) };
}

function firstInputText(item: unknown): string | undefined {
  if (!isRec(item)) return undefined;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return undefined;
  const first = item.content[0];
  return isRec(first) && (first.type === "input_text" || first.type === "text") && typeof first.text === "string" ? first.text : undefined;
}

function firstWireText(message: Rec): string | undefined {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  const first = message.content[0];
  return isRec(first) && first.type === "text" && typeof first.text === "string" ? first.text : undefined;
}

/**
 * The Anthropic `messages` index where this turn's effort message goes: the wire message that
 * starts with this turn's user text. Only the trailing user-role run is searched, since this turn's
 * input is user, tool-result and developer items. A user message merged behind other content, or
 * one that starts with an image, has no such index and the change point is not placed.
 */
export function userMessageWireIndex(messages: readonly unknown[], suffix: readonly unknown[]): number | undefined {
  const text = firstInputText(suffix.find(item => kindOf(item) === "user"));
  if (text === undefined) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isRec(message) || message.role !== "user") return undefined;
    if (firstWireText(message) === text) return index;
  }
  return undefined;
}

// Everything on the wire that does not move with effort. max_tokens and the emitted thinking
// field are compared on their own (rules 3b and 6).
function frameOf(body: Rec): string {
  const { messages: _messages, max_tokens: _maxTokens, stream: _stream, thinking: _thinking, output_config: outputConfig, ...rest } = body;
  const pinned = isRec(outputConfig) ? Object.fromEntries(Object.entries(outputConfig).filter(([key]) => key !== "effort")) : outputConfig;
  return hash({ ...rest, output_config: pinned });
}

function destinationOf(url: string): string | undefined {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

/** A turn the option never serves, decided before the store is consulted. */
function outsideOption(parsed: OcxParsedRequest): boolean {
  return parsed.stream !== true || parsed._advisorGuard !== undefined
    || parsed._compactionRequest === true || parsed._summaryProhibitsToolCalls === true
    || parsed._memoryModelPhase !== undefined;
}

/**
 * Share one turn record across a hosted sidecar loop (web search, images, video) before its first
 * build. Each iteration builds from a spread copy of the parsed request, so the copies hold this
 * same record: the first build decides, a later iteration abandons the decision and is sent as
 * today, and the loop's completion settles it.
 */
export function shareAnthropicPerMessageEffortTurn(parsed: OcxParsedRequest): void {
  parsed._perMessageEffort ??= { builds: 0, generation: KEY_GENERATION };
}

export interface PerMessageEffortBuild {
  provider: OcxProviderConfig;
  parsed: OcxParsedRequest;
  incoming?: IncomingMeta;
  /** The finished wire body, mutated in place on a "send" decision. */
  body: Rec;
  headers: Record<string, string>;
  url: string;
  isOAuth: boolean;
  chatLineage?: string;
}

function requestFor(build: PerMessageEffortBuild, input: unknown[]): EffortHistoryRequest {
  const { provider, parsed, incoming, body, url, isOAuth } = build;
  const raw = parsed._rawBody as Rec;
  const { parent, suffix } = splitTurnInput(input);
  const outputConfig = isRec(body.output_config) ? body.output_config : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return {
    chatLineage: build.chatLineage,
    scope: {
      cohort: incoming ? codexLineageScopeKey(incoming.headers) : undefined,
      provider: incoming?.providerName,
      destination: destinationOf(url),
      adapter: "anthropic",
      model: typeof body.model === "string" ? body.model : undefined,
      credential: typeof provider.apiKey === "string" && provider.apiKey ? hash(["credential", provider.apiKey]) : undefined,
      authMode: isOAuth ? "oauth" : "apiKey",
    },
    parent,
    suffix,
    effort: typeof outputConfig?.effort === "string" ? outputConfig.effort : undefined,
    thinking: body.thinking,
    emittedMaxTokens: typeof body.max_tokens === "number" ? body.max_tokens : undefined,
    frame: frameOf(body),
    generation: KEY_GENERATION,
    cacheControl: JSON.stringify(body).includes("\"cache_control\""),
    stripped: parsed._stripReasoningEncryptedContent === true,
    transport: "http",
    apiKind: parsed._anthropicInbound === true || parsed._chatCompletionsInput === true ? "messages" : "responses",
    previousResponseId: raw.previous_response_id ?? (parsed._previousResponseInputExpanded === true ? true : undefined),
    compactionSummary: suffix.some(item => kindOf(item) === "user" && firstInputText(item)?.startsWith(SUMMARY_PREFIX) === true),
    newTranscriptReceipt: parsed._codexNewHistory === true,
    changeWireIndex: userMessageWireIndex(messages, suffix),
  };
}

function applySend(build: PerMessageEffortBuild, decision: Extract<EffortHistoryDecision, { action: "send" }>): boolean {
  const messages = build.body.messages;
  if (!Array.isArray(messages)) return false;
  const points = [...(decision.changePoints ?? [])].sort((a, b) => b.wireIndex - a.wireIndex);
  // Every stored index must still name a user message in the matched prefix; otherwise nothing is changed.
  if (points.some(point => !isRec(messages[point.wireIndex]) || (messages[point.wireIndex] as Rec).role !== "user")) return false;
  for (const point of points) {
    messages.splice(point.wireIndex, 0, { role: "system", content: [], output_config: { effort: point.effort } });
  }
  build.body.output_config = { ...(isRec(build.body.output_config) ? build.body.output_config : {}), effort: decision.anchorEffort };
  mergeAnthropicBetaHeader(build.headers, [PER_MESSAGE_EFFORT_BETA]);
  return true;
}

/**
 * Decide this build and apply a "send" decision to `body` and `headers`. A second build of the same
 * turn (a retry, rebuild or failover) abandons the first decision and is sent as today.
 */
export function applyAnthropicPerMessageEffort(build: PerMessageEffortBuild): void {
  const { provider, parsed } = build;
  const existing = parsed._perMessageEffort;
  // Counted before the switch: a failover to a provider without the option is still a second build.
  if (existing && existing.builds > 0) {
    existing.builds += 1;
    const token = existing.token;
    existing.token = undefined;
    if (token) abandon(store, token, { sent: true });
    return;
  }
  if (existing) existing.builds = 1;
  if (provider.perMessageEffort !== true) return;
  const turn: PerMessageEffortTurn = existing ?? { builds: 1, generation: KEY_GENERATION };
  parsed._perMessageEffort = turn;
  if (outsideOption(parsed) || !isRec(parsed._rawBody) || !Array.isArray(parsed._rawBody.input)) return;
  const decision = decide(store, requestFor(build, parsed._rawBody.input), {
    enabled: true,
    activated: true,
    websocketHeaderRead: true,
    compactionMarkerIdentified: true,
  });
  if (decision.action !== "send") return;
  if (!applySend(build, decision)) {
    abandon(store, decision.pendingToken, { sent: false });
    return;
  }
  turn.token = decision.pendingToken;
}

/**
 * Settle the turn at its terminal response: a completed Anthropic turn commits with its output
 * items and the cache counters on the response's own usage; anything else deletes the pending slot.
 */
export function settleAnthropicPerMessageEffort(parsed: OcxParsedRequest, response: Rec, adapterName: string): void {
  const turn = parsed._perMessageEffort;
  const token = turn?.token;
  if (!turn || !token) return;
  turn.token = undefined;
  if (response.status !== "completed" || turn.builds !== 1 || adapterName !== "anthropic") {
    abandon(store, token, { sent: true });
    return;
  }
  // The completed response's usage: cached_tokens is the cache read, cache_write_tokens the creation.
  const usage = isRec(response.usage) && isRec(response.usage.input_tokens_details) ? response.usage.input_tokens_details : {};
  const read = typeof usage.cached_tokens === "number" ? usage.cached_tokens : 0;
  const write = typeof usage.cache_write_tokens === "number" ? usage.cache_write_tokens : 0;
  commit(store, token, {
    messageStop: true,
    cacheRead: read,
    P: read + write,
    outputItems: Array.isArray(response.output) ? response.output : undefined,
    generation: turn.generation,
  });
}

/**
 * An upstream error for a turn that holds a pending slot: the slot is deleted, and the documented
 * model-unsupported 400 marks the model and destination unsupported. Nothing is resent here.
 */
export async function rejectAnthropicPerMessageEffort(parsed: OcxParsedRequest, response: Response, signal?: AbortSignal): Promise<void> {
  const turn = parsed._perMessageEffort;
  const token = turn?.token;
  if (!turn || !token || response.ok) return;
  turn.token = undefined;
  let errorText = "";
  if (response.status === 400) {
    try {
      const body = await readBoundedResponseBody(response.clone(), { signal });
      if (body.displaySafe && !body.truncated) errorText = body.text;
    } catch {
      // An unreadable body is an unclassified 400: the slot is still deleted, no capability record.
    }
  }
  rejectUpstream(store, token, { status: response.status, errorText });
}

