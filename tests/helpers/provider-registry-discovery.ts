import { clearModelCache } from "../../src/codex/model-cache";
import { PROVIDER_REGISTRY, type ProviderModelDiscoverySpec } from "../../src/providers/registry";

interface RegistryDiscoveryOverrides {
  preserveCustomDestination?: boolean;
}

/** Temporarily override registry-owned discovery policy with a clean cache before and after. */
export async function withRegistryDiscovery<T>(
  providerId: string,
  spec: ProviderModelDiscoverySpec,
  run: () => Promise<T> | T,
  overrides: RegistryDiscoveryOverrides = {},
): Promise<T> {
  const entry = PROVIDER_REGISTRY.find(row => row.id === providerId);
  if (!entry) throw new Error(`missing ${providerId} registry entry`);
  const originalDiscovery = entry.modelDiscovery;
  const originalPreserveCustomDestination = entry.preserveCustomDestination;
  clearModelCache(providerId, "eviction");
  entry.modelDiscovery = spec;
  if (overrides.preserveCustomDestination !== undefined) {
    entry.preserveCustomDestination = overrides.preserveCustomDestination;
  }
  try {
    return await run();
  } finally {
    if (originalDiscovery === undefined) delete entry.modelDiscovery;
    else entry.modelDiscovery = originalDiscovery;
    if (originalPreserveCustomDestination === undefined) delete entry.preserveCustomDestination;
    else entry.preserveCustomDestination = originalPreserveCustomDestination;
    clearModelCache(providerId, "eviction");
  }
}
