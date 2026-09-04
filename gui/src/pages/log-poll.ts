export interface ParsedLogPollResponse<T> {
  rows: T[];
  cursor: string | null;
  reset: boolean;
  cursorCapable: boolean;
}

export function parseLogPollResponse<T>(body: unknown): ParsedLogPollResponse<T> {
  if (Array.isArray(body)) {
    return {
      rows: body as T[],
      cursor: null,
      reset: false,
      cursorCapable: false,
    };
  }
  if (typeof body === "object" && body !== null) {
    const candidate = body as { logs?: unknown; cursor?: unknown; reset?: unknown };
    const rows = Array.isArray(candidate.logs) ? (candidate.logs as T[]) : [];
    const cursor = typeof candidate.cursor === "string" && candidate.cursor.trim() ? candidate.cursor.trim() : null;
    const reset = candidate.reset === true;
    const cursorCapable = cursor !== null || reset || Object.hasOwn(candidate, "cursor") || Object.hasOwn(candidate, "reset");
    return {
      rows,
      cursor,
      reset,
      cursorCapable,
    };
  }
  return {
    rows: [],
    cursor: null,
    reset: false,
    cursorCapable: false,
  };
}

export function mergeLogDelta<T extends { requestId?: string }>(
  previous: readonly T[],
  incoming: readonly T[],
  cap = 2000,
): T[] {
  if (incoming.length === 0) {
    return previous.length > cap ? previous.slice(previous.length - cap) : [...previous];
  }
  const incomingIds = new Set(
    incoming
      .map(row => row.requestId)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  );
  const filteredPrev = previous.filter(row => !row.requestId || !incomingIds.has(row.requestId));
  const merged = [...filteredPrev, ...incoming];
  return merged.length > cap ? merged.slice(merged.length - cap) : merged;
}
