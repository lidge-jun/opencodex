/**
 * Runtime registry for user-configured provider cost overlays
 * (`providers.<name>.modelCosts` in config.json — per-model prices in ocx's
 * flat `modelXxx` convention, mirroring opencode's per-model pricing).
 *
 * The usage cost estimator stays pure: it receives overlays as parameters and
 * defaults to this registry, which is refreshed at the two config chokepoints
 * (loadConfig and every persist path). A refresh replaces the active array with
 * a NEW identity and bumps a version counter, so the estimator's memo skips
 * stale rows without cross-module invalidation.
 *
 * Display-time estimation only — these rows never affect billing.
 */
import type { OcxConfig, ProviderCostOverlay } from "../types";
import type { ExpectedPriceOverlay } from "./expected-prices";

const EMPTY: readonly ExpectedPriceOverlay[] = [];

let active: readonly ExpectedPriceOverlay[] = EMPTY;
let version = 0;

function validCost4(value: unknown): value is ProviderCostOverlay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return (["input", "output", "cacheRead", "cacheWrite"] as const)
    .every(key => typeof entry[key] === "number" && Number.isFinite(entry[key]) && entry[key] >= 0);
}

/**
 * Rebuild the active user-overlay rows from the current config. Malformed rows
 * are skipped (config validation reports them separately); a provider with no
 * overlay contributes nothing.
 */
export function refreshUserCostOverlays(config: OcxConfig): void {
  const rows: ExpectedPriceOverlay[] = [];
  const providers = config.providers;
  if (providers) {
    for (const [providerName, provider] of Object.entries(providers)) {
      const costs = provider?.modelCosts;
      if (!costs || typeof costs !== "object" || Array.isArray(costs)) continue;
      for (const [modelId, cost4] of Object.entries(costs)) {
        if (!modelId.trim() || !validCost4(cost4)) continue;
        rows.push({
          provider: providerName,
          modelId,
          cost4: { ...cost4 },
          source: `config:providers.${providerName}.modelCosts[${modelId}]`,
          verifiedAt: "user-configured",
          status: "verified",
        });
      }
    }
  }
  active = rows;
  version++;
}

/** Active user-configured overlay rows (stable identity until the next refresh). */
export function activeUserCostOverlays(): readonly ExpectedPriceOverlay[] {
  return active;
}

/** Monotonic version bumped on every refresh; used by the estimator memo key. */
export function userCostOverlayVersion(): number {
  return version;
}
