/**
 * Keyed collapse persistence for the dashboard's collapsible group surfaces.
 *
 * Each surface passes its own storage key: the surfaces collapse different things, and
 * sharing one key would make collapsing "opus" on the Claude Desktop page collapse a
 * provider literally named "opus" on the Models page.
 *
 * Collapse is view state and must stay that way. On the Desktop page `modelsByFamily`
 * and `effectiveDefaults` keep seeing every model regardless of what is folded — see the
 * comment in claude-desktop-lane.ts: narrowing the source arrays would let a view
 * control change which model Claude Desktop actually resolves.
 */

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface CollapseStore {
  /**
   * `null` means "no stored preference" — the caller applies its own default. An empty
   * Set is NOT the same thing: it is the user having explicitly opened everything, and
   * it must survive a reload.
   */
  read(storage?: StorageLike): Set<string> | null;
  write(collapsed: ReadonlySet<string>, storage?: StorageLike): void;
}

function resolveStorage(storage?: StorageLike): StorageLike | undefined {
  if (storage) return storage;
  // SSR/test environments without a DOM: no storage is a valid state, not an error.
  return typeof localStorage === "undefined" ? undefined : localStorage;
}

export function makeCollapseStore(key: string): CollapseStore {
  return {
    read(storage) {
      const store = resolveStorage(storage);
      if (!store) return null;
      try {
        const saved = store.getItem(key);
        if (saved === null) return null;
        const parsed = JSON.parse(saved) as unknown;
        // Corrupt JSON and non-arrays are indistinguishable from "never set" as far as
        // the user is concerned, so both fall back to the caller's default rather than
        // silently collapsing (or expanding) everything.
        return Array.isArray(parsed)
          ? new Set(parsed.filter((value): value is string => typeof value === "string"))
          : null;
      } catch {
        return null;
      }
    },
    write(collapsed, storage) {
      const store = resolveStorage(storage);
      if (!store) return;
      try {
        store.setItem(key, JSON.stringify([...collapsed]));
      } catch {
        /* quota / private-mode — collapse is a preference, never a hard failure */
      }
    },
  };
}

export function toggleInSet(current: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(current);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
