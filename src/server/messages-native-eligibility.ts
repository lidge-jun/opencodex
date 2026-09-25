/**
 * Whether a settled Messages route may take the managed native Messages lane (PF-08).
 *
 * PURE: reads the route, the body's structure and config, and nothing else. The Messages ingress,
 * `count_tokens` and the protocol planner (`src/protocols/plan-snapshot.ts`) all ask here, so a
 * preview, a count and the real send cannot disagree about the lane.
 */
import type { ProtocolReasonCode } from "../protocols/contract";
import { featuresFromMessagesBody } from "../protocols/features";
import { resolveProtocolSettings } from "../protocols/settings";
import type { RouteResult } from "../router";
import type { OcxConfig } from "../types";
import { requiresVisionPreprocessing } from "../vision";

/** Why the managed native Messages lane declines a route, as a protocol reason code. */
export type NativeMessagesDeclineReason = Extract<
  ProtocolReasonCode,
  | "rollout-disabled"
  | "cross-wire-ir"
  | "auth-mode-not-native"
  | "combo-or-policy-route"
  | "effort-row"
  | "fast-row"
  | "vision-preprocessing"
>;

/** Model-selector facts the body cannot carry: a synthetic effort or fast row was requested. */
export interface NativeMessagesSelector {
  effortRow?: boolean;
  fastRow?: boolean;
}

/**
 * The first rule that keeps a Messages request off the managed native lane, or `undefined` when
 * the route is eligible.
 *
 * - the `protocols.rollout.managedMessagesNative` switch is off;
 * - the final adapter is not `anthropic`;
 * - the credential is not a proxy-managed key (OAuth is PF-10; `forward` belongs to the caller);
 * - a combo or policy route owns multi-candidate execution in the Responses pipeline;
 * - a synthetic effort or fast row needs the adapter that owns its wire rewrite;
 * - an image would reach a model the operator declared unable to read it.
 */
export function nativeMessagesDeclineReason(
  route: RouteResult,
  body: Readonly<Record<string, unknown>>,
  config: OcxConfig,
  selector: NativeMessagesSelector = {},
): NativeMessagesDeclineReason | undefined {
  if (!resolveProtocolSettings(config).rollout.managedMessagesNative) return "rollout-disabled";
  const provider = route.provider;
  if (provider.adapter !== "anthropic") return "cross-wire-ir";
  if (provider.authMode !== undefined && provider.authMode !== "key") return "auth-mode-not-native";
  if (route.combo || route.routeKind === "combo" || route.routeKind === "policy") return "combo-or-policy-route";
  if (selector.effortRow) return "effort-row";
  if (selector.fastRow) return "fast-row";
  if (featuresFromMessagesBody(body).has("request.images")
    && requiresVisionPreprocessing(config, provider, route.modelId, route.providerName)) {
    return "vision-preprocessing";
  }
  return undefined;
}

export function isNativeMessagesRouteEligible(
  route: RouteResult,
  body: Readonly<Record<string, unknown>>,
  config: OcxConfig,
  selector?: NativeMessagesSelector,
): boolean {
  return nativeMessagesDeclineReason(route, body, config, selector) === undefined;
}
