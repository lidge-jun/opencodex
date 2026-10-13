import { createHash } from "node:crypto";
import { advisorResultIsAdvice } from "./context";

/**
 * Conversation- and task-scoped advisor state.
 *
 * Three scopes, deliberately separate:
 *
 * 1. REQUEST-scoped state lives in the per-request plan closure (see runtime.ts) — consultation
 *    count, dedup fingerprints, the preflight flag. Born and dies with one request.
 *
 * 2. TASK-scoped preflight ledger (this file): a bounded, process-local claim table that makes
 *    "at most one automatic consultation per task" atomic across concurrent requests. A claim
 *    requires a STABLE conversation identity plus the current task boundary; a client that sends
 *    no identity never enters this ledger (see `advisorLedgerKey`) and therefore fails open —
 *    it may be consulted once per request rather than risk two independent tasks suppressing
 *    each other through a shared guess.
 *
 * 3. PROVENANCE, split by authority:
 *    - MANUAL advice is verifiable history: a `toolResult` whose `toolName` is the synthetic
 *      advisor tool and whose content parses as a runtime-written advice object. Ordinary tool
 *      output, developer text, user text, and failure notices can never match it. Bytes inside
 *      the quoted advice field cannot change the runtime-owned status.
 *    - AUTOMATIC preflight dedup is NOT decided from history at all. The developer transport
 *      envelope labels the payload for the worker; any client could echo or forge such a message,
 *      so the ledger below is the authoritative source for "this task was already consulted" —
 *      `success`, `inflight` and `cooldown` states. A conversation with no stable identity gets
 *      no ledger and therefore fails open (at most one extra attempt). A forged marker or a
 *      forged developer message cannot suppress the policy.
 *
 * Ledger entries are plain state records — no message bodies, no credentials. Every state is
 * bounded by entry count and its own TTL.
 */

/** Long-lived success suppression: the task lifetime approximation (also the ledger TTL cap). */
export const ADVISOR_SUCCESS_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Failure cooldown. One minute is the repository's standing minute-scale unit (tray polling,
 * subagent availability polling); it turns a transient 503 into a short pause instead of
 * silencing the policy for the rest of the coding session.
 */
export const ADVISOR_FAILURE_COOLDOWN_MS = 60 * 1000;
/**
 * In-flight claim expiry. Longer than the largest configurable consultation timeout (600s
 * upper bound on `advisor.timeoutMs`, default 120s) so a slow-but-alive consultation is never
 * mistaken for a wedged one, while a crashed claim cannot block a task forever.
 */
export const ADVISOR_INFLIGHT_TTL_MS = 10 * 60 * 1000;

const MAX_ENTRIES = 512;

export type AdvisorClaimState =
  /** The caller now owns the consultation for this task. */
  | "claimed"
  /** Another request for the same task is consulting right now. */
  | "inflight"
  /** This task already received advice; suppression holds until the success TTL expires. */
  | "complete"
  /** A recent consultation failed; suppression holds for the short failure cooldown. */
  | "cooldown"
  /**
   * The ledger is full of live claims and granted nothing. Fail-open: the worker continues
   * without a new automatic consultation rather than evicting a claim that is still running.
   */
  | "saturated";

/**
 * The result of a claim attempt. `token` identifies THIS claim and is present only on
 * `"claimed"`; settlement must present it, so a slow consultation whose in-flight entry expired
 * cannot settle the successor claim that took its place.
 */
export interface AdvisorClaim {
  state: AdvisorClaimState;
  token?: string;
}

interface LedgerEntry {
  state: "inflight" | "success" | "failed";
  at: number;
  /** Present on in-flight entries: which claim owns this entry. */
  token?: string;
}

export interface AdvisorPreflightLedger {
  /**
   * Atomically try to own the consultation for a task key. Returns `claimed` exactly once per
   * task (with the ownership token) until a matching settlement releases it, so two concurrent
   * requests cannot both consult.
   */
  claim(key: string, now?: number): AdvisorClaim;
  /**
   * Settle a claim the caller owns. A settlement whose token does not match the current entry
   * is a no-op: the entry now belongs to a successor claim (the caller's in-flight window
   * expired), and it must not be able to erase or overwrite that successor's state.
   */
  complete(key: string, token: string, now?: number): void;
  fail(key: string, token: string, now?: number): void;
  release(key: string, token: string, now?: number): void;
  /**
   * Fact, not settlement: this task received advice (used by a successful MANUAL consultation,
   * which owns no preflight claim). Records success regardless of the current entry, because
   * "the task was advised" is true whichever consultation produced it.
   */
  markAdvised(key: string, now?: number): void;
  /** Test/observability seam: current entry count. */
  size(): number;
}

export function createAdvisorPreflightLedger(): AdvisorPreflightLedger {
  const entries = new Map<string, LedgerEntry>();
  let claimSequence = 0;

  const isExpired = (entry: LedgerEntry, now: number): boolean => {
    const ttl = entry.state === "success"
      ? ADVISOR_SUCCESS_TTL_MS
      : entry.state === "failed"
        ? ADVISOR_FAILURE_COOLDOWN_MS
        : ADVISOR_INFLIGHT_TTL_MS;
    return now - entry.at > ttl;
  };

  /**
   * Make room for ONE new claim without ever evicting a live in-flight entry, because that entry
   * is the only thing preventing a second automatic consultation for its task. Order: expired
   * entries first, then settled ones (success before failure), oldest first. Returns false when
   * every entry is a live claim — the caller then reports `saturated` instead of breaking the
   * "at most one in-flight consultation per task" guarantee.
   */
  const makeRoom = (now: number): boolean => {
    if (entries.size < MAX_ENTRIES) return true;
    for (const [key, entry] of entries) {
      if (isExpired(entry, now)) entries.delete(key);
    }
    if (entries.size < MAX_ENTRIES) return true;
    for (const state of ["success", "failed"] as const) {
      for (const [key, entry] of entries) {
        if (entry.state === state) {
          entries.delete(key);
          return true;
        }
      }
    }
    return false;
  };

  const liveEntry = (key: string, now: number): LedgerEntry | undefined => {
    const entry = entries.get(key);
    if (!entry) return undefined;
    if (isExpired(entry, now)) {
      entries.delete(key);
      return undefined;
    }
    return entry;
  };

  // Replacing an existing key never grows the map, and every NEW key is admitted only through
  // claim()'s makeRoom gate, so the table cannot exceed MAX_ENTRIES.
  const set = (key: string, state: LedgerEntry["state"], now: number, token?: string): void => {
    if (entries.has(key)) entries.delete(key);
    entries.set(key, { state, at: now, ...(token !== undefined ? { token } : {}) });
  };

  /** True when the caller's token still owns the current in-flight entry for this key. */
  const owns = (key: string, token: string, now: number): boolean => {
    const entry = liveEntry(key, now);
    return entry?.state === "inflight" && entry.token === token;
  };

  return {
    claim(key, now = Date.now()) {
      const entry = liveEntry(key, now);
      if (entry?.state === "success") return { state: "complete" };
      if (entry?.state === "failed") return { state: "cooldown" };
      if (entry?.state === "inflight") return { state: "inflight" };
      if (!makeRoom(now)) return { state: "saturated" };
      claimSequence += 1;
      const token = `claim-${claimSequence.toString(36)}`;
      set(key, "inflight", now, token);
      return { state: "claimed", token };
    },
    complete(key, token, now = Date.now()) {
      // A settlement that no longer owns the entry is a no-op: the claim it belonged to expired
      // and a successor now owns the state.
      if (owns(key, token, now)) set(key, "success", now);
    },
    fail(key, token, now = Date.now()) {
      if (owns(key, token, now)) set(key, "failed", now);
    },
    release(key, token, now = Date.now()) {
      if (owns(key, token, now)) entries.delete(key);
    },
    markAdvised(key, now = Date.now()) {
      // Recording the FACT must respect the same cap as claiming: a key that is not present and a
      // table holding nothing but live claims means no room, so the record is skipped rather than
      // evicting a claim that is still running. Fail-open: at worst one extra automatic attempt.
      const present = liveEntry(key, now) !== undefined;
      if (!present && !makeRoom(now)) return;
      set(key, "success", now);
    },
    size() {
      return entries.size;
    },
  };
}

/**
 * Stable conversation identity for the ledger, reusing the repository's existing request
 * identities in specificity order: the client's own thread, the shared parent thread, the
 * Cursor conversation, the Cursor client thread, then the reasoning-replay scope's thread.
 * Returns undefined for a client that sends no identity at all — such a caller stays out of the
 * process-global ledger on purpose (fail-open, see the module header).
 */
export function advisorConversationIdentity(parsed: {
  _codexOwnThreadId?: string;
  _clientThreadId?: string;
  _cursorConversationId?: string;
  _cursorClientThreadId?: string;
  _reasoningReplayScope?: { clientThreadId?: string };
}): string | undefined {
  return parsed._codexOwnThreadId
    ?? parsed._clientThreadId
    ?? parsed._cursorConversationId
    ?? parsed._cursorClientThreadId
    ?? parsed._reasoningReplayScope?.clientThreadId
    ?? undefined;
}

/**
 * Domain-separated SHA-256 digest. Task identity and suppression are CORRECTNESS boundaries, so a
 * 32-bit non-cryptographic hash is not an acceptable primary digest: distinct tasks must not
 * collide because of a short fold. The ledger stores only this digest, never the raw text, so a
 * captured key reveals nothing about the conversation. The domain prefix keeps digests from
 * different purposes apart even if their inputs coincide.
 */
function sha256Hex(domain: string, value: string, hexChars: number): string {
  return createHash("sha256").update(`${domain}\0${value}`, "utf8").digest("hex").slice(0, hexChars);
}

/**
 * The current task boundary inside a conversation: how many user turns the history carries and a
 * digest of the FULL latest user text. A new user message moves the boundary (a new task gets its
 * own claim); the same turn re-sent by a stateless full-history client keeps the same boundary,
 * and a `previous_response_id` expansion replays the same user turns, so continuations dedup.
 * The whole text participates — no truncation — so two tasks that share an opening prefix still
 * get different boundaries.
 */
export function advisorTaskBoundary(parsed: {
  context: { messages: readonly { role: string; content: unknown }[] };
}): string {
  let userTurns = 0;
  let lastUserText = "";
  for (const message of parsed.context.messages) {
    if (message.role !== "user") continue;
    userTurns += 1;
    lastUserText = contentText(message.content);
  }
  return `t${userTurns}:${sha256Hex("advisor-task-boundary", lastUserText, 32)}`;
}

/**
 * The ledger key: one domain-separated SHA-256 digest over conversation identity + task boundary
 * + worker model. Returns undefined when the caller has no stable conversation identity — the
 * caller then relies on request-scoped dedup and genuine in-history provenance instead of a
 * shared guess (documented fail-open).
 */
export function advisorLedgerKey(
  parsed: {
    context: { messages: readonly { role: string; content: unknown }[] };
    _codexOwnThreadId?: string;
    _clientThreadId?: string;
    _cursorConversationId?: string;
    _cursorClientThreadId?: string;
    _reasoningReplayScope?: { clientThreadId?: string };
  },
  workerModelId: string,
): string | undefined {
  const identity = advisorConversationIdentity(parsed);
  if (!identity) return undefined;
  const material = `${identity}\0${advisorTaskBoundary(parsed)}\0${workerModelId}`;
  return `ak-${sha256Hex("advisor-task-key", material, 40)}`;
}

/** Text projection for string-or-parts content; used only for hashing, never transmitted. */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } =>
      !!part && typeof part === "object" && (part as { type?: unknown }).type === "text"
      && typeof (part as { text?: unknown }).text === "string")
    .map(part => part.text)
    .join("");
}

/**
 * Legacy marker spellings. Failure text still neutralizes them so an upstream error cannot
 * look like an old wrapper. They are not suppression authority and are not emitted.
 */
export const ADVISOR_PREFLIGHT_MARKER = "<opencodex_advisor_preflight>";

/** The synthetic advisor tool's wire name; kept in sync with the tool definition by test. */
export const ADVISOR_RESULT_TOOL_NAME = "advisor";

/** Legacy manual wrapper spelling. Detection does not search for this substring. */
export const ADVISOR_ADVICE_MARKER = "<opencodex_advisor>";

/**
 * Detect an ALREADY-PRESENT MANUAL advisor result — by provenance, never by a bare string.
 * The message must be a `toolResult` whose `toolName` is the synthetic advisor tool, and its
 * content must parse as a runtime-written advice object (`status === "advice"` on the sibling
 * field the runtime sets). Text inside `advice` cannot flip that field.
 *
 * Only messages after the latest user turn count. Manual advice from an earlier task in the
 * same thread does not suppress preflight for a later task; the ledger keys those separately.
 * Developer messages are deliberately NOT inspected. Automatic preflight dedup lives in the
 * ledger. A client-echoed developer envelope, a shell result, or a failure notice matches nothing.
 */
export function historyHasManualAdvisorResult(parsed: {
  context: { messages: readonly { role: string; content?: unknown; toolName?: string }[] };
}): boolean {
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    const message = parsed.context.messages[i]!;
    if (message.role === "user") break;
    if (message.role !== "toolResult") continue;
    if (message.toolName !== ADVISOR_RESULT_TOOL_NAME) continue;
    if (advisorResultIsAdvice(contentText(message.content))) return true;
  }
  return false;
}

/** Kept for callers that only need the first user text (payload building, tests). */
export function firstUserText(parsed: { context: { messages: readonly { role: string; content: unknown }[] } }): string {
  for (const message of parsed.context.messages) {
    if (message.role !== "user") continue;
    const text = contentText(message.content);
    if (text.trim() !== "") return text;
  }
  return "";
}

/**
 * Deterministic preflight trigger: has this conversation already produced orientation evidence
 * since the latest user message? The documented approximation for "before the first substantive
 * implementation" — the protocol layer offers no safe pre-mutation checkpoint, so OpenCodex fires
 * the automatic attempt on the first worker reasoning turn that arrives with that evidence.
 * Evidence is an assistant tool call OR a tool result after the latest user message (both forms
 * are genuinely accepted; the docs say so). Only text/toolResult content is inspected — never
 * reasoning, never encrypted items.
 */
export function hasOrientationEvidence(parsed: { context: { messages: readonly { role: string; content: unknown }[] } }): boolean {
  let latestUserIndex = -1;
  for (let i = parsed.context.messages.length - 1; i >= 0; i -= 1) {
    if (parsed.context.messages[i]?.role === "user") {
      latestUserIndex = i;
      break;
    }
  }
  if (latestUserIndex < 0) return false;
  for (let i = latestUserIndex + 1; i < parsed.context.messages.length; i += 1) {
    const message = parsed.context.messages[i];
    if (message.role === "toolResult") return true;
    if (message.role === "assistant" && Array.isArray(message.content)
      && message.content.some(part =>
        !!part && typeof part === "object" && (part as { type?: unknown }).type === "toolCall")) {
      return true;
    }
  }
  return false;
}
