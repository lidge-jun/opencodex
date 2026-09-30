import { isDeepStrictEqual } from "node:util";
import { mutatePersistedConfig, readConfigDiagnostics, validateConfigCandidate } from "../config";
import { fileBackedConfigPath } from "../config/rebase-provenance";
import { getConfigPath } from "../config/paths";
import { observeModelCacheRevision } from "../codex/model-cache";
import { adoptPersistedModelDiscovery } from "../config/live-reconcile";
import type { OcxConfig } from "../types";
import { reconcileSuccessfulModelDiscoveries } from "./new-model-policy";

function inventory(config: OcxConfig): unknown {
  const validated = validateConfigCandidate(config);
  if (!validated.ok) return null;
  const providers = Object.fromEntries(Object.entries(validated.config.providers).map(([name, provider]) => [name, {
    ...provider,
    // Initial selection may finish during this discovery, but a re-registration is distinct.
    initialModelSelection: provider.initialModelSelection?.registrationId,
  }]));
  // Compare normalized persisted data, not injected fetch functions. Never log this identity.
  return JSON.parse(JSON.stringify({ providers, combos: validated.config.combos,
    policy: validated.config.modelDiscovery?.newModelPolicy }));
}

export function captureModelDiscoveryBaseline(config: OcxConfig) {
  const identity = inventory(config);
  const disk = readConfigDiagnostics();
  return { identity, persisted: identity !== null && disk.source === "file"
    && isDeepStrictEqual(identity, inventory(disk.config)) };
}

/** Publish new-arrival choices before returning discovery rows to any visibility consumer. */
export function finalizeModelDiscovery(
  config: OcxConfig,
  baseline: ReturnType<typeof captureModelDiscoveryBaseline>,
  models: Iterable<{ provider: string; id: string; custom?: boolean }>,
  authoritativeProviders: string[],
  revisions: Map<string, string>,
  /** Read consumers may publish detached policy state; writers require persisted decisions. */
  publishProjection?: (projection: OcxConfig) => void,
): boolean {
  const filePath = fileBackedConfigPath(config);
  const rows = [...models];
  const now = new Date().toISOString();
  const current = () => (filePath === undefined || filePath === getConfigPath())
    && isDeepStrictEqual(baseline.identity, inventory(config))
    && [...revisions].every(([provider, revision]) => observeModelCacheRevision(provider) === revision);
  if (!current()) return false;
  const reconcile = (target: OcxConfig) => reconcileSuccessfulModelDiscoveries({
    config: target, models: rows, authoritativeProviders, now, mode: "discovery",
  });
  if (!baseline.persisted && filePath === undefined) {
    // Standalone/synthetic callers may project their own config, never overwrite another home.
    reconcile(config);
    return true;
  }
  if (!baseline.persisted && publishProjection) {
    // Drift already existed at admission. Do not add unsaved disables or advance the live
    // merge baseline: a later rebase-save must preserve the operator's on-disk choices.
    const projection = { ...config, modelDiscovery: structuredClone(config.modelDiscovery),
      disabledModels: config.disabledModels === undefined ? undefined : [...config.disabledModels] };
    reconcile(projection);
    publishProjection(projection);
    return true;
  }
  // A file-loaded instance remains file-backed after inventory drift. The locked
  // freshness gate below refuses stale rows without creating unsaved live disables.
  try {
    const result = mutatePersistedConfig(fresh => {
      if (!current() || !isDeepStrictEqual(baseline.identity, inventory(fresh))) {
        return { changed: false, value: null };
      }
      // Re-evaluate against the latest baseline and manual choices under the mutation lock.
      // A second caller then adopts a first caller's result rather than disabling an ID twice.
      const changed = reconcile(fresh);
      return { changed, value: { modelDiscovery: fresh.modelDiscovery, disabledModels: fresh.disabledModels } };
    });
    if (result.status === "unavailable" || !result.value) return false;
    adoptPersistedModelDiscovery(config, result.value);
    return true;
  } catch {
    // Do not publish an unrecorded arrival when persistence failed. The caller retries discovery.
    return false;
  }
}
