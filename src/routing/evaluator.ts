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
  capability?: RouteCapabilityEvidence;
  health?: RouteHealthEvidence;
  quota?: RouteQuotaEvidence;
  cost?: RouteCostEvidence;
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
  // Note: `required === false` is a negative assertion ("must NOT have X"),
  // not "don't care"; an absent field is the only "no requirement" form.
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

/**
 * Requirements derived from the request evidence supplied to a dry-run. A
 * candidate must satisfy both the profile `require` block and the request
 * needs (context window, tools, image input, structured output, reasoning
 * effort, service tier, encrypted Codex tasks) to be eligible.
 */
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
  // Absent flags mean "no requirement": only a positive request need adds a row.
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
      ...requirementFor(profile.require, evidence.capability),
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
    // Unknown capability handling per profile: exclude (default), penalize,
    // or allow. "penalize" currently cannot move the score because RI-04 has
    // no capability component yet - the capability score arrives with RI-05.
    const excludedByUnknown = unknown && profile.unknownEvidence.capability === "exclude";
    const costLimit = profile.limits.maxEstimatedCostUsd;
    const estimatedCost = evidence.cost?.estimatedUsd;
    const overCostLimit = costLimit !== undefined
      && typeof estimatedCost === "number"
      && Number.isFinite(estimatedCost)
      && estimatedCost > costLimit;
    if (overCostLimit) {
      exclusions.push({ code: "cost-limit", detail: "maxEstimatedCostUsd" });
    }
    const eligible = !unsatisfied && !excludedByUnknown && !overCostLimit;

    const priorityScore = configuredPriorityScore(index, profile.candidates.length);
    const score: RouteScoreEvidence = {
      total: priorityScore,
      components: { configuredPriority: priorityScore },
    };
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
    // Flat, capped summary (truncation is flagged by the builder); per-candidate
    // attribution lives in each candidate's `requirements`/`exclusions`.
    requirements: candidates.flatMap(candidate => candidate.requirements).slice(0, 16),
    candidates: candidates.map(candidate => ({
      provider: candidate.provider,
      model: candidate.model,
      ...(candidate.accountRef ? { accountRef: candidate.accountRef } : {}),
      eligible: candidate.eligible,
      exclusions: candidate.exclusions,
      ...(candidate.score ? { score: candidate.score } : {}),
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
