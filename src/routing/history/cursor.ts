/**
 * Opaque keyset cursor for request-history pagination (RI-02, ADR-9).
 *
 * Ordering is `timestamp DESC, request_id DESC`; the cursor encodes the last
 * returned row's `(timestamp, requestId)` pair as base64url JSON. Cursors are
 * opaque to clients: any decode failure or shape mismatch yields `null` and
 * the API answers `400 invalid_cursor` instead of guessing.
 */

export interface HistoryCursor {
  t: number;
  i: string;
}

export class InvalidCursorError extends Error {
  readonly code = "invalid_cursor" as const;

  constructor() {
    super("invalid_cursor");
    this.name = "InvalidCursorError";
  }
}

export function encodeHistoryCursor(cursor: HistoryCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

export function decodeHistoryCursor(raw: string | null | undefined): HistoryCursor | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4096) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf-8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const t = record.t;
  const i = record.i;
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  if (typeof i !== "string" || i.length === 0 || i.length > 256) return null;
  return { t, i };
}
