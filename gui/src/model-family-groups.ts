import type { StorageLike } from "./pages/models-shared";

export const FAMILY_COLLAPSED_KEY = "ocx-models-family-collapsed:v1";

/** Groups default to expanded, so the stored set holds only what the user collapsed. */
export const familyGroupKey = (scope: string, familyId: string): string => `${scope}\u0000${familyId}`;

/**
 * Sets that could not be written, per storage. Once a write fails, later reads and toggles use
 * this copy, so a header still expands again and sibling folds survive for the session.
 */
const unsaved = new WeakMap<StorageLike, Set<string>>();

export function readCollapsedFamilies(storage: StorageLike = localStorage): Set<string> {
  const pending = unsaved.get(storage);
  if (pending) return new Set(pending);
  try {
    const parsed = JSON.parse(storage.getItem(FAMILY_COLLAPSED_KEY) ?? "null") as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((value): value is string => typeof value === "string")) : new Set();
  } catch {
    return new Set();
  }
}

/**
 * Flip one group and return the whole stored set. Every provider card owns its own list, so each
 * toggle re-reads storage instead of trusting a stale in-memory copy and erasing a sibling's change.
 */
export function toggleCollapsedFamily(key: string, storage: StorageLike = localStorage): Set<string> {
  const next = readCollapsedFamilies(storage);
  if (!next.delete(key)) next.add(key);
  try {
    storage.setItem(FAMILY_COLLAPSED_KEY, JSON.stringify([...next]));
    unsaved.delete(storage);
  } catch {
    // quota / private-mode: keep the set in memory so the next toggle builds on it
    unsaved.set(storage, new Set(next));
  }
  return next;
}
