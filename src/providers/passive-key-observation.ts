import type { OcxConfig, OcxProviderConfig } from "../types";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";
import { isPassiveKeyTransparent } from "../lib/passive-key-fetch-proof";
import { isKeychainReference, resolveProviderApiKeyPassively } from "./api-key-resolve";
import { passiveKeyLimits, type PassiveKeyProvider } from "./quota/passive-key-limits";
import { extractPassiveWireModel } from "./quota/passive-wire-model";

const destinations = new Map<string, PassiveKeyProvider>([
  ["https://api.openai.com", "openai"], ["https://api.anthropic.com", "anthropic"],
  ["https://api.x.ai", "xai"], ["https://api.groq.com", "groq"], ["https://api.mistral.ai", "mistral"],
]);
const paths: Record<PassiveKeyProvider, readonly string[]> = {
  openai: ["/v1/chat/completions", "/v1/responses", "/v1/responses/compact"],
  anthropic: ["/v1/messages"], xai: ["/v1/chat/completions", "/v1/responses"],
  groq: ["/openai/v1/chat/completions"], mistral: ["/v1/chat/completions"],
};
let sequence = 0;
const seenResponses = new WeakSet<Response>();
// Account identities contain only hashes. Eviction also revokes reservations in the limit cache.
const incarnations = new Map<string, { name: string; owner: string }>();
const MAX_INCARNATIONS = 512;

/** Invalidate both stored and in-flight observations after key-store mutation. */
export function clearPassiveKeyLimits(name?: string): void {
  passiveKeyLimits.clear(name);
  for (const [scope, entry] of incarnations) if (name === undefined || entry.name === name) incarnations.delete(scope);
}

function accountScope(name: string, id: string): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([name, id])).digest("hex");
}

/** Retire all models and outstanding reservations for one account incarnation. */
export function clearPassiveKeyAccount(name: string, id: string): void {
  const scope = accountScope(name, id);
  passiveKeyLimits.clear(name, scope);
  incarnations.delete(scope);
}

function keyId(reference: string): string {
  return new Bun.CryptoHasher("sha256").update(reference).digest("hex").slice(0, 8);
}

function identity(name: string, provider: OcxProviderConfig, id: string, reference: string, key: string): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([name, provider.adapter, provider.baseUrl, id, reference, key])).digest("hex");
}

function remember(name: string, id: string, owner: string): void {
  const scope = accountScope(name, id);
  const previous = incarnations.get(scope);
  if (previous && previous.owner !== owner) clearPassiveKeyAccount(name, id);
  incarnations.delete(scope);
  incarnations.set(scope, { name, owner });
  if (incarnations.size > MAX_INCARNATIONS) {
    const oldest = incarnations.keys().next().value!;
    const entry = incarnations.get(oldest)!;
    passiveKeyLimits.clear(entry.name, oldest);
    incarnations.delete(oldest);
  }
}

/** Poll only accounts already observed; a changed value revokes every model and flight. */
function currentOwner(name: string, provider: OcxProviderConfig, id: string, reference: string): string | undefined {
  const existing = incarnations.get(accountScope(name, id));
  if (!existing) return undefined;
  try {
    if (isKeychainReference(reference)) { clearPassiveKeyAccount(name, id); return undefined; }
    const key = resolveProviderApiKeyPassively(reference);
    const owner = key && identity(name, provider, id, reference, key);
    if (owner === existing.owner) return owner;
  } catch { /* A malformed account cannot invalidate another account's projection. */ }
  clearPassiveKeyAccount(name, id);
  return undefined;
}

/** A selected account remains the owner after a different account becomes active. */
function stillConfigured(config: OcxConfig, name: string, snapshot: OcxProviderConfig): boolean {
  const current = config.providers[name];
  const selection = snapshot._apiKeyAttempt;
  if (!current || current.disabled || !selection?.reference || !snapshot.apiKey
    || (current.authMode !== undefined && current.authMode !== "key")
    || current.adapter !== snapshot.adapter || current.baseUrl !== snapshot.baseUrl) return false;
  const reference = selection.reference;
  // An external keychain replacement is not observable without another OS read.
  if (isKeychainReference(reference)) return false;
  if (current.apiKeyPool?.length) {
    const row = current.apiKeyPool.find(entry => entry.id === selection.entryId && entry.key === reference);
    if (!row || row.disabled) return false;
  } else if (current.apiKey !== reference) return false;
  const id = selection.entryId ?? keyId(reference);
  const key = resolveProviderApiKeyPassively(reference);
  if (key !== snapshot.apiKey) {
    currentOwner(name, current, id, reference);
    return false;
  }
  return true;
}

/** Record only a configured key at the final destination and credential boundary. */
export function passiveKeyPhysicalFetch(
  physicalFetch: typeof globalThis.fetch, config: OcxConfig, name: string, provider: OcxProviderConfig,
): typeof globalThis.fetch {
  if (!isPassiveKeyTransparent(physicalFetch) || (provider.authMode !== undefined && provider.authMode !== "key") || !provider.apiKey || !provider._apiKeyAttempt?.reference) return physicalFetch;
  const snapshot = { ...provider, _apiKeyAttempt: { ...provider._apiKeyAttempt } };
  const wrapped = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let destination: URL;
    try { destination = new URL(url); } catch { return physicalFetch(input, init); }
    const vendor = destinations.get(destination.origin);
    const key = snapshot.apiKey!;
    let owned = false;
    try {
      owned = !!vendor && new URL(snapshot.baseUrl).origin === destination.origin
        && destination.protocol === "https:" && !destination.username && !destination.password
        && paths[vendor].includes(destination.pathname) && !destination.search && !destination.hash
        && (vendor !== "openai" || key.startsWith("sk-"));
    } catch { /* An unprovable owner cannot receive a passive observation. */ }
    if (owned) {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      const expectedAuth = vendor === "anthropic" && snapshot.apiKeyTransport !== "bearer"
        ? headers.get("x-api-key") === key && !headers.has("authorization")
        : headers.get("authorization") === `Bearer ${key}` && !headers.has("x-api-key");
      try { owned = !headers.has("api-key") && expectedAuth && stillConfigured(config, name, snapshot); }
      catch { owned = false; /* An unprovable owner cannot receive a passive observation. */ }
    }
    const model = owned ? extractPassiveWireModel(init?.body) : undefined;
    const attempt = ++sequence;
    let reservation: ReturnType<typeof passiveKeyLimits.reserve>;
    try {
      if (owned && vendor && model) {
        const reference = snapshot._apiKeyAttempt!.reference!;
        const id = snapshot._apiKeyAttempt!.entryId ?? keyId(reference);
        const owner = identity(name, snapshot, id, reference, key);
        remember(name, id, owner);
        reservation = passiveKeyLimits.reserve({ owner, provider: vendor, model, namespace: name, account: accountScope(name, id) }, attempt);
      }
    } catch { /* Reservation failure cannot prevent a proxied send. */ }
    try {
      const response = await physicalFetch(input, init);
      const reused = seenResponses.has(response);
      seenResponses.add(response);
      try {
        if (reservation && !reused && stillConfigured(config, name, snapshot)) {
          reservation.record(response.headers, Date.now());
        }
      } catch { /* Passive display evidence must not fail the proxied response. */ }
      return response;
    } finally { reservation?.cancel(); }
  }) as typeof globalThis.fetch;
  return isEgressTransparentExecutor(physicalFetch) ? markEgressTransparentExecutor(wrapped) : wrapped;
}

/** Read the current configured key only; missing or replaced keys cannot inherit observations. */
export function getPassiveKeyLimits(config: OcxConfig, name: string, model: string) {
  const provider = config.providers[name];
  if (!provider || (provider.authMode !== undefined && provider.authMode !== "key") || !provider.apiKey) return [];
  let vendor: PassiveKeyProvider | undefined;
  try { vendor = destinations.get(new URL(provider.baseUrl).origin); } catch { return []; }
  if (!vendor) return [];
  const id = provider.apiKeyPool?.find(entry => entry.key === provider.apiKey)?.id ?? keyId(provider.apiKey);
  const owner = currentOwner(name, provider, id, provider.apiKey);
  return owner ? passiveKeyLimits.get({ owner, provider: vendor, model }, Date.now()) : [];
}

/** Cached-only projection, scoped to configured account IDs and without credential material. */
export function listPassiveKeyLimits(config: OcxConfig) {
  const result: Array<{ provider: string; keyId: string; model: string; windows: ReturnType<typeof passiveKeyLimits.get> }> = [];
  for (const [name, provider] of Object.entries(config.providers)) {
    if (provider.disabled || (provider.authMode !== undefined && provider.authMode !== "key")) continue;
    let vendor: PassiveKeyProvider | undefined;
    try { vendor = destinations.get(new URL(provider.baseUrl).origin); } catch { continue; }
    if (!vendor) continue;
    const entries = provider.apiKeyPool?.length ? provider.apiKeyPool : provider.apiKey
      ? [{ id: keyId(provider.apiKey), key: provider.apiKey }] : [];
    for (const entry of entries) {
      try {
        if ("disabled" in entry && entry.disabled) continue;
        const owner = currentOwner(name, provider, entry.id, entry.key);
        if (!owner) continue;
        for (const reading of passiveKeyLimits.list(owner, vendor, Date.now())) {
          result.push({ provider: name, keyId: entry.id, ...reading });
        }
      } catch { /* One invalid account cannot reject the whole projection. */ }
    }
  }
  return result;
}
