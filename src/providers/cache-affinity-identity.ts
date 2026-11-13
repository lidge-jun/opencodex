import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { OcxProviderConfig } from "../types";
import { routedProviderConfig } from "./routed-config";

// The fingerprint is process-local and is never included in request logs or persisted.
const fingerprintKey = randomBytes(32);
// Enumerable symbols follow the existing combo/policy context copies, while JSON and
// the request-log serializers omit them. No credential or destination is retained.
const sentIdentity = Symbol("cache-affinity-identity");
type IdentityContext = { [sentIdentity]?: string };
const generations = new Map<string, { providerName: string; entryId: string; fingerprint?: string; token: string }>();
const GENERATION_CAPACITY = 2048;

function observedIdentity(providerName: string, entryId: string, fingerprint: string | undefined): string | undefined {
  const key = JSON.stringify([providerName, entryId]);
  let generation = generations.get(key);
  if (!generation || generation.fingerprint !== fingerprint) {
    generation = { providerName, entryId, fingerprint, token: randomUUID() };
    generations.delete(key);
    generations.set(key, generation);
    if (generations.size > GENERATION_CAPACITY) generations.delete(generations.keys().next().value!);
  }
  return fingerprint ? generation.token : undefined;
}

export function cacheAffinityIdentity(provider: OcxProviderConfig): string | undefined {
  const selection = provider._apiKeyAttempt;
  if (!selection?.entryId || !selection.reference || !provider.apiKey) return undefined;
  return createHmac("sha256", fingerprintKey).update(JSON.stringify([
    selection.entryId, selection.reference, provider.apiKey, provider.authMode,
    provider.adapter, provider.baseUrl, provider.responsesPath, provider.chatCompletionsPath,
    provider.googleMode, provider.project, provider.location, provider.apiKeyTransport,
  ])).digest("hex");
}

export function currentCacheAffinityIdentity(providerName: string, provider: OcxProviderConfig | undefined, entryId: string): string | undefined {
  if (!provider || provider.disabled || provider.cacheAffinity === "off" || provider.authMode === "oauth"
    || provider.authMode === "forward" || (provider.apiKeyPool?.length ?? 0) < 2) {
    return observedIdentity(providerName, entryId, undefined);
  }
  const entry = provider.apiKeyPool?.find(item => item.id === entryId && !item.disabled);
  if (!entry) return observedIdentity(providerName, entryId, undefined);
  try {
    return observedIdentity(providerName, entryId, cacheAffinityIdentity(routedProviderConfig(providerName, { ...provider, apiKey: entry.key,
      _apiKeyAttempt: { entryId: entry.id, reference: entry.key } })));
  } catch {
    return observedIdentity(providerName, entryId, undefined);
  }
}

export function captureCacheAffinityIdentity(context: object, providerName: string, provider: OcxProviderConfig): void {
  const selection = provider._apiKeyAttempt;
  const entryId = selection?.entryId;
  const identity = selection?.cacheAffinity ? selection.cacheAffinityGeneration
    : entryId ? observedIdentity(providerName, entryId, cacheAffinityIdentity(provider)) : undefined;
  if (identity) (context as IdentityContext)[sentIdentity] = identity;
  else delete (context as IdentityContext)[sentIdentity];
}

export function capturedCacheAffinityIdentity(context: object): string | undefined {
  return (context as IdentityContext)[sentIdentity];
}

/** Also observe in-flight credentials which have not yet produced a binding. */
export function reconcileCacheAffinityIdentities(providers: Readonly<Record<string, OcxProviderConfig>>): void {
  for (const { providerName, entryId } of [...generations.values()]) {
    currentCacheAffinityIdentity(providerName, providers[providerName], entryId);
  }
}

export function clearCacheAffinityIdentitiesForTests(): void {
  generations.clear();
}
