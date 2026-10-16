import { printData } from "./runtime-api";
import { ObservationError, withObserveStream, type ObserveStreamDeps } from "./observe-stream";
import type { DebugLogEntry } from "../lib/debug-log-buffer";

function parseRows(body: unknown, after: number, limit: number): DebugLogEntry[] {
  if (!Array.isArray(body) || body.length > limit) throw new ObservationError("Invalid injection log window. Restart follow after checking the runtime.");
  let previous = after;
  return body.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ObservationError("Invalid injection log row.");
    const { seq, at, line } = value as Record<string, unknown>;
    if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq <= previous || seq <= 0
      || typeof at !== "number" || !Number.isFinite(at) || typeof line !== "string") {
      throw new ObservationError("Invalid injection log order or row. Restart follow after checking the runtime.");
    }
    previous = seq;
    return { seq, at, line };
  });
}

export async function followInjection(limit: number, jsonl: boolean, deps: ObserveStreamDeps): Promise<number> {
  return withObserveStream(deps, async stream => {
    let after = 0;
    while (true) {
      const query = new URLSearchParams({ limit: String(limit), after: String(after) });
      const rows = parseRows(await stream.get("/api/debug/injection-logs", query), after, limit);
      for (const row of rows) {
        stream.signal.throwIfAborted();
        if (jsonl) console.log(JSON.stringify(row));
        else printData(row, false, [`${row.seq}  ${row.at}  ${row.line}`]);
        after = row.seq;
      }
      await stream.wait();
    }
  });
}
