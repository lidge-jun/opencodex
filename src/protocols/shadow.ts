/**
 * Shadow-plan comparison (PF-12, `protocols.rollout.shadowPlan`): does the dispatch-basis plan
 * for a request agree with what the request actually did?
 *
 * LEAF MODULE (see `contract.ts`) and PURE. It compares two finished records and nothing else:
 * no second request, no config read, no state. The caller (`trace.ts`) contains any throw.
 *
 * What is compared, and why only that:
 *
 * - The candidate is the one the request settled on (provider and model of the final route),
 *   falling back to the plan's first eligible candidate. A combo that failed over is compared
 *   against the target that answered, not against the first one the plan lists.
 * - Mode, upstream wire and request path. The response path is not compared: with
 *   `directEncoders` on, the client side leaves the internal Responses hop while the request
 *   side keeps it, and the planner does not model the encoder switch.
 * - A Messages request forwarded with the caller's own Anthropic credential is native by the
 *   caller's choice; the plan says so with `caller-credential-required` and never predicts it.
 * - A blocked trace agrees with a blocked plan. A compatibility reject is Claude-integration
 *   policy the planner does not model, so it is not compared.
 */
import type { ProtocolHop } from "./contract";
import type { ProtocolPlanCandidateV1, ProtocolPlanV1, ProtocolTraceV1 } from "./dto";

/** The route the request settled on, as the request log context records it. */
export interface ShadowSettledRoute {
  provider?: string;
  model?: string;
}

function samePath(a: readonly ProtocolHop[], b: readonly ProtocolHop[]): boolean {
  return a.length === b.length && a.every((hop, index) => hop === b[index]);
}

function settledCandidate(plan: ProtocolPlanV1, settled: ShadowSettledRoute): ProtocolPlanCandidateV1 | undefined {
  const exact = settled.provider && settled.model
    ? plan.candidates.find(candidate => candidate.provider === settled.provider && candidate.model === settled.model)
    : undefined;
  return exact ?? plan.candidates.find(candidate => candidate.eligible);
}

/** True when the plan and the observed trace disagree about the path the request took. */
export function shadowPlanMismatch(
  plan: ProtocolPlanV1,
  trace: ProtocolTraceV1,
  settled: ShadowSettledRoute = {},
): boolean {
  if (plan.inbound !== trace.inbound) return true;
  if (trace.mode === "blocked") {
    if (trace.reasonCodes.includes("compatibility-reject")) return false;
    return plan.mode !== "blocked";
  }
  if (trace.inbound === "messages" && trace.mode === "native"
    && plan.reasonCodes.includes("caller-credential-required")
    && samePath(trace.requestPath, ["messages", "messages"])) {
    return false;
  }
  const candidate = settledCandidate(plan, settled);
  if (!candidate || candidate.mode === "blocked") return true;
  return candidate.mode !== trace.mode
    || candidate.upstream !== trace.upstream
    || !samePath(candidate.requestPath, trace.requestPath);
}
