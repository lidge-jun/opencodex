/**
 * A versioned, content-free identity for one kind of request failure (#3748).
 *
 * #3748 proposed a second SQLite store under src/telemetry/ holding a free-text `signature`
 * masked by regular expressions. Both halves are replaced here. The store is replaced by a
 * projection rebuilt from usage.jsonl, and the masked signature is replaced by a tuple of closed
 * roster members -- because a regular expression can only assert that it removed what it matched,
 * while a tuple whose every slot is a member of a frozen list has nothing to remove.
 *
 * That is the whole design: the input type cannot express a provider alias, a model, an account,
 * an error message, a prompt, a request id or a timestamp, so no amount of upstream text can
 * reach a fingerprint.
 */
import { createHash } from "node:crypto";
import type { RequestFailureCause } from "../lib/request-failure-model";
import type { RequestCloseReason, RequestTerminalStatus } from "./request-outcome";
import type { PersistedUsageEntry } from "./log";

/**
 * The tuple layout and its meaning are one contract.
 *
 * Adding, removing, reordering or reinterpreting a position changes what a stored fingerprint
 * means, so any of those requires incrementing this. Tests import it rather than writing `1`,
 * so a bump cannot be silently contradicted by a test that still expects the old prefix.
 */
export const FAILURE_FINGERPRINT_VERSION = 1 as const;

/**
 * The status reduced to its class.
 *
 * The exact code is not in the tuple: a 502 and a 503 that both failed for `upstream-fault` are
 * one problem to an operator, and keeping the code would split every group by whichever number
 * an origin happened to send.
 */
export const FAILURE_STATUS_CLASSES = Object.freeze([
  "1xx", "2xx", "3xx", "4xx", "5xx", "unknown",
] as const);

export type FailureStatusClass = typeof FAILURE_STATUS_CLASSES[number];

export type FailureFingerprint = `v${typeof FAILURE_FINGERPRINT_VERSION}:${string}`;

/**
 * Everything a fingerprint is allowed to read, and nothing else.
 *
 * Every slot is either a member of a frozen roster or `null`. `providerClass` is the one field
 * that starts life as free text: the durable `provider` is a name the user chose, so it is
 * resolved against the provider registry first and becomes `null` when it is not a registry
 * member. A configured alias therefore cannot reach the key whatever it was named.
 */
export interface FailureFingerprintFacts {
  readonly cause: RequestFailureCause;
  readonly statusClass: FailureStatusClass;
  readonly providerClass: string | null;
  readonly inboundProtocol: NonNullable<PersistedUsageEntry["inboundProtocol"]> | null;
  readonly terminalStatus: RequestTerminalStatus | null;
  readonly closeReason: RequestCloseReason | null;
  readonly transportPhase: NonNullable<PersistedUsageEntry["transportPhase"]> | null;
  readonly terminalSource: NonNullable<PersistedUsageEntry["terminalSource"]> | null;
}

/**
 * Fixed positions, with every absent fact written as an explicit `null`.
 *
 * Omitting an absent field, or joining the present ones with a delimiter, would let two
 * different failures collide: `[a, null, b]` and `[a, b]` are the same string once the nulls
 * are dropped. A fixed-arity tuple cannot collide that way, which is why the shape is a tuple
 * rather than an object with optional keys.
 */
export type FailureFingerprintTuple = readonly [
  version: typeof FAILURE_FINGERPRINT_VERSION,
  cause: FailureFingerprintFacts["cause"],
  statusClass: FailureFingerprintFacts["statusClass"],
  providerClass: FailureFingerprintFacts["providerClass"],
  inboundProtocol: FailureFingerprintFacts["inboundProtocol"],
  terminalStatus: FailureFingerprintFacts["terminalStatus"],
  closeReason: FailureFingerprintFacts["closeReason"],
  transportPhase: FailureFingerprintFacts["transportPhase"],
  terminalSource: FailureFingerprintFacts["terminalSource"],
];

export function failureStatusClass(status: unknown): FailureStatusClass {
  if (typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599) {
    return "unknown";
  }
  const index = Math.floor(status / 100) - 1;
  return FAILURE_STATUS_CLASSES[index] ?? "unknown";
}

export function canonicalFailureFingerprintTuple(
  facts: FailureFingerprintFacts,
): FailureFingerprintTuple {
  return [
    FAILURE_FINGERPRINT_VERSION,
    facts.cause,
    facts.statusClass,
    facts.providerClass,
    facts.inboundProtocol,
    facts.terminalStatus,
    facts.closeReason,
    facts.transportPhase,
    facts.terminalSource,
  ];
}

/**
 * The version travels in the value, not only in the hashed input.
 *
 * Both matter and for different reasons: hashing it means two versions of the same failure never
 * collide, and prefixing it means a reader holding an old fingerprint can tell that it is old
 * instead of concluding the failure stopped happening.
 */
export function computeFailureFingerprint(facts: FailureFingerprintFacts): FailureFingerprint {
  const digest = createHash("sha256")
    .update(JSON.stringify(canonicalFailureFingerprintTuple(facts)))
    .digest("hex");
  return `v${FAILURE_FINGERPRINT_VERSION}:${digest}`;
}
