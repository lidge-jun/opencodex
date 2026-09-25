import { chatBodyCarriesImage, chatBodyCarriesToolResultImage } from "../chat/image-parts";
import type { ProtocolReasonCode } from "../protocols/contract";
import type { RouteResult } from "../router";
import type { OcxConfig } from "../types";
import { isModelTextOnly, requiresVisionPreprocessing } from "../vision";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Why the native Chat lane declines a route, as a protocol reason code. */
export type NativeChatDeclineReason = Extract<
  ProtocolReasonCode,
  | "cross-wire-ir"
  | "auth-mode-not-native"
  | "combo-or-policy-route"
  | "responses-only-feature"
  | "tool-result-image"
  | "vision-preprocessing"
  | "hosted-tool"
>;

/**
 * The first rule that keeps a Chat request off the native Chat lane, or `undefined` when the
 * route is eligible. The order is the order the checks always ran in, so the reason reported is
 * the one that actually decided.
 */
export function nativeChatDeclineReason(
  route: RouteResult,
  rawBody: Rec,
  config?: OcxConfig,
): NativeChatDeclineReason | undefined {
  const provider = route.provider;
  if (provider.adapter !== "openai-chat") return "cross-wire-ir";
  if (provider.authMode !== undefined && provider.authMode !== "key" && provider.authMode !== "local") return "auth-mode-not-native";
  // Combo and policy execution own multi-candidate retries in the Responses pipeline.
  if (route.combo || route.routeKind === "combo" || route.routeKind === "policy") return "combo-or-policy-route";
  if (rawBody.store === true || rawBody.background === true) return "responses-only-feature";
  if (typeof rawBody.previous_response_id === "string" && rawBody.previous_response_id.length > 0) return "responses-only-feature";
  if (rawBody.compaction_trigger !== undefined) return "responses-only-feature";
  // A standard Chat tool message accepts a string or text parts, not image_url, so
  // normalizing a Pi/Anthropic tool image into image_url is not enough on its own —
  // the part is still inside a tool message. The translated adapter already places
  // tool-result images in a following user carrier after the complete paired batch
  // (flushToolResultImages), so divert these requests there. Ordinary user images and
  // text-only tool results keep the native fast path.
  if (chatBodyCarriesToolResultImage(rawBody)) return "tool-result-image";
  // Vision sidecar coverage (roadmap 180): a text-only routed model with an
  // image-bearing body must go through the Responses pipeline, whose plan
  // site describes or strips the image. The native fast path has no vision
  // handling, so letting it keep such a request forwards raw pixels to a
  // model the operator declared blind.
  if (chatBodyCarriesImage(rawBody)) {
    const needsVision = config
      ? requiresVisionPreprocessing(config, provider, route.modelId, route.providerName)
      : isModelTextOnly(provider, route.modelId);
    if (needsVision) return "vision-preprocessing";
  }
  if (Array.isArray(rawBody.tools)) {
    for (const tool of rawBody.tools) {
      if (!isRec(tool)) continue;
      if (tool.type === "web_search" || tool.type === "web_search_preview" || tool.type === "image_generation") {
        return "hosted-tool";
      }
    }
  }
  return undefined;
}

export function isNativeChatRouteEligible(route: RouteResult, rawBody: Rec, config?: OcxConfig): boolean {
  return nativeChatDeclineReason(route, rawBody, config) === undefined;
}
