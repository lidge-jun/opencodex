import type { OcxConfig, OcxProviderConfig } from "../types";
import { isNonReplayableResponse } from "../lib/upstream-retry";
import { anthropicBillingResponseOwner } from "./anthropic-billing-ownership";
import { readAnthropicBillingRefusal } from "./anthropic-billing-refusal";
import { hasKeyPoolFailover, rotateProviderTransportOnAnthropicBilling } from "./key-failover";
import type { OcxProviderTransport } from "./xai-transport";

/**
 * Whether a provider can recover a credit-balance refusal by key rotation. This is an
 * eligibility predicate for send accounting, not a recovery site: the one billing recovery
 * loop in adapter-dispatch.ts keeps its own `hasKeyPoolFailover` guard.
 */
export function isAnthropicBillingKeyPool(provider: OcxProviderConfig): boolean {
  return provider.adapter === "anthropic" && hasKeyPoolFailover(provider);
}

/** Pre-output billing recovery cools the refused key for the credit-balance window. */
export async function rotateAnthropicBillingKeyOnResponse(
  response: Response, config: OcxConfig, providerName: string, attemptedProvider: OcxProviderConfig,
  options: { signal?: AbortSignal; promptCacheKey?: string } = {},
): Promise<OcxProviderTransport | null> {
  if (options.signal?.aborted || isNonReplayableResponse(response)
    || !anthropicBillingResponseOwner(response, config, providerName, attemptedProvider)) return null;
  if (!await readAnthropicBillingRefusal(response, options.signal) || options.signal?.aborted) return null;
  // Reading is asynchronous: fence a late refusal against manual selection or key replacement.
  const owner = anthropicBillingResponseOwner(response, config, providerName, attemptedProvider);
  if (!owner) return null;
  return rotateProviderTransportOnAnthropicBilling(config, providerName, owner, {
    attemptedKey: owner.apiKey, attemptedSelection: owner._apiKeyAttempt, promptCacheKey: options.promptCacheKey,
  });
}
