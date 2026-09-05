import { mutatePersistedConfig, validateConfigCandidate } from "../config";
import { isDeepStrictEqual } from "node:util";
import type { OcxConfig, OcxProviderConfig } from "../types";
import type { CatalogModel } from "../codex/catalog";
import {
  adoptInitialModelSelections,
  initialModelSelection,
  initialModelSelectionPending,
  reconcileInitialModelSelections,
} from "./initial-model-selection";

interface InitialSelectionBaseline {
  providers: string[];
  inventory: unknown;
  disabled: string;
}

function inventoryIdentity(config: OcxConfig): unknown {
  const validated = validateConfigCandidate(config);
  if (!validated.ok) return null;
  // Compare all inventory-producing configuration, including custom rows and combos.
  // Normalize schema defaults, ignoring completed-selection state and switch values.
  // Listener binding intentionally differs between live and disk after a port/host edit;
  // it cannot affect provider discovery and must not leave registration pending forever.
  // The incarnation remains: identical delete/re-add is NOT the same registration.
  const providers = Object.fromEntries(Object.entries(validated.config.providers).map(([name, provider]) => [name, {
    ...provider,
    initialModelSelection: initialModelSelection(provider)?.registrationId,
  }]));
  // Ephemeral only: never log this value, which may contain credentials.
  return JSON.parse(JSON.stringify({ ...validated.config, providers, disabledModels: undefined, port: undefined, hostname: undefined }));
}

export function captureInitialSelectionBaseline(config: OcxConfig): InitialSelectionBaseline | null {
  const providers = Object.entries(config.providers)
    .filter(([, provider]) => initialModelSelectionPending(provider))
    .map(([name]) => name);
  if (!providers.length) return null;
  const inventory = inventoryIdentity(config);
  return inventory === null ? null : { providers, inventory, disabled: JSON.stringify(config.disabledModels ?? []) };
}

/** Commit only decisions whose provider and user-selection snapshot still match. */
export function finalizeInitialModelSelection(
  config: OcxConfig,
  baseline: InitialSelectionBaseline | null,
  models: readonly CatalogModel[],
  authoritativeProviders: readonly string[],
): void {
  if (!baseline || JSON.stringify(config.disabledModels ?? []) !== baseline.disabled) return;
  if (!isDeepStrictEqual(inventoryIdentity(config), baseline.inventory)) return;
  try {
    const outcome = mutatePersistedConfig(fresh => {
      if (!isDeepStrictEqual(inventoryIdentity(fresh), baseline.inventory)) return { changed: false, value: null };
      const providers: Record<string, OcxProviderConfig> = {};
      for (const name of baseline.providers) {
        const provider = fresh.providers[name];
        if (!provider || !initialModelSelection(provider)) continue;
        // A concurrent successful initializer may already have committed its result.
        // Adopt that result, including any later manual switch edits; never initialize twice.
        if (initialModelSelectionPending(provider) && JSON.stringify(fresh.disabledModels ?? []) !== baseline.disabled) continue;
        providers[name] = provider;
      }
      const projection = { ...fresh, providers };
      const changed = reconcileInitialModelSelections(projection, models, authoritativeProviders);
      if (changed) fresh.disabledModels = projection.disabledModels;
      return { changed, value: { ...projection, disabledModels: fresh.disabledModels } };
    });
    if (outcome.status === "unavailable" || !outcome.value) return;
    adoptInitialModelSelections(config, outcome.value);
    if (Object.keys(outcome.value.providers).length) {
      config.disabledModels = outcome.value.disabledModels === undefined ? undefined : [...outcome.value.disabledModels];
    }
  } catch {
    // Keep pending publication fenced on contention or failed persistence. A later ordinary
    // model refresh retries; no dedicated timer and no private exception/path output.
    console.warn("[initial-model-selection] Could not save initial model choices; model exposure remains pending. Retry model discovery.");
  }
}

/** Ordinary discovery, before retained catalog evidence is captured. */
export async function resolvePendingInitialModelSelection(config: OcxConfig): Promise<void> {
  const baseline = captureInitialSelectionBaseline(config);
  if (!baseline) return;
  const { gatherRoutedModels, uniqueCatalogModelsForPublicList } = await import("../codex/catalog");
  const outcomes: Array<{ provider: string; state: "authoritative" | "degraded" }> = [];
  const models = await gatherRoutedModels(config, { providerModelOutcomes: outcomes });
  finalizeInitialModelSelection(config, baseline, uniqueCatalogModelsForPublicList(models),
    outcomes.filter(outcome => outcome.state === "authoritative").map(outcome => outcome.provider));
}
