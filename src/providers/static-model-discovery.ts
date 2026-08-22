import type { OcxProviderConfig } from "../types";
import {
  getProviderRegistryEntry,
  providerMatchesRegistryTransport,
  type ProviderRegistryEntry,
} from "./registry";

const STATIC_MODEL_CATALOG_PROVIDER_IDS = new Set(["cline-pass", "mimo-free"]);

function normalizedEndpoint(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

function exactRegistryTransportMatch(
  entry: ProviderRegistryEntry,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
  options: { allowLegacyMimoLocal?: boolean } = {},
): boolean {
  if (entry.allowBaseUrlOverride || /\{[^}]*\}/.test(entry.baseUrl)) return false;
  if (typeof provider.baseUrl !== "string" || provider.adapter !== entry.adapter) return false;
  const legacyMimoLocal = options.allowLegacyMimoLocal === true
    && entry.id === "mimo-free"
    && provider.authMode === "local";
  if (provider.authMode !== undefined && provider.authMode !== "key" && !legacyMimoLocal) return false;
  return normalizedEndpoint(provider.baseUrl) === normalizedEndpoint(entry.baseUrl);
}

/** Registry policy for providers whose maintained model list is authoritative. */
export function registryEntrySupportsLiveModelDiscovery(entry: ProviderRegistryEntry): boolean {
  return !STATIC_MODEL_CATALOG_PROVIDER_IDS.has(entry.id);
}

/**
 * Static-catalog authority is tied to canonical provider identity and exact transport.
 * Renamed/custom rows stay operator-owned: Cline and ClinePass intentionally share a transport,
 * so destination matching alone cannot safely identify a renamed ClinePass configuration.
 */
export function staticModelCatalogEntryForProvider(
  name: string,
  provider: OcxProviderConfig,
): ProviderRegistryEntry | undefined {
  const entry = getProviderRegistryEntry(name);
  if (!entry || !STATIC_MODEL_CATALOG_PROVIDER_IDS.has(entry.id)) return undefined;
  return exactRegistryTransportMatch(entry, provider, { allowLegacyMimoLocal: true })
    ? entry
    : undefined;
}

export function providerSupportsLiveModelDiscovery(name: string, provider: OcxProviderConfig): boolean {
  return staticModelCatalogEntryForProvider(name, provider) === undefined;
}

/**
 * MiMo Free predates collision preservation in the registry. Keep same-named custom rows out of
 * registry ownership without broadening the generic transport matcher to other key providers.
 */
export function providerMatchesRegistryTransportWithStaticGuards(
  name: string,
  provider: Pick<OcxProviderConfig, "baseUrl" | "adapter"> & Partial<Pick<OcxProviderConfig, "authMode">>,
): boolean {
  if (name !== "mimo-free") return providerMatchesRegistryTransport(name, provider);
  const entry = getProviderRegistryEntry(name);
  return entry !== undefined
    && exactRegistryTransportMatch(entry, provider, { allowLegacyMimoLocal: true });
}

/** Repair only registry-owned legacy state; operator-owned model lists stay untouched. */
export function repairStaticModelCatalogProvider(name: string, provider: OcxProviderConfig): void {
  const entry = staticModelCatalogEntryForProvider(name, provider);
  if (!entry) return;
  provider.liveModels = false;
  if (
    name === "mimo-free"
    && entry.id === "mimo-free"
    && (provider.authMode === undefined || provider.authMode === "local")
  ) {
    provider.authMode = "key";
  }
}
