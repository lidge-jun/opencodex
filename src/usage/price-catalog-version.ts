/**
 * Version counter for the online price catalog. Kept apart from `price-catalog.ts` so
 * `user-cost-overlays.ts` can fold it into `userCostOverlayVersion()` without importing the
 * provider registry (the key function in `price-catalog.ts` pulls it in).
 */
let catalogVersion = 0;

/** Bumped on every change to a catalog snapshot; memoized prices and usage caches key on it. */
export function priceCatalogVersion(): number {
  return catalogVersion;
}

export function bumpPriceCatalogVersion(): void {
  catalogVersion++;
}
