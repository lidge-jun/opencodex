/** Routing-profile configuration types (`routingProfiles` in config.json). */

export type OcxRoutingUnknownEvidenceMode = "allow" | "penalize" | "exclude";

export interface OcxRoutingProfileCandidate {
  provider: string;
  model: string;
}

export interface OcxRoutingProfileRequirements {
  /** Minimum model context window in tokens. */
  minContextWindow?: number;
  /** Minimum remaining quota headroom fraction (0..1). */
  minQuotaHeadroom?: number;
  tools?: boolean;
  imageInput?: boolean;
  structuredOutput?: boolean;
  reasoningEffort?: string;
  serviceTier?: string;
  localOnly?: boolean;
  remoteAllowed?: boolean;
  /** Special encrypted Codex task readability (ChatGPT forward pool). */
  encryptedCodexTasks?: boolean;
}

export interface OcxRoutingProfileOptimize {
  latency?: number;
  health?: number;
  cost?: number;
  quota?: number;
}

/**
 * Policy for the hard cost ceiling when a candidate has no finite cost
 * estimate. `"allow"` (default) preserves the documented dry-run contract:
 * the cap only excludes evidence known to exceed it, and the candidate's
 * `cost.capOutcome` is `"unknown-allowed"`. `"exclude"` makes the ceiling
 * fail-closed (`cost-limit-unknown` + `capOutcome: "unknown-excluded"`).
 */
export type OcxRoutingUnknownCostCapMode = "allow" | "exclude";

export interface OcxRoutingProfileLimits {
  /** Hard per-request estimated-cost ceiling in USD. */
  maxEstimatedCostUsd?: number;
  /**
   * How `maxEstimatedCostUsd` behaves when the estimate is unknown.
   * Defaults to `"allow"` (eligible + `cost.capOutcome: "unknown-allowed"`);
   * opt in to `"exclude"` for a true hard ceiling.
   */
  onUnknownCost?: OcxRoutingUnknownCostCapMode;
}

export interface OcxRoutingProfileUnknownEvidence {
  capability?: OcxRoutingUnknownEvidenceMode;
  health?: OcxRoutingUnknownEvidenceMode;
  quota?: OcxRoutingUnknownEvidenceMode;
  cost?: OcxRoutingUnknownEvidenceMode;
}

export interface OcxRoutingProfileCompatibilitySuite {
  suiteId: string;
  evidenceLayer: "protocol_conformance" | "live_route_compatibility";
}

export interface OcxRoutingProfileCompatibility {
  requiredSuites?: OcxRoutingProfileCompatibilitySuite[];
  minStatus?: "PROBED" | "VERIFIED";
  maxEvidenceAgeMs?: number;
  unknownEvidence?: OcxRoutingUnknownEvidenceMode;
  degradedEvidence?: OcxRoutingUnknownEvidenceMode;
}

export interface OcxRoutingProfileConfig {
  /**
   * Explicit candidate allowlist (`provider/model` refs). No implicit
   * expansion in v1.
   */
  candidates: OcxRoutingProfileCandidate[];
  /** Optional public model name replacing the default `policy/<id>` slug. */
  alias?: string;
  /** Hard requirements evaluated before scoring. */
  require?: OcxRoutingProfileRequirements;
  /** Optimization weights; normalized deterministically. */
  optimize?: OcxRoutingProfileOptimize;
  limits?: OcxRoutingProfileLimits;
  /** How unknown evidence is handled per dimension. */
  unknownEvidence?: OcxRoutingProfileUnknownEvidence;
  /** Optional Compatibility Lab policy (CL-06). */
  compatibility?: OcxRoutingProfileCompatibility;
}
