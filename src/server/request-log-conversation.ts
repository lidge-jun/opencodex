/**
 * Best-effort chat/session correlation for Logs / usage.jsonl (#330).
 * Opaque ids only — never persist raw emails or Claude Desktop system-hash fallbacks.
 */
import { createHash } from "node:crypto";

/** Reject absurdly long client strings before hashing (DoS / JSONL bloat). */
export const LOG_CONVERSATION_ID_INPUT_MAX = 4096;
/** Persisted / filterable form is always a 32-char hex digest. */
export const LOG_CONVERSATION_ID_LEN = 32;

function hasControlChars(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function sanitizeConversationIdInput(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  // Reject control characters that would break JSONL / UI paste.
  if (hasControlChars(trimmed)) return undefined;
  if (trimmed.length > LOG_CONVERSATION_ID_INPUT_MAX) return undefined;
  return trimmed;
}

/**
 * Cap / sanitize a correlation id for persistence.
 * Always hashes so client-controlled headers cannot land emails or short secrets in usage.jsonl.
 */
export function normalizeLogConversationId(raw: string | undefined | null): string | undefined {
  const trimmed = sanitizeConversationIdInput(raw);
  if (!trimmed) return undefined;
  return createHash("sha256").update(trimmed).digest("hex").slice(0, LOG_CONVERSATION_ID_LEN);
}

/**
 * Filter match: accept either the persisted digest or the original preimage
 * (so pasting from Logs detail or the client-facing session id both work).
 */
export function matchesLogConversationId(
  stored: string | undefined,
  query: string | undefined | null,
): boolean {
  if (!stored) return false;
  const trimmed = typeof query === "string" ? query.trim() : "";
  if (!trimmed) return false;
  if (stored === trimmed) return true;
  const hashed = normalizeLogConversationId(trimmed);
  return hashed !== undefined && stored === hashed;
}

/**
 * Codex/Claude/Cursor priority for Responses-shaped requests:
 * parent thread header > session_id / session-id > thread-id > cursor conversation id.
 */
export function sessionIdHeaderFromRequest(headers: Headers): string | null {
  return headers.get("session_id") ?? headers.get("session-id");
}

/**
 * Fixed-size logical turn lane (#820).
 *
 * A lane must be as SPECIFIC as the identity available, which is the opposite of what
 * `codexPoolAffinityKey` wants. Affinity deliberately prefers the parent thread so a whole
 * subagent fan-out pins to one account; a lane keyed that way would put every parallel
 * subagent of one parent into a single lane and reject all but the first with 503 — the
 * fan-out is the normal case, not an abuse.
 *
 * So the parent is a QUALIFIER, never the lane on its own when a child thread exists: the
 * pair separates siblings while still keeping one conversation's overlapping turns together.
 */
export function sessionLaneIdFromRequest(headers: Headers): string | undefined {
  const parent = normalizeLogConversationId(headers.get("x-codex-parent-thread-id"));
  const thread = normalizeLogConversationId(headers.get("thread-id"));
  const session = normalizeLogConversationId(sessionIdHeaderFromRequest(headers));
  const specific = thread ?? session;
  if (parent && specific) return `${parent}\u0000${specific}`;
  return specific ?? parent;
}

function firstSanitizedConversationId(
  ...values: Array<string | null | undefined>
): string | undefined {
  for (const value of values) {
    const sanitized = sanitizeConversationIdInput(value);
    if (sanitized) return sanitized;
  }
  return undefined;
}

/**
 * Conversation namespace for reasoning replay. Unlike the persisted log id, this stays the raw
 * sanitized identity so mixed headers that carry the same conversation still hit one serving
 * record. Do not hash, and do not prefer session_id over a true per-conversation thread/Cursor
 * identity: session_id can be synthesized from a shared prompt_cache_key.
 */
export function reasoningReplayConversationIdFromResponsesRequest(input: {
  clientThreadId?: string;
  threadIdHeader?: string | null;
  cursorConversationId?: string;
  sessionIdHeader?: string | null;
}): string | undefined {
  return firstSanitizedConversationId(
    input.clientThreadId,
    input.threadIdHeader,
    input.cursorConversationId,
    input.sessionIdHeader,
  );
}

export function conversationIdFromResponsesRequest(input: {
  clientThreadId?: string;
  sessionIdHeader?: string | null;
  threadIdHeader?: string | null;
  cursorConversationId?: string;
}): string | undefined {
  return normalizeLogConversationId(
    input.clientThreadId
      ?? input.sessionIdHeader
      ?? input.threadIdHeader
      ?? input.cursorConversationId,
  );
}

/**
 * Claude Code metadata.user_id only — never the system-hash Desktop fallback.
 * Hashes the raw user_id once (same opacity goal as inbound prompt_cache_key).
 */
export function conversationIdFromClaudeMetadata(
  metadata: { user_id?: unknown } | null | undefined,
): string | undefined {
  if (!metadata || typeof metadata.user_id !== "string") return undefined;
  return normalizeLogConversationId(metadata.user_id);
}

/** @deprecated Prefer conversationIdFromClaudeMetadata; kept for call-site clarity. */
export function conversationIdFromClaudeCacheKey(
  cacheKeySource: "metadata" | "system" | null | undefined,
  promptCacheKey: string | undefined,
): string | undefined {
  if (cacheKeySource !== "metadata") return undefined;
  // prompt_cache_key is already sha256(user_id)[:32] from inbound — persist as-is
  // (do not re-hash) so native and translated paths stay aligned when callers pass
  // the preimage via conversationIdFromClaudeMetadata instead.
  const trimmed = sanitizeConversationIdInput(promptCacheKey);
  if (!trimmed) return undefined;
  if (trimmed.length === LOG_CONVERSATION_ID_LEN && /^[0-9a-f]+$/i.test(trimmed)) return trimmed.toLowerCase();
  return normalizeLogConversationId(trimmed);
}

export interface ConversationLogTotals {
  requests: number;
  totalTokens: number;
  estimatedCostUsd: number;
  pricedRequests: number;
  unpricedRequests: number;
  unmeteredRequests: number;
}

type TotalsSource = {
  totalTokens?: number;
  usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
  usageStatus?: string;
  displayMetrics?: {
    cost?:
      | { kind: "value"; estimate: { cost: { total: number } } }
      | { kind: "unavailable"; reason: string };
  };
};

function rowTokenTotal(entry: TotalsSource): number | undefined {
  if (typeof entry.totalTokens === "number" && Number.isFinite(entry.totalTokens) && entry.totalTokens >= 0) {
    return entry.totalTokens;
  }
  const usageTotal = entry.usage?.totalTokens;
  if (typeof usageTotal === "number" && Number.isFinite(usageTotal) && usageTotal >= 0) return usageTotal;
  const input = entry.usage?.inputTokens;
  const output = entry.usage?.outputTokens;
  if (typeof input === "number" && typeof output === "number" && Number.isFinite(input) && Number.isFinite(output)) {
    return Math.max(0, input) + Math.max(0, output);
  }
  return undefined;
}

/** Sum tokens/cost for the currently loaded log slice matching a conversation filter. */
export function summarizeConversationLogs(entries: readonly TotalsSource[]): ConversationLogTotals {
  let totalTokens = 0;
  let estimatedCostUsd = 0;
  let pricedRequests = 0;
  let unpricedRequests = 0;
  let unmeteredRequests = 0;
  for (const entry of entries) {
    const tokens = rowTokenTotal(entry);
    if (tokens !== undefined) totalTokens += tokens;
    if (entry.usageStatus === "unsupported") {
      unmeteredRequests += 1;
      continue;
    }
    const cost = entry.displayMetrics?.cost;
    if (cost?.kind === "value" && Number.isFinite(cost.estimate.cost.total) && cost.estimate.cost.total >= 0) {
      estimatedCostUsd += cost.estimate.cost.total;
      pricedRequests += 1;
      continue;
    }
    unpricedRequests += 1;
  }
  return {
    requests: entries.length,
    totalTokens,
    estimatedCostUsd,
    pricedRequests,
    unpricedRequests,
    unmeteredRequests,
  };
}
