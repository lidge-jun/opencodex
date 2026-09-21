/**
 * Failures grouped by what they have in common, rebuilt from the canonical ledger.
 *
 * This is the derived form of #3748. The original built a second durable store; this holds only
 * a count and two timestamps per group, and every one of them falls out of a scan of
 * usage.jsonl. Delete a row from the ledger and it leaves this projection on the next rebuild,
 * which is what it means for retention to have one owner rather than four.
 *
 * What it deliberately does NOT hold: the occurrence list the original retained (a second copy
 * of history with its own retention policy), and the mutable monitoring/dispatched/fixed/ignored
 * remediation status with its free-text notes. Those are operator state, not event history: they
 * cannot be reconstructed from immutable request rows, so presenting them as a derived ledger
 * would be presenting a claim this projection cannot make. They need their own owner if they are
 * wanted, keyed by the fingerprint below.
 */
import { getProviderRegistryEntry } from "../providers/registry";
import { baseProviderLabel } from "../providers/label";
import {
  computeFailureFingerprint,
  failureStatusClass,
  FAILURE_FINGERPRINT_VERSION,
  type FailureFingerprint,
  type FailureFingerprintFacts,
} from "./failure-fingerprint";
import {
  classifyRequestOutcome,
  isRequestCloseReason,
  isRequestTerminalStatus,
} from "./request-outcome";
import {
  isKnownInboundProtocol,
  isKnownRequestFailureCause,
  isKnownTerminalSource,
  isKnownTransportPhase,
  type PersistedUsageEntry,
} from "./log";

/**
 * The configured provider name reduced to a registry member, or null.
 *
 * The durable `provider` is whatever the user named their provider entry, so it is open text and
 * cannot enter a key that promises to carry no content. Resolving it against the registry makes
 * the value closed by construction: either it is one of the ids this build ships, or it is
 * nothing. A user who names a provider after themselves groups under `null`, which is the
 * correct answer -- the projection does not know which provider it is.
 */
export function failureProviderClass(provider: string): string | null {
  return getProviderRegistryEntry(baseProviderLabel(provider))?.id ?? null;
}

export interface FailureProjectionGroup extends FailureFingerprintFacts {
  fingerprint: FailureFingerprint;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

export interface FailureProjectionSnapshot {
  fingerprintVersion: typeof FAILURE_FINGERPRINT_VERSION;
  groups: readonly FailureProjectionGroup[];
  /**
   * Failed rows written before the recorder stored a cause. Counted rather than bucketed under
   * an invented "unknown" cause, because a group an operator cannot act on is worse than a
   * number that says how much history predates the field.
   */
  unattributedFailures: number;
  /** Failed rows whose timestamp is not a finite number, so they cannot date a group. */
  invalidTimestampFailures: number;
}

export interface FailureProjectionAccumulator {
  add(entry: PersistedUsageEntry): void;
  clone(): FailureProjectionAccumulator;
  snapshot(): FailureProjectionSnapshot;
  readonly groupCount: number;
}

interface MutableGroup extends FailureFingerprintFacts {
  fingerprint: FailureFingerprint;
  firstSeen: number;
  lastSeen: number;
  count: number;
}

function factsFor(entry: PersistedUsageEntry): FailureFingerprintFacts | null {
  if (!isKnownRequestFailureCause(entry.failureCause)) return null;
  return {
    cause: entry.failureCause,
    statusClass: failureStatusClass(entry.status),
    providerClass: failureProviderClass(entry.provider),
    inboundProtocol: isKnownInboundProtocol(entry.inboundProtocol) ? entry.inboundProtocol : null,
    // Validated rather than copied. This is the one tuple slot whose durable type is a plain
    // string, and it is assembled from an upstream terminal frame, so an unvalidated value is
    // the single way upstream-controlled text could reach a grouping key.
    terminalStatus: isRequestTerminalStatus(entry.terminalStatus) ? entry.terminalStatus : null,
    closeReason: isRequestCloseReason(entry.closeReason) ? entry.closeReason : null,
    transportPhase: isKnownTransportPhase(entry.transportPhase) ? entry.transportPhase : null,
    terminalSource: isKnownTerminalSource(entry.terminalSource) ? entry.terminalSource : null,
  };
}

function createFrom(groups: Map<string, MutableGroup>, counters: {
  unattributed: number;
  invalidTimestamp: number;
}): FailureProjectionAccumulator {
  let unattributedFailures = counters.unattributed;
  let invalidTimestampFailures = counters.invalidTimestamp;

  return {
    add(entry: PersistedUsageEntry): void {
      // The shared classifier decides what a failure is, so this projection and the exporter
      // agree on which rows are in scope. An incomplete turn is not here: it has no cause.
      if (classifyRequestOutcome(entry) !== "failed") return;
      const facts = factsFor(entry);
      if (facts === null) {
        unattributedFailures += 1;
        return;
      }
      if (typeof entry.timestamp !== "number" || !Number.isFinite(entry.timestamp)) {
        invalidTimestampFailures += 1;
        return;
      }
      const fingerprint = computeFailureFingerprint(facts);
      const existing = groups.get(fingerprint);
      if (existing === undefined) {
        groups.set(fingerprint, {
          ...facts,
          fingerprint,
          firstSeen: entry.timestamp,
          lastSeen: entry.timestamp,
          count: 1,
        });
        return;
      }
      // Min and max rather than first-and-last-written: a ledger is append-ordered in practice
      // but nothing in the format promises it, and a projection that assumed order would report
      // a first-seen later than its last-seen for a hand-merged file.
      existing.firstSeen = Math.min(existing.firstSeen, entry.timestamp);
      existing.lastSeen = Math.max(existing.lastSeen, entry.timestamp);
      existing.count += 1;
    },

    clone(): FailureProjectionAccumulator {
      const copy = new Map<string, MutableGroup>();
      for (const [key, group] of groups) copy.set(key, { ...group });
      return createFrom(copy, {
        unattributed: unattributedFailures,
        invalidTimestamp: invalidTimestampFailures,
      });
    },

    snapshot(): FailureProjectionSnapshot {
      // Most recent first, then by fingerprint, so two runs over the same ledger produce the
      // same order. A tie broken by insertion order would depend on scan chunking.
      const ordered = [...groups.values()]
        .map(group => ({ ...group }))
        .sort((a, b) => b.lastSeen - a.lastSeen || (a.fingerprint < b.fingerprint ? -1 : a.fingerprint > b.fingerprint ? 1 : 0));
      return {
        fingerprintVersion: FAILURE_FINGERPRINT_VERSION,
        groups: ordered,
        unattributedFailures,
        invalidTimestampFailures,
      };
    },

    get groupCount(): number {
      return groups.size;
    },
  };
}

export function createFailureProjectionAccumulator(): FailureProjectionAccumulator {
  return createFrom(new Map(), { unattributed: 0, invalidTimestamp: 0 });
}
