import type { ClaimSnapshotEvent, LabEvent, ObservationEvent } from "../events/types";
import type { InvalidationIndex } from "./invalidation";

/** Collect artifacts that the frozen CL-00 retention rules still require. */
export function collectReferencedArtifactDigests(
  events: LabEvent[],
  index: InvalidationIndex,
  opts: { excludeEventIds?: Set<string> } = {},
): Set<string> {
  const refs = new Set<string>();
  const exclude = opts.excludeEventIds ?? new Set<string>();

  for (const event of events) {
    if (exclude.has(event.eventId)) continue;
    if (index.purgedEventIds.has(event.eventId)) continue;

    if (event.eventKind === "observation") {
      // CL-00 releases observation artifacts after invalidation or purge.
      if (index.invalidatedBy.has(event.eventId)) continue;
      addObservationArtifacts(event, refs);
      continue;
    }
    if (event.eventKind === "claim_snapshot") {
      // CL-00 retains claim source manifests while any non-purged claim references them.
      refs.add(event.sourceManifestDigest);
    }
  }
  return refs;
}

function addObservationArtifacts(obs: ObservationEvent, refs: Set<string>): void {
  refs.add(obs.scenarioManifestDigest);
  refs.add(obs.suiteManifestDigest);
  for (const digest of obs.fixtureDigests) refs.add(digest);
  for (const ref of obs.artifactRefs) refs.add(ref.digest);
}

export function eventReferencesArtifactDigest(event: LabEvent, digest: string): boolean {
  if (event.eventKind === "observation") {
    if (event.scenarioManifestDigest === digest) return true;
    if (event.suiteManifestDigest === digest) return true;
    if (event.fixtureDigests.includes(digest)) return true;
    return event.artifactRefs.some((ref) => ref.digest === digest);
  }
  if (event.eventKind === "claim_snapshot") {
    return event.sourceManifestDigest === digest;
  }
  return false;
}

/**
 * Expand purge targets so explicitly sensitive artifact digests cannot survive
 * while any retained ledger evidence line still references them.
 */
export function expandSensitiveArtifactEventTargets(
  events: LabEvent[],
  index: InvalidationIndex,
  targetEventIds: Set<string>,
  explicitArtifactDigests: Set<string>,
): Set<string> {
  const expanded = new Set(targetEventIds);
  if (explicitArtifactDigests.size === 0) return expanded;

  for (const event of events) {
    if (expanded.has(event.eventId)) continue;
    if (index.purgedEventIds.has(event.eventId)) continue;
    for (const digest of explicitArtifactDigests) {
      if (eventReferencesArtifactDigest(event, digest)) {
        expanded.add(event.eventId);
        break;
      }
    }
  }
  return expanded;
}

/** Artifacts still required by surviving evidence after excluding purge targets. */
export function artifactsStillRequired(
  events: LabEvent[],
  index: InvalidationIndex,
  excludeEventIds: Set<string>,
): Set<string> {
  return collectReferencedArtifactDigests(events, index, { excludeEventIds });
}

export interface ArtifactDeletionPlan {
  deletable: string[];
  /** Explicitly sensitive digests that remain pinned by surviving evidence. */
  retainedExplicit: string[];
}

/** Plan physical artifact deletion for a purge without silently retaining explicit targets. */
export function artifactDeletionPlan(
  events: LabEvent[],
  index: InvalidationIndex,
  targetEventIds: Set<string>,
  explicitArtifactDigests: string[],
): ArtifactDeletionPlan {
  const stillRequired = artifactsStillRequired(events, index, targetEventIds);
  const candidates = new Set<string>(explicitArtifactDigests);

  for (const event of events) {
    if (!targetEventIds.has(event.eventId)) continue;
    if (event.eventKind === "observation") {
      const scratch = new Set<string>();
      addObservationArtifacts(event, scratch);
      for (const digest of scratch) candidates.add(digest);
    } else if (event.eventKind === "claim_snapshot") {
      candidates.add(event.sourceManifestDigest);
    }
  }

  return {
    deletable: [...candidates].filter((digest) => !stillRequired.has(digest)).sort(),
    retainedExplicit: explicitArtifactDigests.filter((digest) => stillRequired.has(digest)).sort(),
  };
}

export function observationArtifactDigests(obs: ObservationEvent): string[] {
  const out = new Set<string>();
  addObservationArtifacts(obs, out);
  return [...out].sort();
}

export function claimArtifactDigests(claim: ClaimSnapshotEvent): string[] {
  return [claim.sourceManifestDigest];
}
