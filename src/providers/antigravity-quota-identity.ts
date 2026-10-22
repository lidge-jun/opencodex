import { createHash } from "node:crypto";
import { effectiveGoogleMode, getProviderRegistryEntry } from "./registry";
import type { OAuthCredentials } from "../oauth/types";
import type { OcxProviderConfig } from "../types";

const ARGON_TOKEN = /(?:^|[^a-z0-9])argon(?:[^a-z0-9]|$)/i;
/** Argon has an independent quota pool, including its native effort-suffixed identities. */
export function isAntigravityArgonIdentity(identity: string): boolean { return ARGON_TOKEN.test(identity); }

/**
 * The OAuth store key whose account both inference and the quota probe resolve. Inference reads
 * `store[route.providerName]` and refreshes through the OAuth definition registered under that same
 * name, and `ocx login` only accepts registered names, so a renamed provider row never authenticates
 * as this account. Evidence is bound to this key alone; a renamed row reads unknown.
 */
export const ANTIGRAVITY_OAUTH_STORE_KEY = "google-antigravity";

/** Accounting and inference must refer to the same OAuth store entry and the supported Antigravity destination. */
export function antigravityQuotaEligible(name: string, provider: OcxProviderConfig): boolean {
  if (name !== ANTIGRAVITY_OAUTH_STORE_KEY || provider.disabled || provider.authMode !== "oauth"
    || effectiveGoogleMode(name, provider) !== "cloud-code-assist") return false;
  try {
    const url = new URL(provider.baseUrl);
    const expected = new URL(getProviderRegistryEntry(ANTIGRAVITY_OAUTH_STORE_KEY)!.baseUrl);
    return url.href.replace(/\/$/, "") === expected.href.replace(/\/$/, "");
  } catch { return false; }
}

/** Private generation includes the accounting project, not just the rotating bearer. */
export function antigravityQuotaCredentialGeneration(credential: OAuthCredentials): string {
  return createHash("sha256").update(JSON.stringify([credential.refresh, credential.access, credential.expires, credential.projectId])).digest("hex");
}

/** Immutable instance/destination policy, never returned to decision services. */
export function antigravityQuotaPolicy(name: string, provider: OcxProviderConfig): string {
  return createHash("sha256").update(JSON.stringify([name, provider])).digest("hex");
}
