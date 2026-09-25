/**
 * The protocol planner: given a snapshot of what the router settled, predict the path each
 * candidate would take, what it does to the request's features, and whether it would be
 * refused under the unrepresentable policy.
 *
 * LEAF MODULE (see `contract.ts`) and PURE. The planner never selects a provider and never
 * reads config; `plan-snapshot.ts` builds its input on the server. Paths come from
 * `path.ts`, the same rule the observed trace uses, so a preview and the log of the same
 * request cannot disagree about how a lane maps to hops. Settings and surfaces are taken
 * structurally rather than imported from `settings.ts`, which reads config types and is
 * therefore not a leaf.
 */
import { PROTOCOL_CONTRACT_VERSION, upstreamWireForAdapter, type Protocol, type ProtocolReasonCode } from "./contract";
import {
  PROTOCOL_DTO_LIMITS,
  PROTOCOL_PLAN_SCHEMA_VERSION,
  type ProtocolPlanCandidateV1,
  type ProtocolPlanV1,
} from "./dto";
import { featureEffectsForPath, PROTOCOL_FEATURES, unrepresentableFeatures, type ProtocolFeature } from "./features";
import { deliveryModeForLane, requestPathForLane, responsePathForLane, type ProtocolLane } from "./path";

/** One settled route target, as the server resolved it. */
export interface ProtocolPlanCandidateInput {
  provider: string;
  model: string;
  /** Final adapter id after the wire override for this inbound. */
  adapter: string;
  /** True when the ingress would send its own wire to this candidate. */
  nativeEligible: boolean;
  /** Why the ingress declined its native lane, when it did. */
  declineReasons: readonly ProtocolReasonCode[];
}

export interface ProtocolPlanInput {
  inbound: Protocol;
  requestedModel: string;
  routeKind: ProtocolPlanV1["routeKind"];
  candidates: readonly ProtocolPlanCandidateInput[];
  features: readonly ProtocolFeature[];
  surfaces: Readonly<Record<Protocol, { readonly enabled: boolean }>>;
  settings: { readonly unrepresentable: "legacy" | "reject" };
  policyRevision: string;
  basis: ProtocolPlanV1["basis"];
  /** Plan-level reasons the snapshot observed, such as `caller-credential-required`. */
  reasonCodes?: readonly ProtocolReasonCode[];
}

function bounded(codes: Iterable<ProtocolReasonCode>): ProtocolReasonCode[] {
  return [...new Set(codes)].slice(0, PROTOCOL_DTO_LIMITS.reasonCodes);
}

function orderedFeatures(features: Iterable<ProtocolFeature>): ProtocolFeature[] {
  const present = new Set(features);
  return PROTOCOL_FEATURES.filter(feature => present.has(feature));
}

function blockedCandidate(candidate: ProtocolPlanCandidateInput, reason: ProtocolReasonCode): ProtocolPlanCandidateV1 {
  return {
    provider: candidate.provider,
    model: candidate.model,
    adapter: candidate.adapter,
    upstream: upstreamWireForAdapter(candidate.adapter),
    mode: "blocked",
    requestPath: [],
    responsePath: [],
    fidelity: "unknown",
    reasonCodes: [reason],
    featureEffects: [],
    unknownFeatures: [],
    eligible: false,
  };
}

function planCandidate(
  input: ProtocolPlanInput,
  candidate: ProtocolPlanCandidateInput,
  features: readonly ProtocolFeature[],
): ProtocolPlanCandidateV1 {
  const upstream = upstreamWireForAdapter(candidate.adapter);
  // A native lane only exists toward the ingress's own wire; an inconsistent snapshot must
  // not produce a path that claims the source body reached a different wire untouched.
  const lane: ProtocolLane = candidate.nativeEligible && upstream === input.inbound ? "native" : "bridge";
  const requestPath = requestPathForLane(input.inbound, lane, upstream);
  const responsePath = responsePathForLane(input.inbound, lane, upstream);
  const mode = deliveryModeForLane(input.inbound, lane, upstream);
  const effects = featureEffectsForPath(input.inbound, requestPath, features);
  const eligible = input.settings.unrepresentable !== "reject" || unrepresentableFeatures(effects.effects).length === 0;

  const reasons: ProtocolReasonCode[] = [];
  if (mode === "native") reasons.push("same-wire-native");
  else if (mode === "translated") reasons.push(requestPath.length === 2 ? "cross-wire-codec" : "cross-wire-ir");
  else reasons.push("not-migrated");
  if (upstream === "other") reasons.push("upstream-other");
  // Why the native lane was declined matters only where a native lane could exist: toward a
  // different wire the path reason above already says it.
  if (lane === "bridge" && input.inbound !== "responses" && upstream === input.inbound) {
    reasons.push(...candidate.declineReasons);
  }
  if (!eligible) reasons.push("feature-unrepresentable");

  return {
    provider: candidate.provider,
    model: candidate.model,
    adapter: candidate.adapter,
    upstream,
    mode,
    requestPath,
    responsePath,
    fidelity: effects.fidelity,
    reasonCodes: bounded(reasons),
    featureEffects: effects.effects.map(effect => ({ feature: effect.feature, disposition: effect.disposition })),
    unknownFeatures: effects.unknown,
    eligible,
  };
}

/** Features preserved (passthrough or translated) by every / by only some eligible candidates. */
function featureSplit(
  eligible: readonly ProtocolPlanCandidateV1[],
  features: readonly ProtocolFeature[],
): { guaranteed: ProtocolFeature[]; partial: ProtocolFeature[] } {
  const guaranteed: ProtocolFeature[] = [];
  const partial: ProtocolFeature[] = [];
  if (eligible.length === 0) return { guaranteed, partial };
  for (const feature of features) {
    let preserved = 0;
    for (const candidate of eligible) {
      const effect = candidate.featureEffects.find(entry => entry.feature === feature);
      if (effect && (effect.disposition === "passthrough" || effect.disposition === "translated")) preserved++;
    }
    if (preserved === eligible.length) guaranteed.push(feature);
    else if (preserved > 0) partial.push(feature);
  }
  return { guaranteed, partial };
}

export function planProtocol(input: ProtocolPlanInput): ProtocolPlanV1 {
  const features = orderedFeatures(input.features);
  const snapshotCandidates = input.candidates.slice(0, PROTOCOL_DTO_LIMITS.candidates);
  const base = {
    schemaVersion: PROTOCOL_PLAN_SCHEMA_VERSION,
    basis: input.basis,
    contractVersion: PROTOCOL_CONTRACT_VERSION,
    policyRevision: input.policyRevision,
    inbound: input.inbound,
    requestedModel: input.requestedModel,
    routeKind: input.routeKind,
  } as const;

  if (!input.surfaces[input.inbound].enabled) {
    return {
      ...base,
      mode: "blocked",
      reasonCodes: ["surface-disabled"],
      candidates: snapshotCandidates.map(candidate => blockedCandidate(candidate, "surface-disabled")),
      guaranteedFeatures: [],
      partialFeatures: [],
    };
  }

  if (input.routeKind === "unknown" || snapshotCandidates.length === 0) {
    return {
      ...base,
      mode: "blocked",
      reasonCodes: bounded([...(input.reasonCodes ?? []), "unknown-model"]),
      candidates: [],
      guaranteedFeatures: [],
      partialFeatures: [],
    };
  }

  const candidates = snapshotCandidates.map(candidate => planCandidate(input, candidate, features));
  const eligible = candidates.filter(candidate => candidate.eligible);
  const first = eligible[0];
  const { guaranteed, partial } = featureSplit(eligible, features);
  const routeReasons: ProtocolReasonCode[] = input.routeKind === "combo" || input.routeKind === "policy"
    ? ["combo-or-policy-route"]
    : [];
  return {
    ...base,
    mode: first ? first.mode : "blocked",
    reasonCodes: bounded([
      ...(input.reasonCodes ?? []),
      ...routeReasons,
      ...(first ? first.reasonCodes : ["feature-unrepresentable" as const]),
    ]),
    candidates,
    guaranteedFeatures: guaranteed,
    partialFeatures: partial,
  };
}
