import { resolveEnvValue } from "../../config";
import { getAccountSet } from "../../oauth/store";
import type { OcxConfig } from "../../types";
import { apiKeyPoolEntryId } from "../api-keys";

/** Fallback for reports without a probe-bound credential. */
export function providerObservationAccountKey(provider: string, config: OcxConfig): string {
  const oauthAccountId = getAccountSet(provider)?.activeAccountId;
  if (oauthAccountId !== undefined) return `${provider}\u0000${oauthAccountId}`;
  const providerConfig = config.providers[provider];
  const resolvedKey = typeof providerConfig?.apiKey === "string"
    ? resolveEnvValue(providerConfig.apiKey)?.trim()
    : undefined;
  const keyId = resolvedKey ? apiKeyPoolEntryId(resolvedKey) : "default";
  return `${provider}\u0000key:${keyId}`;
}

/** Test-only view of the observation account key. */
export const providerObservationAccountKeyForTests = providerObservationAccountKey;
