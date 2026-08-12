import type {
  ClaimSnapshotEvent,
  InvalidationEvent,
  LabEvent,
  LedgerCorruption,
  ObservationEvent,
  PurgeTombstoneEvent,
} from "../events/types";
import { LabValidationError } from "../events/validate";

export interface InvalidationIndex {
  /** eventId -> invalidation eventIds that targeted it */
  invalidatedBy: Map<string, string[]>;
  purgedEventIds: Set<string>;
  purgedArtifactDigests: Set<string>;
  corruptions: LedgerCorruption[];
}

type EventPosition = { kind: LabEvent["eventKind"]; index: number };

/**
 * Apply purge tombstones before ordinary invalidations.
 * Invalidation target lists are atomic: any bad target rejects the whole event.
 */
export function buildInvalidationIndex(events: LabEvent[]): InvalidationIndex {
  const purgedEventIds = new Set<string>();
  const purgedArtifactDigests = new Set<string>();
  const invalidatedBy = new Map<string, string[]>();
  const corruptions: LedgerCorruption[] = [];

  const validEvidenceIds = new Map<string, { kind: "observation" | "claim_snapshot"; index: number }>();
  const allEventIds = new Map<string, EventPosition>();

  // First pass: record event positions and evidence positions; apply purges as encountered.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    allEventIds.set(event.eventId, { kind: event.eventKind, index: i });
    if (event.eventKind === "observation" || event.eventKind === "claim_snapshot") {
      validEvidenceIds.set(event.eventId, { kind: event.eventKind, index: i });
      continue;
    }
    if (event.eventKind === "purge_tombstone") {
      applyPurge(event, purgedEventIds, purgedArtifactDigests);
    }
  }

  // Second pass: validate and apply invalidations against earlier evidence.
  for (let i = 0; i < events.length; i++) {
    const event = events[i]!;
    if (event.eventKind !== "invalidation") continue;
    try {
      validateInvalidationTargets(event, i, validEvidenceIds, allEventIds);
      for (const target of event.targetEventIds) {
        const list = invalidatedBy.get(target) ?? [];
        list.push(event.eventId);
        invalidatedBy.set(target, list);
      }
    } catch (err) {
      corruptions.push({
        kind: "invalid_reference",
        eventId: event.eventId,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { invalidatedBy, purgedEventIds, purgedArtifactDigests, corruptions };
}

function applyPurge(
  event: PurgeTombstoneEvent,
  purgedEventIds: Set<string>,
  purgedArtifactDigests: Set<string>,
): void {
  for (const id of event.targetEventIds) purgedEventIds.add(id);
  for (const digest of event.targetArtifactDigests) purgedArtifactDigests.add(digest);
}

function validateInvalidationTargets(
  event: InvalidationEvent,
  index: number,
  validEvidenceIds: Map<string, { kind: "observation" | "claim_snapshot"; index: number }>,
  allEventIds: Map<string, EventPosition>,
): void {
  for (const target of event.targetEventIds) {
    if (target === event.eventId) {
      throw new LabValidationError("self_target", "invalidation cannot target itself");
    }
    const meta = validEvidenceIds.get(target);
    if (!meta) {
      const other = allEventIds.get(target);
      if (
        other &&
        other.index < index &&
        (other.kind === "invalidation" || other.kind === "purge_tombstone")
      ) {
        throw new LabValidationError("bad_target_kind", `cannot invalidate ${other.kind}`);
      }
      throw new LabValidationError("unknown_target", `unknown target ${target}`);
    }
    if (meta.index >= index) {
      throw new LabValidationError("future_target", `target ${target} is not earlier`);
    }
    // Purged targets may no longer have a ledger line. A previously valid evidence
    // ID remains addressable because validEvidenceIds records its original position.
  }
}

export function isEventExcluded(
  eventId: string,
  index: InvalidationIndex,
): boolean {
  if (index.purgedEventIds.has(eventId)) return true;
  if (index.invalidatedBy.has(eventId)) return true;
  return false;
}

export function usableObservations(
  events: LabEvent[],
  index: InvalidationIndex,
): ObservationEvent[] {
  return events.filter(
    (e): e is ObservationEvent =>
      e.eventKind === "observation" && !isEventExcluded(e.eventId, index),
  );
}

export function usableClaims(
  events: LabEvent[],
  index: InvalidationIndex,
): ClaimSnapshotEvent[] {
  return events.filter(
    (e): e is ClaimSnapshotEvent =>
      e.eventKind === "claim_snapshot" && !isEventExcluded(e.eventId, index),
  );
}
