import { NoAvailableComboTargetsError } from "../../combos";
import { NoEligiblePolicyCandidateError, type RouteResult } from "../../router";
import { AdmissionModelDeniedError } from "../admission-model-scope";

/**
 * Shadow-call interception names one operator-chosen target (#5618). When that target stops
 * resolving (its provider disabled or deleted, its combo removed), the helper call must fail once,
 * clearly, before anything is sent. It must not pass through to the native model it was meant to
 * replace, and it must not reach the default provider through the router's last-resort fallback:
 * either would change the destination, the credentials and the cost without the operator choosing
 * it. A combo or routing-profile target keeps its own declared failover, which is the fallback the
 * operator approved.
 */
export const INTERCEPT_TARGET_UNAVAILABLE_CODE = "intercept_target_unavailable";

/** Non-retryable: the target stays unavailable until the operator changes the configuration. */
export const INTERCEPT_TARGET_UNAVAILABLE_STATUS = 409;

export type ShadowTargetResolution = { route: RouteResult } | { unavailable: string };

/**
 * Resolve the configured target. Admission-scope refusals, exhausted combos and policy
 * evaluations keep their existing responses, so they are rethrown to the caller's handler.
 */
export function resolveShadowCallTarget(
  model: string,
  resolve: (model: string) => RouteResult,
): ShadowTargetResolution {
  let route: RouteResult;
  try {
    route = resolve(model);
  } catch (error) {
    if (error instanceof AdmissionModelDeniedError
      || error instanceof NoAvailableComboTargetsError
      || error instanceof NoEligiblePolicyCandidateError) throw error;
    return { unavailable: error instanceof Error ? error.message : String(error) };
  }
  // A qualified target whose provider segment matched nothing reaches the default provider only
  // through the router's terminal fallback. A bare target resolved that way is the operator's
  // documented choice and stays valid.
  if (route.routeKind === "default-provider" && model.includes("/")) {
    return { unavailable: "it names no configured provider and would only reach the default provider" };
  }
  return { route };
}

const warnedTargets = new Set<string>();

export function interceptTargetUnavailableResponse(model: string, detail: string): Response {
  const message = `Shadow call intercept target "${model}" is unavailable: ${detail}. `
    + "Choose another target in the shadow call settings or re-enable its provider.";
  const key = `${model}\u0000${detail}`;
  if (!warnedTargets.has(key)) {
    warnedTargets.add(key);
    console.warn(`shadow-call: ${message}`);
  }
  return new Response(
    JSON.stringify({ error: { message, type: "invalid_request_error", code: INTERCEPT_TARGET_UNAVAILABLE_CODE } }),
    { status: INTERCEPT_TARGET_UNAVAILABLE_STATUS, headers: { "Content-Type": "application/json" } },
  );
}
