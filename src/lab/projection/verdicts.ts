import type { CompatibilityVerdict } from "../constants";
import { LAB_PROJECTION_SPEC_VERSION } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";
import { jcsStringify } from "../digest";
import type {
  ClaimSnapshotEvent,
  LabEvent,
  LedgerCorruption,
  ObservationEvent,
} from "../events/types";
import {
  buildInvalidationIndex,
  isEventExcluded,
  usableClaims,
  usableObservations,
  type InvalidationIndex,
} from "../ledger/invalidation";
import {
  evaluateAllApplicableRequiredPassV1,
  newestObservationByScenario,
  type ScenarioRequirements,
} from "./verification";

export interface ProjectionKey {
  subjectId: string;
  evidenceLayer: string;
  suiteId: string;
  suiteVersion: string;
  suiteManifestDigest: string;
  projectionSpecVersion: string;
}

function componentKey(parts: readonly string[]): string {
  return jcsStringify([...parts]);
}

export function projectionKeyString(key: ProjectionKey): string {
  return componentKey([
    key.subjectId,
    key.evidenceLayer,
    key.suiteId,
    key.suiteVersion,
    key.suiteManifestDigest,
    key.projectionSpecVersion,
  ]);
}

export function claimKeyString(subjectId: string, capability: string): string {
  return componentKey([subjectId, capability]);
}

export interface DerivedVerdict {
  key: ProjectionKey;
  verdict: CompatibilityVerdict;
  asOf: number;
  scenarioManifestDigests: string[];
  claimSourceDigest?: string;
  contributingEventIds: string[];
  contradictingEventIds: string[];
  notes: string[];
}

export interface ClaimState {
  key: string;
  current: ClaimSnapshotEvent | null;
  corruption?: string;
  unusable?: boolean;
}

export interface ProjectVerdictsOptions {
  asOf?: number;
  index?: InvalidationIndex;
  unusableObservationIds?: Set<string>;
  unusableClaimEventIds?: Set<string>;
  loadSuiteManifest?: (digest: string) => SuiteManifestV1 | null;
  loadScenarioManifest?: (digest: string) => Record<string, unknown> | null;
  loadScenarioRequirements?: (digest: string) => ScenarioRequirements | null;
}

/**
 * Resolve current claims after purge/invalidation and supersession.
 * Multiple unsuperseded claims, missing predecessors, cross-key supersession, or cycles → UNKNOWN + corruption.
 */
export function resolveClaimStates(
  claims: ClaimSnapshotEvent[],
  opts: {
    unusableClaimEventIds?: Set<string>;
    purgedEventIds?: ReadonlySet<string>;
  } = {},
): {
  states: Map<string, ClaimState>;
  corruptions: LedgerCorruption[];
} {
  const unusableClaims = opts.unusableClaimEventIds ?? new Set<string>();
  const purgedEventIds = opts.purgedEventIds ?? new Set<string>();
  const byKey = new Map<string, ClaimSnapshotEvent[]>();
  const allById = new Map(claims.map((claim) => [claim.eventId, claim]));
  for (const claim of claims) {
    const key = claimKeyString(claim.subjectId, claim.capability);
    const list = byKey.get(key) ?? [];
    list.push(claim);
    byKey.set(key, list);
  }

  const states = new Map<string, ClaimState>();
  const corruptions: LedgerCorruption[] = [];

  for (const [key, list] of byKey) {
    const sorted = [...list].sort((a, b) => {
      if (a.effectiveAt !== b.effectiveAt) return a.effectiveAt - b.effectiveAt;
      if (a.recordedAt !== b.recordedAt) return a.recordedAt - b.recordedAt;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });

    const superseded = new Set<string>();

    for (const claim of sorted) {
      for (const pred of claim.supersedes) {
        const prev = allById.get(pred);
        if (!prev) {
          if (purgedEventIds.has(pred)) {
            // A purge may physically remove a superseded predecessor. The ID remains
            // valid provenance but is not a live claim candidate.
            continue;
          }
          corruptions.push({
            kind: "claim_corruption",
            eventId: claim.eventId,
            detail: `missing supersedes predecessor ${pred}`,
          });
          states.set(key, { key, current: null, corruption: "missing predecessor" });
          continue;
        }
        if (prev.subjectId !== claim.subjectId || prev.capability !== claim.capability) {
          corruptions.push({
            kind: "claim_corruption",
            eventId: claim.eventId,
            detail: "cross-key supersession",
          });
          states.set(key, { key, current: null, corruption: "cross-key supersession" });
          continue;
        }
        superseded.add(pred);
      }
    }

    if (states.get(key)?.corruption) continue;

    const current = sorted.filter((c) => !superseded.has(c.eventId));
    if (current.length > 1) {
      corruptions.push({
        kind: "claim_corruption",
        detail: `multiple unsuperseded claims for ${key}`,
      });
      states.set(key, { key, current: null, corruption: "conflicting current claims" });
      continue;
    }
    const currentClaim = current[0] ?? null;
    states.set(key, {
      key,
      current: currentClaim,
      unusable: currentClaim ? unusableClaims.has(currentClaim.eventId) : undefined,
    });
  }

  return { states, corruptions };
}

function supportedClaimsForSubject(claimStates: Map<string, ClaimState>, subjectId: string): string[] {
  const supported = new Set<string>();
  for (const state of claimStates.values()) {
    const claim = state.current;
    if (!claim || state.corruption || state.unusable) continue;
    if (claim.subjectId === subjectId && claim.polarity === "supported") supported.add(claim.capability);
  }
  return [...supported].sort();
}

/**
 * CL-02 verdict projection primitives with frozen CL-00 verification semantics.
 */
export function projectVerdicts(
  events: LabEvent[],
  opts: ProjectVerdictsOptions = {},
): { verdicts: DerivedVerdict[]; corruptions: LedgerCorruption[]; index: InvalidationIndex } {
  const index = opts.index ?? buildInvalidationIndex(events);
  const corruptions = [...index.corruptions];
  const unusableObs = opts.unusableObservationIds ?? new Set<string>();
  const unusableClaims = opts.unusableClaimEventIds ?? new Set<string>();
  const asOf =
    opts.asOf ??
    events.reduce((max, event) => {
      if (event.eventKind === "observation") return Math.max(max, event.completedAt, event.recordedAt);
      if (event.eventKind === "claim_snapshot") return Math.max(max, event.effectiveAt, event.recordedAt);
      return Math.max(max, event.recordedAt);
    }, 0);

  const observations = usableObservations(events, index)
    .filter((o) => o.completedAt <= asOf)
    .filter((o) => !unusableObs.has(o.eventId));
  const claims = usableClaims(events, index).filter((c) => c.effectiveAt <= asOf);
  const { states: claimStates, corruptions: claimCorruptions } = resolveClaimStates(claims, {
    unusableClaimEventIds: unusableClaims,
    purgedEventIds: index.purgedEventIds,
  });
  corruptions.push(...claimCorruptions);

  const groups = new Map<string, ObservationEvent[]>();
  for (const obs of observations) {
    const key: ProjectionKey = {
      subjectId: obs.subjectId,
      evidenceLayer: obs.evidenceLayer,
      suiteId: obs.suiteId,
      suiteVersion: obs.suiteVersion,
      suiteManifestDigest: obs.suiteManifestDigest,
      projectionSpecVersion: LAB_PROJECTION_SPEC_VERSION,
    };
    const ks = projectionKeyString(key);
    const list = groups.get(ks) ?? [];
    list.push(obs);
    groups.set(ks, list);
  }

  const verdicts: DerivedVerdict[] = [];

  for (const [, list] of groups) {
    const sample = list[0]!;
    const key: ProjectionKey = {
      subjectId: sample.subjectId,
      evidenceLayer: sample.evidenceLayer,
      suiteId: sample.suiteId,
      suiteVersion: sample.suiteVersion,
      suiteManifestDigest: sample.suiteManifestDigest,
      projectionSpecVersion: LAB_PROJECTION_SPEC_VERSION,
    };
    const ordered = [...list].sort((a, b) => {
      if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
      return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
    });
    const suiteManifest = opts.loadSuiteManifest?.(key.suiteManifestDigest) ?? null;
    verdicts.push(
      projectObservationGroup(key, ordered, asOf, suiteManifest, {
        loadScenarioManifest: opts.loadScenarioManifest,
        loadScenarioRequirements: opts.loadScenarioRequirements,
        routeSupportedClaims: key.evidenceLayer === "live_route_compatibility"
          ? supportedClaimsForSubject(claimStates, key.subjectId)
          : undefined,
      }),
    );
  }

  for (const [, state] of claimStates) {
    if (!state.current || state.current.polarity !== "supported") continue;
    if (state.corruption) continue;
    const claim = state.current;
    const key: ProjectionKey = {
      subjectId: claim.subjectId,
      evidenceLayer: "live_route_compatibility",
      suiteId: "_claims",
      suiteVersion: "1",
      suiteManifestDigest: claim.sourceManifestDigest,
      projectionSpecVersion: LAB_PROJECTION_SPEC_VERSION,
    };
    const ks = projectionKeyString(key);
    if (verdicts.some((v) => projectionKeyString(v.key) === ks)) continue;
    if (state.unusable) {
      verdicts.push({
        key,
        verdict: "UNKNOWN",
        asOf,
        scenarioManifestDigests: [],
        claimSourceDigest: claim.sourceManifestDigest,
        contributingEventIds: [claim.eventId],
        contradictingEventIds: [],
        notes: ["current_claim_unusable"],
      });
      continue;
    }
    verdicts.push({
      key,
      verdict: "CLAIMED",
      asOf,
      scenarioManifestDigests: [],
      claimSourceDigest: claim.sourceManifestDigest,
      contributingEventIds: [claim.eventId],
      contradictingEventIds: [],
      notes: ["claim_snapshot"],
    });
  }

  return { verdicts, corruptions, index };
}

function isMatchedCapabilityAbsenceControl(obs: ObservationEvent): boolean {
  const expected = obs.expectedFailure;
  return (
    obs.outcome === "pass" &&
    !!expected &&
    expected.controlKind === "capability_absence_control" &&
    expected.onMatch === "unsupported"
  );
}

function evaluateRequiredPassVerdict(input: {
  suiteManifest: SuiteManifestV1 | null;
  ordered: ObservationEvent[];
  executionMode: ObservationEvent["executionMode"];
  subject?: ObservationEvent["subject"];
  routeSupportedClaims?: readonly string[];
  fabricCapability?: {
    harnessFeatures: readonly string[];
    platforms: readonly string[];
    routePreconditions: readonly string[];
  };
  loadScenarioManifest?: (digest: string) => Record<string, unknown> | null;
  loadScenarioRequirements?: ProjectVerdictsOptions["loadScenarioRequirements"];
  asOf: number;
}): { verdict: CompatibilityVerdict; notes: string[] } {
  const notes: string[] = [];
  if (!input.suiteManifest) {
    return { verdict: "PROBED", notes: ["suite_manifest_unavailable"] };
  }
  const evaluation = evaluateAllApplicableRequiredPassV1(
    input.suiteManifest,
    input.ordered,
    input.executionMode,
    {
      subject: input.subject,
      routeSupportedClaims: input.routeSupportedClaims,
      fabricCapability: input.fabricCapability,
      loadScenarioManifest: input.loadScenarioManifest,
      loadScenarioRequirements: input.loadScenarioRequirements,
      asOf: input.asOf,
    },
  );
  notes.push(...evaluation.notes);
  if (evaluation.applicableRequiredScenarioIds.length === 0) {
    return { verdict: "UNKNOWN", notes };
  }
  if (evaluation.canVerify) {
    notes.push("all-applicable-required-pass-v1");
    return { verdict: "VERIFIED", notes };
  }
  notes.push("incomplete_required_coverage");
  return { verdict: "PROBED", notes };
}

function projectObservationGroup(
  key: ProjectionKey,
  ordered: ObservationEvent[],
  asOf: number,
  suiteManifest: SuiteManifestV1 | null,
  opts: {
    loadScenarioManifest?: (digest: string) => Record<string, unknown> | null;
    loadScenarioRequirements?: ProjectVerdictsOptions["loadScenarioRequirements"];
    routeSupportedClaims?: readonly string[];
    fabricCapability?: {
      harnessFeatures: readonly string[];
      platforms: readonly string[];
      routePreconditions: readonly string[];
    };
  } = {},
): DerivedVerdict {
  const contributing: string[] = [];
  const contradicting: string[] = [];
  const digests = new Set<string>();
  const notes: string[] = [];

  for (const obs of ordered) {
    digests.add(obs.scenarioManifestDigest);
    contributing.push(obs.eventId);
    if (obs.outcome === "fail") contradicting.push(obs.eventId);
  }

  const newest = newestObservationByScenario(ordered);
  const currentObservations = [...newest.values()];
  const currentFails = currentObservations.filter((o) => o.outcome === "fail");
  const currentPasses = currentObservations.filter((o) => o.outcome === "pass");
  const currentBlocked = currentObservations.some((o) => o.outcome === "blocked");
  const currentInconclusive = currentObservations.some((o) => o.outcome === "inconclusive");
  const matchedCapabilityAbsence = currentObservations.some(isMatchedCapabilityAbsenceControl);
  const currentModes = new Set(currentObservations.map((o) => o.executionMode));
  const newestCurrent = [...currentObservations].sort((a, b) => {
    if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  }).at(-1);

  let verdict: CompatibilityVerdict = "UNKNOWN";
  if (
    key.evidenceLayer !== "protocol_conformance" &&
    key.evidenceLayer !== "live_route_compatibility" &&
    key.evidenceLayer !== "task_effectiveness"
  ) {
    verdict = "UNKNOWN";
  } else if (matchedCapabilityAbsence) {
    verdict = "UNSUPPORTED";
    notes.push("capability_absence_control");
  } else if (currentFails.length > 0) {
    verdict = "DEGRADED";
  } else if (currentPasses.length > 0 && !currentInconclusive && !currentBlocked) {
    if (currentModes.size > 1) {
      verdict = "PROBED";
      notes.push("mixed_execution_modes");
    } else if (key.evidenceLayer === "protocol_conformance" && newestCurrent?.executionMode === "fixture") {
      const evaluated = evaluateRequiredPassVerdict({
        suiteManifest,
        ordered,
        executionMode: newestCurrent.executionMode,
        subject: newestCurrent.subject.subjectKind === "protocol" ? newestCurrent.subject : undefined,
        loadScenarioManifest: opts.loadScenarioManifest,
        loadScenarioRequirements: opts.loadScenarioRequirements,
        asOf,
      });
      verdict = evaluated.verdict;
      notes.push(...evaluated.notes);
    } else if (key.evidenceLayer === "live_route_compatibility" && newestCurrent?.executionMode === "live") {
      const evaluated = evaluateRequiredPassVerdict({
        suiteManifest,
        ordered,
        executionMode: newestCurrent.executionMode,
        subject: newestCurrent.subject.subjectKind === "route" ? newestCurrent.subject : undefined,
        routeSupportedClaims: opts.routeSupportedClaims,
        loadScenarioManifest: opts.loadScenarioManifest,
        loadScenarioRequirements: opts.loadScenarioRequirements,
        asOf,
      });
      verdict = evaluated.verdict;
      notes.push(...evaluated.notes);
    } else if (key.evidenceLayer === "task_effectiveness" && newestCurrent?.executionMode === "fabric") {
      const evaluated = evaluateRequiredPassVerdict({
        suiteManifest,
        ordered,
        executionMode: newestCurrent.executionMode,
        subject: newestCurrent.subject.subjectKind === "task" ? newestCurrent.subject : undefined,
        fabricCapability: opts.fabricCapability ?? {
          harnessFeatures: ["fabric-scratch-v1"],
          platforms: [process.platform, "*"],
          routePreconditions: ["exact-route-subject"],
        },
        loadScenarioManifest: opts.loadScenarioManifest,
        loadScenarioRequirements: opts.loadScenarioRequirements,
        asOf,
      });
      verdict = evaluated.verdict;
      notes.push(...evaluated.notes);
    } else {
      verdict = "PROBED";
    }
  } else if (currentPasses.length > 0) {
    verdict = "PROBED";
  } else if (currentBlocked) {
    verdict = "BLOCKED";
  } else {
    verdict = "UNKNOWN";
  }

  return {
    key,
    verdict,
    asOf,
    scenarioManifestDigests: [...digests].sort(),
    contributingEventIds: contributing,
    contradictingEventIds: contradicting,
    notes,
  };
}

export function excludeEventIds(index: InvalidationIndex): Set<string> {
  const out = new Set<string>([...index.purgedEventIds]);
  for (const id of index.invalidatedBy.keys()) out.add(id);
  return out;
}

export { isEventExcluded };
