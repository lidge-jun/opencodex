import type { OcxConfig, OcxParsedRequest, OcxProviderConfig } from "../../types";
import { nativeEffortClamp, shouldApplyNativeEffortClamp } from "../../codex/catalog";
import { applyEffortCap, applyPinnedEffort, effortCapAppliesTo, prepareEffortNormalization, stripEmptyLadderEffort, supportedLadderFor } from "../effort-policy";
import { collabSurface } from "./collaboration";
import { mapRoutedResponsesReasoningEffort, normalizeConfiguredReasoningSummaryDelivery,
  stripDisabledReasoningSummaries, stripDisabledVerbosity, stripUnsupportedReasoningSummaryDelivery } from "../../adapters/openai-responses/reasoning";
import { NativeSteeringError } from "./native-steering";
import { nativeResponseRecord as record } from "./native-response-json";
import { STEERING_MUTABLE_SETTINGS } from "./native-steering-settings";

type Frame = Record<string, unknown>;

/** Reuse normal route-specific policy on a private override, never reroute or rebuild saved tool results. */
export function createSteeringSettingsNormalizer(
  parsed: OcxParsedRequest,
  route: { provider: OcxProviderConfig; providerName: string; modelId: string },
  config: OcxConfig,
  headers: Headers,
): (frame: Frame) => Frame {
  const selector = prepareEffortNormalization(parsed, route);
  const surface = collabSurface(parsed);
  return (frame: Frame): Frame => {
    if (route.provider.authMode === "forward" && Object.hasOwn(frame, "max_output_tokens")) {
      throw new NativeSteeringError("steering_settings_unsupported", "This subscription route does not accept max_output_tokens; omit that override.");
    }
    // The frame is cloned by the channel. Policy receives only generation keys,
    // not saved results, tool declarations, credentials or caller response IDs.
    let body: Frame = Object.fromEntries(STEERING_MUTABLE_SETTINGS.filter(key => Object.hasOwn(frame, key)).map(key => [key, frame[key]]));
    if (Object.hasOwn(body, "reasoning")) {
      const candidate = { ...parsed, options: { ...parsed.options,
        reasoning: record(body.reasoning) && typeof body.reasoning.effort === "string" ? body.reasoning.effort : undefined }, _rawBody: body };
      applyPinnedEffort(candidate, route, config, selector);
      if (effortCapAppliesTo(surface, headers, config, parsed._compactionRequest === true)) {
        applyEffortCap(candidate, headers, config, supportedLadderFor(route));
      }
      const clamp = shouldApplyNativeEffortClamp(route.providerName, route.provider, route.modelId)
        ? nativeEffortClamp(route.modelId, candidate.options.reasoning) : null;
      if (clamp && record(body.reasoning)) body.reasoning.effort = clamp;
      body = mapRoutedResponsesReasoningEffort(body, route.provider, route.modelId) as Frame;
      body.reasoning = stripEmptyLadderEffort(body.reasoning, supportedLadderFor(route));
    }
    body = stripDisabledVerbosity(stripDisabledReasoningSummaries(
      normalizeConfiguredReasoningSummaryDelivery(stripUnsupportedReasoningSummaryDelivery(body, route.modelId), route.provider, route.modelId),
      route.provider, route.modelId), route.provider, route.modelId) as Frame;
    const next = { ...frame };
    for (const key of STEERING_MUTABLE_SETTINGS) if (Object.hasOwn(frame, key)) next[key] = body[key];
    return next;
  };
}
