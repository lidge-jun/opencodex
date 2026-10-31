import { createHash } from "node:crypto";

/** A content-free binding, derived only from trusted admission and the request's OWN thread. */
export function responseReplayOwnerKey(principal: string | undefined, ownThread: string | undefined): string | null {
  if (!principal || !ownThread?.trim()) return null;
  return createHash("sha256").update(JSON.stringify(["ocx-response-owner-v1", principal, ownThread.trim()])).digest("hex");
}

export function validReplayOwnerKey(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

export function normalizedClientThreadId(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Undefined is the legacy internal API; null explicitly means a request without an owner. */
export function replayScopeMatches(
  entry: { clientThreadId?: string; replayOwnerKey?: string }, thread: string | undefined, key: string | null | undefined,
): boolean {
  if (key === null || (key !== undefined && !validReplayOwnerKey(key))) return false;
  return key === entry.replayOwnerKey
    && normalizedClientThreadId(thread) === normalizedClientThreadId(entry.clientThreadId);
}
