/** In-memory ring buffer of multi-agent guidance-injection / effort-cap log lines.
 *
 * Injection debug lines were previously console-only, so the GUI had an "Injection log"
 * toggle with nothing to display. This buffer mirrors the provider debug buffer so the
 * management API and GUI can tail injection lines the same way. Callers keep their own
 * `isInjectionDebugEnabled()` guard; this module only stores what it is given. */

import type { DebugLogEntry } from "./debug-log-buffer";

const MAX_LINES = 2_000;
const buffer: DebugLogEntry[] = [];
let nextSeq = 1;

/** Append a line to the injection buffer and echo it to the server console. */
export function injectionDebugLog(line: string): void {
  const entry: DebugLogEntry = { seq: nextSeq++, at: Date.now(), line };
  buffer.push(entry);
  if (buffer.length > MAX_LINES) buffer.splice(0, buffer.length - MAX_LINES);
  console.log(line);
}

export function getInjectionDebugLogEntries(options?: { after?: number; limit?: number }): DebugLogEntry[] {
  const after = options?.after ?? 0;
  const limit = options?.limit ?? 500;
  const filtered = after > 0 ? buffer.filter(entry => entry.seq > after) : buffer;
  if (filtered.length <= limit) return filtered;
  return filtered.slice(-limit);
}

/** Test isolation. */
export function resetInjectionDebugLogBufferForTests(): void {
  buffer.length = 0;
  nextSeq = 1;
}
