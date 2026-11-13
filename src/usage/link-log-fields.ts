/**
 * Remote Link request-log fields (design T4 section 9.1): how a link request arrived and whether it carried a
 * continuation. Written only for link traffic while the link WebSocket feature is on (src/server/link-turn.ts); a row
 * without them is not link traffic or predates them. threadRef and turnRef are HMAC-SHA256 refs under the Home's
 * private activity reference key, never the raw ids. Lives here so both the in-memory request log and usage.jsonl
 * share one validator, and request-log.ts (at its line cap) only spreads it.
 */

export type LinkTransport = "http" | "websocket";
export type LinkContinuation = "chained" | "full" | "miss";
export type LinkContinuationReason = "first" | "client" | "missing" | "scope_mismatch"
  | "spill_missing" | "spill_corrupt" | "spill_failed" | "spill_too_large";

export interface LinkRequestLogFields {
  transport: LinkTransport;
  continuation: LinkContinuation;
  continuationReason?: LinkContinuationReason;
  threadRef?: string;
  turnRef?: string;
}

/** Mixed into the request-log context, entry and persisted row. */
export interface LinkRequestLogCarrier { link?: LinkRequestLogFields }

const TRANSPORTS: ReadonlySet<string> = new Set<LinkTransport>(["http", "websocket"]);
const CONTINUATIONS: ReadonlySet<string> = new Set<LinkContinuation>(["chained", "full", "miss"]);
const REASONS: ReadonlySet<string> = new Set<LinkContinuationReason>(["first", "client", "missing", "scope_mismatch",
  "spill_missing", "spill_corrupt", "spill_failed", "spill_too_large"]);
const REF = /^[0-9a-f]{64}$/;

/** The validated field as a spreadable object: `{ link }` for a well-formed value, `{}` for anything else. */
export function linkLogField(value: unknown): { link?: LinkRequestLogFields } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  if (typeof raw.transport !== "string" || !TRANSPORTS.has(raw.transport)) return {};
  if (typeof raw.continuation !== "string" || !CONTINUATIONS.has(raw.continuation)) return {};
  if (raw.continuationReason !== undefined && (typeof raw.continuationReason !== "string" || !REASONS.has(raw.continuationReason))) return {};
  for (const key of ["threadRef", "turnRef"] as const) {
    if (raw[key] !== undefined && (typeof raw[key] !== "string" || !REF.test(raw[key] as string))) return {};
  }
  return { link: {
    transport: raw.transport as LinkTransport,
    continuation: raw.continuation as LinkContinuation,
    ...(raw.continuationReason !== undefined ? { continuationReason: raw.continuationReason as LinkContinuationReason } : {}),
    ...(raw.threadRef !== undefined ? { threadRef: raw.threadRef as string } : {}),
    ...(raw.turnRef !== undefined ? { turnRef: raw.turnRef as string } : {}),
  } };
}
