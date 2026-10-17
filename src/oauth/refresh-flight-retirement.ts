import { createAdmissionGate } from "../lib/admission";
import { isAnthropicOAuthInstance } from "../providers/anthropic-instance";
import { clearObservedAnthropicRefreshIntent } from "./anthropic-oauth-definitions";
import { logOAuthEvent } from "./log";
import { markOAuthRefreshIntentStaleOwner, readOAuthRefreshIntent } from "./store";

/** Independent of client lifetime; a cancelled caller can still be awaiting a shared refresh. */
export const MAX_OAUTH_TOKEN_REFRESH_WAITERS = 256;
export const tokenRefreshWaiters = createAdmissionGate("oauth_token_refresh_waiters", MAX_OAUTH_TOKEN_REFRESH_WAITERS);

export interface OAuthRefreshFlightEvidence { flightId: string; dispatched: boolean }

export interface RetirableOAuthRefreshFlight extends OAuthRefreshFlightEvidence {
  settled?: boolean;
  retirementDeferredLogged?: boolean;
}

// Retire only after the old attempt has finished its definitive-result cleanup. A provider
// may ignore abort; marking its intent sooner would poison a late, safely retryable rejection.
// Failed durable retirement retains the same bounded registry slot for a later retry.
export function retireSettledOAuthRefreshFlight<F extends RetirableOAuthRefreshFlight>(
  tokenRefreshes: Map<string, F>, key: string, flight: F,
): boolean {
  if (!flight.settled) return false;
  const [provider, accountId] = key.split("\0");
  const defer = (reason: "uncertain_intent" | "intent_changed" | "storage_failure"): false => {
    if (!flight.retirementDeferredLogged) {
      flight.retirementDeferredLogged = true;
      logOAuthEvent("OAuth refresh flight retirement deferred", { provider: provider ?? "unknown", reason });
    }
    return false;
  };
  try {
    if (provider && accountId && isAnthropicOAuthInstance(provider)) {
      const intent = readOAuthRefreshIntent(provider, accountId);
      if (intent?.uncertain) return defer("uncertain_intent");
      if (intent?.flightId === flight.flightId && !intent.staleOwner && !intent.cleanupPending) {
        const retired = flight.dispatched
          ? markOAuthRefreshIntentStaleOwner(provider, accountId, intent.generation, flight.flightId)
          : clearObservedAnthropicRefreshIntent(provider, accountId, intent);
        if (!retired) return defer("intent_changed");
      }
    }
  } catch { return defer("storage_failure"); }
  if (tokenRefreshes.get(key) === flight) tokenRefreshes.delete(key);
  return true;
}

