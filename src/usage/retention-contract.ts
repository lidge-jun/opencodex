/**
 * The usage-ledger retention limits, stated once for the schema, the server and the dashboard.
 *
 * Import-free, for the reason `telemetry-contract.ts` gives: the dashboard is a separate
 * TypeScript project, and a type-only import still drags the imported file's whole graph into
 * the browser build. Anything added here must keep that property.
 */

/**
 * Below this a ceiling cannot hold even one large row plus its successor, so a value under it is
 * treated as unset rather than enforced into an empty ledger.
 */
export const MIN_USAGE_LEDGER_MAX_BYTES = 1024 * 1024;

/** What the dashboard offers when a user turns the limit on. Not a default for the proxy. */
export const SUGGESTED_USAGE_LEDGER_MAX_BYTES = 1024 * 1024 * 1024;

/**
 * Trim to this fraction of the ceiling rather than to the ceiling itself, so the next append does
 * not immediately re-cross it and charge every subsequent append a full rewrite.
 */
export const USAGE_LEDGER_RETENTION_TARGET_RATIO = 0.9;

export interface UsageLedgerRetentionStatus {
  /** Absent when no limit is configured. */
  maxBytes?: number;
  currentBytes: number;
}
