import type { CodexAccountMode, OcxProviderConfig } from "../types";
import { fastWireDeclarationError } from "./fastwire";
import {
  PROVIDER_REGISTRY,
  type InboundWire,
  type ProviderRegistryEntry,
  type ResponsesTerminalRepairPolicy,
} from "./registry-catalog";

export function providerRegistryFastWireError(
  entry: Pick<ProviderRegistryEntry, "fastWire" | "supportsServiceTier" | "modelSupportsServiceTier">,
): string | null {
  return fastWireDeclarationError(entry);
}

for (const entry of PROVIDER_REGISTRY) {
  const error = providerRegistryFastWireError(entry);
  if (error) throw new TypeError(`Invalid provider registry entry ${entry.id}: ${error}`);
}

export function getProviderRegistryEntry(id: string): ProviderRegistryEntry | undefined {
  return PROVIDER_REGISTRY.find(entry => entry.id === id);
}

/**
 * Merge a registry row's `staticHeaders` beneath a provider's own headers.
 *
 * The field is documented as "merged into every upstream request for this provider", but that
 * was only ever true for a freshly seeded config: `providerConfigSeed` copies the block once
 * (`derive.ts`), `enrichProviderFromCatalog` fills it only when the whole block is absent, and
 * nothing merged it at request time. So an install that predates a header — or that saved any
 * header of its own — never received the new one, which is exactly what #2067 would have
 * shipped for every existing opencode-free user.
 *
 * The comparison is case-insensitive on purpose. HTTP header names are case-insensitive, but a
 * plain object spread is not: merging a registry `User-Agent` over a user's `user-agent`
 * produces two entries that `Headers` serializes as one comma-joined value
 * ("opencode, custom-agent"), which is a corrupted request rather than an override. The user's
 * spelling and value both win; the registry only fills names the user has not spoken for.
 */
export function mergeRegistryStaticHeaders(
  staticHeaders: Record<string, string> | undefined,
  userHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!staticHeaders) return userHeaders;
  if (!userHeaders) return { ...staticHeaders };
  const claimed = new Set(Object.keys(userHeaders).map(name => name.toLowerCase()));
  const merged: Record<string, string> = { ...userHeaders };
  for (const [name, value] of Object.entries(staticHeaders)) {
    if (!claimed.has(name.toLowerCase())) merged[name] = value;
  }
  return merged;
}

/** Whether this registry row's per-model service-tier evidence applies to one configured target. */
export function registryModelServiceTierCapabilityApplies(
  entry: Pick<ProviderRegistryEntry, "modelServiceTierCapabilityBaseUrlGuard">,
  provider: Pick<OcxProviderConfig, "baseUrl">,
): boolean {
  const guard = entry.modelServiceTierCapabilityBaseUrlGuard;
  return guard === undefined || guard(provider.baseUrl);
}

function normalizedProviderEndpoint(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/**
 * Whether registry transport defaults own this configured row.
 *
 * OAuth/forward providers stay pinned because their credentials must never be sent to an
 * arbitrary same-named host. Existing key presets keep their historical pinning behavior; a new
 * preset can opt into collision preservation, in which case its fixed endpoint owns only rows
 * that still match that destination.
 */
export function providerMatchesRegistryTransport(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
): boolean {
  const entry = getProviderRegistryEntry(id);
  if (!entry) return false;
  if (entry.authKind !== "key" || entry.preserveCustomDestination !== true) return true;
  // The opt-in is intentionally limited to fixed key destinations. Fail closed if a future
  // registry edit combines it with an override/template despite the registry parity tests.
  if (entry.allowBaseUrlOverride || /\{[^}]*\}/.test(entry.baseUrl)) return false;
  if (typeof provider.baseUrl !== "string") return false;
  if (provider.adapter !== entry.adapter) return false;
  if (provider.authMode !== undefined && provider.authMode !== "key") return false;
  return normalizedProviderEndpoint(provider.baseUrl) === normalizedProviderEndpoint(entry.baseUrl);
}

/**
 * Resolve the registry entry a configured provider actually points at, by TRANSPORT
 * rather than by name.
 *
 * `providerMatchesRegistryTransport` answers "does the row named X still point at X's
 * documented destination", which is the right question for routing but the wrong one
 * for user-facing metadata: the GUI lets a preset be saved under any name, and a
 * renamed row would silently lose a usage restriction it still needs to display.
 *
 * Only fixed key destinations are matched. Entries with an overridable or templated
 * base URL are skipped, because their configured URL cannot identify one vendor route.
 */
export function registryEntryForProviderDestination(
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
): ProviderRegistryEntry | undefined {
  if (typeof provider.baseUrl !== "string" || !provider.baseUrl) return undefined;
  if (provider.authMode !== undefined && provider.authMode !== "key") return undefined;
  const endpoint = normalizedProviderEndpoint(provider.baseUrl);
  return PROVIDER_REGISTRY.find(entry =>
    entry.authKind === "key"
    && !entry.allowBaseUrlOverride
    && !/\{[^}]*\}/.test(entry.baseUrl)
    && entry.adapter === provider.adapter
    && normalizedProviderEndpoint(entry.baseUrl) === endpoint);
}

/**
 * Resolve a registry-only default for a mixed-wire provider. Defaults only move a provider
 * between the two OpenAI-shaped adapters and never override a provider configured on another
 * wire. The resolver receives the allow-list so this helper cannot accidentally widen the
 * adapter-selection boundary when a new registry entry is added.
 */
export function providerModelWireDefault(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
  allowedWires: ReadonlySet<string>,
  inbound: InboundWire,
): string | undefined {
  if (!allowedWires.has(provider.adapter)) return undefined;
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelWireDefaults || !providerMatchesRegistryTransport(id, provider)) return undefined;
  const declared = entry.modelWireDefaults[modelId.trim().toLowerCase()];
  if (declared === undefined) return undefined;
  // A bare string applies to every inbound/auth mode; the object form may narrow either.
  if (typeof declared !== "string") {
    if (!declared.inbound.includes(inbound)) return undefined;
    const authMode = provider.authMode ?? entry.authKind;
    if (declared.authModes && !declared.authModes.includes(authMode)) return undefined;
  }
  const wire = typeof declared === "string" ? declared : declared.wire;
  return wire !== undefined && allowedWires.has(wire) ? wire : undefined;
}

/** Resolve a registry-only upstream-streaming compatibility hint for Responses turns. */
export function providerModelResponsesUpstreamStreaming(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
): boolean | undefined {
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelResponsesUpstreamStreaming || !providerMatchesRegistryTransport(id, provider)) return undefined;
  return entry.modelResponsesUpstreamStreaming[modelId.trim().toLowerCase()];
}

/** Resolve a registry-only terminal-repair policy for native Responses streams. */
export function providerModelResponsesTerminalRepair(
  id: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  modelId: string,
): ResponsesTerminalRepairPolicy | undefined {
  const entry = getProviderRegistryEntry(id);
  if (!entry?.modelResponsesTerminalRepair || !providerMatchesRegistryTransport(id, provider)) return undefined;
  const policy = entry.modelResponsesTerminalRepair[modelId.trim().toLowerCase()];
  const graceMs = Math.floor(policy?.graceMs ?? 0);
  if (!Number.isFinite(graceMs) || graceMs <= 0) return undefined;
  return { graceMs };
}

/**
 * Effective Codex account mode for a provider. For canonical `openai`, a valid persisted
 * `codexAccountMode` on the provider config wins and a missing/invalid value defaults to
 * `"pool"`. Other providers keep registry-only metadata (there is no mode for `openai-apikey`).
 */
export function providerCodexAccountMode(id: string, provider?: OcxProviderConfig): CodexAccountMode | undefined {
  const registryMode = getProviderRegistryEntry(id)?.codexAccountMode;
  if (id !== "openai") return registryMode;
  const persisted = provider?.codexAccountMode;
  if (persisted === "pool" || persisted === "direct") return persisted;
  return registryMode ?? "pool";
}

/**
 * Effective Google wire mode for a provider: config value, else registry backfill (a saved
 * key-login config may omit `googleMode` — mirrors the router's backfill), else "ai-studio"
 * (the Generative Language API default). Null for non-google adapters.
 */
export function effectiveGoogleMode(
  providerId: string,
  prov: { adapter?: string; googleMode?: "ai-studio" | "vertex" | "cloud-code-assist" },
): "ai-studio" | "vertex" | "cloud-code-assist" | null {
  if (prov.adapter !== "google") return null;
  return prov.googleMode ?? getProviderRegistryEntry(providerId)?.googleMode ?? "ai-studio";
}
