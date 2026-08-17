import type { OcxProviderContinuationOwner } from "../types";

const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

/** Validate proxy-authored continuation ownership before trusting persisted state. */
export function isValidProviderContinuationOwner(
  value: unknown,
): value is OcxProviderContinuationOwner {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const owner = value as Record<string, unknown>;
  return owner.version === 1
    && bounded(owner.providerName, 256)
    && typeof owner.providerDestinationIdentity === "string"
    && /^destination:[0-9a-f]{64}$/.test(owner.providerDestinationIdentity)
    && bounded(owner.adapterName, 128)
    && bounded(owner.modelId, 512)
    && typeof owner.credentialIdentity === "string"
    && /^(key|oauth|codex|oauth-account|forward-account):[0-9a-f]{64}$/.test(
      owner.credentialIdentity,
    );
}
