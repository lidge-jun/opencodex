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

/**
 * Tag the initial slice of items [0 ... prefixLength) as historical.
 */
export function tagHistoricalInputItems(input: unknown[], prefixLength: number): unknown[] {
  if (!Array.isArray(input)) return input;
  const prefix = Math.min(input.length, Math.max(0, Math.trunc(prefixLength)));
  if (prefix <= 0) return input;
  return input.map((item, index) => {
    if (index < prefix && isPlainObject(item)) {
      return markHistoricalItem({ ...item });
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
  const hasProvenance = input.some(isHistoricalItem);
  if (!hasProvenance) {
    return Math.min(input.length, Math.max(0, Math.trunc(fallback)));
  }
  const firstLiveIndex = input.findIndex(item => !isHistoricalItem(item));
  return firstLiveIndex === -1 ? input.length : firstLiveIndex;
}
