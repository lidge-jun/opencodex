/**
 * Deterministic policy-profile evaluator (RI-04 core; extended by RI-05..08).
 *
 * RI-04 evaluates hard capability requirements against supplied evidence and
 * scores by deterministic configured priority only. It never dispatches an
 * upstream request; execution wiring arrives with RI-05.
 */

import type { OcxConfig } from "../types";
import {
  buildRouteDecisionTrace,
  MAX_REQUIREMENTS,
  type RouteCapabilityEvidence,
  type RouteCostEvidence,
  type RouteDecisionTraceV1,
  type RouteExclusionReason,
  type RouteHealthEvidence,
  type RouteQuotaEvidence,
  type RouteRequirementEvidence,
  type RouteScoreEvidence,
  type Unknownable,
} from "./trace";
import { getRoutingProfile, policyModelId, type NormalizedRoutingProfile } from "./profile";
import { healthScore, latencyScoreFromEvidence } from "./health";
import { quotaScore } from "./quota";
import { costScore } from "./cost";
import { evaluateCompatibilityForCandidate } from "./compatibility/policy";
import { COMPATIBILITY_WEIGHT, type CandidateCompatibilityEvidence } from "./compatibility/types";
import type { RouteCompatibilityEvidence } from "./trace";

/** Unknown health under "penalize": a low-but-not-zero deterministic floor. */
export const HEALTH_UNKNOWN_PENALTY_SCORE = 0.3;
/** Unknown health under "allow": neutral midpoint of the [0,1] health scale. */
export const HEALTH_UNKNOWN_NEUTRAL_SCORE = 0.5;
/** Unknown quota under "penalize": deterministic low floor. */
export const QUOTA_UNKNOWN_PENALTY_SCORE = 0.3;
/** Unknown cost under "penalize": deterministic low floor. */
export const COST_UNKNOWN_PENALTY_SCORE = 0.3;

export interface PolicyRequestEvidence {
  /** Required context window for this request (tokens). */
  contextWindow?: number;
  toolsRequired?: boolean;
  imageInputRequired?: boolean;
  structuredOutputRequired?: boolean;
  reasoningEffort?: string;
  serviceTier?: string;
  encryptedCodexTask?: boolean;
}

export interface PolicyCandidateEvidence {
  provider: string;
  model: string;
  accountRef?: string;
  /** Codex pool account id (provider "openai"); used to derive account-scoped quota evidence. */
  codexAccountId?: string;
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
  compatibility?: CandidateCompatibilityEvidence;
}

export interface PolicyEvaluationCandidate {
  provider: string;
  model: string;
  accountRef?: string;
  eligible: boolean;
  exclusions: RouteExclusionReason[];
  requirements: RouteRequirementEvidence[];
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
  compatibility?: RouteCompatibilityEvidence;
  score?: RouteScoreEvidence;
}

export interface PolicyEvaluationResult {
  profileId: string;
  profileRevision: string;
  candidates: PolicyEvaluationCandidate[];
  selectedIndex: number | null;
  trace: RouteDecisionTraceV1;
}

function booleanRequirement(
  id: string,
  required: boolean | undefined,
  actual: Unknownable | undefined,
): RouteRequirementEvidence | null {
  if (required === undefined) return null;
  if (actual === undefined || actual === "unknown") {
    return { id, expected: required, outcome: "unknown" };
  }
  return {
    id,
    expected: required,
    actual: typeof actual === "boolean" ? actual : String(actual),
    outcome: typeof actual === "boolean" && actual === required ? "satisfied" : "unsatisfied",
  };
}

function requirementFor(
  require: NormalizedRoutingProfile["require"],
  capability: RouteCapabilityEvidence | undefined,
  quota: RouteQuotaEvidence | undefined,
): RouteRequirementEvidence[] {
  const requirements: RouteRequirementEvidence[] = [];
  if (require.minContextWindow !== undefined) {
    const actual = capability?.contextWindow;
    if (typeof actual === "number") {
      requirements.push({
        id: "min-context-window",
        expected: require.minContextWindow,
        actual,
        outcome: actual >= require.minContextWindow ? "satisfied" : "unsatisfied",
      });
    } else {
      requirements.push({ id: "min-context-window", expected: require.minContextWindow, outcome: "unknown" });
    }
  }
  if (require.minQuotaHeadroom !== undefined) {
    const quotaHeadroom = quotaScore(quota);
    if (quotaHeadroom !== null) {
      requirements.push({
        id: "min-quota-headroom",
        expected: require.minQuotaHeadroom,
        actual: quotaHeadroom,
        outcome: quotaHeadroom >= require.minQuotaHeadroom ? "satisfied" : "unsatisfied",
      });
    }
  }
  const tools = booleanRequirement("tools", require.tools, capability?.tools);
  if (tools) requirements.push(tools);
  const image = booleanRequirement("image-input", require.imageInput, capability?.image);
  if (image) requirements.push(image);
  const structured = booleanRequirement("structured-output", require.structuredOutput, capability?.structuredOutput);
  if (structured) requirements.push(structured);
  if (require.reasoningEffort !== undefined) {
    const ladder = capability?.reasoningEfforts;
    if (Array.isArray(ladder)) {
      requirements.push({
        id: "reasoning-effort",
        expected: require.reasoningEffort,
        actual: ladder.join(","),
        outcome: ladder.includes(require.reasoningEffort) ? "satisfied" : "unsatisfied",
      });
    } else {
      requirements.push({ id: "reasoning-effort", expected: require.reasoningEffort, outcome: "unknown" });
    }
  }
  if (require.serviceTier !== undefined) {
    const actual = capability?.serviceTier;
    if (actual === undefined || actual === "unknown") {
      requirements.push({ id: "service-tier", expected: require.serviceTier, outcome: "unknown" });
    } else {
      requirements.push({
        id: "service-tier",
        expected: require.serviceTier,
        actual: String(actual),
        outcome: actual === require.serviceTier ? "satisfied" : "unsatisfied",
      });
    }
  }
  const local = booleanRequirement("local-only", require.localOnly, capability?.localOnly);
  if (local) requirements.push(local);
  const remote = booleanRequirement("remote-allowed", require.remoteAllowed, capability?.remoteAllowed);
  if (remote) requirements.push(remote);
  const encrypted = booleanRequirement(
    "encrypted-codex-tasks",
    require.encryptedCodexTasks,
    capability?.encryptedCodexTasks,
  );
  if (encrypted) requirements.push(encrypted);
  return requirements;
}

function unsatisfiedOrUnknown(requirements: RouteRequirementEvidence[]): RouteRequirementEvidence[] {
  return requirements.filter(requirement => requirement.outcome !== "satisfied");
}

function configuredPriorityScore(index: number, total: number): number {
  return total > 1 ? (total - index) / total : 1;
}

function requestRequirementFor(
  request: PolicyRequestEvidence,
  capability: RouteCapabilityEvidence | undefined,
): RouteRequirementEvidence[] {
  const requirements: RouteRequirementEvidence[] = [];
  if (request.contextWindow !== undefined) {
    const actual = capability?.contextWindow;
    if (typeof actual === "number") {
      requirements.push({
        id: "request-context-window",
        expected: request.contextWindow,
        actual,
        outcome: actual >= request.contextWindow ? "satisfied" : "unsatisfied",
      });
    } else {
      requirements.push({ id: "request-context-window", expected: request.contextWindow, outcome: "unknown" });
    }
  }
  if (request.toolsRequired === true) {
    const tools = booleanRequirement("request-tools", true, capability?.tools);
    if (tools) requirements.push(tools);
  }
  if (request.imageInputRequired === true) {
    const image = booleanRequirement("request-image-input", true, capability?.image);
    if (image) requirements.push(image);
  }
  if (request.structuredOutputRequired === true) {
    const structured = booleanRequirement("request-structured-output", true, capability?.structuredOutput);
    if (structured) requirements.push(structured);
  }
  if (request.reasoningEffort !== undefined) {
    const ladder = capability?.reasoningEfforts;
    if (Array.isArray(ladder)) {
      requirements.push({
        id: "request-reasoning-effort",
        expected: request.reasoningEffort,
        actual: ladder.join(","),
        outcome: ladder.includes(request.reasoningEffort) ? "satisfied" : "unsatisfied",
      });
    } else {
      requirements.push({ id: "request-reasoning-effort", expected: request.reasoningEffort, outcome: "unknown" });
    }
  }
  if (request.serviceTier !== undefined) {
    const actual = capability?.serviceTier;
    if (actual === undefined || actual === "unknown") {
      requirements.push({ id: "request-service-tier", expected: request.serviceTier, outcome: "unknown" });
    } else {
      requirements.push({
        id: "request-service-tier",
        expected: request.serviceTier,
        actual: String(actual),
        outcome: actual === request.serviceTier ? "satisfied" : "unsatisfied",
      });
    }
  }
  if (request.encryptedCodexTask === true) {
    const encrypted = booleanRequirement(
      "request-encrypted-codex-tasks",
      true,
      capability?.encryptedCodexTasks,
    );
    if (encrypted) requirements.push(encrypted);
  }
  return requirements;
}

/**
 * Evaluate a profile against request + candidate evidence. Deterministic:
 * candidates are scored in declaration order, ties break by earlier index.
 */
export function evaluatePolicyProfile(
  config: OcxConfig,
  profileId: string,
  requestEvidence: PolicyRequestEvidence,
  candidateEvidence: PolicyCandidateEvidence[],
  now = Date.now(),
): PolicyEvaluationResult {
  const profile = getRoutingProfile(config, profileId);
  if (!profile) throw new Error(`Unknown routing profile: ${profileId}`);

  const candidates: PolicyEvaluationCandidate[] = [];
  let selectedIndex: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  profile.candidates.forEach((declared, index) => {
    const evidence = candidateEvidence.find(
      candidate => candidate.provider === declared.provider && candidate.model === declared.model,
    ) ?? { provider: declared.provider, model: declared.model };
    const requirements = [
      ...requirementFor(profile.require, evidence.capability, evidence.quota),
      ...requestRequirementFor(requestEvidence, evidence.capability),
    ];
    const exclusions: RouteExclusionReason[] = [];
    const bad = unsatisfiedOrUnknown(requirements);
    for (const requirement of bad) {
      if (requirement.outcome === "unsatisfied") {
        exclusions.push({ code: "capability-unsatisfied", detail: requirement.id });
      } else {
        exclusions.push({ code: "unknown-capability", detail: requirement.id });
      }
    }
    const unsatisfied = bad.some(requirement => requirement.outcome === "unsatisfied");
    const unknown = bad.some(requirement => requirement.outcome === "unknown");
    const excludedByUnknown = unknown && profile.unknownEvidence.capability === "exclude";
    const costLimit = profile.limits.maxEstimatedCostUsd;
    const estimatedCost = evidence.cost?.estimatedUsd;
    const costEstimateKnown = typeof estimatedCost === "number" && Number.isFinite(estimatedCost);
    const overCostLimit = costLimit !== undefined
      && costEstimateKnown
      && estimatedCost! > costLimit;
    if (overCostLimit) {
      exclusions.push({ code: "cost-limit", detail: "maxEstimatedCostUsd" });
    }
    // A cap can only be *proven* satisfied when the estimate is known. The live
    // routing path often has no usage evidence yet, so the default stays
    // "allow" to preserve the documented dry-run contract; operators who need a
    // genuine hard ceiling opt into "exclude". Exclusions cover only the
    // fail-closed path; the allow path stamps `cost.capOutcome` so operators
    // can still distinguish "known under the cap" from "unknown cost allowed".
    const unknownCostUnderCap = costLimit !== undefined && !costEstimateKnown;
    const unknownCostBlocked = unknownCostUnderCap
      && profile.limits.onUnknownCost === "exclude";
    if (unknownCostBlocked) {
      exclusions.push({ code: "cost-limit-unknown", detail: "maxEstimatedCostUsd" });
    }
    let eligible = !unsatisfied && !excludedByUnknown && !overCostLimit && !unknownCostBlocked;

    // Trace/dry-run copy only: report the profile cap that was applied and the
    // operator-visible outcome. Do not feed this copy into costScore() — that
    // would silently change ranking when a caller supplied a different
    // limitUsd (costScore uses limitUsd as its reference denominator).
    let costForCandidate = evidence.cost;
    if (costLimit !== undefined) {
      const capOutcome = overCostLimit
        ? "exceeded" as const
        : unknownCostBlocked
          ? "unknown-excluded" as const
          : unknownCostUnderCap
            ? "unknown-allowed" as const
            : "satisfied" as const;
      if (!costEstimateKnown) {
        // Missing or non-finite estimates are the same unknown: never stamp
        // Infinity/NaN into the trace, and always mark incomplete.
        const { estimatedUsd: _nonFiniteOrMissing, ...rest } = evidence.cost ?? {};
        costForCandidate = {
          ...rest,
          incomplete: true,
          limitUsd: costLimit,
          capOutcome,
        };
      } else {
        costForCandidate = {
          ...evidence.cost!,
          limitUsd: costLimit,
          capOutcome,
        };
      }
    }

    const compatibilityEval = evaluateCompatibilityForCandidate(
      profile.compatibility,
      evidence.compatibility,
      now,
    );
    if (compatibilityEval.exclusions.length > 0) {
      exclusions.push(...compatibilityEval.exclusions);
      eligible = false;
    }
    const compatibilityValue = compatibilityEval.penaltyScore;
    const compatibilityTrace = compatibilityEval.trace;

    const health = evidence.health;
    let healthValue = health ? healthScore(health, now) : null;
    if (health?.cooldownUntilMs !== undefined && health.cooldownUntilMs > now) {
      exclusions.push({ code: "cooldown" });
      eligible = false;
    } else if (healthValue === null && profile.unknownEvidence.health === "exclude") {
      exclusions.push({ code: "unknown-health" });
      eligible = false;
    } else if (healthValue === null && profile.unknownEvidence.health === "penalize") {
      healthValue = HEALTH_UNKNOWN_PENALTY_SCORE;
    } else if (healthValue === null && profile.unknownEvidence.health === "allow") {
      healthValue = HEALTH_UNKNOWN_NEUTRAL_SCORE;
    }

    const quota = evidence.quota;
    let quotaValue = quota ? quotaScore(quota) : null;
    if (quotaValue === null) {
      if (profile.unknownEvidence.quota === "exclude") {
        exclusions.push({ code: "unknown-quota" });
        eligible = false;
      } else if (profile.unknownEvidence.quota === "penalize") {
        quotaValue = QUOTA_UNKNOWN_PENALTY_SCORE;
      }
    }

    // Cost scoring (RI-08): the hard per-request ceiling was already checked
    // above; unknown cost follows the profile's unknownEvidence policy.
    // Score against the caller's original evidence so trace stamping cannot
    // move the costScore reference / ranking.
    const cost = evidence.cost;
    let costValue = cost ? costScore(cost) : null;
    if (costValue === null && profile.unknownEvidence.cost === "exclude") {
      exclusions.push({ code: "unknown-price" });
      eligible = false;
    } else if (costValue === null && profile.unknownEvidence.cost === "penalize") {
      costValue = COST_UNKNOWN_PENALTY_SCORE;
    }

    const priorityScore = configuredPriorityScore(index, profile.candidates.length);
    const healthWeight = profile.optimize.health;
    const quotaWeight = profile.optimize.quota;
    const costWeight = profile.optimize.cost;
    // `optimize.latency` was normalized into the weight sum but never spent, so whatever
    // was allocated to it silently became configuredPriority -- i.e. declaration order.
    // Spend it on the same p50-derived score the health composite already uses.
    const latencyWeight = profile.optimize.latency;
    const latencyValue = latencyWeight > 0 ? latencyScoreFromEvidence(health) : null;
    const spentHealth = healthValue !== null ? healthWeight : 0;
    const spentQuota = quotaValue !== null ? quotaWeight : 0;
    const spentCost = costValue !== null ? costWeight : 0;
    const spentLatency = latencyValue !== null ? latencyWeight : 0;
    const priorityWeight = Math.max(0, 1 - spentHealth - spentQuota - spentCost - spentLatency);
    const components: RouteScoreEvidence["components"] = { configuredPriority: priorityScore };
    let total = priorityWeight * priorityScore;
    if (healthWeight > 0 && healthValue !== null) {
      total += healthWeight * healthValue;
      components.health = healthValue;
    }
    if (quotaWeight > 0 && quotaValue !== null) {
      total += quotaWeight * quotaValue;
      components.quota = quotaValue;
    }
    if (costWeight > 0 && costValue !== null) {
      total += costWeight * costValue;
      components.cost = costValue;
    }
    if (latencyWeight > 0 && latencyValue !== null) {
      total += latencyWeight * latencyValue;
      components.latency = latencyValue;
    }
    if (compatibilityValue !== null) {
      // Compatibility is a penalty-only dimension. A penalized candidate loses
      // a bounded fraction of its existing score; satisfied/allowed evidence
      // does not receive a synthetic bonus or alter configured priority.
      total = Math.max(0, total - COMPATIBILITY_WEIGHT * (1 - compatibilityValue));
      components.compatibility = compatibilityValue;
    }
    const score: RouteScoreEvidence = { total, components };
    const evaluated: PolicyEvaluationCandidate = {
      provider: evidence.provider,
      model: evidence.model,
      ...(evidence.accountRef ? { accountRef: evidence.accountRef } : {}),
      eligible,
      exclusions,
      requirements,
      ...(evidence.capability ? { capability: evidence.capability } : {}),
      ...(evidence.health ? { health: evidence.health } : {}),
      ...(evidence.quota ? { quota: evidence.quota } : {}),
      ...(evidence.cost ? { cost: evidence.cost } : {}),
      ...(compatibilityTrace ? { compatibility: compatibilityTrace } : {}),
      ...(costForCandidate ? { cost: costForCandidate } : {}),
      score,
    };
    candidates.push(evaluated);

    if (evaluated.eligible && score.total > bestScore) {
      bestScore = score.total;
      selectedIndex = index;
    }
  });

  const trace = buildRouteDecisionTrace({
    requestedModel: policyModelId(profileId),
    routeKind: "policy",
    profile: { id: profile.id, revision: profile.revision },
    requirements: candidates.flatMap(candidate => candidate.requirements).slice(0, MAX_REQUIREMENTS),
    candidates: candidates.map(candidate => ({
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.accountRef ? { accountRef: candidate.accountRef } : {}),
      eligible: candidate.eligible,
      exclusions: candidate.exclusions,
      ...(candidate.score ? { score: candidate.score } : {}),
      ...(candidate.capability ? { capability: candidate.capability } : {}),
      ...(candidate.health ? { health: candidate.health } : {}),
      ...(candidate.quota ? { quota: candidate.quota } : {}),
      ...(candidate.cost ? { cost: candidate.cost } : {}),
      ...(candidate.compatibility ? { compatibility: candidate.compatibility } : {}),
    })),
    selected: selectedIndex === null
      ? { provider: candidates[0]?.provider ?? "", model: candidates[0]?.model ?? "", reason: "no-eligible-candidate" }
      : {
        candidateIndex: selectedIndex,
        provider: candidates[selectedIndex]!.provider,
        model: candidates[selectedIndex]!.model,
        reason: "policy-selected",
      },
  });

  return {
    profileId: profile.id,
    profileRevision: profile.revision,
    candidates,
    selectedIndex,
    trace,
  };
}
