/**
 * Whether a settled Messages route may take the managed native Messages lane (PF-08).
 *
 * PURE: reads the route, the body's structure and config, and nothing else. The Messages ingress,
 * `count_tokens` and the protocol planner (`src/protocols/plan-snapshot.ts`) all ask here, so a
 * preview, a count and the real send cannot disagree about the lane.
 */
import { anthropicBodyElidesBlockedSkill } from "../claude/inbound";
import { isClaudeWebSearchToolName } from "../claude/outbound";
import { isAnthropicAccountPoolEnabled } from "../oauth/anthropic-routing";
import type { ProtocolReasonCode } from "../protocols/contract";
import { featuresFromMessagesBody } from "../protocols/features";
import { credentialDomainFor } from "../protocols/opaque-state";
import { resolveProtocolSettings } from "../protocols/settings";
import type { RouteResult } from "../router";
import type { OcxConfig } from "../types";
import { requiresVisionPreprocessing } from "../vision";
import { resolvePinnedEffort } from "./effort-policy";

/** Why the managed native Messages lane declines a route, as a protocol reason code. */
export type NativeMessagesDeclineReason = Extract<
  ProtocolReasonCode,
  | "rollout-disabled"
  | "cross-wire-ir"
  | "auth-mode-not-native"
  | "oauth-account-pool"
  | "combo-or-policy-route"
  | "effort-row"
  | "fast-row"
  | "vision-preprocessing"
  | "bridge-only-policy"
>;

/** Request facts the body cannot carry. */
export interface NativeMessagesSelector {
  /** A synthetic effort row was requested. */
  effortRow?: boolean;
  /** A synthetic fast row was requested. */
  fastRow?: boolean;
  /** The model id the bridge would parse (the translated body's `model`), for the effort pin. */
  routeSelector?: string;
  /** The Claude settings this ingress reads (intercept bindings applied); defaults to config's. */
  claudeCode?: OcxConfig["claudeCode"];
  /**
   * Runtime fact, supplied by a caller that is about to send: two or more usable Anthropic OAuth
   * accounts are stored, so the bridge would rotate accounts on a 429
   * (`hasAnthropicFailoverQuorum`). It reads the account store, so the planner never supplies it
   * and judges OAuth from config alone.
   */
  oauthFailoverQuorum?: boolean;
}

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Whether the bridge could hand this request to the web-search sidecar: a `web_search*` server
 * tool the tool choice does not exclude, with the sidecar not disabled in the Claude replay config
 * (`buildClaudeReplayConfig` merges `claudeCode.webSearchSidecar` over the global block). Whether
 * a backend credential then exists is decided at dispatch and is not read here, so this errs
 * toward the bridge, which is today's behavior for every such request.
 */
function webSearchSidecarMayEngage(body: Readonly<Rec>, config: OcxConfig): boolean {
  const sidecar = { ...config.webSearchSidecar, ...config.claudeCode?.webSearchSidecar };
  if (sidecar.enabled === false) return false;
  if (!Array.isArray(body.tools)) return false;
  const declared = body.tools.some(tool => isRec(tool) && typeof tool.type === "string" && tool.type.startsWith("web_search"));
  if (!declared) return false;
  const choice = body.tool_choice;
  if (isRec(choice)) {
    if (choice.type === "none") return false;
    if (choice.type === "tool") return typeof choice.name === "string" && isClaudeWebSearchToolName(choice.name);
  }
  return true;
}

/**
 * Operator policy the translated path applies and the native lane would skip: a pinned
 * reasoning effort for the route, a blocked-skill bundle the translator would elide, or the
 * web-search sidecar. Any of them keeps the request on the bridge.
 */
function bridgeOnlyPolicyApplies(
  route: RouteResult,
  body: Readonly<Rec>,
  config: OcxConfig,
  selector: NativeMessagesSelector,
): boolean {
  if (resolvePinnedEffort(route, selector.routeSelector, config) !== undefined) return true;
  if (anthropicBodyElidesBlockedSkill(body, selector.claudeCode ?? config.claudeCode)) return true;
  return webSearchSidecarMayEngage(body, config);
}

/**
 * The credential rule. A proxy-managed key is native since PF-08. An Anthropic OAuth account
 * is native only with `managedMessagesNativeOAuth` on (itself effective only with
 * `managedMessagesNative`), only for the `anthropic` provider the OAuth store serves, and only
 * to `api.anthropic.com`. A pooled account set declines: rotation, session affinity and quota
 * ranking live in the Responses pipeline's transport and are not replicated here. `forward`
 * belongs to the caller.
 */
function credentialDeclineReason(
  route: RouteResult,
  config: OcxConfig,
  selector: NativeMessagesSelector,
): NativeMessagesDeclineReason | undefined {
  const provider = route.provider;
  if (provider.authMode === undefined || provider.authMode === "key") return undefined;
  if (provider.authMode !== "oauth") return "auth-mode-not-native";
  if (!resolveProtocolSettings(config).rollout.managedMessagesNativeOAuth) return "auth-mode-not-native";
  if (route.providerName !== "anthropic") return "auth-mode-not-native";
  if (!credentialDomainFor(provider)?.firstPartyAnthropic) return "auth-mode-not-native";
  if (isAnthropicAccountPoolEnabled(config) || selector.oauthFailoverQuorum === true) return "oauth-account-pool";
  return undefined;
}

/**
 * The first rule that keeps a Messages request off the managed native lane, or `undefined` when
 * the route is eligible.
 *
 * - the `protocols.rollout.managedMessagesNative` switch is off;
 * - the final adapter is not `anthropic`;
 * - the credential is neither a proxy-managed key nor an eligible Anthropic OAuth account
 *   (`credentialDeclineReason`); a pooled OAuth account set is `oauth-account-pool`;
 * - a combo or policy route owns multi-candidate execution in the Responses pipeline;
 * - a synthetic effort or fast row needs the adapter that owns its wire rewrite;
 * - an image would reach a model the operator declared unable to read it;
 * - operator policy only the bridge applies would engage (pinned effort, blocked-skill elision,
 *   the web-search sidecar).
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
  const credentialDecline = credentialDeclineReason(route, config, selector);
  if (credentialDecline) return credentialDecline;
  if (route.combo || route.routeKind === "combo" || route.routeKind === "policy") return "combo-or-policy-route";
  if (selector.effortRow) return "effort-row";
  if (selector.fastRow) return "fast-row";
  if (featuresFromMessagesBody(body).has("request.images")
    && requiresVisionPreprocessing(config, provider, route.modelId, route.providerName)) {
    return "vision-preprocessing";
  }
  if (bridgeOnlyPolicyApplies(route, body, config, selector)) return "bridge-only-policy";
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
