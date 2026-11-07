import type { OcxConfig, OcxProviderConfig } from "../types";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";
import { resolveProviderApiKey } from "./api-key-resolve";
import { passiveKeyLimits, type PassiveKeyProvider } from "./quota/passive-key-limits";

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
let epoch = 0;
const seenResponses = new WeakSet<Response>();

/** Invalidate both stored and in-flight observations after key-store mutation. */
export function clearPassiveKeyLimits(): void {
  epoch++;
  passiveKeyLimits.clear();
}

function keyId(reference: string): string {
  return new Bun.CryptoHasher("sha256").update(reference).digest("hex").slice(0, 8);
}

function identity(name: string, provider: OcxProviderConfig, id: string, reference: string, key: string): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([name, provider.adapter, provider.baseUrl, id, reference, key])).digest("hex");
}

/** A selected account remains the owner after a different account becomes active. */
function stillConfigured(config: OcxConfig, name: string, snapshot: OcxProviderConfig): boolean {
  const current = config.providers[name];
  const selection = snapshot._apiKeyAttempt;
  if (!current || current.disabled || !selection?.reference || !snapshot.apiKey
    || (current.authMode !== undefined && current.authMode !== "key")
    || current.adapter !== snapshot.adapter || current.baseUrl !== snapshot.baseUrl) return false;
  const reference = selection.reference;
  if (current.apiKeyPool?.length) {
    const row = current.apiKeyPool.find(entry => entry.id === selection.entryId && entry.key === reference);
    if (!row || row.disabled) return false;
  } else if (current.apiKey !== reference) return false;
  return resolveProviderApiKey(reference) === snapshot.apiKey;
}

/** Parse bounded serialized bodies only; large sends are accepted when model is first. */
function wireModel(body: BodyInit | null | undefined): string | undefined {
  if (typeof body !== "string") return undefined;
  const prefix = /^\s*\{\s*"model"\s*:\s*("(?:[^"\\]|\\.)*")\s*[,}]/.exec(body.slice(0, 4096))?.[1];
  try {
    const value = prefix ? JSON.parse(prefix) : body.length <= 65536 ? JSON.parse(body)?.model : undefined;
    return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value) ? value : undefined;
  } catch { return undefined; }
}

/** Record only a configured key at the final destination and credential boundary. */
export function passiveKeyPhysicalFetch(
  physicalFetch: typeof globalThis.fetch, config: OcxConfig, name: string, provider: OcxProviderConfig,
): typeof globalThis.fetch {
  if ((provider.authMode !== undefined && provider.authMode !== "key") || !provider.apiKey || !provider._apiKeyAttempt?.reference) return physicalFetch;
  const snapshot = { ...provider, _apiKeyAttempt: { ...provider._apiKeyAttempt } };
  const wrapped = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    let destination: URL;
    try { destination = new URL(url); } catch { return physicalFetch(input, init); }
    const vendor = destinations.get(destination.origin);
    const model = wireModel(init?.body);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const key = snapshot.apiKey!;
    const expectedAuth = vendor === "anthropic" && snapshot.apiKeyTransport !== "bearer"
      ? headers.get("x-api-key") === key && !headers.has("authorization")
      : headers.get("authorization") === `Bearer ${key}` && !headers.has("x-api-key");
    let owned = false;
    try {
      owned = !!vendor && !!model && new URL(snapshot.baseUrl).origin === destination.origin
        && destination.protocol === "https:" && !destination.username && !destination.password
        && paths[vendor].includes(destination.pathname) && !destination.search && !destination.hash
        && (vendor !== "openai" || key.startsWith("sk-"))
        && !headers.has("api-key") && expectedAuth && stillConfigured(config, name, snapshot);
    } catch { /* An unprovable owner cannot receive a passive observation. */ }
    const attempt = ++sequence;
    const generation = epoch;
    const response = await physicalFetch(input, init);
    const reused = seenResponses.has(response);
    seenResponses.add(response);
    try {
      if (owned && vendor && model && !reused && generation === epoch && stillConfigured(config, name, snapshot)) {
        const reference = snapshot._apiKeyAttempt!.reference!;
        passiveKeyLimits.record({ owner: identity(name, snapshot, snapshot._apiKeyAttempt!.entryId ?? keyId(reference), reference, key), provider: vendor, model }, response.headers, Date.now(), attempt);
      }
    } catch { /* Passive display evidence must not fail the proxied response. */ }
    return response;
  }) as typeof globalThis.fetch;
  return isEgressTransparentExecutor(physicalFetch) ? markEgressTransparentExecutor(wrapped) : wrapped;
}

/** Read the current configured key only; missing or replaced keys cannot inherit observations. */
export function getPassiveKeyLimits(config: OcxConfig, name: string, model: string) {
  const provider = config.providers[name];
  if (!provider || (provider.authMode !== undefined && provider.authMode !== "key") || !provider.apiKey) return [];
  const key = resolveProviderApiKey(provider.apiKey);
  if (!key) return [];
  let vendor: PassiveKeyProvider | undefined;
  try { vendor = destinations.get(new URL(provider.baseUrl).origin); } catch { return []; }
  if (!vendor) return [];
  const id = provider.apiKeyPool?.find(entry => entry.key === provider.apiKey)?.id ?? keyId(provider.apiKey);
  return passiveKeyLimits.get({ owner: identity(name, provider, id, provider.apiKey, key), provider: vendor, model }, Date.now());
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
      if ("disabled" in entry && entry.disabled) continue;
      const key = resolveProviderApiKey(entry.key);
      if (!key || (vendor === "openai" && !key.startsWith("sk-"))) continue;
      for (const reading of passiveKeyLimits.list(identity(name, provider, entry.id, entry.key, key), vendor, Date.now())) {
        result.push({ provider: name, keyId: entry.id, ...reading });
      }
    }
  }
  return result;
}
