import type { CompatibilityVerdict, EvidenceLayer } from "../../lab/constants";
import type { OcxRoutingUnknownEvidenceMode } from "../../types";

export type RoutingCompatibilityEvidenceLayer = Extract<
  EvidenceLayer,
  "protocol_conformance" | "live_route_compatibility"
>;

export interface CompatibilitySuiteRequirement {
  suiteId: string;
  evidenceLayer: RoutingCompatibilityEvidenceLayer;
}

export interface NormalizedCompatibilityPolicy {
  requiredSuites: CompatibilitySuiteRequirement[];
  minStatus?: "PROBED" | "VERIFIED";
  maxEvidenceAgeMs?: number;
  unknownEvidence: OcxRoutingUnknownEvidenceMode;
  degradedEvidence: OcxRoutingUnknownEvidenceMode;
}

export interface ObservedSuiteVerdict {
  subjectId: string;
  suiteId: string;
  evidenceLayer: RoutingCompatibilityEvidenceLayer;
  suiteVersion: string;
  suiteManifestDigest: string;
  verdict: CompatibilityVerdict;
  asOf: number;
  /** Current catalog freshness ceiling for this exact suite identity. */
  maxAgeMs: number | null;
  notes: string[];
}

export interface CandidateCompatibilityEvidence {
  subjectIds: Partial<Record<RoutingCompatibilityEvidenceLayer, string>>;
  projectionAvailable: boolean;
  suites: ObservedSuiteVerdict[];
}

export interface CompatibilityEvaluationOutcome {
  exclusions: Array<{ code: string; detail?: string }>;
  /** Numeric floor applied only when an explicit penalize policy fires. */
  penaltyScore: number | null;
  suiteTraces: Array<{
    suiteId: string;
    evidenceLayer: RoutingCompatibilityEvidenceLayer;
    subjectIdPrefix?: string;
    verdict?: CompatibilityVerdict;
    minStatus?: "PROBED" | "VERIFIED";
    fresh?: boolean;
    unknownPolicy?: OcxRoutingUnknownEvidenceMode;
    degradedPolicy?: OcxRoutingUnknownEvidenceMode;
    outcome: "satisfied" | "penalized" | "excluded" | "unknown";
    reason?: string;
  }>;
  traceTruncated: boolean;
}

export const COMPATIBILITY_UNKNOWN_PENALTY_SCORE = 0.3;
/** Compatibility is a bounded penalty dimension, not a universal score. */
export const COMPATIBILITY_WEIGHT = 0.05;
export const MAX_TRACE_COMPATIBILITY_SUITES = 8;
export const MAX_COMPATIBILITY_REQUIRED_SUITES = MAX_TRACE_COMPATIBILITY_SUITES;
