import { createHash } from "node:crypto";
import { effectiveGoogleMode, getProviderRegistryEntry } from "./registry";
import type { OAuthCredentials } from "../oauth/types";
import type { OcxProviderConfig } from "../types";

const ARGON_TOKEN = /(?:^|[^a-z0-9])argon(?:[^a-z0-9]|$)/i;
/** Argon has an independent quota pool, including its native effort-suffixed identities. */
export function isAntigravityArgonIdentity(identity: string): boolean { return ARGON_TOKEN.test(identity); }

/** Accounting and inference must refer to the same supported Antigravity destination. */
export function antigravityQuotaEligible(name: string, provider: OcxProviderConfig): boolean {
  if (provider.disabled || provider.authMode !== "oauth" || effectiveGoogleMode(name, provider) !== "cloud-code-assist") return false;
  try {
    const url = new URL(provider.baseUrl);
    const expected = new URL(getProviderRegistryEntry("google-antigravity")!.baseUrl);
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
