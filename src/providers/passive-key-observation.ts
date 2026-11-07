import type { OcxConfig, OcxProviderConfig } from "../types";
import { isEgressTransparentExecutor, markEgressTransparentExecutor } from "../lib/provider-egress";
import { providerApiKeySelectionOwnsFailure } from "./api-key-selection";
import { resolveProviderApiKey } from "./api-key-resolve";
import { passiveKeyLimits, type PassiveKeyProvider } from "./quota/passive-key-limits";

const destinations = new Map<string, PassiveKeyProvider>([
  ["https://api.openai.com", "openai"], ["https://api.anthropic.com", "anthropic"],
  ["https://api.x.ai", "xai"], ["https://api.groq.com", "groq"], ["https://api.mistral.ai", "mistral"],
]);
let sequence = 0;
const seenResponses = new WeakSet<Response>();

function identity(name: string, provider: OcxProviderConfig, reference: string, key: string): string {
  return new Bun.CryptoHasher("sha256").update(JSON.stringify([name, provider.adapter, provider.baseUrl, reference, key])).digest("hex");
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
        && (vendor !== "openai" || key.startsWith("sk-"))
        && !headers.has("api-key") && expectedAuth && providerApiKeySelectionOwnsFailure(config, name, snapshot);
    } catch { /* An unprovable owner cannot receive a passive observation. */ }
    const attempt = ++sequence;
    const response = await physicalFetch(input, init);
    const reused = seenResponses.has(response);
    seenResponses.add(response);
    try {
      if (owned && vendor && model && !reused && providerApiKeySelectionOwnsFailure(config, name, snapshot)) {
        passiveKeyLimits.record({ owner: identity(name, snapshot, snapshot._apiKeyAttempt!.reference!, key), provider: vendor, model }, response.headers, Date.now(), attempt);
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
  return passiveKeyLimits.get({ owner: identity(name, provider, provider.apiKey, key), provider: vendor, model }, Date.now());
}
