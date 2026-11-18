import type { OcxConfig, OcxProviderConfig } from "../types";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";
import { inheritPassiveKeyProof } from "../lib/passive-key-fetch-proof";
import { isNonReplayableResponse } from "../lib/upstream-retry";
import { providerApiKeySelectionOwnsFailure } from "./api-key-selection";
import { recordDistributedKeyFailure } from "./key-failover";
import { registerProviderResponseProvenance } from "./request-pacing";

interface KeyResponseOwner {
  readonly providerName: string;
  readonly provider: OcxProviderConfig;
}
const owners = new WeakMap<Response, KeyResponseOwner | null>();
registerProviderResponseProvenance(owners);

/** Any key-auth header besides the one written by the credential owner makes attribution ambiguous. */
export function hasConflictingApiKeyHeaders(
  names: Iterable<string>, ownedHeader?: "authorization" | "x-api-key",
): boolean {
  for (const name of names) {
    const header = name.toLowerCase();
    if (header !== ownedHeader && (header === "authorization" || header === "x-api-key" || header === "api-key")) return true;
  }
  return false;
}

/** Capture the credential after connection-policy rewrites, immediately before fetch. */
export function distributedKeyPhysicalFetch(
  physicalFetch: typeof globalThis.fetch, providerName: string, provider: OcxProviderConfig, target: string,
  authHeader: "authorization" | "x-api-key" = "authorization",
): typeof globalThis.fetch {
  if (!provider._apiKeyAttempt?.distributed) return physicalFetch;
  const wrapped = (async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const destination = input instanceof Request ? input.url : String(input);
    const expected = authHeader === "authorization" ? `Bearer ${provider.apiKey}` : provider.apiKey;
    const ownsCredential = destination === target && headers.get(authHeader) === expected
      && !hasConflictingApiKeyHeaders(headers.keys(), authHeader);
    const owner: KeyResponseOwner | null = provider._apiKeyAttempt?.distributed && ownsCredential
      ? Object.freeze({ providerName, provider: Object.freeze({ ...provider,
        _apiKeyAttempt: Object.freeze({ ...provider._apiKeyAttempt }) }) }) : null;
    const response = await physicalFetch(input, init);
    // Reused response identities cannot safely describe two physical sends.
    owners.set(response, owners.has(response) ? null : owner);
    return response;
  }) as typeof globalThis.fetch;
  inheritPassiveKeyProof(wrapped, physicalFetch);
  return isEgressTransparentExecutor(physicalFetch) ? markEgressTransparentExecutor(wrapped) : wrapped;
}

/** Return only a still-configured credential captured at the physical send. */
export function distributedKeyResponseOwner(
  response: Response, config: OcxConfig, providerName: string,
): OcxProviderConfig | null {
  const owner = owners.get(response);
  return owner?.providerName === providerName
    && providerApiKeySelectionOwnsFailure(config, providerName, owner.provider) ? owner.provider : null;
}

/** Settle only the terminal refusal; configured same-key 429 retries retain their key. */
export function recordDistributedResponseFailure(
  response: Response, config: OcxConfig, providerName: string, signal?: AbortSignal,
): void {
  if (signal?.aborted || isNonReplayableResponse(response) || (response.status !== 401 && response.status !== 429)) return;
  const owner = distributedKeyResponseOwner(response, config, providerName);
  if (!owner) return;
  recordDistributedKeyFailure(config, providerName, owner._apiKeyAttempt,
    response.status, Date.now(), response.headers.get("retry-after"));
}
