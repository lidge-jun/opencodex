export const REPLAY_HISTORICAL_ITEM = Symbol.for("ocx.responses.replayHistoricalItem");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Mark an input item object as belonging to the historical replay prefix.
 * Uses an enumerable symbol so it is preserved across shallow object spreads (`{ ...item }`),
 * but completely ignored by `JSON.stringify` and `Object.keys`.
 */
export function markHistoricalItem<T extends object>(item: T): T {
  Object.defineProperty(item, REPLAY_HISTORICAL_ITEM, {
    value: true,
    enumerable: true,
    configurable: true,
    writable: true,
  });
  return item;
}

/**
 * Check whether an input item originated in the historical replay.
 */
export function isHistoricalItem(item: unknown): boolean {
  return (
    typeof item === "object"
    && item !== null
    && (item as Record<string | symbol, unknown>)[REPLAY_HISTORICAL_ITEM] === true
  );
}

/** A live marker survives even when a rewrite removes every historical item. */
export function hasItemProvenance(item: unknown): boolean {
  return typeof item === "object" && item !== null
    && typeof (item as Record<string | symbol, unknown>)[REPLAY_HISTORICAL_ITEM] === "boolean";
}

/** Replacement and synthesized items inherit the source's historical or live tag. */
export function copyItemProvenance<T extends object>(source: unknown, target: T): T {
  if (hasItemProvenance(source)) {
    Object.assign(target, { [REPLAY_HISTORICAL_ITEM]: isHistoricalItem(source) });
  }
  return target;
}

/**
 * Tag both historical and live items so an empty replay prefix remains distinguishable
 * from an input that has never been tagged. Input that already carries provenance keeps it:
 * an earlier rewrite (Zed lifting a replayed wrapper) may have shifted items past the
 * numeric prefix, so re-tagging by index would mislabel current-turn items as history.
 */
export function tagHistoricalInputItems(input: unknown[], prefixLength: number): unknown[] {
  if (!Array.isArray(input)) return input;
  if (input.some(hasItemProvenance)) return input;
  const prefix = Math.min(input.length, Math.max(0, Math.trunc(prefixLength)));
  if (prefix <= 0) return input;
  return input.map((item, index) => {
    if (isPlainObject(item)) {
      return { ...item, [REPLAY_HISTORICAL_ITEM]: index < prefix };
    }
    return item;
  });
}

/**
 * Compute the current replay prefix length dynamically.
 * If items carry provenance markers, the boundary is the index of the first non-historical item.
 * Otherwise, falls back to the provided fallback prefix length.
 */
export function computeReplayPrefixLength(input: unknown[], fallback = 0): number {
  if (!Array.isArray(input)) return fallback;
  const hasProvenance = input.some(hasItemProvenance);
  if (!hasProvenance) {
    return Math.min(input.length, Math.max(0, Math.trunc(fallback)));
  }
  const firstLiveIndex = input.findIndex(item => !isHistoricalItem(item));
  return firstLiveIndex === -1 ? input.length : firstLiveIndex;
}
