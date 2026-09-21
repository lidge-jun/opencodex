/**
 * Request bodies that must never enter the continuation cache.
 *
 * The cache is persisted to `responses-state.json`, so anything recorded here reaches disk.
 * Encrypted-agent-task recovery decrypts task text into the request body and promises
 * in-memory, TTL-bounded retention; recording that body would put the plaintext on disk with
 * no TTL and break the promise.
 *
 * A WeakSet rather than a body field on purpose: `_rawBody` is serialized verbatim by the
 * native passthrough, so any marker written into the body itself would be sent upstream.
 * Marking is enforced once here rather than at each call site, because every recording path
 * (streaming, non-streaming, passthrough, forced) funnels through `rememberResponseState` —
 * a new call site cannot reintroduce the leak by forgetting a guard.
 */
const nonPersistableBodies = new WeakSet<object>();

/** Bar this exact request body from the continuation cache, and therefore from disk. */
export function markBodyNonPersistable(body: unknown): void {
  if (body && typeof body === "object") nonPersistableBodies.add(body as object);
}

/** Test the body's in-memory persistence restriction without adding a wire marker. */
export function isBodyNonPersistable(body: unknown): boolean {
  return !!body && typeof body === "object" && nonPersistableBodies.has(body);
}
