/** In-memory ring buffer of debug log lines for `ocx debug logs` / GUI tailing. */

export interface DebugLogEntry {
  /** Monotonic cursor for pagination; survives same-millisecond bursts. */
  seq: number;
  at: number;
  line: string;
}

const MAX_LINES = 2_000;
const buffer: DebugLogEntry[] = [];
const listeners = new Set<(entry: DebugLogEntry) => void>();
let nextSeq = 1;

export function appendDebugLogLine(line: string): void {
  const entry: DebugLogEntry = { seq: nextSeq++, at: Date.now(), line };
  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  for (const listener of listeners) {
    try { listener(entry); } catch { /* listeners must not break logging */ }
  }
}

export function getDebugLogEntries(options?: { after?: number; limit?: number }): DebugLogEntry[] {
  const after = options?.after ?? 0;
  const limit = options?.limit ?? 500;
  const filtered = after > 0 ? buffer.filter(entry => entry.seq > after) : buffer;
  if (filtered.length <= limit) return filtered;
  return filtered.slice(-limit);
}

export function subscribeDebugLogEntries(listener: (entry: DebugLogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test isolation. */
export function resetDebugLogBufferForTests(): void {
  buffer.length = 0;
  listeners.clear();
  nextSeq = 1;
}
