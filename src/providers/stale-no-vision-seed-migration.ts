/**
 * Drop a saved `noVisionModels` list that is still, byte for byte, a retired registry seed.
 *
 * `enrichProviderFromRegistry` fills `noVisionModels` all-or-nothing, so a provider row saved
 * while the registry seeded a blanket list keeps that list after the registry stops seeding it.
 * Qoder Global seeded its whole static discovery roster as text-only until the Global adapter
 * began forwarding image input to the Qoder CLI (#6906). The saved copy would keep every image
 * on the vision sidecar path, stripped or captioned before the adapter could forward it.
 *
 * This projection removes one thing: a saved list identical, in order, to a seed this file names,
 * on a row the registry still owns (same adapter, and the registry transport rule enrichment uses),
 * and only while the registry no longer seeds the list at all. Any edited list does not match and
 * is left alone. `modelCapabilities` and `modelInputModalities` are untouched; they are where a
 * deliberate per-model text-only declaration belongs.
 */
import { PROVIDER_REGISTRY, providerMatchesRegistryTransport } from "./registry";
import type { OcxConfig } from "../types";

export interface StaleNoVisionSeed {
  /** Registry provider id whose saved rows may carry the retired list. */
  provider: string;
  /** Every list the registry ever seeded, in seed order; only an exact match is removed. */
  seeds: readonly (readonly string[])[];
}

export interface StaleNoVisionSeedProjection {
  config: OcxConfig;
  changed: boolean;
  warnings: string[];
}

export const STALE_NO_VISION_SEEDS: readonly StaleNoVisionSeed[] = [
  {
    provider: "qoder",
    seeds: [
      // 2026-09-03 (Qoder Global PAT provider) until the DeepSeek V4.1 transition (#4282).
      ["Qwen3.8-Max", "Qwen3.7-Max", "Qwen3.7-Plus", "Kimi-K3", "Kimi-K2.7-Code", "GLM-5.3", "GLM-5.2", "DeepSeek-V4-Pro"],
      // #4282 until Global image input (#6906).
      ["Qwen3.8-Max", "Qwen3.7-Max", "Qwen3.7-Plus", "Kimi-K3", "Kimi-K2.7-Code", "GLM-5.3", "GLM-5.2"],
    ],
  },
];

function sameList(current: readonly unknown[], expected: readonly string[]): boolean {
  return current.length === expected.length && current.every((value, index) => value === expected[index]);
}

/** Pure projection. The caller decides whether to persist. */
export function projectStaleNoVisionSeeds(
  config: OcxConfig,
  entries: readonly StaleNoVisionSeed[] = STALE_NO_VISION_SEEDS,
): StaleNoVisionSeedProjection {
  const warnings: string[] = [];
  let changed = false;
  for (const entry of entries) {
    const prov = config.providers?.[entry.provider];
    if (!prov || !Array.isArray(prov.noVisionModels)) continue;
    const registry = PROVIDER_REGISTRY.find(row => row.id === entry.provider);
    // While the registry still seeds a list, the saved one is not stale by this file's rule.
    if (!registry || registry.noVisionModels !== undefined || registry.adapter !== prov.adapter) continue;
    if (!providerMatchesRegistryTransport(entry.provider, prov)) continue;
    const saved = prov.noVisionModels;
    if (!entry.seeds.some(seed => sameList(saved, seed))) continue;
    delete prov.noVisionModels;
    changed = true;
    warnings.push(
      `removed the retired registry noVisionModels seed (${saved.length} model(s)) from "${entry.provider}"; `
      + "image input now follows the provider's current classification.",
    );
  }
  return { config, changed, warnings };
}
