/** In-memory ring buffer of debug log lines for `ocx debug logs` / GUI tailing. */

export interface DebugLogEntry {
  at: number;
  line: string;
}

const MAX_LINES = 2_000;
const buffer: DebugLogEntry[] = [];
const listeners = new Set<(entry: DebugLogEntry) => void>();

export function appendDebugLogLine(line: string): void {
  const entry: DebugLogEntry = { at: Date.now(), line };
  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  for (const listener of listeners) {
    try { listener(entry); } catch { /* listeners must not break logging */ }
  }
}

export function getDebugLogEntries(options?: { since?: number; limit?: number }): DebugLogEntry[] {
  const since = options?.since ?? 0;
  const limit = options?.limit ?? 500;
  const filtered = since > 0 ? buffer.filter(entry => entry.at > since) : buffer;
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
}

