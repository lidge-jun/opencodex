import { decodeRequestLogCursor } from "../server/request-log-cursor";
import { printData } from "./runtime-api";
import { ObservationError, withObserveStream, type ObserveStreamDeps } from "./observe-stream";

type LogRow = Record<string, unknown>;
interface Poll { rows: LogRow[]; cursor: string | null; reset: boolean }

function parsePoll(body: unknown, limit: number): Poll {
  let rows: unknown;
  let cursor: string | null = null;
  let reset = false;
  if (Array.isArray(body)) rows = body;
  else if (body && typeof body === "object") {
    const value = body as Record<string, unknown>;
    if (Object.hasOwn(value, "cursor") || Object.hasOwn(value, "reset")) {
      if (typeof value.cursor !== "string" || !decodeRequestLogCursor(value.cursor) || typeof value.reset !== "boolean") {
        throw new ObservationError("Invalid log cursor response. Upgrade the runtime and restart follow.");
      }
      cursor = value.cursor;
      reset = value.reset;
      rows = value.logs;
    } else {
      for (const key of ["logs", "entries", "requests"]) {
        if (Object.hasOwn(value, key)) { rows = value[key]; break; }
      }
    }
  }
  if (!Array.isArray(rows) || rows.length > limit || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
    throw new ObservationError("Invalid log window. Check --limit and upgrade the runtime before restarting follow.");
  }
  return { rows: rows as LogRow[], cursor, reset };
}

/** Compare row occurrences, not request IDs: identical duplicates each consume one match. */
function newOccurrences(previous: LogRow[], incoming: LogRow[]): LogRow[] {
  const counts = new Map<string, number>();
  for (const row of previous) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return incoming.filter(row => {
    const key = JSON.stringify(row);
    const remaining = counts.get(key) ?? 0;
    if (!remaining) return true;
    counts.set(key, remaining - 1);
    return false;
  });
}

export async function followLogs(
  options: { query: URLSearchParams; limit: number; jsonl: boolean; events: boolean; formatRow: (row: LogRow) => string },
  deps: ObserveStreamDeps,
): Promise<number> {
  return withObserveStream(deps, async stream => {
    let window: LogRow[] = [];
    let cursor: string | null = null;
    let initial = true;
    while (true) {
      const query = new URLSearchParams(options.query);
      if (cursor !== null) query.set("cursor", cursor);
      const poll = parsePoll(await stream.get("/api/logs", query), options.limit);
      stream.signal.throwIfAborted();
      const append = !initial && cursor !== null && poll.cursor !== null && !poll.reset;
      const next = append ? [...window, ...poll.rows].slice(-options.limit) : poll.rows;
      if (options.events) {
        const changed = JSON.stringify(next) !== JSON.stringify(window);
        if (initial || poll.reset || (append ? poll.rows.length > 0 : changed)) {
          console.log(JSON.stringify({ schemaVersion: 1, type: append ? "append" : "snapshot", rows: poll.rows, cursor: poll.cursor, limit: options.limit }));
        }
      } else {
        const emitted = append ? poll.rows : newOccurrences(window, next);
        for (const row of emitted) {
          stream.signal.throwIfAborted();
          if (options.jsonl) console.log(JSON.stringify(row));
          else printData(row, false, [options.formatRow(row)]);
        }
      }
      window = next;
      cursor = poll.cursor;
      initial = false;
      await stream.wait();
    }
  });
}
