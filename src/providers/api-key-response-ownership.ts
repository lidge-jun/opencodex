import type { OcxConfig, OcxProviderConfig } from "../types";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";
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

/** Capture the credential after connection-policy rewrites, immediately before fetch. */
export function distributedKeyPhysicalFetch(
  physicalFetch: typeof globalThis.fetch, providerName: string, provider: OcxProviderConfig, target: string,
): typeof globalThis.fetch {
  if (!provider._apiKeyAttempt?.distributed) return physicalFetch;
  const wrapped = (async (input, init) => {
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const destination = input instanceof Request ? input.url : String(input);
    const ownsCredential = destination === target && headers.get("authorization") === `Bearer ${provider.apiKey}`
      && !headers.has("x-api-key") && !headers.has("api-key");
    const owner: KeyResponseOwner | null = provider._apiKeyAttempt?.distributed && ownsCredential
      ? { providerName, provider: { ...provider, _apiKeyAttempt: { ...provider._apiKeyAttempt } } } : null;
    const response = await physicalFetch(input, init);
    // Reused response identities cannot safely describe two physical sends.
    owners.set(response, owners.has(response) ? null : owner);
    return response;
  }) as typeof globalThis.fetch;
  return isEgressTransparentExecutor(physicalFetch) ? markEgressTransparentExecutor(wrapped) : wrapped;
}

/** Settle only the terminal refusal; configured same-key 429 retries retain their key. */
export function recordDistributedResponseFailure(
  response: Response, config: OcxConfig, providerName: string, signal?: AbortSignal,
): void {
  if (signal?.aborted || isNonReplayableResponse(response) || (response.status !== 401 && response.status !== 429)) return;
  const owner = owners.get(response);
  if (!owner || owner.providerName !== providerName
    || !providerApiKeySelectionOwnsFailure(config, providerName, owner.provider)) return;
  recordDistributedKeyFailure(config, providerName, owner.provider._apiKeyAttempt,
    response.status, Date.now(), response.headers.get("retry-after"));
}
