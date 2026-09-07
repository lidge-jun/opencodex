/**
 * provider-catalog/provider-presets.ts
 *
 * Pure data owner for the add-provider catalog: the /api/provider-presets DTO
 * shape, tier classification (delegating to the provider-workspace catalog
 * predicates), search filtering, and deterministic sorting. No React, no fetch.
 */

import { providerTier, type ProviderTier, type WorkspaceProvider, type WorkspaceItem } from "../../provider-workspace/catalog";
import type { ProviderPayload } from "../../provider-payload";

/** Row shape returned by GET /api/provider-presets (mirrors DerivedProviderPreset). */
export interface CatalogPreset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
  responsesPath?: string;
  defaultModel?: string;
  /** "oauth": account login · "forward": ChatGPT passthrough · "key": API key · "local": local scaffold. */
  auth: "oauth" | "forward" | "key" | "local";
  /** OAuth registry id (for auth === "oauth"). */
  oauthProvider?: string;
  /** Where to create/copy the API key (for auth === "key" catalog providers). */
  dashboardUrl?: string;
  note?: string;
  /** API key is optional — provider works without one (keyless free). */
  keyOptional?: boolean;
  /** Free pricing — may still require an API key (e.g. NVIDIA NIM). */
  freeTier?: boolean;
  /** Sponsor tier (SPONSORS.md). Sponsor rows are pinned to the top of their tab and chipped. */
  sponsor?: "main" | "standard";
  sponsorUrl?: string;
  /**
   * Endpoint picker (e.g. Qwen Cloud). Choice without `baseUrl` = Custom (show text field).
   */
  baseUrlChoices?: Array<{ id: string; label: string; baseUrl?: string }>;
  codexAccountMode?: "direct" | "pool";
  provider?: ProviderPayload;
}

/** A configured name alone cannot identify a sponsor after its endpoint is edited. */
export function matchingWorkspacePreset(item: WorkspaceItem, presets: CatalogPreset[]): CatalogPreset | undefined {
  const endpoint = (value: string) => {
    try {
      const url = new URL(value.trim());
      if (url.username || url.password || url.search || url.hash) return undefined;
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch { return undefined; }
  };
  const base = endpoint(item.baseUrl);
  if (!base) return undefined;
  return presets.find(preset => preset.id === item.name && preset.adapter === item.adapter
    && endpoint(preset.baseUrl) === base);
}

/**
 * Adapt a preset row to the WorkspaceProvider shape the tier predicates expect
 * (preset `auth` ↔ config `authMode`; booleans normalized).
 */
export function presetTierInput(preset: CatalogPreset): WorkspaceProvider {
  return {
    adapter: preset.adapter,
    baseUrl: preset.baseUrl,
    authMode: preset.auth,
    freeTier: !!preset.freeTier,
    keyOptional: !!preset.keyOptional,
  };
}

/** Three-way tier for a catalog preset row (accounts wins over free; else paid). */
export function presetTier(preset: CatalogPreset): ProviderTier {
  return providerTier(preset.id, presetTierInput(preset));
}

/** Tab buckets for the catalog: accounts / free / paid, preserving input order per bucket. */
export function bucketPresets(presets: CatalogPreset[]): Record<ProviderTier, CatalogPreset[]> {
  const buckets: Record<ProviderTier, CatalogPreset[]> = { accounts: [], free: [], paid: [] };
  for (const preset of presets) buckets[presetTier(preset)].push(preset);
  return buckets;
}

/** Case-insensitive search across label and id only (never adapter/baseUrl). */
export function filterPresets(presets: CatalogPreset[], query: string): CatalogPreset[] {
  const q = query.trim().toLowerCase();
  if (!q) return presets;
  return presets.filter(p => p.label.toLowerCase().includes(q) || p.id.toLowerCase().includes(q));
}

const SPONSOR_RANK: Record<NonNullable<CatalogPreset["sponsor"]>, number> = { main: 0, standard: 1 };

/**
 * Sponsor rows first — Main before Standard, alphabetical by label within a tier — then the
 * caller's order untouched. Stable, so usage ranking still decides the non-sponsor tail.
 * Alphabetical among sponsors is deliberate: it is the one order no sponsor can buy.
 */
export function pinSponsors(presets: CatalogPreset[]): CatalogPreset[] {
  const sponsors = presets.filter(p => p.sponsor);
  if (sponsors.length === 0) return presets;
  sponsors.sort((a, b) =>
    SPONSOR_RANK[a.sponsor!] - SPONSOR_RANK[b.sponsor!]
    || a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
    || a.id.localeCompare(b.id));
  return [...sponsors, ...presets.filter(p => !p.sponsor)];
}
