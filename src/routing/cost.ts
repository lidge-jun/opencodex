/**
 * Cost-aware policy scoring and limits (RI-08).
 *
 * Reuses the canonical price/cost normalization (`src/usage/cost.ts`).
 * Evidence distinguishes estimated vs authoritative usage and registry vs
 * expected prices. Unknown prices stay unknown (never free); the profile's
 * `unknownEvidence.cost` policy decides how unknown evidence is handled.
 *
 * No billing, invoicing, or hidden budgets - a hard per-request ceiling
 * (`limits.maxEstimatedCostUsd`) is evaluated deterministically.
 */

import type { OcxUsage } from "../types";
import type { UsageStatus } from "../usage/log";
import { estimateRequestCost, type ServiceTierInput } from "../usage/cost";
import type { RouteCostEvidence } from "./trace";

/** Reference cost (USD) for the relative cost score when no limit is set. */
export const COST_SCORE_REFERENCE_USD = 1.0;

export interface CostEvidenceInput {
  provider: string;
  model: string;
  usage?: OcxUsage;
  usageStatus?: UsageStatus;
  serviceTier?: ServiceTierInput;
  limitUsd?: number;
}

/**
 * Assemble cost evidence from the canonical price model. Returns unknown-ish
 * evidence (`incomplete: true`, no estimate) when usage or a price is
 * missing - never a fabricated zero.
 */
export function costEvidenceForCandidate(input: CostEvidenceInput): RouteCostEvidence {
  const limitUsd = input.limitUsd;
  if (!input.usage) {
    return {
      ...(limitUsd !== undefined ? { limitUsd } : {}),
      incomplete: true,
    };
  }
  const estimate = estimateRequestCost({
    provider: input.provider,
    model: input.model,
    usage: input.usage,
    usageStatus: input.usageStatus ?? "estimated",
    ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
  });
  if (!estimate) {
    return {
      ...(limitUsd !== undefined ? { limitUsd } : {}),
      incomplete: true,
      priceSource: "unmatched",
    };
  }
  const priceSource = estimate.price?.source ?? "registry";
  return {
    estimatedUsd: estimate.cost.total,
    priceSource,
    incomplete: estimate.estimated || priceSource === "expected",
    ...(limitUsd !== undefined ? { limitUsd } : {}),
  };
}

/**
 * Deterministic cost score in [0,1]: cheaper is better, relative to
 * `COST_SCORE_REFERENCE_USD` (or the profile limit when set). Unknown
 * estimates return null so the profile's unknownEvidence policy applies.
 */
export function costScore(evidence: RouteCostEvidence | undefined): number | null {
  if (evidence?.estimatedUsd === undefined || !Number.isFinite(evidence.estimatedUsd)) return null;
  const reference = typeof evidence.limitUsd === "number" && evidence.limitUsd > 0
    ? evidence.limitUsd
    : COST_SCORE_REFERENCE_USD;
  return Math.max(0, Math.min(1, 1 - evidence.estimatedUsd / reference));
}
