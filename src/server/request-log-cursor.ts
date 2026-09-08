import { createHash, randomBytes } from "node:crypto";

const MAX_CURSOR_LENGTH = 512;
const MAX_WINDOW_ROWS = 2000;
// A restart must invalidate even an identical window hydrated from usage.jsonl.
const processEpoch = randomBytes(16).toString("hex");

interface SnapshotCursor {
  v: 2;
  e: string;
  n: number;
  q: string;
  h: string;
}

interface LegacyCursor {
  v: 1;
  t: number;
  id: string;
}

export type RequestLogCursor = SnapshotCursor | LegacyCursor;

/** A cursor is a bounded freshness hint, never an admission credential. */
export function decodeRequestLogCursor(raw: string): RequestLogCursor | null {
  if (!raw || raw.length > MAX_CURSOR_LENGTH || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  try {
    const bytes = Buffer.from(raw, "base64url");
    if (bytes.toString("base64url") !== raw) return null;
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    const keys = Object.keys(row).sort().join(",");
    if (row.v === 1 && keys === "id,t,v"
      && typeof row.t === "number" && Number.isFinite(row.t) && row.t >= 0
      && typeof row.id === "string" && row.id.length > 0 && row.id.length <= 256) {
      return { v: 1, t: row.t, id: row.id };
    }
    if (row.v !== 2 || keys !== "e,h,n,q,v"
      || typeof row.e !== "string" || !/^[a-f0-9]{32}$/.test(row.e)
      || typeof row.n !== "number" || !Number.isSafeInteger(row.n) || row.n < 0 || row.n > MAX_WINDOW_ROWS
      || typeof row.q !== "string" || !/^[a-f0-9]{64}$/.test(row.q)
      || typeof row.h !== "string" || !/^[a-f0-9]{64}$/.test(row.h)) return null;
    return { v: 2, e: row.e, n: row.n, q: row.q, h: row.h };
  } catch {
    return null;
  }
}

/**
 * Compare the current projected window, not ring identities: live entries and
 * display-time pricing can change without append. This saves response bytes for
 * stable prefixes; DTO projection and hashing still cost O(window bytes).
 * No per-client rows or history are retained. The route calls this synchronously
 * after projecting the full filtered/paginated window.
 */
export function selectRequestLogPoll<T extends object>(
  rows: readonly T[],
  params: URLSearchParams,
  cursor: RequestLogCursor | null,
  epoch = processEpoch,
): { logs: T[]; cursor: string; reset: boolean } {
  const query = new URLSearchParams(params);
  query.delete("cursor");
  query.sort();
  const queryDigest = createHash("sha256").update(query.toString()).digest("hex");
  const candidate = cursor?.v === 2 && cursor.e === epoch && cursor.q === queryDigest
    && cursor.n <= rows.length ? cursor : null;
  const full = createHash("sha256");
  const prefix = createHash("sha256");
  for (let index = 0; index < rows.length; index++) {
    // JSON escapes embedded newlines, so the delimiter frames each whole row.
    const serialized = JSON.stringify(rows[index]) + "\n";
    full.update(serialized);
    if (candidate && index < candidate.n) prefix.update(serialized);
  }
  const unchangedPrefix = candidate !== null && prefix.digest("hex") === candidate.h;
  const next: SnapshotCursor = { v: 2, e: epoch, n: rows.length, q: queryDigest, h: full.digest("hex") };
  return {
    logs: rows.slice(unchangedPrefix ? candidate.n : 0),
    cursor: Buffer.from(JSON.stringify(next)).toString("base64url"),
    reset: cursor !== null && !unchangedPrefix,
  };
}
