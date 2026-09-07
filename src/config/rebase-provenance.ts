import type { OcxConfig } from "../types";

const pendingTopLevelDeletions = new WeakMap<OcxConfig, Set<string>>();
const pendingObjectChildDeletions = new WeakMap<OcxConfig, Map<string, Set<string>>>();
export const CONFIG_REBASE_PROVENANCE_KEY = "configRebaseProvenance";

export type ConfigObjectChildDeletions = Map<string, Set<string>>;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

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

/** Delete one child from a record-valued field without tombstoning concurrent sibling keys. */
export function deleteConfigObjectChildKey<K extends keyof OcxConfig>(
  config: OcxConfig,
  key: K,
  childKey: string,
): void {
  const record = config as unknown as Record<string, unknown>;
  const value = record[key as string];
  if (isPlainRecord(value)) {
    delete value[childKey];
    if (Object.keys(value).length === 0) delete record[key as string];
  }
  const byParent = pendingObjectChildDeletions.get(config) ?? new Map<string, Set<string>>();
  const deleted = byParent.get(key as string) ?? new Set<string>();
  deleted.add(childKey);
  byParent.set(key as string, deleted);
  pendingObjectChildDeletions.set(config, byParent);
}

/**
 * Materialize record containers so the normal recursive three-way merge can adopt
 * concurrent sibling keys. Returned child tombstones must be applied after that merge.
 */
export function prepareConfigObjectChildDeletionRebase(config: OcxConfig): ConfigObjectChildDeletions {
  const pending = pendingObjectChildDeletions.get(config);
  const active: ConfigObjectChildDeletions = new Map();
  if (!pending) return active;
  const record = config as unknown as Record<string, unknown>;
  for (const [key, children] of pending) {
    const current = record[key];
    const deleted = new Set([...children].filter(child =>
      !isPlainRecord(current) || !Object.hasOwn(current, child) || current[child] === undefined));
    if (deleted.size === 0) continue;
    active.set(key, deleted);
    if (!isPlainRecord(current)) record[key] = {};
  }
  return active;
}

/** Reassert explicit child deletions after rebasing, then omit an empty parent record. */
export function applyConfigObjectChildDeletions(
  config: OcxConfig,
  deletions: ConfigObjectChildDeletions,
): void {
  const record = config as unknown as Record<string, unknown>;
  for (const [key, children] of deletions) {
    const current = record[key];
    if (!isPlainRecord(current)) continue;
    for (const child of children) delete current[child];
    if (Object.keys(current).length === 0) delete record[key];
  }
}

export function clearPendingConfigTopLevelDeletions(config: OcxConfig): void {
  pendingTopLevelDeletions.delete(config);
}

export function clearPendingConfigObjectChildDeletions(config: OcxConfig): void {
  pendingObjectChildDeletions.delete(config);
}

/**
 * Capture field replacements and deletion intent for a synchronous live-config save.
 * Restore before yielding on failure: an asynchronous rollback could overwrite a newer
 * mutation. Descriptors preserve absent versus explicitly undefined properties; the
 * private pending set must also retain its original presence, even when it was empty.
 * Unrelated fields and the live object's identity/baselines are left in place.
 */
export function captureConfigTopLevelRollback(
  config: OcxConfig,
  keys: readonly (keyof OcxConfig)[],
): () => void {
  const descriptors = new Map([...new Set<keyof OcxConfig>([...keys, CONFIG_REBASE_PROVENANCE_KEY])]
    .map(key => [key, Object.getOwnPropertyDescriptor(config, key)] as const));
  const pending = pendingTopLevelDeletions.get(config);
  const pendingBefore = pending === undefined ? undefined : new Set(pending);
  return () => {
    for (const [key, descriptor] of descriptors) {
      if (descriptor) Object.defineProperty(config, key, descriptor);
      else deleteConfigTopLevelKey(config, key);
    }
    // The absent fields above are restoration, not new user deletion commands.
    if (pendingBefore === undefined) pendingTopLevelDeletions.delete(config);
    else pendingTopLevelDeletions.set(config, new Set(pendingBefore));
  };
}
