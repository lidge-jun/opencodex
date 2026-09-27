import type { OcxConfig } from "../../types";
import { withConfigMutationLockSync } from "../../config/mutation-lock";
import { captureConfigTopLevelRollback } from "../../config/rebase-provenance";
import { ConfigWritePublishedError } from "../../config/persist-unlocked";

/**
 * Persistence rebases nested records and arrays in place before writing. Keep their
 * identities and descriptors so a failed write also restores references held by routing.
 * Only plain config containers are traversed; opaque runtime values and accessors are
 * retained as descriptors, never cloned or invoked while taking the snapshot.
 */
function captureConfigGraphRollback(config: OcxConfig): () => void {
  const snapshots = new Map<object, PropertyDescriptorMap>();
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || snapshots.has(value)) return;
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    snapshots.set(value, descriptors);
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as keyof typeof descriptors]!;
      if ("value" in descriptor) visit(descriptor.value);
    }
  };
  visit(config);
  const restoreProvenance = captureConfigTopLevelRollback(config, []);
  return () => {
    for (const [value, descriptors] of snapshots) {
      const keys = Reflect.ownKeys(value);
      const originalKeys = Reflect.ownKeys(descriptors);
      // Re-defining a deleted provider appends it, changing route tie-breaking.
      // Rebuild record properties in snapshot order; array indices/length retain
      // their descriptor-based restoration and every container keeps its identity.
      const reordered = !Array.isArray(value)
        && (keys.length !== originalKeys.length || keys.some((key, index) => key !== originalKeys[index]));
      for (const key of keys) {
        if (reordered || !Object.hasOwn(descriptors, key)) Reflect.deleteProperty(value, key);
      }
      Object.defineProperties(value, descriptors);
    }
    restoreProvenance();
  };
}

/** No await may separate mutation, persistence, and rollback inside this lock. */
export function commitProviderPatch(
  config: OcxConfig,
  mutate: () => void,
  save: (config: OcxConfig) => void,
): void {
  withConfigMutationLockSync(() => {
    const rollback = captureConfigGraphRollback(config);
    try {
      mutate();
      save(config);
    } catch (error) {
      if (!(error instanceof ConfigWritePublishedError)) rollback();
      throw error;
    }
  });
}
