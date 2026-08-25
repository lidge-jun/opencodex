import type { OcxConfig } from "../types";

const pendingTopLevelDeletions = new WeakMap<OcxConfig, Set<string>>();
export const CONFIG_REBASE_PROVENANCE_KEY = "configRebaseProvenance";

export function parsedConfigRebaseDeletionKeys(config: OcxConfig): Set<string> | null {
  const value = config.configRebaseProvenance;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.deletedTopLevelKeys)) return null;
  if (!record.deletedTopLevelKeys.every(key => typeof key === "string" && key !== CONFIG_REBASE_PROVENANCE_KEY)) {
    return null;
  }
  return new Set(record.deletedTopLevelKeys as string[]);
}

export function configRebaseDeletionKeys(config: OcxConfig): Set<string> {
  const deleted = new Set([
    ...(parsedConfigRebaseDeletionKeys(config) ?? []),
    ...(pendingTopLevelDeletions.get(config) ?? []),
  ]);
  const record = config as unknown as Record<string, unknown>;
  for (const key of [...deleted]) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) deleted.delete(key);
  }
  return deleted;
}

export function configHasRebaseProvenance(config: OcxConfig): boolean {
  return parsedConfigRebaseDeletionKeys(config) !== null || pendingTopLevelDeletions.has(config);
}

export function projectConfigRebaseProvenance(config: OcxConfig): OcxConfig {
  const pending = pendingTopLevelDeletions.get(config);
  const parsed = parsedConfigRebaseDeletionKeys(config);
  // Preserve unknown future metadata byte-for-value. It carries no authority here.
  if (config.configRebaseProvenance !== undefined && parsed === null) return config;
  const deleted = new Set([...(parsed ?? []), ...(pending ?? [])]);
  const record = config as unknown as Record<string, unknown>;
  for (const key of [...deleted]) {
    if (Object.hasOwn(record, key) && record[key] !== undefined) deleted.delete(key);
  }
  // A SHALLOW copy, deliberately. A provider entry may carry a non-cloneable value — a test
  // fixture injects its own `fetch`, and `structuredClone` throws DataCloneError on a function,
  // which took every provider-probe and CLI-parity suite down. Only the provenance key is
  // rewritten here, so nothing below the top level needs to be copied at all; the deep clone
  // was doing work this projection never asked for.
  const projected = { ...config };
  if (deleted.size === 0) delete projected.configRebaseProvenance;
  else projected.configRebaseProvenance = {
    version: 1,
    deletedTopLevelKeys: [...deleted].sort(),
  };
  return projected;
}

/** Delete one top-level config key and retain the writer's explicit intent for rebasing. */
export function deleteConfigTopLevelKey<K extends keyof OcxConfig>(config: OcxConfig, key: K): void {
  delete config[key];
  if (key === CONFIG_REBASE_PROVENANCE_KEY) return;
  const deleted = pendingTopLevelDeletions.get(config) ?? new Set<string>();
  deleted.add(key);
  pendingTopLevelDeletions.set(config, deleted);
}

export function clearPendingConfigTopLevelDeletions(config: OcxConfig): void {
  pendingTopLevelDeletions.delete(config);
}
