/**
 * Proxy-owned handles for the Codex turn-state token.
 *
 * Codex reads `x-codex-turn-state` from a response (or the WebSocket upgrade) and sends it back on
 * later requests of the same turn, so the upstream can keep the turn on one backend. The client
 * receives a random handle this proxy generates instead of the upstream bytes; the handle maps back
 * to the upstream value here, in process memory, and is translated before the request is forwarded.
 * The map is bounded (oldest entries are evicted) and entries expire; an unknown or expired handle
 * is removed from the request rather than forwarded.
 */

export const TURN_STATE_HEADER = "x-codex-turn-state";
const HANDLE_PREFIX = "ocx-ts-";
const HANDLE = /^ocx-ts-[0-9a-f]{32}$/;
const MAX_HANDLES = 4096;
const HANDLE_TTL_MS = 6 * 60 * 60 * 1000;

type Entry = { value: string; expiresAt: number };
const byHandle = new Map<string, Entry>();
const byValue = new Map<string, string>();

function randomHandle(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return HANDLE_PREFIX + Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function live(handle: string, now: number): Entry | undefined {
  const entry = byHandle.get(handle);
  if (!entry) return undefined;
  if (entry.expiresAt > now) return entry;
  byHandle.delete(handle);
  if (byValue.get(entry.value) === handle) byValue.delete(entry.value);
  return undefined;
}

/** The handle a client receives for an upstream turn-state value; a live handle is returned as is. */
export function issueTurnStateHandle(value: string, now = Date.now()): string {
  if (HANDLE.test(value) && live(value, now)) return value;
  const existing = byValue.get(value);
  if (existing && live(existing, now)) return existing;
  const handle = randomHandle();
  byHandle.set(handle, { value, expiresAt: now + HANDLE_TTL_MS });
  byValue.set(value, handle);
  while (byHandle.size > MAX_HANDLES) {
    const [oldest, entry] = byHandle.entries().next().value as [string, Entry];
    byHandle.delete(oldest);
    if (byValue.get(entry.value) === oldest) byValue.delete(entry.value);
  }
  return handle;
}

/**
 * The value to forward for an inbound turn-state: the upstream value for a live handle, nothing for
 * an unknown or expired handle, and any other value unchanged (it did not come from a handle).
 */
export function resolveTurnStateHandle(value: string, now = Date.now()): string | undefined {
  if (!value.startsWith(HANDLE_PREFIX)) return value;
  return live(value, now)?.value;
}

/** Translate an inbound `x-codex-turn-state` header in place. */
export function translateInboundTurnState(headers: Headers): void {
  const value = headers.get(TURN_STATE_HEADER);
  if (value === null) return;
  const resolved = resolveTurnStateHandle(value);
  if (resolved === undefined) headers.delete(TURN_STATE_HEADER);
  else if (resolved !== value) headers.set(TURN_STATE_HEADER, resolved);
}

/** Translate `client_metadata["x-codex-turn-state"]` in an inbound WebSocket frame in place. */
export function translateInboundTurnStateMetadata(frame: Record<string, unknown>): void {
  const metadata = frame.client_metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return;
  const record = metadata as Record<string, unknown>;
  const value = Object.hasOwn(record, TURN_STATE_HEADER) ? record[TURN_STATE_HEADER] : undefined;
  if (typeof value !== "string") return;
  const resolved = resolveTurnStateHandle(value);
  if (resolved === value) return;
  const next = { ...record };
  if (resolved === undefined) delete next[TURN_STATE_HEADER];
  else next[TURN_STATE_HEADER] = resolved;
  frame.client_metadata = next;
}

export function resetTurnStateHandlesForTests(): void {
  byHandle.clear();
  byValue.clear();
}
