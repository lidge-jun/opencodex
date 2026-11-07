/** Process-local proof that an executor preserves destination and credential headers. */
const proven = new WeakSet<typeof globalThis.fetch>();
const deferred = new WeakSet<typeof globalThis.fetch>();

/** A trusted transport calls this hook immediately before its physical executor. */
export const PASSIVE_KEY_SEND = Symbol("passive-key-send");

export function markPassiveKeyDeferred<T extends typeof globalThis.fetch>(fetcher: T): T {
  deferred.add(fetcher);
  return fetcher;
}

export function isPassiveKeyDeferred(fetcher: typeof globalThis.fetch): boolean {
  return deferred.has(fetcher);
}

export function inheritPassiveKeyProof<T extends typeof globalThis.fetch>(wrapper: T, inner: typeof globalThis.fetch): T {
  if (isPassiveKeyTransparent(inner)) markPassiveKeyTransparent(wrapper);
  if (isPassiveKeyDeferred(inner)) markPassiveKeyDeferred(wrapper);
  return wrapper;
}

export function markPassiveKeyTransparent<T extends typeof globalThis.fetch>(fetcher: T): T {
  proven.add(fetcher);
  return fetcher;
}

export function isPassiveKeyTransparent(fetcher: typeof globalThis.fetch): boolean {
  return proven.has(fetcher);
}
