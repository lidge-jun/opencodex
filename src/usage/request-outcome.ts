/**
 * One terminal classification for a finished logical request, and the counts that go with it.
 *
 * Three surfaces answer "how did this request end" and they used to answer it three different
 * ways. The durable row carries `terminalStatus` and `closeReason`; the Prometheus exporter had
 * its own private `classifyResult`; the dashboard read the numeric HTTP status and nothing else.
 * That is not a cosmetic difference. A turn cut short by `max_output_tokens` is durably
 * `status: 200, terminalStatus: "incomplete"`, which the exporter reports as `incomplete` and the
 * dashboard rendered as a green 200 — the operator and the metric disagreed about whether the
 * user got an answer.
 *
 * The fix is not a third classifier. It is this one, which the exporter imports, the management
 * payload carries, and the dashboard renders, so agreement is structural rather than a rule
 * someone has to keep.
 *
 * Leaf module: its only import is a type, erased at runtime.
 */
import type { RequestSpendTotals } from "./telemetry-contract";

/**
 * Ordered by how much of an answer the caller received. The order is not a ranking of severity;
 * `aborted` is last because the caller chose it, not because it is the worst outcome.
 */
export const REQUEST_OUTCOME_CLASSES = Object.freeze([
  /** A terminal event settled the turn and the caller received the answer. */
  "completed",
  /** The turn ended without an answer. */
  "failed",
  /** The turn produced part of an answer and stopped. */
  "incomplete",
  /** The caller went away before the turn finished. */
  "aborted",
] as const);

export type RequestOutcomeClass = typeof REQUEST_OUTCOME_CLASSES[number];

/**
 * The terminal statuses a Responses turn can settle on.
 *
 * Derived from the outcome classes rather than restated: a turn reports whether it completed,
 * failed or stopped short, and `aborted` is not one of them because the caller leaving is not a
 * terminal the origin emits. Deriving it means a fifth outcome class cannot leave this list
 * stale, and restating the three would be the same copy that let the recovery roster drift.
 */
export type RequestTerminalStatus = Exclude<RequestOutcomeClass, "aborted">;

/**
 * The same three members as a runtime list, filtered out of the outcome roster rather than
 * typed out again, so the guard below cannot disagree with the type above it.
 */
export const REQUEST_TERMINAL_STATUSES: readonly RequestTerminalStatus[] = Object.freeze(
  REQUEST_OUTCOME_CLASSES.filter((value): value is RequestTerminalStatus => value !== "aborted"),
);

/** Why the response body stopped being read. Closed, and persisted as such. */
export const REQUEST_CLOSE_REASONS = Object.freeze([
  "terminal",
  "client_cancel",
  "non_stream",
  "body_stall",
  "body_overflow",
] as const);

export type RequestCloseReason = typeof REQUEST_CLOSE_REASONS[number];

/**
 * Read-back guards for the two facts that reach a durable row as strings.
 *
 * `terminalStatus` was typed `string` on the persisted entry and copied through the normalizer
 * on truthiness alone, unlike the inbound protocol, transport phase and terminal source beside
 * it. That was harmless while the value was only rendered; it stops being harmless the moment
 * the value becomes part of a grouping key, because the string is assembled from an upstream
 * frame and an unvalidated one would put upstream-controlled text into the key.
 */
export function isRequestTerminalStatus(value: unknown): value is RequestTerminalStatus {
  return typeof value === "string"
    && (REQUEST_TERMINAL_STATUSES as readonly string[]).includes(value);
}

export function isRequestCloseReason(value: unknown): value is RequestCloseReason {
  return typeof value === "string"
    && (REQUEST_CLOSE_REASONS as readonly string[]).includes(value);
}

/**
 * The facts a terminal classification is allowed to read.
 *
 * Deliberately narrow, and deliberately NOT the whole durable row: an outcome that could consult
 * a provider name or an error message would be a different answer per provider, which is how the
 * three surfaces drifted apart in the first place.
 */
export interface RequestOutcomeFacts {
  readonly status: number;
  readonly terminalStatus?: string | undefined;
  readonly closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow" | undefined;
}

/**
 * Classify one finished logical request.
 *
 * Semantic terminal facts are read BEFORE the numeric status, which is the whole point. An HTTP
 * 200 that carried an incomplete terminal is incomplete; a 502 that carried an incomplete
 * terminal is also incomplete, and reading the status first would have called them success and
 * failure. The numeric status is consulted only when no terminal event was recorded at all.
 */
export function classifyRequestOutcome(facts: RequestOutcomeFacts): RequestOutcomeClass {
  if (facts.closeReason === "client_cancel" || facts.status === 499) return "aborted";
  if (facts.terminalStatus === "failed") return "failed";
  if (facts.terminalStatus === "incomplete"
    || facts.closeReason === "body_stall"
    || facts.closeReason === "body_overflow") return "incomplete";
  if (facts.terminalStatus === "completed") return "completed";
  if (facts.terminalStatus === undefined
    && (facts.status === 101 || (facts.status >= 200 && facts.status < 400))) return "completed";
  return "failed";
}

/** A count is reportable only when the writer recorded a non-negative integer. */
function reportableCount(value: number | undefined): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * Physical sends a finished request made, as the one number every surface shows.
 *
 * This READS the recorded total rather than recomputing one. An earlier draft returned
 * `max(sends, reserved)` on the reasoning that a budget charge with no attempt row behind it is
 * still a send that left — true, but it made the dashboard report four where the exporter, which
 * sums the same attempts the recorder summed, reported three. Two defensible formulas are still
 * two answers. The recorder already decided this, and `unresolved` below is where a charge with
 * no attempt behind it becomes visible.
 */
export function requestPhysicalSends(spend: RequestSpendTotals | undefined): number {
  return reportableCount(spend?.sends);
}

/**
 * Sends whose attempt reached a terminal status, and sends that did not.
 *
 * Kept beside {@link requestPhysicalSends} because an operator reading a send total needs to know
 * how much of it is explained. An unresolved send is the quantity a duplicate-send incident shows
 * up in, and folding it into the total is what made #4546 invisible for so long.
 */
export function requestSettledSends(spend: RequestSpendTotals | undefined): number {
  return reportableCount(spend?.settled);
}

export function requestUnresolvedSends(spend: RequestSpendTotals | undefined): number {
  return reportableCount(spend?.unresolved);
}
