/**
 * The telemetry vocabulary both the proxy and the dashboard read.
 *
 * This module has NO imports, and that is its entire job. The dashboard is a separate TypeScript
 * project with `erasableSyntaxOnly`, and a type-only import still pulls the imported file's whole
 * import graph into that project. Importing these names from `./log` therefore dragged
 * `node:fs`, `node:crypto` and the config barrel into the browser build, where a parameter
 * property in `src/config/atomic-write.ts` fails to compile. The names below are the ones a
 * browser legitimately needs, so they live where a browser can reach them.
 *
 * Anything added here must stay free of imports. A contract that acquires a dependency stops
 * being a contract.
 */

/**
 * Recovery kinds recorded per attempt in the usage log; the dashboard renders localized labels
 * for these wire values.
 *
 * The roster is the single statement of this vocabulary and the type is derived from it. It was
 * written twice once -- as a union and as the read-back whitelist -- and the two are not
 * interchangeable: a member added only to the union compiles, is written to disk, and is dropped
 * on the next read, so the row loses the field that says why it recovered. One declaration cannot
 * drift from itself, and the dashboard now reads this one rather than keeping a third copy.
 */
export const ATTEMPT_RECOVERY_KIND_ROSTER = Object.freeze([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-401",
  "key-429",
  "rate-limit-429",
  "anthropic-oauth-429",
  "oauth-account-429",
  "image-413",
  "console-go-upload-retry",
  "opaque-blob-rejection",
  "empty-completion",
  "reasoning-effort-downgrade",
] as const);

export type AttemptRecoveryKind = typeof ATTEMPT_RECOVERY_KIND_ROSTER[number];

/**
 * Why a recovery this request was otherwise willing to make did not happen.
 *
 * Recorded separately from `recoveryKinds` and from `sendCount` because the question it answers
 * is different from either. A log showing one physical send and no recovery kind used to be
 * ambiguous: nothing was eligible, or something was and the send budget withheld it. Those need
 * opposite follow-ups and the second was invisible (#5044).
 *
 * `sendCount` deliberately does not move for these. A refused attempt is not a physical send, and
 * inflating the count to signal the refusal would corrupt the one number that means "requests this
 * proxy actually made".
 */
export const ATTEMPT_RECOVERY_WITHHELD_ROSTER = Object.freeze([
  "retry-send-budget",
  "rotation-send-budget",
] as const);

export type AttemptRecoveryWithheld = typeof ATTEMPT_RECOVERY_WITHHELD_ROSTER[number];

/**
 * What one logical request spent upstream, decomposed by how much of it is explained.
 *
 * The counting half of the durable spend record, without the routing detail that sits beside it.
 * Every surface that reports a send total reads these three numbers and none of them recomputes a
 * total of its own -- a recomputed total is how the exporter and the dashboard ended up reporting
 * different send counts for the same request.
 */
export interface RequestSpendTotals {
  /** Physical upstream sends summed across every attempt, combo children included. */
  sends: number;
  /** Sends whose attempt reached a terminal status, so the spend has a known outcome. */
  settled: number;
  /**
   * Sends charged with no terminal outcome behind them: an attempt abandoned mid-flight, or a
   * budget charge no attempt row ever accounted for. Never folded into `settled` -- an unexplained
   * send is the exact quantity this record exists to make visible.
   */
  unresolved: number;
  /** Model sends the request execution budget charged. Absent when no budget was attached. */
  reserved?: number;
}
