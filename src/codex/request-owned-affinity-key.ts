/**
 * The namespace of caller-owned affinity keys, kept in a module with no imports so that stores
 * which must refuse these keys (the durable Codex pool affinity store) can test for them without
 * importing the routing modules that request-owned affinity itself depends on.
 */
export const REQUEST_OWNED_AFFINITY_KEY_PREFIX = "request-owned:v1:";

/** Identify namespace keys that must remain process-local. */
export function isRequestOwnedAffinityKey(value: string): boolean {
  return value.startsWith(REQUEST_OWNED_AFFINITY_KEY_PREFIX);
}
