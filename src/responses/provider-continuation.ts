import type {
  OcxProviderContinuationOwner,
  OcxReasoningReplayIdentity,
} from "../types";

const bounded = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const defineOwn = (target: Record<string, unknown>, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
};

/** Recursively merge provider-owned plain objects; arrays and scalar values replace prior state. */
export function mergeProviderContinuationPayload(
  inherited: Readonly<Record<string, unknown>>,
  emitted: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(inherited)) defineOwn(merged, key, value);
  for (const [key, value] of Object.entries(emitted)) {
    const prior = Object.hasOwn(merged, key) ? merged[key] : undefined;
    defineOwn(
      merged,
      key,
      isPlainRecord(prior) && isPlainRecord(value)
        ? mergeProviderContinuationPayload(prior, value)
        : value,
    );
  }
  return merged;
}

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
    && /^(key|oauth|codex):[0-9a-f]{64}$/.test(owner.credentialIdentity);
}

/** Reuse the exact process-local route identity already established for reasoning replay. */
export function providerContinuationOwnerFromReplayIdentity(
  identity: Readonly<OcxReasoningReplayIdentity> | undefined,
): OcxProviderContinuationOwner | undefined {
  if (!identity) return undefined;
  const owner: OcxProviderContinuationOwner = {
    version: 1,
    providerName: identity.providerName,
    providerDestinationIdentity: identity.providerDestinationIdentity,
    adapterName: identity.adapterName,
    modelId: identity.modelId,
    credentialIdentity: identity.credentialIdentity,
  };
  return isValidProviderContinuationOwner(owner) ? owner : undefined;
}

export function sameProviderContinuationOwner(
  left: OcxProviderContinuationOwner,
  right: OcxProviderContinuationOwner,
): boolean {
  return left.version === right.version
    && left.providerName === right.providerName
    && left.providerDestinationIdentity === right.providerDestinationIdentity
    && left.adapterName === right.adapterName
    && left.modelId === right.modelId
    && left.credentialIdentity === right.credentialIdentity;
}

/** Cursor hashes this non-secret namespace with the client thread id. */
export function providerContinuationRouteScope(owner: OcxProviderContinuationOwner): string {
  return JSON.stringify([
    "provider-continuation-v1",
    owner.providerName,
    owner.providerDestinationIdentity,
    owner.adapterName,
    owner.modelId,
    owner.credentialIdentity,
  ]);
}
