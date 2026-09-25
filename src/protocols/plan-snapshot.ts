/**
 * Builds the planner's input from live config, for a preview that sends nothing.
 *
 * SERVER SIDE (not a leaf): this reads the router and the ingress eligibility rules so the
 * snapshot is the route the request would actually settle on. It must stay free of side
 * effects, which is why it does not simply call `routeModel` for every selector:
 *
 * - a combo selector would go through `tryPickComboModel`, which advances round-robin state.
 *   Combos are expanded here from their configured targets, each resolved with
 *   `routeConcreteModel` (no combo or policy lookup, no pick);
 * - a policy selector would run the evaluator, whose clock-dependent pick is not what a
 *   preview describes. Policies are expanded from their configured candidates the same way;
 * - every other selector takes `routeModel`'s deterministic branches, which read config and
 *   the last-known model cache and never fetch, refresh or write.
 *
 * Messages caller-forward passthrough depends on the caller's own Anthropic credential, which
 * a preview does not have; it is reported as `caller-credential-required`, never assumed.
 */
import { resolveInboundModel } from "../claude/inbound-model-options";
import { getCombo, preservesPhysicalComboProvider, resolveComboId } from "../combos";
import { captureRouteStaticPolicy, routeConcreteModel, routeModel, type RouteResult } from "../router";
import { getRoutingProfile, POLICY_NAMESPACE, resolvePolicyProfileId } from "../routing/profile";
import { resolveWireProtocolOverride } from "../server/adapter-resolve";
import { nativeChatDeclineReason } from "../server/chat-native-eligibility";
import { nativeMessagesDeclineReason } from "../server/messages-native-eligibility";
import { parseSyntheticRowId } from "../server/fast-row";
import type { OcxConfig } from "../types";
import { inboundWireForProtocol, type Protocol, type ProtocolReasonCode } from "./contract";
import type { ProtocolPlanV1 } from "./dto";
import type { ProtocolFeature } from "./features";
import { planProtocol, type ProtocolPlanCandidateInput, type ProtocolPlanInput } from "./plan";
import { protocolPolicyRevision, resolveApiSurfaceSettings, resolveProtocolSettings } from "./settings";

export interface ProtocolPlanRequest {
  model: string;
  inbound: Protocol;
  features: readonly ProtocolFeature[];
}

type SettledRouteKind = Exclude<ProtocolPlanV1["routeKind"], "unknown">;

interface SettledTargets {
  routeKind: SettledRouteKind;
  routes: RouteResult[];
}

function concreteRoutes(config: OcxConfig, targets: readonly { provider: string; model: string }[]): RouteResult[] {
  const routes: RouteResult[] = [];
  for (const target of targets) {
    try {
      routes.push(routeConcreteModel(config, `${target.provider}/${target.model}`));
    } catch {
      // An unconfigured or disabled target is skipped at dispatch time as well.
    }
  }
  return routes;
}

/** The route targets a selector settles on, or `undefined` when nothing routes it. */
function settleTargets(config: OcxConfig, modelId: string): SettledTargets | undefined {
  const policyId = resolvePolicyProfileId(config, modelId);
  if (policyId !== null || modelId.startsWith(`${POLICY_NAMESPACE}/`)) {
    const profile = policyId ? getRoutingProfile(config, policyId) : undefined;
    return profile ? { routeKind: "policy", routes: concreteRoutes(config, profile.candidates) } : undefined;
  }
  if (!preservesPhysicalComboProvider(config)) {
    const comboId = resolveComboId(config, modelId);
    if (comboId !== null) {
      const combo = getCombo(config, comboId);
      return combo ? { routeKind: "combo", routes: concreteRoutes(config, combo.targets) } : undefined;
    }
  }
  try {
    return { routeKind: "direct", routes: [routeModel(config, modelId)] };
  } catch {
    return undefined;
  }
}

/**
 * A structural stand-in for a Chat body carrying the requested features, for the
 * eligibility rules that inspect the body. Never derived from a real request.
 */
function chatBodyForFeatures(features: ReadonlySet<ProtocolFeature>): Record<string, unknown> {
  const content = features.has("request.images")
    ? [{ type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }]
    : "";
  return {
    messages: [{ role: "user", content }],
    ...(features.has("request.tools") ? { tools: [{ type: "function", function: { name: "preview" } }] } : {}),
  };
}

/** The Messages counterpart of `chatBodyForFeatures`. */
function messagesBodyForFeatures(features: ReadonlySet<ProtocolFeature>): Record<string, unknown> {
  const content = features.has("request.images")
    ? [{ type: "image", source: { type: "base64", media_type: "image/png", data: "AA==" } }]
    : "";
  return { messages: [{ role: "user", content }] };
}

interface SyntheticRows {
  effortRow: boolean;
  fastRow: boolean;
  /** The resolved selector the bridge would parse; the effort pin reads it. */
  routeSelector: string;
}

function candidateFor(
  config: OcxConfig,
  inbound: Protocol,
  route: RouteResult,
  routeKind: SettledRouteKind,
  features: ReadonlySet<ProtocolFeature>,
  rows: SyntheticRows,
): ProtocolPlanCandidateInput {
  const wire = inboundWireForProtocol(inbound);
  // The same two steps every ingress runs: recapture static policy for the original inbound,
  // then settle the wire from it.
  const staticPolicy = captureRouteStaticPolicy(
    route.providerName, route.modelId, route.provider, route.staticPolicy.effectiveAlias, wire,
  );
  const provider = resolveWireProtocolOverride(route.providerName, route.modelId, route.provider, wire, staticPolicy);
  const adapter = provider.adapter ?? "openai-responses";
  let declineReasons: ProtocolReasonCode[] = [];
  let nativeEligible = false;
  // With `nativeChatCombos` on, the combo loop judges each Chat candidate as the concrete route it
  // is (PF-07), so the preview must too; a policy still resolves one candidate on the bridge.
  const comboChildNative = inbound === "chat" && routeKind === "combo"
    && resolveProtocolSettings(config).rollout.nativeChatCombos;
  const settled: RouteResult = {
    ...route,
    provider,
    staticPolicy,
    ...(routeKind === "direct" || comboChildNative ? {} : { routeKind }),
  };
  if (inbound === "chat") {
    const reason = rows.effortRow ? "effort-row" : nativeChatDeclineReason(settled, chatBodyForFeatures(features), config);
    nativeEligible = reason === undefined;
    if (reason) declineReasons = [reason];
  } else if (inbound === "messages" && resolveProtocolSettings(config).rollout.managedMessagesNative) {
    // The runtime rule itself. With the switch off nothing is judged, so the default preview
    // is exactly what it was before the managed native lane existed.
    // Pinned effort is judged from config and the route; blocked-skill elision and the web-search
    // sidecar depend on body content no feature describes, so a preview cannot predict them.
    // Anthropic OAuth (PF-10) is judged from config alone: the rollout switch, the provider, its
    // host and `anthropicAccountPool.enabled`. The stored-account quorum a sender supplies is
    // never read here, so a preview selects, resolves and refreshes no account.
    const reason = nativeMessagesDeclineReason(settled, messagesBodyForFeatures(features), config, {
      ...rows,
      claudeCode: config.claudeCode,
    });
    nativeEligible = reason === undefined;
    if (reason) declineReasons = [reason];
  }
  return { provider: route.providerName, model: route.modelId, adapter, nativeEligible, declineReasons };
}

/** Whether the Messages ingress could forward this selector with a caller's own credential. */
function messagesPassthroughPossible(config: OcxConfig, model: string): boolean {
  if (config.claudeCode?.nativePassthrough === false) return false;
  if (!/^(claude|anthropic)/i.test(model)) return false;
  try {
    return resolveInboundModel(model, config.claudeCode) === model;
  } catch {
    return false;
  }
}

export function buildProtocolPlanSnapshot(
  config: OcxConfig,
  request: ProtocolPlanRequest,
  basis: ProtocolPlanV1["basis"] = "preview",
): ProtocolPlanInput {
  const base = {
    inbound: request.inbound,
    requestedModel: request.model,
    features: [...request.features],
    surfaces: resolveApiSurfaceSettings(config),
    settings: resolveProtocolSettings(config),
    policyRevision: protocolPolicyRevision(config),
    basis,
  };
  const reasonCodes: ProtocolReasonCode[] = [];
  let routeKey = request.model;
  let effortRow = false;
  let fastRow = false;
  let syntheticRow = false;
  try {
    const parsed = parseSyntheticRowId(request.model, config);
    if (parsed.effortRow) {
      routeKey = parsed.effortRow.baseId;
      effortRow = true;
      syntheticRow = true;
    } else if (parsed.fastRow) {
      routeKey = parsed.fastRow.baseId;
      fastRow = true;
      syntheticRow = true;
    }
  } catch {
    // An unparseable synthetic id routes as written, exactly as the ingress falls through.
  }
  if (request.inbound === "messages") {
    // A synthetic row needs the proxy-owned adapter, so it never takes the passthrough.
    if (!syntheticRow && messagesPassthroughPossible(config, request.model)) reasonCodes.push("caller-credential-required");
    try {
      routeKey = resolveInboundModel(routeKey, config.claudeCode);
    } catch {
      return { ...base, routeKind: "unknown", candidates: [], reasonCodes };
    }
  }
  const settled = settleTargets(config, routeKey);
  if (!settled || settled.routes.length === 0) return { ...base, routeKind: "unknown", candidates: [], reasonCodes };
  const features = new Set(request.features);
  return {
    ...base,
    routeKind: settled.routeKind,
    candidates: settled.routes.map(route => candidateFor(config, request.inbound, route, settled.routeKind, features, { effortRow, fastRow, routeSelector: routeKey })),
    reasonCodes,
  };
}

/** A preview plan for one selector, computed from config alone. */
export function previewProtocolPlan(config: OcxConfig, request: ProtocolPlanRequest): ProtocolPlanV1 {
  return planProtocol(buildProtocolPlanSnapshot(config, request, "preview"));
}
