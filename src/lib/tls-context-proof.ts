const TLS_CONTEXT_TRANSPARENT = Symbol.for("opencodex.tls-context.transparent-executor");

/** Marks a wrapper that forwards request TLS settings without owning a hidden TLS session. */
export function markTlsContextTransparentExecutor<F extends typeof globalThis.fetch>(executor: F): F {
  (executor as unknown as Record<symbol, boolean>)[TLS_CONTEXT_TRANSPARENT] = true;
  return executor;
}

export function isTlsContextTransparentExecutor(executor: unknown): boolean {
  return executor === globalThis.fetch || (typeof executor === "function"
    && (executor as unknown as Record<symbol, unknown>)[TLS_CONTEXT_TRANSPARENT] === true);
}

export function inheritTlsContextProof(executor: typeof globalThis.fetch, underlying: typeof globalThis.fetch): void {
  if (isTlsContextTransparentExecutor(underlying)) markTlsContextTransparentExecutor(executor);
}
