import type { OcxConfig, OcxProviderConfig } from "../types";
import { isNonReplayableResponse } from "../lib/upstream-retry";
import { anthropicBillingResponseOwner } from "./anthropic-billing-ownership";
import { readAnthropicBillingRefusal } from "./anthropic-billing-refusal";
import { rotateProviderTransportOnAnthropicBilling } from "./key-failover";
import type { OcxProviderTransport } from "./xai-transport";

/** Pre-output billing recovery uses the same credential cooldown as key-401 recovery. */
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
