import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { hasKeyPoolFailover, rotateProviderTransportOn429 } from "../../providers/key-failover";
import type { RouteResult } from "../../router";
import type { OcxConfig, OcxParsedRequest } from "../../types";
import { bindRouteReasoningReplayScope } from "./core-replay";

// Passthrough's credential moves share one import site so passthrough-dispatch.ts stays under its line cap.
export { recoverAutoPausedAccount } from "./account-auto-pause-recovery";

/**
 * Key-pool failover for a native passthrough 429 before any output. This wire returns before the
 * adapter loop's key-429 arm, so without it a pooled key's 429 reached the client while the same
 * refusal rotates on the adapter and chat-native wires. Distributed (round-robin) selection already
 * cools the key on the send and deliberately answers without a replay. A synthesized replay refusal
 * is not a provider rate limit and must not cool a key. A spent send budget is checked before any
 * key is cooled, so it keeps the real 429 body. Returns undefined when nothing rotated.
 */
export async function rotatePassthroughKeyOn429<T>(options: {
  config: OcxConfig;
  route: Pick<RouteResult, "provider" | "providerName">;
  parsed: OcxParsedRequest;
  response: Response;
  adapterName: string;
  budgetSpent: () => boolean;
  refetch: () => Promise<T>;
}): Promise<T | undefined> {
  const { config, route, parsed, response, adapterName, refetch } = options;
  if (response.status !== 429 || isNonReplayableResponse(response) || !hasKeyPoolFailover(route.provider)
    || route.provider._apiKeyAttempt?.distributed || options.budgetSpent()) return;
  const rotated = rotateProviderTransportOn429(config, route.providerName, route.provider, {
    retryAfter: response.headers.get("retry-after"),
    attemptedKey: route.provider.apiKey,
    promptCacheKey: parsed.options.promptCacheKey,
  });
  if (!rotated) return;
  try { void response.body?.cancel().catch(() => {}); } catch { /* already closed */ }
  route.provider = rotated;
  bindRouteReasoningReplayScope({ parsed, providerName: route.providerName, provider: rotated, adapterName });
  return refetch();
}
