import { formatErrorResponse } from "../../bridge";
import type { RouteResult } from "../../router";
import type { RouteDecisionTraceV1 } from "../../routing/trace";
import { resolveOpenAiVirtualModel } from "../../providers/openai-virtual-models";

/** Request-owned authorization, separate from the diagnostic trace and each physical attempt. */
export interface PolicyRequestScope {
  decision?: RouteDecisionTraceV1;
  eligibility?: ReadonlySet<string>;
  readonly triedDestinations: Set<string>;
  preparedDestination?: string;
}

export function policyDestinationKey(provider: string, model: string): string {
  return `${provider}\u0000${model}`;
}

export function policyWireDestination(route: Pick<RouteResult, "providerName" | "modelId">): string {
  const model = resolveOpenAiVirtualModel(route.providerName, route.modelId)?.wireModelId ?? route.modelId;
  return policyDestinationKey(route.providerName, model);
}

export class PolicyCandidateUnavailableError extends Error {
  constructor() {
    super("The candidate cannot serve this request within its original routing policy.");
    this.name = "PolicyCandidateUnavailableError";
  }
}

const localRefusals = new WeakSet<Response>();

export function policyCandidateRefusalResponse(error: unknown): Response | undefined {
  if (!(error instanceof PolicyCandidateUnavailableError)) return undefined;
  const response = formatErrorResponse(409, "policy_candidate_unavailable", error.message);
  localRefusals.add(response);
  return response;
}

/** Upstream text or a matching error code cannot authorize another policy attempt. */
export function isPolicyCandidateRefusal(response: Response): boolean {
  return localRefusals.has(response);
}

export function capturePolicyRequestRoute(scope: PolicyRequestScope, route: RouteResult): RouteResult {
  if (!scope.eligibility && route.policyEligibility && route.routeDecision?.routeKind === "policy") {
    scope.eligibility = new Set(route.policyEligibility);
    scope.decision = route.routeDecision;
  }
  if (!scope.eligibility) return route;
  if (!scope.eligibility.has(policyDestinationKey(route.providerName, route.modelId))) {
    throw new PolicyCandidateUnavailableError();
  }
  // Preparation and normalization both project from RouteResult into the log. Keep the original
  // authorization and decision on every allowed replacement, including recovery's second pass.
  route.routeKind = "policy";
  route.policyEligibility = scope.eligibility;
  route.routeDecision = scope.decision;
  return route;
}

/** Only the admitted selector's existing virtual-model rewrite may change its final route id. */
export function assertPolicyNormalizedRoute(
  scope: PolicyRequestScope,
  admitted: Pick<RouteResult, "providerName" | "modelId">,
  route: RouteResult,
): void {
  if (!scope.eligibility) return;
  if (route.providerName !== admitted.providerName || (route.modelId !== admitted.modelId
    && route.modelId !== resolveOpenAiVirtualModel(admitted.providerName, admitted.modelId)?.wireModelId)) {
    throw new PolicyCandidateUnavailableError();
  }
}

/** Called once preparation has settled the wire, before dispatch; account retries keep their own budget. */
export function recordPolicyPreparedDestination(scope: PolicyRequestScope, provider: string, model: string): void {
  if (!scope.eligibility) return;
  const destination = policyDestinationKey(provider, model);
  if (scope.triedDestinations.has(destination)) throw new PolicyCandidateUnavailableError();
  scope.preparedDestination = destination;
}
