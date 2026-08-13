import type { ObservationEvent, ProtocolSubjectV1, RouteSubjectV1, TaskSubjectV1 } from "../events/types";
import { EVIDENCE_LAYERS, type ExecutionMode } from "../constants";
import type { SuiteManifestV1 } from "../conformance/suite-manifest";
import type { VerificationRole } from "../conformance/types";
import { isSha256Hex } from "../digest";

export interface VerificationEvaluation {
  applicableRequiredScenarioIds: string[];
  passingRequiredScenarioIds: string[];
  missingRequiredScenarioIds: string[];
  canVerify: boolean;
  notes: string[];
}

export type LoadScenarioManifest = (digest: string) => Record<string, unknown> | null;

export interface ScenarioRequirements {
  inboundProtocols?: string[];
  upstreamProtocols?: string[];
  surfaces?: string[];
  requiredClaims?: string[];
  requiredHarnessFeatures?: string[];
  platforms?: string[];
  routePreconditions?: string[];
  freshness?: { maxAgeMs: number | null };
}

export type LoadScenarioRequirements = (digest: string) => ScenarioRequirements | null;

/** Live-reserved scenarios are inapplicable in fixture-mode protocol conformance. */
export function isScenarioApplicable(
  scenarioId: string,
  executionMode: ExecutionMode,
  evidenceLayer: string,
): boolean {
  if (evidenceLayer === "protocol_conformance" && executionMode === "fixture") {
    // The frozen CL-00 scenario schema has no explicit execution-mode field.
    // Use an exact dot-delimited `live` segment rather than substring matching.
    if (scenarioId.split(".").includes("live")) return false;
  }
  return true;
}

/** Match protocol subject fields against scenario requirement lists. */
function scenarioApplicableToRequirements(
  requirements: ScenarioRequirements,
  subject: ProtocolSubjectV1,
): boolean {
  const inbound = requirements.inboundProtocols ?? [];
  const upstream = requirements.upstreamProtocols ?? [];
  const surfaces = requirements.surfaces ?? [];
  return (
    inbound.includes(subject.inboundProtocol) &&
    upstream.includes(subject.upstreamProtocol) &&
    surfaces.includes(subject.surface)
  );
}

/** Applicability for live_route_compatibility using exact RouteSubjectV1 plus validated claim state. */
export function routeSubjectApplicableToRequirements(
  requirements: ScenarioRequirements,
  subject: RouteSubjectV1,
  supportedClaims: readonly string[],
): boolean {
  const inbound = requirements.inboundProtocols ?? [];
  const upstream = requirements.upstreamProtocols ?? [];
  const surfaces = requirements.surfaces ?? [];
  const requiredClaims = requirements.requiredClaims ?? [];
  const claimsOk = requiredClaims.every((claim) => supportedClaims.includes(claim));
  return (
    inbound.includes(subject.inboundProtocol) &&
    upstream.includes(subject.upstreamProtocol) &&
    surfaces.includes(subject.surface) &&
    claimsOk
  );
}

/** Task-layer applicability against harness/platform/precondition state. */
export function taskSubjectApplicableToRequirements(
  requirements: ScenarioRequirements,
  capability: {
    harnessFeatures: readonly string[];
    platforms: readonly string[];
    routePreconditions: readonly string[];
  },
): boolean {
  const platforms = requirements.platforms ?? ["*"];
  const features = requirements.requiredHarnessFeatures ?? [];
  const preconditions = requirements.routePreconditions ?? [];
  const platformOk = platforms.includes("*")
    || capability.platforms.includes("*")
    || platforms.some((platform) => capability.platforms.includes(platform));
  const featuresOk = features.every((feature) => capability.harnessFeatures.includes(feature));
  const preconditionsOk = preconditions.every((item) => capability.routePreconditions.includes(item));
  return platformOk && featuresOk && preconditionsOk;
}

/** Return true for non-negative integer values used in freshness parsing. */
function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/** Parse a freshness object from a scenario manifest fragment. */
function parseFreshness(value: unknown): { maxAgeMs: number | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const maxAgeMs = (value as { maxAgeMs?: unknown }).maxAgeMs;
  if (maxAgeMs === null) return { maxAgeMs: null };
  if (!isNonNegativeInteger(maxAgeMs)) return null;
  return { maxAgeMs };
}

/** Parse a string array requirement field from a manifest fragment. */
function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) return null;
  return value;
}

function scenarioContractFromManifest(
  scenarioManifest: Record<string, unknown> | null,
): ScenarioRequirements | null {
  if (!scenarioManifest) return null;
  const req = scenarioManifest.requirements;
  if (!req || typeof req !== "object" || Array.isArray(req)) return null;
  const row = req as Record<string, unknown>;
  const inboundProtocols = parseStringArray(row.inboundProtocols);
  const upstreamProtocols = parseStringArray(row.upstreamProtocols);
  const surfaces = parseStringArray(row.surfaces);
  if (!inboundProtocols || !upstreamProtocols || !surfaces) return null;
  const requiredClaims = row.requiredClaims === undefined ? [] : parseStringArray(row.requiredClaims);
  if (!requiredClaims) return null;
  const requiredHarnessFeatures = row.requiredHarnessFeatures === undefined
    ? []
    : parseStringArray(row.requiredHarnessFeatures);
  if (!requiredHarnessFeatures) return null;
  const platforms = row.platforms === undefined ? ["*"] : parseStringArray(row.platforms);
  if (!platforms) return null;
  const routePreconditions = row.routePreconditions === undefined
    ? []
    : parseStringArray(row.routePreconditions);
  if (!routePreconditions) return null;
  const freshness = parseFreshness(scenarioManifest.freshness);
  if (!freshness) return null;
  return {
    inboundProtocols,
    upstreamProtocols,
    surfaces,
    requiredClaims,
    requiredHarnessFeatures,
    platforms,
    routePreconditions,
    freshness,
  };
}

function effectiveMaxAgeMs(
  suiteMaxAgeMs: number | null,
  scenarioMaxAgeMs: number | null,
): number | null {
  if (suiteMaxAgeMs === null) return scenarioMaxAgeMs;
  if (scenarioMaxAgeMs === null) return suiteMaxAgeMs;
  return Math.min(suiteMaxAgeMs, scenarioMaxAgeMs);
}

export function newestObservationByScenario(
  observations: ObservationEvent[],
): Map<string, ObservationEvent> {
  const byScenario = new Map<string, ObservationEvent>();
  const ordered = [...observations].sort((a, b) => {
    if (a.completedAt !== b.completedAt) return a.completedAt - b.completedAt;
    return a.eventId < b.eventId ? -1 : a.eventId > b.eventId ? 1 : 0;
  });
  for (const obs of ordered) {
    byScenario.set(obs.scenarioId, obs);
  }
  return byScenario;
}

/**
 * Evaluate `all-applicable-required-pass-v1` per frozen CL-00 semantics.
 * Positive VERIFIED requires a non-empty applicable required/control set and a
 * current, fresh pass for every applicable required scenario and negative control.
 */
export function evaluateAllApplicableRequiredPassV1(
  suiteManifest: SuiteManifestV1,
  observations: ObservationEvent[],
  executionMode: ExecutionMode,
  opts: {
    subject?: ProtocolSubjectV1 | RouteSubjectV1 | TaskSubjectV1;
    /** For live projection this must come from validated current claim snapshots for subjectId. */
    routeSupportedClaims?: readonly string[];
    /** Fabric harness/platform/precondition state for task_effectiveness applicability. */
    fabricCapability?: {
      harnessFeatures: readonly string[];
      platforms: readonly string[];
      routePreconditions: readonly string[];
    };
    loadScenarioManifest?: LoadScenarioManifest;
    loadScenarioRequirements?: LoadScenarioRequirements;
    asOf?: number;
  } = {},
): VerificationEvaluation {
  const notes: string[] = [];
  if (suiteManifest.verificationRule !== "all-applicable-required-pass-v1") {
    return {
      applicableRequiredScenarioIds: [],
      passingRequiredScenarioIds: [],
      missingRequiredScenarioIds: [],
      canVerify: false,
      notes: ["unsupported_verification_rule"],
    };
  }
  if (suiteManifest.evidenceLayer === "live_route_compatibility") {
    if (opts.subject?.subjectKind !== "route") {
      return { applicableRequiredScenarioIds: [], passingRequiredScenarioIds: [], missingRequiredScenarioIds: [], canVerify: false, notes: ["route_subject_required"] };
    }
    if (opts.routeSupportedClaims === undefined) {
      return { applicableRequiredScenarioIds: [], passingRequiredScenarioIds: [], missingRequiredScenarioIds: [], canVerify: false, notes: ["route_claim_state_required"] };
    }
  }
  if (suiteManifest.evidenceLayer === "task_effectiveness") {
    if (opts.subject?.subjectKind !== "task") {
      return {
        applicableRequiredScenarioIds: [],
        passingRequiredScenarioIds: [],
        missingRequiredScenarioIds: [],
        canVerify: false,
        notes: ["task_subject_required"],
      };
    }
    if (executionMode !== "fabric") {
      return {
        applicableRequiredScenarioIds: [],
        passingRequiredScenarioIds: [],
        missingRequiredScenarioIds: [],
        canVerify: false,
        notes: ["fabric_execution_mode_required"],
      };
    }
  }

  const requiredScenarios = suiteManifest.scenarios.filter(
    (s) => s.role === "required" || s.role === "negative_control",
  );
  const applicableRequired: string[] = [];
  const unavailableManifests: string[] = [];
  const scenarioMaxAgeById = new Map<string, number | null>();

  for (const s of requiredScenarios) {
    if (!isScenarioApplicable(s.id, executionMode, suiteManifest.evidenceLayer)) continue;

    let requirements: ScenarioRequirements | null = null;
    const scenarioManifest = opts.loadScenarioManifest?.(s.manifestDigest) ?? null;
    if (scenarioManifest) {
      requirements = scenarioContractFromManifest(scenarioManifest);
      if (!requirements) {
        unavailableManifests.push(s.id);
        continue;
      }
    } else {
      requirements = opts.loadScenarioRequirements?.(s.manifestDigest) ?? null;
      if (!requirements || !requirements.freshness) {
        unavailableManifests.push(s.id);
        continue;
      }
    }

    if (suiteManifest.evidenceLayer === "protocol_conformance" && opts.subject?.subjectKind === "protocol") {
      if (!scenarioApplicableToRequirements(requirements, opts.subject)) continue;
    }
    if (suiteManifest.evidenceLayer === "live_route_compatibility" && opts.subject?.subjectKind === "route") {
      if (!routeSubjectApplicableToRequirements(requirements, opts.subject, opts.routeSupportedClaims!)) continue;
    }
    if (suiteManifest.evidenceLayer === "task_effectiveness" && opts.subject?.subjectKind === "task") {
      const capability = opts.fabricCapability ?? {
        harnessFeatures: ["fabric-scratch-v1"],
        platforms: [process.platform, "*"],
        routePreconditions: ["exact-route-subject"],
      };
      if (!taskSubjectApplicableToRequirements(requirements, capability)) continue;
    }
    applicableRequired.push(s.id);
    scenarioMaxAgeById.set(s.id, requirements.freshness?.maxAgeMs ?? null);
  }
  applicableRequired.sort();

  if (unavailableManifests.length > 0) {
    return {
      applicableRequiredScenarioIds: applicableRequired,
      passingRequiredScenarioIds: [],
      missingRequiredScenarioIds: [...new Set([...applicableRequired, ...unavailableManifests])].sort(),
      canVerify: false,
      notes: unavailableManifests.map((id) => `scenario_manifest_unavailable:${id}`),
    };
  }

  if (applicableRequired.length === 0) {
    return {
      applicableRequiredScenarioIds: [],
      passingRequiredScenarioIds: [],
      missingRequiredScenarioIds: [],
      canVerify: false,
      notes: ["empty_applicable_required_set"],
    };
  }

  const newest = newestObservationByScenario(observations);
  const passing: string[] = [];
  const missing: string[] = [];
  const asOf = opts.asOf ?? observations.reduce((max, obs) => Math.max(max, obs.completedAt), 0);

  for (const scenarioId of applicableRequired) {
    const scenarioRef = requiredScenarios.find((s) => s.id === scenarioId)!;
    const obs = newest.get(scenarioId);
    if (!obs) {
      missing.push(scenarioId);
      continue;
    }
    if (obs.scenarioManifestDigest !== scenarioRef.manifestDigest) {
      missing.push(scenarioId);
      notes.push(`digest_mismatch:${scenarioId}`);
      continue;
    }
    const maxAgeMs = effectiveMaxAgeMs(
      suiteManifest.freshness.maxAgeMs,
      scenarioMaxAgeById.get(scenarioId) ?? null,
    );
    if (maxAgeMs !== null && asOf - obs.completedAt > maxAgeMs) {
      missing.push(scenarioId);
      notes.push(`stale_observation:${scenarioId}`);
      continue;
    }
    if (obs.outcome !== "pass") {
      missing.push(scenarioId);
      continue;
    }
    passing.push(scenarioId);
  }

  return {
    applicableRequiredScenarioIds: applicableRequired,
    passingRequiredScenarioIds: passing,
    missingRequiredScenarioIds: missing,
    canVerify: missing.length === 0 && passing.length === applicableRequired.length,
    notes,
  };
}

function requireNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function parseSuiteManifestFromArtifact(parsed: unknown): SuiteManifestV1 | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;
  if (raw.schemaVersion !== 1) return null;

  const id = requireNonEmptyString(raw.id);
  const version = requireNonEmptyString(raw.version);
  const capability = requireNonEmptyString(raw.capability);
  const assertionDslVersion = requireNonEmptyString(raw.assertionDslVersion);
  const evidenceSchemaVersion = requireNonEmptyString(raw.evidenceSchemaVersion);
  const contradictionRule = requireNonEmptyString(raw.contradictionRule);
  const verificationRule = requireNonEmptyString(raw.verificationRule);
  if (
    !id || !version || !capability || !assertionDslVersion ||
    !evidenceSchemaVersion || !contradictionRule ||
    verificationRule !== "all-applicable-required-pass-v1"
  ) return null;
  if (
    typeof raw.evidenceLayer !== "string" ||
    !(EVIDENCE_LAYERS as readonly string[]).includes(raw.evidenceLayer)
  ) return null;
  const freshness = parseFreshness(raw.freshness);
  if (!freshness || !Array.isArray(raw.scenarios)) return null;

  const roles = new Set<VerificationRole>(["required", "supplemental", "negative_control"]);
  const seenScenarioIds = new Set<string>();
  const scenarios: SuiteManifestV1["scenarios"] = [];
  for (const s of raw.scenarios) {
    if (!s || typeof s !== "object" || Array.isArray(s)) return null;
    const row = s as Record<string, unknown>;
    const scenarioId = requireNonEmptyString(row.id);
    const scenarioVersion = requireNonEmptyString(row.version);
    const manifestDigest = requireNonEmptyString(row.manifestDigest);
    if (
      !scenarioId || !scenarioVersion || !manifestDigest || !isSha256Hex(manifestDigest) ||
      typeof row.role !== "string" || !roles.has(row.role as VerificationRole) ||
      seenScenarioIds.has(scenarioId)
    ) return null;
    seenScenarioIds.add(scenarioId);
    scenarios.push({
      id: scenarioId,
      version: scenarioVersion,
      role: row.role as VerificationRole,
      manifestDigest,
    });
  }

  return {
    schemaVersion: 1,
    id,
    version,
    evidenceLayer: raw.evidenceLayer,
    capability,
    assertionDslVersion,
    evidenceSchemaVersion,
    freshness,
    contradictionRule,
    scenarios,
    verificationRule,
  };
}
