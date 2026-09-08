export interface ParsedLogPollResponse<T> {
  rows: T[];
  cursor: string | null;
  reset: boolean;
  generatedAt?: unknown;
  timeZone?: string;
  total?: number;
}

/** Legacy responses replace the window; malformed cursor responses keep last-good data. */
export function parseLogPollResponse<T>(body: unknown): ParsedLogPollResponse<T> {
  if (Array.isArray(body)) return { rows: body as T[], cursor: null, reset: false };
  if (!body || typeof body !== "object") throw new Error("Invalid log response");
  const value = body as Record<string, unknown>;
  const hasCursor = Object.hasOwn(value, "cursor") || Object.hasOwn(value, "reset");
  if ((value.logs !== undefined && !Array.isArray(value.logs))
    || (hasCursor && (!Array.isArray(value.logs)
      || typeof value.cursor !== "string" || value.cursor.length === 0 || value.cursor.length > 512
      || !/^[A-Za-z0-9_-]+$/.test(value.cursor) || typeof value.reset !== "boolean"))) {
    throw new Error("Invalid log response");
  }
  return {
    rows: (value.logs ?? []) as T[],
    cursor: hasCursor ? value.cursor as string : null,
    reset: value.reset === true,
    generatedAt: value.generatedAt,
    ...(typeof value.timeZone === "string" ? { timeZone: value.timeZone } : {}),
    ...(typeof value.total === "number" && Number.isFinite(value.total) && value.total >= 0
      ? { total: value.total } : {}),
  };
}

/** Updates/removals arrive as resets. Preserve order and even repeated IDs in valid suffixes. */
export function mergeLogDelta<T>(previous: T[], incoming: readonly T[], cap = 2000): T[] {
  if (incoming.length === 0 && previous.length <= cap) return previous;
  const merged = [...previous, ...incoming];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
