/** Process-local proof that an executor preserves destination and credential headers. */
const proven = new WeakSet<typeof globalThis.fetch>();

export function markPassiveKeyTransparent<T extends typeof globalThis.fetch>(fetcher: T): T {
  proven.add(fetcher);
  return fetcher;
}

export function isPassiveKeyTransparent(fetcher: typeof globalThis.fetch): boolean {
  return proven.has(fetcher);
}
