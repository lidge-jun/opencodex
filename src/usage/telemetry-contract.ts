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
 * How far a failed exchange got, ordered by how much the DOWNSTREAM CLIENT observed.
 *
 * The order is by client observation rather than by upstream progress, because the question it
 * answers is whether resending can duplicate something the caller already saw. An upstream that
 * completed a turn we never relayed has committed nothing downstream; an upstream that emitted
 * one token has.
 *
 * The roster lives here rather than beside the resend tables for the reason stated at the top of
 * this file: the dashboard renders a label per member, and reaching the table module for the
 * names would drag its import graph into the browser project. `src/lib/request-failure-model.ts`
 * re-exports it, so every existing importer keeps its path and there is still exactly one
 * declaration.
 */
export const REQUEST_FAILURE_STAGES = Object.freeze([
  /** No response head exists. Whether the origin began the turn is not known from the stage alone. */
  "pre-header",
  /** A status line and headers exist, and no protocol body event has been parsed yet. */
  "headers-only",
  /** The protocol body began with control events only -- `response.created`, quota frames. */
  "protocol-prelude",
  /** At least one output-bearing event reached the caller. */
  "semantic-output",
  /** A tool call or other externally visible effect was emitted. */
  "side-effect",
  /** A terminal event settled the turn after its answer reached the caller. */
  "terminal",
] as const);

export type RequestFailureStage = typeof REQUEST_FAILURE_STAGES[number];

/**
 * Why the request failed, as one closed dictionary for every layer.
 *
 * Bounded on purpose: these are wire values a maintainer reads and a metric labels by, never a
 * credential, an account identifier, an upstream body or prompt content. That bound is what lets
 * the value be a Prometheus label and a grouping key without a masking pass -- a closed roster
 * has nothing to mask.
 */
export const REQUEST_FAILURE_CAUSES = Object.freeze([
  /** The bytes provably never reached the origin: connect refused, DNS failure, TLS handshake. */
  "transport-unsent",
  /** The bytes left and the connection died before a head. The origin may be running the turn. */
  "transport-ambiguous",
  /** The origin answered that it would not start the turn now: 503, overloaded, backpressure. */
  "upstream-declined",
  /** A 429 rate limit. Capacity is momentarily gone; waiting is the remedy. */
  "rate-limit",
  /** Plan or credit quota is gone. Waiting out a retry window does not help; the account must change. */
  "quota-exhausted",
  /** Credentials were rejected: 401, 403 on identity. */
  "credential-rejected",
  /** The origin evaluated the content and refused it. Identical bytes get the identical refusal. */
  "policy-refusal",
  /**
   * The origin rejected a request PARAMETER rather than the content: an unsupported reasoning
   * effort, an unknown field. Distinct from `policy-refusal` because the remedy is opposite --
   * the same content succeeds once the parameter is adjusted.
   */
  "parameter-rejected",
  /** Opaque replay state was rejected as unverifiable. Only a request without it can succeed. */
  "ciphertext-refusal",
  /**
   * The payload exceeded a size the origin accepts. A smaller rebuild of the same turn can
   * succeed, which is why this is not the same answer as `payload-rejected`.
   */
  "payload-too-large",
  /** The payload was rejected on its merits: unsupported media, malformed part. No repair helps. */
  "payload-rejected",
  /**
   * The origin returned a server-side fault. Whether it had already begun the turn is not
   * knowable from the status, so this is the honest classification for the mixed 5xx set the
   * transient layer retries: 503 really did decline, 500 may not have.
   */
  "upstream-fault",
  /** The turn settled carrying no usable output. */
  "empty-output",
  /** The caller went away. */
  "client-cancelled",
  /** This proxy refused before dispatch: send budget, route policy, replay refusal. */
  "local-refusal",
] as const);

export type RequestFailureCause = typeof REQUEST_FAILURE_CAUSES[number];

/**
 * Whether this proxy may send the request again. Derived at READ time from the stage and the
 * cause and never persisted, so a stored row cannot carry a verdict that the current table
 * would no longer reach.
 *
 * Every refusal names WHY it refused, because the three reasons need different operator
 * responses and used to arrive as one undifferentiated "no retry".
 */
export const RESEND_PERMISSIONS = Object.freeze([
  /** The same request may be sent again. */
  "permitted",
  /** Only a modified request may be sent: rotated credential, stripped ciphertext. */
  "permitted-after-repair",
  /** Upstream execution state is unknown. No AUTOMATIC resend. */
  "refused-ambiguous",
  /** The caller already observed output or an externally visible effect. */
  "refused-committed",
  /** Identical bytes would get the identical answer. */
  "refused-futile",
] as const);

export type ResendPermission = typeof RESEND_PERMISSIONS[number];

/**
 * Where a terminal or failure was observed on the wire.
 *
 * Declared here because three modules read it as a closed set -- the durable row's validator,
 * the failure attribution and the failure fingerprint -- and a fourth restatement in a test is
 * how a member added later leaves an "exhaustive" cross product green without exercising it.
 */
export const REQUEST_TRANSPORT_PHASES = Object.freeze([
  "pre_headers",
  "mid_stream",
  "terminal_sse",
] as const);

export type RequestTransportPhase = typeof REQUEST_TRANSPORT_PHASES[number];

/**
 * What an attempt actually delivered, as five bounded counts (#3983).
 *
 * #3983 wanted these signals and emitted one debug line per event to get them. That is a second
 * durable record: `emitDebugLine` writes the in-process ring AND stderr, and stderr is redirected
 * to the service log under both launchd and systemd, so an installed service ends up with a
 * per-event history beside the ledger, carrying its own retention, sequencing and identity. It
 * also fingerprinted each payload under a process-global random key, which makes every repeated
 * prompt fragment, tool name and error message correlatable for the process lifetime.
 *
 * Counts answer the same questions -- a missing terminal, adapter-to-client loss, empty output,
 * partial output size -- and cannot carry content at all. They ride the attempt, so they inherit
 * the ledger's normalization, masking and retention rather than acquiring their own.
 *
 * Counted where the event is DELIVERED, not where it is read. An adapter event the client never
 * received is exactly the discrepancy worth seeing, and counting both ends at the reader would
 * make the two numbers equal by construction.
 */
export interface AttemptDeliverySummary {
  /** Events this attempt's adapter produced. */
  adapterEvents: number;
  /** Frames that reached the client transport, after a successful enqueue. */
  relayedEvents: number;
  /** UTF-8 bytes of output-bearing delta actually relayed. Never the content itself. */
  semanticBytes: number;
  /** Externally visible effects relayed: a tool call or a search call starting. */
  sideEffectEvents: number;
  /** Terminal frames relayed. Zero on a delivered stream is the missing-terminal signal. */
  terminalEvents: number;
}

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
