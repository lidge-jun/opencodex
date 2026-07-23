/**
 * provider-catalog/provider-presets.ts
 *
 * Pure data owner for the add-provider catalog: the /api/provider-presets DTO
 * shape, tier classification (delegating to the provider-workspace catalog
 * predicates), search filtering, and deterministic sorting. No React, no fetch.
 */

import { providerTier, type ProviderTier, type WorkspaceProvider } from "../../provider-workspace/catalog";
import type { ProviderPayload } from "../../provider-payload";

export type ProviderAccessGroup =
  | "recurring-or-keyless"
  | "recurring-uncapped"
  | "recurring-credit"
  | "signup-credit";

export type ProviderSupportLevel = "supported" | "experimental" | "reference";

/** Row shape returned by GET /api/provider-presets (mirrors DerivedProviderPreset). */
export interface CatalogPreset {
  id: string;
  label: string;
  adapter: string;
  baseUrl: string;
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
  /**
   * Endpoint picker (e.g. Qwen Cloud). Choice without `baseUrl` = Custom (show text field).
   */
  baseUrlChoices?: Array<{ id: string; label: string; baseUrl?: string }>;
  codexAccountMode?: "direct" | "pool";
  provider?: ProviderPayload;
  accessGroups?: readonly ProviderAccessGroup[];
  supportLevel?: ProviderSupportLevel;
  verification?: "official" | "primary" | "unverified";
  documentationUrl?: string;
  modelsUrl?: string;
  discovery?: "live" | "static" | "hybrid" | "unsupported";
  lastVerified?: string;
  models?: string[];
  liveModels?: boolean;
}

export const ACCESS_GROUPS: ProviderAccessGroup[] = [
  "recurring-or-keyless",
  "recurring-uncapped",
  "recurring-credit",
  "signup-credit",
];

/** Curated free-directory rows. A provider may belong to more than one group. */
export function curatedPresets(presets: CatalogPreset[]): CatalogPreset[] {
  return presets.filter(p => (p.accessGroups?.length ?? 0) > 0);
}

export function accessGroupCounts(presets: CatalogPreset[]): Record<ProviderAccessGroup, number> {
  const counts = Object.fromEntries(ACCESS_GROUPS.map(group => [group, 0])) as Record<ProviderAccessGroup, number>;
  for (const preset of curatedPresets(presets)) {
    for (const group of new Set(preset.accessGroups)) counts[group] += 1;
  }
  return counts;
}

export function filterByAccessGroup(presets: CatalogPreset[], group: ProviderAccessGroup | "all"): CatalogPreset[] {
  const curated = curatedPresets(presets);
  return group === "all" ? curated : curated.filter(p => p.accessGroups?.includes(group));
}

/** Keep the requested directory at 81 while retaining legacy free/local presets in a separate lane. */
export function freeCatalogSections(presets: CatalogPreset[]): { directory: CatalogPreset[]; existing: CatalogPreset[] } {
  const directory = curatedPresets(presets);
  const free = bucketPresets(presets).free;
  if (directory.length === 0) return { directory: free, existing: [] };
  const directoryIds = new Set(directory.map(preset => preset.id));
  return { directory, existing: free.filter(preset => !directoryIds.has(preset.id)) };
}

export function isPresetActionable(preset: CatalogPreset): boolean {
  return preset.supportLevel !== "reference";
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

/** Deterministic catalog order: label A→Z (case-insensitive), id as tiebreak. */
export function sortPresets(presets: CatalogPreset[]): CatalogPreset[] {
  return [...presets].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id));
}
