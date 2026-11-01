import {
  boundEntryIdForLane,
  recordProviderCacheAffinity,
  releaseProviderCacheAffinity,
} from "../providers/cache-affinity";
import { isAnthropicBillingFailure } from "../providers/anthropic-billing-refusal";
import type { OcxUsage } from "../types";
import type { RequestLogContext } from "./request-log";

/** Finalize against the serving credential, never a logical combo's display label. */
export function finalizeProviderCacheAffinity(
  logCtx: RequestLogContext,
  status: number,
  usage: OcxUsage | undefined,
): void {
  const {
    affinityLane: lane,
    affinityKeyEntryId: entryId,
    affinityProviderName: providerName,
  } = logCtx;
  if (!lane || !entryId || !providerName || logCtx.cacheAffinityApplicable !== true) return;
  if (status >= 200 && status < 300 && logCtx.observedTerminalStatus !== "failed") {
    const previouslyBound = boundEntryIdForLane(lane);
    recordProviderCacheAffinity({
      lane,
      providerName,
      entryId,
      model: logCtx.affinityModel ?? logCtx.model,
      cacheRead: usage?.cacheReadInputTokens ?? usage?.cachedInputTokens,
      cacheWrite: usage?.cacheCreationInputTokens,
      cacheWriteLong: usage?.cacheCreation1hInputTokens,
      inputTokens: usage?.inputTokens,
    });
    if (logCtx.cacheAffinity === "kept" && logCtx.affinityKeptEntryId !== entryId) {
      logCtx.cacheAffinity = "bound";
      logCtx.cacheAffinityReason = "new";
    } else if (!logCtx.cacheAffinity) {
      logCtx.cacheAffinity = previouslyBound === entryId ? "kept" : "bound";
      logCtx.cacheAffinityReason = previouslyBound === entryId ? "cache" : "new";
    }
  } else if (
    logCtx.terminalSource !== "synthetic" &&
    (status === 401 ||
      status === 402 ||
      status === 429 ||
      (logCtx.providerAdapter === "anthropic" &&
        isAnthropicBillingFailure(status, logCtx.upstreamError ?? "", logCtx.upstreamErrorType)))
  ) {
    // Only this request's refusal is evidence. A shared cooldown may have been
    // written by another conversation while this request was in flight.
    if (!releaseProviderCacheAffinity(lane, providerName, entryId)) return;
    logCtx.cacheAffinity = "released";
    logCtx.cacheAffinityReason = status === 401 ? "auth" : "quota";
  }
}
