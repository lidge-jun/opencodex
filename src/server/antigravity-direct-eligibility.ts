/**
 * Whether a settled Chat route may take the Antigravity direct lane.
 *
 * On that lane the Chat ingress hands the Responses core a body that carries only the request
 * settings (model, stream, reasoning, limits, tool choice, tier) and decodes the conversation
 * straight from the Chat body into the IR at the parse seam (`src/protocols/codecs/chat-ir.ts`),
 * so the Google adapter compiles from the caller's own messages. Everything that is decided from
 * those settings keeps its current owner in the core: routing, account rotation, effort policy,
 * usage and logging.
 *
 * PURE: reads the route, the body's structure and config. The Chat ingress and the protocol
 * planner (`src/protocols/plan-snapshot.ts`) both ask here, so a preview and the real send cannot
 * disagree about the lane.
 */
import { chatBodyCarriesImage } from "../chat/image-parts";
import { contentToText } from "../chat/inbound";
import { isShadowSourceModel } from "../lib/shadow-call";
import type { ProtocolReasonCode } from "../protocols/contract";
import { resolveProtocolSettings } from "../protocols/settings";
import { effectiveGoogleMode } from "../providers/registry";
import type { RouteResult } from "../router";
import type { OcxConfig } from "../types";
import { requiresVisionPreprocessing } from "../vision";

/** Why the Antigravity direct lane declines a route, as a protocol reason code. */
export type AntigravityDirectDeclineReason = Extract<
  ProtocolReasonCode,
  | "rollout-disabled"
  | "not-migrated"
  | "combo-or-policy-route"
  | "hosted-tool"
  | "vision-preprocessing"
  | "bridge-only-policy"
>;

type Rec = Record<string, unknown>;
function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type RouteShape = Pick<RouteResult, "providerName" | "modelId" | "provider" | "combo" | "routeKind">;

/** A Google adapter route in Cloud Code Assist mode: the Antigravity wire. */
export function isAntigravityRoute(route: Pick<RouteResult, "providerName" | "provider">): boolean {
  return effectiveGoogleMode(route.providerName, route.provider) === "cloud-code-assist";
}

/**
 * A hosted web-search tool the bridge would hand to the web-search sidecar. The sidecar reads
 * the hosted tool from the parsed Responses body, which this lane does not build.
 */
function declaresHostedWebSearch(body: Readonly<Rec>): boolean {
  return Array.isArray(body.tools)
    && body.tools.some(tool => isRec(tool) && (tool.type === "web_search" || tool.type === "web_search_preview"));
}

/**
 * The shadow-call intercept rewrites the model to another target (often a combo) before the
 * core parses the body, so the request would leave the route this lane was decided for.
 */
function shadowInterceptMayApply(body: Readonly<Rec>, config: OcxConfig): boolean {
  const intercept = config.shadowCallIntercept;
  return intercept?.enabled === true && typeof intercept.model === "string" && intercept.model.length > 0
    && typeof body.model === "string" && isShadowSourceModel(body.model, intercept.sourceModels);
}

const SKILLS_CATALOG_MARKER = "<skills_instructions>";
const GENERATED_IMAGE_LINK = "![Generated image](<";

/**
 * Text the Responses core rewrites on the bridge body before parsing: a skills catalog in an
 * instruction (the per-session skills snapshot substitutes a stored block) and a generated-image
 * link in assistant history (hosted display paths are redacted to the artifact URL). The lane's
 * settings-only body has neither, so such a request keeps the bridge.
 */
function carriesBridgeRewrittenText(body: Readonly<Rec>): boolean {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some(message => {
    if (!isRec(message)) return false;
    if (message.role === "system" || message.role === "developer") {
      return contentToText(message.content).includes(SKILLS_CATALOG_MARKER);
    }
    if (message.role === "assistant") return contentToText(message.content).includes(GENERATED_IMAGE_LINK);
    return false;
  });
}

/** Request facts the body and config cannot carry, supplied by a caller that is about to send. */
export interface AntigravityDirectRuntime {
  /**
   * The cache diagnostic recorder is observing inbound bodies. It records the body the core
   * receives, which on the lane has no conversation, so the request keeps the bridge while it
   * observes. The planner never supplies this.
   */
  cacheDiagnostics?: boolean;
}

/**
 * The first rule that keeps a Chat request off the Antigravity direct lane, or `undefined` when
 * the route is eligible.
 *
 * - the `protocols.rollout.antigravityDirect` switch is off;
 * - the final adapter is not Google in Cloud Code Assist mode;
 * - a combo or policy route owns multi-candidate execution in the Responses pipeline;
 * - a hosted web-search tool would engage the sidecar, which reads the Responses body;
 * - an image would reach a model the operator declared unable to read it (the vision sidecar
 *   rewrites images on the Responses body as well as the IR);
 * - the shadow-call intercept could move the request to another target before parsing.
 * - the core would rewrite conversation text on the bridge body (a skills catalog, a generated
 *   image link), or the cache diagnostic recorder is observing.
 */
export function antigravityDirectDeclineReason(
  route: RouteShape,
  body: Readonly<Rec>,
  config: OcxConfig,
  runtime: AntigravityDirectRuntime = {},
): AntigravityDirectDeclineReason | undefined {
  if (!resolveProtocolSettings(config).rollout.antigravityDirect) return "rollout-disabled";
  if (!isAntigravityRoute(route)) return "not-migrated";
  if (route.combo !== undefined || route.routeKind === "combo" || route.routeKind === "policy") return "combo-or-policy-route";
  if (declaresHostedWebSearch(body)) return "hosted-tool";
  if (chatBodyCarriesImage(body) && requiresVisionPreprocessing(config, route.provider, route.modelId, route.providerName)) {
    return "vision-preprocessing";
  }
  if (shadowInterceptMayApply(body, config)) return "bridge-only-policy";
  if (carriesBridgeRewrittenText(body) || runtime.cacheDiagnostics === true) return "bridge-only-policy";
  return undefined;
}
