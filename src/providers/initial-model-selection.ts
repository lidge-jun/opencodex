import type { OcxConfig, OcxProviderConfig } from "../types";
import { randomUUID } from "node:crypto";
import { getProviderRegistryEntry, providerMatchesRegistryTransport } from "./registry";
import { routedSlug, slugEquivalenceKey } from "./slug-codec";
import { comboDisabledModelSelectors } from "../combos/types";
import { providerUsesKeyAuthOverride, resolveProviderApiKey } from "./key-store";

export const INITIAL_MODEL_SELECTION_THRESHOLD = 20;
type Selection = NonNullable<OcxProviderConfig["initialModelSelection"]>;

/** Read only the public, non-secret shape; editor input never owns this state. */
export function initialModelSelection(provider: OcxProviderConfig | undefined): Selection | undefined {
  const value = provider?.initialModelSelection;
  if (!value || value.version !== 1 || typeof value.registrationId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.registrationId)
    || !["pending", "ready", "all-off"].includes(value.status)) return undefined;
  return {
    version: 1,
    registrationId: value.registrationId,
    status: value.status,
    ...(Number.isSafeInteger(value.modelCount) && value.modelCount! >= 0 ? { modelCount: value.modelCount } : {}),
  };
}

export function initialModelSelectionPending(provider: OcxProviderConfig | undefined): boolean {
  return initialModelSelection(provider)?.status === "pending";
}

function loginConnection(name: string, provider: OcxProviderConfig): boolean {
  const entry = getProviderRegistryEntry(name);
  if (entry && providerMatchesRegistryTransport(name, provider)) {
    if (entry.authKind === "forward") return true;
    if (entry.authKind === "oauth") {
      return !providerUsesKeyAuthOverride(entry, provider, resolveProviderApiKey(provider.apiKey));
    }
  }
  return provider.authMode === "oauth" || provider.authMode === "forward";
}

/** Registration only: absence on an existing row is legacy/exempt, never a migration trigger. */
export function initializeProviderModelSelection(
  name: string,
  next: OcxProviderConfig,
  existing?: OcxProviderConfig,
  config?: Pick<OcxConfig, "disabledModels" | "combos" | "modelDiscovery">,
): void {
  delete next.initialModelSelection;
  if (existing) {
    for (const key of ["selectedModels", "modelPreset", "newModelPolicy"] as const) {
      if (next[key] === undefined && existing[key] !== undefined) {
        Object.assign(next, { [key]: structuredClone(existing[key]) });
      }
    }
    if (existing.initialModelSelection !== undefined) next.initialModelSelection = structuredClone(existing.initialModelSelection);
  } else {
    // A deleted provider's discovery history belongs to that old registration too.
    if (config?.modelDiscovery?.knownModels) delete config.modelDiscovery.knownModels[name];
    if (config?.modelDiscovery?.recentArrivals) delete config.modelDiscovery.recentArrivals[name];
    if (config?.disabledModels) {
      const comboSelectors = new Set(Object.entries(config.combos ?? {})
        .flatMap(([id, combo]) => comboDisabledModelSelectors(id, combo)));
      config.disabledModels = config.disabledModels.filter(selector =>
        !selector.startsWith(`${name}/`) || comboSelectors.has(selector));
    }
    if (!loginConnection(name, next)) {
      next.initialModelSelection = { version: 1, registrationId: randomUUID(), status: "pending" };
    }
  }
}

/** Count the canonical switch identities that the Models inventory displays. */
export function reconcileInitialModelSelections(
  config: OcxConfig,
  models: Iterable<{ provider: string; id: string }>,
  authoritativeProviders: Iterable<string>,
): boolean {
  const selectors = new Map<string, Set<string>>();
  for (const model of models) {
    const ids = selectors.get(model.provider) ?? new Set<string>();
    ids.add(routedSlug(model.provider, model.id));
    selectors.set(model.provider, ids);
  }
  const authoritative = new Set(authoritativeProviders);
  let changed = false;
  for (const [name, provider] of Object.entries(config.providers)) {
    const initial = initialModelSelection(provider);
    if (initial?.status !== "pending") continue;
    if (loginConnection(name, provider)) {
      provider.initialModelSelection = { version: 1, registrationId: initial.registrationId, status: "ready" };
      changed = true;
      continue;
    }
    if (!authoritative.has(name)) continue;
    const ids = selectors.get(name) ?? new Set<string>();
    const allOff = ids.size >= INITIAL_MODEL_SELECTION_THRESHOLD;
    if (allOff) {
      const disabled = config.disabledModels ??= [];
      const keys = new Set(disabled.map(slugEquivalenceKey));
      for (const id of ids) {
        const key = slugEquivalenceKey(id);
        if (!keys.has(key)) { disabled.push(id); keys.add(key); }
      }
    }
    provider.initialModelSelection = { version: 1, registrationId: initial.registrationId, status: allOff ? "all-off" : "ready", modelCount: ids.size };
    changed = true;
  }
  return changed;
}

export function adoptInitialModelSelections(target: OcxConfig, source: OcxConfig): void {
  for (const [name, provider] of Object.entries(source.providers)) {
    if (target.providers[name] && provider.initialModelSelection !== undefined) {
      target.providers[name].initialModelSelection = structuredClone(provider.initialModelSelection);
    }
  }
}

export function pendingModelSelectionProviders(config: Pick<OcxConfig, "providers">): Set<string> {
  return new Set(Object.entries(config.providers).filter(([, provider]) => initialModelSelectionPending(provider)).map(([name]) => name));
}
