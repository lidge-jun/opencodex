/**
 * Per-message effort history (#6895): the decision state machine behind the Anthropic adapter's
 * experimental `perMessageEffort` option.
 *
 * A Codex conversation that changes reasoning effort mid-chat rewrites Anthropic's top-level
 * `output_config.effort`, and that rewrite invalidates every cached message block. Anthropic's
 * per-message effort beta instead takes an effort-only system message at the turn where the
 * effort changes, so the top-level value, and with it the cached prefix, can stay pinned to the
 * conversation's first effort. Codex history carries no per-turn effort, so this module remembers,
 * per conversation, where each change point sits and which effort it set.
 *
 * Design: rkb32's contract and offline slice on #6895 (rules 0-9, failure table, bounds). The store
 * is process-local and holds hashes and pinned values only, never transcript text. Every path that
 * cannot prove the request extends a committed history answers "off", which sends the request
 * exactly as it would be sent without the option.
 *
 * Owner: structure/providers/anthropic-per-message-effort.md. Production seam:
 * src/adapters/anthropic/per-message-effort.ts.
 */
import { createHmac, randomBytes } from "node:crypto";

// Per-process key: fingerprints are not reproducible outside this process.
const hashKey = randomBytes(32);

export const MAX_ENTRIES = 64;
/** Hard bound on everything the store holds, pending slots and their buffers included. */
export const MAX_TOTAL_BYTES = 512 * 1024;
/** Cap on the output one pending slot may commit (stored records are hashes, so this bounds the buffer). */
export const MAX_BUFFER_BYTES = 128 * 1024;
/** Change points are re-sent on every later turn, so their count is capped. */
export const MAX_CHANGE_POINTS = 64;
/** One hour from last use. */
export const ENTRY_TTL_MS = 60 * 60 * 1000;
/** A model/destination refusal is remembered this long. */
export const CAPABILITY_TTL_MS = 60 * 60 * 1000;
const MAX_CAPABILITY = 256;
/** A pending slot expires this long after admission. */
export const PENDING_TTL_MS = 10 * 60 * 1000;
export const SCOPE_PARTS = ["cohort", "provider", "destination", "adapter", "model", "credential", "authMode"] as const;
// api.anthropic.com only. Fable 5.1 stays off until its wire id is checked against the Mythos rule.
const IN_SCOPE_MODEL = /^(claude-)?(mythos-5-1|opus-5-5|opus-5|sonnet-5-5|haiku-5-5)$/;
const ENDPOINT = "api.anthropic.com";
// Effort names the serializer can emit (anthropic.ts adaptiveEffort / reasoningBudget).
const EFFORTS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);
/**
 * The documented 400 for a model without per-message effort:
 * "output_config.effort requires a model that supports per-turn effort; this model does not".
 * Any other 400 sets nothing.
 */
export const BETA_FRAGMENT = "requires a model that supports per-turn effort";

type Rec = Record<string, unknown>;
export type EffortHistoryScope = Record<(typeof SCOPE_PARTS)[number], string | undefined>;

/** One request, as the decision sees it. Every compared value is the one actually emitted. */
export interface EffortHistoryRequest {
  chatLineage?: string;
  scope?: Partial<EffortHistoryScope>;
  /** Raw Responses items before this turn's new input. */
  parent: unknown[];
  /** This turn's new input: user, tool-result, developer and configuration items. */
  suffix: unknown[];
  effort?: string;
  /** The emitted `thinking` field. */
  thinking?: unknown;
  emittedMaxTokens?: number;
  explicitCap?: number;
  omittedMaxTokens?: number;
  /** Hash of everything on the wire that does not depend on effort (system, tools, display...). */
  frame?: string;
  generation?: string;
  cacheControl?: boolean;
  stripped?: boolean;
  transport?: "http" | "websocket";
  apiKind?: "responses" | "messages";
  previousResponseId?: unknown;
  compactionSummary?: boolean;
  /** A positive new-transcript receipt for this turn (never inferred from shape alone). */
  newTranscriptReceipt?: boolean;
  /**
   * The Anthropic `messages` index the effort message for this turn's change point would take:
   * the wire message that starts with this turn's user message. Undefined when it cannot be placed.
   */
  changeWireIndex?: number;
}

export interface EffortHistoryOptions {
  enabled?: boolean;
  activated?: boolean;
  websocketHeaderRead?: boolean;
  compactionMarkerIdentified?: boolean;
  now?: number;
}

export interface EffortChangePoint { at: number; wireIndex: number; effort: string }

export type EffortHistoryDecision =
  | { action: "off"; reason: string; deleted?: boolean }
  | {
    action: "send";
    kind: "new" | "matched";
    pendingToken: string;
    anchorEffort: string;
    changePoint?: boolean;
    shape?: "a" | "tool-only";
    insert?: EffortChangePoint | null;
    changePoints?: EffortChangePoint[];
  };

interface PinnedRequest {
  /** Digest of the chat lineage; the raw value is never kept. */
  lineageKey: string;
  /** Digest of the model and destination the capability record is keyed by. */
  capabilityKey: string;
  effort?: string;
  /** Digest of the emitted `thinking` field. */
  thinkingKey: string;
  explicitCap?: number;
  emittedMaxTokens?: number;
  omittedMaxTokens?: number;
  frame?: string;
  generation?: string;
  changeAt: number;
  changeWireIndex?: number;
}

interface Entry {
  scopeKey: string;
  frame?: string;
  generation?: string;
  prefixHash: string;
  inputHash: string;
  effortInEffect: string;
  lineageKey: string;
  anchorEffort: string;
  thinkingKey: string;
  budget: number;
  limit: number;
  changePoints: EffortChangePoint[];
  P: number;
  version: number;
  lastUsed: number;
  bytes: number;
}

interface Slot {
  kind: "new" | "matched";
  key: string;
  token: string;
  version: number;
  createdAt: number;
  inputHash: string;
  scopeKey: string;
  req: PinnedRequest;
  pinnedBytes: number;
  attemptGeneration?: string;
  entry?: Entry;
  changePoint?: boolean;
  buffered?: number;
}

export interface EffortHistoryStore {
  entries: Map<string, Entry>;
  pending: Map<string, Slot>;
  capability: Map<string, { state: "unsupported"; at: number }>;
  committedInputs: Map<string, true>;
  nextVersion: number;
}

export interface EffortHistoryCommitResult {
  messageStop?: boolean;
  failedBeforeSend?: boolean;
  restoreOnFailure?: boolean;
  cacheRead?: number;
  P?: number;
  outputItems?: unknown[];
  generation?: string;
}

export type EffortHistoryOutcome = { action: string; reason?: string; key?: string; deleted?: boolean };

// A tool call with no output in the same request: the serializer would synthesize one the client never sent.
function hasOrphanCall(items: unknown[]): boolean {
  const outputs = new Set(items.filter(i => TOOL_OUTPUTS.has(String((i as Rec | null)?.type))).map(i => (i as Rec).call_id));
  return items.some(i => {
    const type = (i as Rec | null)?.type;
    return (type === "function_call" || type === "custom_tool_call") && !outputs.has((i as Rec).call_id);
  });
}
// Activation gates: no request reached the upstream path, so nothing is deleted.
const GATE_REASONS = new Set(["switch-off", "not-activated", "websocket-before-activation"]);

// Canonical JSON: object keys sorted at every level, so equal content hashes equally. A null field
// is the same as an absent one: Codex 0.167 echoes a reasoning item with `content: null` that the
// proxy never sent (live capture, 2026-11-16).
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const rec = value as Rec;
    return Object.fromEntries(Object.keys(rec).filter(k => rec[k] !== null).sort().map(k => [k, canonical(rec[k])]));
  }
  return value;
}
const stableJson = (value: unknown): string => JSON.stringify(canonical(value)) ?? "undefined";
/** The one projection used for commit and lookup. Key order is canonical; nothing else is dropped. */
export const project = (items: unknown): unknown => canonical(items);
export const hash = (value: unknown): string => createHmac("sha256", hashKey).update(stableJson(value)).digest("hex");
// A prefix digest is a chain over per-item digests, so a pending slot can extend it at commit
// without keeping any item text.
const extendChain = (digest: string, items: unknown[]): string => items.reduce<string>((d, item) => hash([d, hash(project(item))]), digest);
export const EMPTY_CHAIN = hash([]);
export const hashItems = (items: unknown[]): string => extendChain(EMPTY_CHAIN, items);
const bytesOf = (value: unknown): number => Buffer.byteLength(stableJson(value));

/** `minimal` maps to `low` for adaptive output (anthropic.ts adaptiveEffort), so the two are not a change point. */
export const mapEffort = (effort: string): string => (effort === "minimal" ? "low" : effort);

// Reasoning budget by effort (anthropic.ts reasoningBudget).
const BUDGET: Record<string, number> = { minimal: 1024, low: 4096, medium: 8192, high: 16384, xhigh: 24576, max: 32000 };
/**
 * Effective output limit for this request. The emitted `max_tokens` wins; otherwise an explicit
 * client cap; otherwise the adaptive derivation max(omitted, min(40192, max(8192, budget + 8192))).
 */
export function effectiveLimit(req: Pick<EffortHistoryRequest, "emittedMaxTokens" | "explicitCap" | "effort" | "omittedMaxTokens">): number {
  if (req.emittedMaxTokens !== undefined) return req.emittedMaxTokens;
  if (req.explicitCap !== undefined) return req.explicitCap;
  const budget = (Object.hasOwn(BUDGET, mapEffort(String(req.effort))) ? BUDGET[mapEffort(String(req.effort))] : undefined) ?? 8192;
  return Math.max(req.omittedMaxTokens ?? 8192, Math.min(40192, Math.max(8192, budget + 8192)));
}

const off = (reason: string, extra: { deleted?: boolean } = {}): EffortHistoryDecision => ({ action: "off", reason, ...extra });

// Capability is per model and destination, not per chat or credential.
const capabilityKey = (s: Partial<EffortHistoryScope>): string => hash({ model: s.model, destination: s.destination });

export function createStore(): EffortHistoryStore {
  return { entries: new Map(), pending: new Map(), capability: new Map(), committedInputs: new Map(), nextVersion: 1 };
}

// Entry key: scope + committed prefix. The frame is a field, not part of the key, so a frame
// change finds the entry by prefix and rule 6 can fire.
const entryKey = (scopeKey: string, prefixHash: string): string => hash([scopeKey, prefixHash]);
const newKey = (scopeKey: string, inputHash: string): string => hash(["new", scopeKey, inputHash]);

/**
 * Codex's own per-turn `x-codex-turn-metadata` value: true only for `history_initialization` "new".
 * Codex 0.167 sends the lowercase serde spelling; the enum's source name `New` is accepted too.
 * The caller decides which copy of the metadata describes the turn (see the production seam).
 */
export function lineageFromMetadata(headerValue: unknown): boolean {
  if (typeof headerValue !== "string") return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(headerValue);
  } catch {
    return false;
  }
  const value = parsed !== null && typeof parsed === "object" ? (parsed as Rec).history_initialization : undefined;
  return value === "new" || value === "New";
}

// Tool output types the Responses parser handles.
const TOOL_OUTPUTS = new Set(["function_call_output", "custom_tool_call_output", "tool_search_output"]);
/** Item kind: a test shorthand (`kind`), or a real Responses input item by its type and role. */
export function kindOf(item: unknown): string {
  const rec = (item && typeof item === "object" ? item : {}) as Rec;
  if (typeof rec.kind === "string" && rec.type === undefined && rec.role === undefined) return rec.kind;
  const type = rec.type ?? (rec.role ? "message" : undefined);
  if (type === "message") {
    if (rec.role === "user") return "user";
    if (rec.role === "assistant") return "assistant";
    if (rec.role === "developer" || rec.role === "system") return "developer";
  }
  if (TOOL_OUTPUTS.has(String(type))) return "tool_result";
  if (type === "configuration_update") return "configuration_update";
  return `other:${String(type)}`;
}
const isUser = (item: unknown): boolean => kindOf(item) === "user";
const isTool = (item: unknown): boolean => kindOf(item) === "tool_result";
const isDeveloper = (item: unknown): boolean => kindOf(item) === "developer";
const hasConfigUpdate = (items: unknown[]): boolean => items.some(item => kindOf(item) === "configuration_update");

// Off, and the parent entry is deleted before the request is sent.
function offSend(store: EffortHistoryStore, parentKey: string, reason: string): EffortHistoryDecision {
  store.entries.delete(parentKey);
  store.pending.delete(parentKey);
  return off(reason, { deleted: true });
}

// Drop entries past their TTL and pending slots past theirs.
function sweep(store: EffortHistoryStore, now: number): void {
  for (const [key, cap] of store.capability) {
    if (now - cap.at > CAPABILITY_TTL_MS) store.capability.delete(key);
  }
  for (const [key, entry] of store.entries) {
    if (now - entry.lastUsed > ENTRY_TTL_MS) store.entries.delete(key);
  }
  for (const [key, slot] of store.pending) {
    if (now - slot.createdAt > PENDING_TTL_MS) store.pending.delete(key);
  }
}

// An account, provider, or model change ends the old scope of this chat.
function endOtherScopes(store: EffortHistoryStore, lineage: string, scopeKey: string): void {
  for (const [key, entry] of store.entries) {
    if (entry.lineageKey === lineage && entry.scopeKey !== scopeKey) store.entries.delete(key);
  }
  for (const [key, slot] of store.pending) {
    if (slot.req?.lineageKey === lineage && slot.scopeKey !== scopeKey) store.pending.delete(key);
  }
}

function dropParent(store: EffortHistoryStore, req: EffortHistoryRequest): void {
  const s = req.scope;
  if (!s || !req.chatLineage || !Array.isArray(req.parent)) return;
  const key = entryKey(hash([s, req.chatLineage]), hashItems(req.parent));
  store.entries.delete(key);
  store.pending.delete(key);
}

function decideWithCleanup(store: EffortHistoryStore, req: EffortHistoryRequest, opts?: EffortHistoryOptions): EffortHistoryDecision {
  const result = decideInner(store, req, opts);
  if (result.action === "off" && !GATE_REASONS.has(result.reason)) dropParent(store, req);
  return result;
}

const validWireIndex = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;

// Ordered algorithm. The first rule that decides wins.
function decideInner(store: EffortHistoryStore, req: EffortHistoryRequest, opts: EffortHistoryOptions = {}): EffortHistoryDecision {
  const now = opts.now ?? Date.now();
  sweep(store, now);

  // Rule 0 (global gate): nothing runs unless the option is on and activated.
  if (opts.enabled !== true) return off("switch-off");
  if (opts.activated !== true) return off("not-activated");
  if (req.transport === "websocket" && opts.websocketHeaderRead !== true) return off("websocket-before-activation");
  // Rule 1: out of scope. Claude Messages requests and requests with previous_response_id are always off.
  if (req.apiKind === "messages") return off("out-of-scope-messages-api");
  if (req.previousResponseId) return off("out-of-scope-previous-response-id");

  // Fable 5.1 is in scope only once its wire id is checked against the Mythos rule; until then off.
  if (/fable/i.test(req.scope?.model ?? "")) return off("fable-wire-id-unchecked");
  if (hasOrphanCall([...req.parent, ...req.suffix])) return off("orphan-tool-call");
  // No effort level ("none" or absent) cannot be a per-message effort value: off, as today.
  if (typeof req.effort !== "string" || !EFFORTS.has(req.effort)) return off("no-effort-level");
  // Rule 2: every scope part is required.
  const s = req.scope;
  if (!s || SCOPE_PARTS.some(k => !s[k])) return off("missing-scope");
  if (s.authMode !== "apiKey") return off("oauth-not-in-first-slice");
  if (s.destination !== ENDPOINT) return off("out-of-scope-destination");
  if (typeof s.model !== "string" || !IN_SCOPE_MODEL.test(s.model)) return off("out-of-scope-model");
  // Chat identity: two chats can share a first message, so each chat needs its own lineage value.
  if (!req.chatLineage) return off("no-chat-lineage");
  const scopeKey = hash([s, req.chatLineage]);
  endOtherScopes(store, hash(req.chatLineage), scopeKey);
  const parentHash = hashItems(req.parent);
  const parentKey = entryKey(scopeKey, parentHash);
  const inputHash = hashItems([...req.parent, ...req.suffix]);

  // Rule 2a: no cache breakpoint. Rule 3: the proxy stripped reasoning.
  if (!req.cacheControl) return offSend(store, parentKey, "no-cache-control");
  if (req.stripped) return offSend(store, parentKey, "proxy-stripped");

  // Rule 3a: an unsupported capability record.
  const cap = store.capability.get(capabilityKey(s));
  if (cap && cap.state === "unsupported" && now - cap.at <= CAPABILITY_TTL_MS) return offSend(store, parentKey, "capability-unsupported");

  // Rule 3b runs before rule 4: a thinking change on a matching parent. Only emitted fields count:
  // an emitted budget_tokens change is a change; the adaptive branch's internal budget is never emitted.
  const parent = store.entries.get(parentKey);
  if (parent && hash(req.thinking) !== parent.thinkingKey) return offSend(store, parentKey, "thinking-change");

  // Rule 4: replay. The request is a turn already committed (same input hash).
  for (const [key, entry] of store.entries) {
    if (entry.scopeKey === scopeKey && entry.inputHash === inputHash) {
      store.entries.delete(key);
      store.entries.delete(parentKey);
      return off("replay", { deleted: true });
    }
  }
  // The turn's entry may already be consumed by a later turn; the committed-input record still refuses it.
  if (store.committedInputs.has(hash([scopeKey, inputHash]))) {
    store.entries.delete(parentKey);
    return off("replay", { deleted: true });
  }
  // A placeholder with the same input hash is a duplicate first request: off, and it is deleted.
  const placeholder = newKey(scopeKey, inputHash);
  if (store.pending.has(placeholder)) {
    store.pending.delete(placeholder);
    return off("placeholder-exists", { deleted: true });
  }

  if (hasConfigUpdate(req.suffix)) return offSend(store, parentKey, "configuration-update-in-suffix");

  // A second request for a parent that is already pending is a fork or retry.
  if (store.pending.has(parentKey)) {
    store.pending.delete(parentKey);
    return off("in-flight-collision", { deleted: true });
  }

  const suffix = req.suffix;
  const userCount = suffix.filter(isUser).length;
  const toolOnly = suffix.length > 0 && suffix.every(isTool);
  // Shape (a): one user message, optionally after tool results. Developer items may appear.
  const firstUser = suffix.findIndex(isUser);
  const shapeA = userCount === 1
    && suffix.every(item => isUser(item) || isTool(item) || isDeveloper(item))
    && suffix.slice(firstUser + 1).every(item => !isTool(item));

  if (!parent) {
    // Rule 7: a compaction summary is user-role; it never starts a history.
    if (req.compactionSummary === true) return off("compaction-summary");
    if (opts.compactionMarkerIdentified !== true) return off("compaction-marker-unidentified");
    // A new history needs a positive new-transcript receipt and a transcript of user and developer
    // items only: a real Codex first turn carries its environment context as a second user message.
    // A restart, eviction, or compaction is not new.
    const newChat = req.newTranscriptReceipt === true && req.parent.length === 0
      && userCount >= 1 && suffix.every(item => isUser(item) || isDeveloper(item));
    if (!newChat) return off("no-history");
    if (store.entries.size + store.pending.size >= MAX_ENTRIES) {
      const oldest = leastRecentlyUsed(store);
      if (oldest === undefined) return off("bounds-refused");
      store.entries.delete(oldest);
    }
    const version = store.nextVersion++;
    const token = `${placeholder}:${version}`;
    const pinned = pin(req);
    const pinnedBytes = bytesOf(pinned);
    // The slot's bytes count against the store total: evict stored histories until it fits, or refuse.
    if (!evictUntilFits(store, pinnedBytes)) return off("bounds-refused");
    store.pending.set(placeholder, {
      kind: "new", key: placeholder, token, version, createdAt: now, inputHash, scopeKey, req: pinned, pinnedBytes, attemptGeneration: req.generation,
    });
    return { action: "send", kind: "new", pendingToken: token, anchorEffort: mapEffort(req.effort) };
  }

  // Rule 6: frame and generation.
  if (parent.frame !== req.frame) return offSend(store, parentKey, "frame-mismatch");
  if (parent.generation !== req.generation) return offSend(store, parentKey, "generation-mismatch");
  // Any output limit different from the anchor's is off. A cap is never raised to make a turn eligible.
  if (effectiveLimit(req) !== parent.limit) return offSend(store, parentKey, "limit-differs");

  if (userCount > 1) return offSend(store, parentKey, "more-than-one-user-message");

  const effort = mapEffort(req.effort);
  if (toolOnly) {
    if (effort !== parent.effortInEffect) return offSend(store, parentKey, "tool-only-effort-change");
    return admitMatched(store, { scopeKey, parentKey, req, parent, now, inputHash, changePoint: false, shape: "tool-only" });
  }
  if (!shapeA) return offSend(store, parentKey, "unclassified-suffix");

  const changePoint = effort !== parent.effortInEffect;
  if (changePoint && parent.changePoints.length >= MAX_CHANGE_POINTS) return offSend(store, parentKey, "change-points-full");
  // Mythos: any effort change is off, because its budget depends on effort.
  if (changePoint && /mythos/i.test(s.model)) return offSend(store, parentKey, "mythos-effort-change");
  // The effort message must land before this turn's user message on the wire; without a place, off.
  if (changePoint && !validWireIndex(req.changeWireIndex)) return offSend(store, parentKey, "change-point-unplaceable");
  return admitMatched(store, { scopeKey, parentKey, req, parent, now, inputHash, changePoint, shape: "a" });
}

interface MatchPlan {
  scopeKey: string;
  parentKey: string;
  req: EffortHistoryRequest;
  parent: Entry;
  now: number;
  inputHash: string;
  changePoint: boolean;
  shape: "a" | "tool-only";
}

// Matched: the parent entry moves to a pending slot until its commit.
function admitMatched(store: EffortHistoryStore, plan: MatchPlan): EffortHistoryDecision {
  store.entries.delete(plan.parentKey);
  const version = store.nextVersion++;
  const token = `${plan.parentKey}:${version}`;
  const pinned = pin(plan.req);
  const pinnedBytes = bytesOf(pinned);
  // The slot holds the parent entry and its pinned values; both count against the store total.
  if (!evictUntilFits(store, plan.parent.bytes + pinnedBytes)) return off("bounds-refused", { deleted: true });
  store.pending.set(plan.parentKey, {
    kind: "matched", key: plan.parentKey, token, version, createdAt: plan.now, inputHash: plan.inputHash,
    attemptGeneration: plan.req.generation,
    scopeKey: plan.scopeKey, entry: plan.parent, req: pinned, pinnedBytes, changePoint: plan.changePoint,
  });
  const insert: EffortChangePoint | null = plan.changePoint
    ? { at: pinned.changeAt, wireIndex: pinned.changeWireIndex as number, effort: mapEffort(plan.req.effort as string) }
    : null;
  return {
    action: "send",
    kind: "matched",
    pendingToken: token,
    anchorEffort: plan.parent.anchorEffort,
    changePoint: plan.changePoint,
    shape: plan.shape,
    // What the adapter inserts: an effort-only system message before this turn's user message.
    insert,
    // Every change point on this chat, in prefix order, so the adapter re-sends all of them each turn.
    changePoints: [...plan.parent.changePoints.map(c => ({ ...c })), ...(insert ? [insert] : [])],
  };
}

// The pending slot is the compare-and-set check: a commit is written only if its slot still exists.
function totalBytes(store: EffortHistoryStore): number {
  let total = 0;
  for (const entry of store.entries.values()) total += entry.bytes;
  // A matched parent in flight still holds its bytes until its commit or restore, and buffered
  // streaming output counts too.
  for (const slot of store.pending.values()) {
    if (slot.entry) total += slot.entry.bytes;
    total += (slot.pinnedBytes ?? 0) + (slot.buffered ?? 0);
  }
  return total;
}

// Resolve a token to its slot without removing it. A token from an earlier admission does not match.
function peekSlot(store: EffortHistoryStore, token: unknown): Slot | null {
  if (typeof token !== "string") return null;
  const sep = token.lastIndexOf(":");
  if (sep < 0) return null;
  const key = token.slice(0, sep);
  const slot = store.pending.get(key);
  if (!slot || slot.token !== token) return null;
  return slot;
}

function takeSlot(store: EffortHistoryStore, token: unknown): Slot | null {
  const slot = peekSlot(store, token);
  if (slot) store.pending.delete(slot.key);
  return slot;
}

// Eviction order: the entry with the oldest last use, not the first inserted.
function leastRecentlyUsed(store: EffortHistoryStore): string | undefined {
  let best: string | undefined;
  for (const [key, entry] of store.entries) {
    if (best === undefined || entry.lastUsed < (store.entries.get(best) as Entry).lastUsed) best = key;
  }
  return best;
}

// Streaming: buffered output for a pending slot. Over the store cap or the per-slot cap, the slot
// is deleted and nothing commits; the response itself is not interrupted.
function bufferInner(store: EffortHistoryStore, token: unknown, bytes: number): EffortHistoryOutcome {
  const slot = peekSlot(store, token);
  if (!slot) return { action: "dropped", reason: "pending-missing" };
  if (!Number.isFinite(bytes) || bytes < 0) {
    store.pending.delete(slot.key);
    return { action: "deleted", reason: "bad-bytes" };
  }
  if (totalBytes(store) + bytes > MAX_TOTAL_BYTES) {
    store.pending.delete(slot.key);
    return { action: "deleted", reason: "streaming-over-store-cap" };
  }
  if ((slot.buffered ?? 0) + bytes > MAX_BUFFER_BYTES) {
    store.pending.delete(slot.key);
    return { action: "deleted", reason: "over-buffer-cap" };
  }
  slot.buffered = (slot.buffered ?? 0) + bytes;
  return { action: "buffering" };
}

function evictUntilFits(store: EffortHistoryStore, bytes: number): boolean {
  // Decide first, evict second: if the pending bytes alone do not leave room, nothing is evicted.
  let evictable = 0;
  for (const entry of store.entries.values()) evictable += entry.bytes;
  const pendingBytes = totalBytes(store) - evictable;
  if (pendingBytes + bytes > MAX_TOTAL_BYTES) return false;
  while (totalBytes(store) + bytes > MAX_TOTAL_BYTES) {
    const oldest = leastRecentlyUsed(store);
    if (oldest === undefined) return false;
    store.entries.delete(oldest);
  }
  return true;
}

function recordCommittedInput(store: EffortHistoryStore, slot: Slot): void {
  store.committedInputs.set(hash([slot.scopeKey, slot.inputHash]), true);
  while (store.committedInputs.size > MAX_ENTRIES * 4) {
    store.committedInputs.delete(store.committedInputs.keys().next().value as string);
  }
}

// Outcomes after a send, in the contract's order.
function commitInner(store: EffortHistoryStore, token: unknown, result: EffortHistoryCommitResult, now = Date.now()): EffortHistoryOutcome {
  const slot = takeSlot(store, token);
  if (!slot) return { action: "dropped", reason: "pending-missing" };
  if (now - slot.createdAt > PENDING_TTL_MS) return { action: "dropped", reason: "pending-expired" };
  if (!result || typeof result !== "object") return { action: "deleted", reason: "bad-result" };
  const { req } = slot;

  if (result.messageStop && !result.failedBeforeSend && !Array.isArray(result.outputItems)) return { action: "deleted", reason: "bad-output" };
  if (result.failedBeforeSend) {
    // Default: delete. Restore only the matched parent, and only when the caller enables it.
    if (slot.kind === "matched" && slot.entry && result.restoreOnFailure === true) {
      if (!evictUntilFits(store, slot.entry.bytes)) return { action: "dropped", reason: "over-store-cap" };
      store.entries.set(slot.key, slot.entry);
      return { action: "restored" };
    }
    return { action: "deleted", reason: slot.kind === "matched" ? "failed-before-send" : "placeholder-failed" };
  }
  if (!result.messageStop) return { action: "deleted", reason: "uncertain-outcome" };

  // Cache check. A missing cache read counts as zero; NaN or a non-number fails closed.
  const cacheRead = result.cacheRead ?? 0;
  if (slot.kind === "matched" && !(cacheRead >= (slot.entry as Entry).P)) {
    return { action: "deleted", reason: "cache-below-P" };
  }
  if (!((result.P ?? 0) > 0)) {
    if (slot.kind === "new") recordCommittedInput(store, slot);
    return { action: "not-committed", reason: "P-zero" };
  }
  // Generation check: the generation at commit must equal both the lookup and the attempt-start value.
  if (result.generation !== req.generation || result.generation !== slot.attemptGeneration) {
    return { action: "deleted", reason: "generation-changed" };
  }

  // Size checks, after the slot check: the larger of the bytes streamed and the canonical output size.
  if (Math.max(slot.buffered ?? 0, bytesOf(result.outputItems)) > MAX_BUFFER_BYTES) return { action: "deleted", reason: "over-buffer-cap" };

  const prior = slot.kind === "matched" ? slot.entry as Entry : null;
  const effort = mapEffort(req.effort as string);
  const changePoints = prior
    ? [...prior.changePoints, ...(slot.changePoint ? [{ at: req.changeAt, wireIndex: req.changeWireIndex as number, effort }] : [])]
    : [];
  const effortInEffect = prior && !slot.changePoint ? prior.effortInEffect : effort;

  const prefixHash = extendChain(slot.inputHash, result.outputItems as unknown[]);
  const record = {
    scopeKey: slot.scopeKey,
    frame: req.frame,
    generation: result.generation,
    prefixHash,
    inputHash: slot.inputHash,
    effortInEffect,
    lineageKey: req.lineageKey,
    anchorEffort: prior ? prior.anchorEffort : effort,
    thinkingKey: req.thinkingKey,
    budget: BUDGET[effort] ?? 8192,
    limit: effectiveLimit(req),
    changePoints,
    P: result.P as number,
    version: store.nextVersion++,
    lastUsed: now,
  };
  const bytes = bytesOf(record);
  if (!evictUntilFits(store, bytes)) return { action: "dropped", reason: "over-store-cap" };

  const key = entryKey(slot.scopeKey, prefixHash);
  // Remember the committed input so a later retry of this turn is refused even after its entry is consumed.
  recordCommittedInput(store, slot);
  store.entries.set(key, { ...record, bytes });
  return { action: "committed", key };
}

// An error from upstream. A 400 with the documented model-unsupported text sets the capability
// record to unsupported. Every error deletes the pending slot; nothing is resent.
function rejectInner(store: EffortHistoryStore, token: unknown, { status, errorText = "" }: { status?: number; errorText?: string } = {}): EffortHistoryOutcome {
  const slot = takeSlot(store, token);
  if (!slot) return { action: "dropped", reason: "pending-missing" };
  if (status === 400 && typeof errorText === "string" && errorText.includes(BETA_FRAGMENT)) {
    store.capability.set(slot.req.capabilityKey, { state: "unsupported", at: Date.now() });
    while (store.capability.size > MAX_CAPABILITY) store.capability.delete(store.capability.keys().next().value as string);
    return { action: "off", reason: "capability-unsupported", deleted: true };
  }
  return { action: "error", reason: status === 400 ? "other-400" : "upstream-error", deleted: true };
}

// The client disconnected or the request was abandoned: nothing is committed. A matched parent is
// restored only when nothing was sent and the caller enables restore; otherwise it is deleted.
function abandonInner(store: EffortHistoryStore, token: unknown, { sent = true, restoreOnFailure = false }: { sent?: boolean; restoreOnFailure?: boolean } = {}): EffortHistoryOutcome {
  const slot = takeSlot(store, token);
  if (!slot) return { action: "dropped", reason: "pending-missing" };
  if (!sent && restoreOnFailure && slot.kind === "matched" && slot.entry) {
    if (!evictUntilFits(store, slot.entry.bytes)) return { action: "dropped", reason: "over-store-cap" };
    store.entries.set(slot.key, slot.entry);
    return { action: "restored" };
  }
  return { action: "deleted", reason: "abandoned" };
}

// A pending slot keeps only what commit needs: digests and pinned scalar values, never the request's
// items or the raw lineage, scope or thinking field.
function pin(req: EffortHistoryRequest): PinnedRequest {
  return {
    lineageKey: hash(req.chatLineage), capabilityKey: capabilityKey(req.scope ?? {}), effort: req.effort,
    thinkingKey: hash(req.thinking), explicitCap: req.explicitCap,
    emittedMaxTokens: req.emittedMaxTokens, omittedMaxTokens: req.omittedMaxTokens,
    frame: req.frame, generation: req.generation, changeAt: changePointAt(req),
    ...(validWireIndex(req.changeWireIndex) ? { changeWireIndex: req.changeWireIndex } : {}),
  };
}

function takeOrIgnore(store: EffortHistoryStore, token: unknown): void {
  try {
    takeSlot(store, token);
  } catch {
    // A malformed store is left as it is; the caller gets a fail-closed result.
  }
}

/** Decide one request. Any internal failure is "off". */
export function decide(store: EffortHistoryStore, req: EffortHistoryRequest, opts?: EffortHistoryOptions): EffortHistoryDecision {
  try { return decideWithCleanup(store, req, opts); } catch { return off("internal-error"); }
}
export function commit(store: EffortHistoryStore, token: unknown, result: EffortHistoryCommitResult, now?: number): EffortHistoryOutcome {
  try { return commitInner(store, token, result, now); } catch { takeOrIgnore(store, token); return { action: "deleted", reason: "internal-error" }; }
}
export function buffer(store: EffortHistoryStore, token: unknown, bytes: number): EffortHistoryOutcome {
  try { return bufferInner(store, token, bytes); } catch { takeOrIgnore(store, token); return { action: "deleted", reason: "internal-error" }; }
}
export function rejectUpstream(store: EffortHistoryStore, token: unknown, error?: { status?: number; errorText?: string }): EffortHistoryOutcome {
  try { return rejectInner(store, token, error); } catch { takeOrIgnore(store, token); return { action: "error", reason: "internal-error", deleted: true }; }
}
export function abandon(store: EffortHistoryStore, token: unknown, opts?: { sent?: boolean; restoreOnFailure?: boolean }): EffortHistoryOutcome {
  try { return abandonInner(store, token, opts); } catch { takeOrIgnore(store, token); return { action: "deleted", reason: "internal-error" }; }
}

// The change point goes after the leading tool results, before the user message, as an index into
// the request input array (the parent items come first).
function changePointAt(req: EffortHistoryRequest): number {
  const firstUser = req.suffix.findIndex(isUser);
  return req.parent.length + (firstUser < 0 ? 0 : firstUser);
}

