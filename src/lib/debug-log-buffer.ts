/** In-memory ring buffer of debug log lines for `ocx debug logs` / GUI tailing. */

export interface DebugLogEntry {
  /** Monotonic cursor for pagination; survives same-millisecond bursts. */
  seq: number;
  at: number;
  line: string;
}

const MAX_LINES = 2_000;
const MAX_DEBUG_SUBSCRIBERS = 64;
const MAX_DEBUG_LINE_BYTES = 16 * 1024;
const buffer: DebugLogEntry[] = [];
interface DebugSubscriberRegistration { lease: AdmissionLease }
const listeners = new Map<(entry: DebugLogEntry) => void, DebugSubscriberRegistration>();
const subscriberGate = createAdmissionGate("debug_subscribers", MAX_DEBUG_SUBSCRIBERS);
let nextSeq = 1;
let bufferBytes = 0;

function removeOldestEntry(): number {
  const entry = buffer.shift();
  if (!entry) return 0;
  const bytes = retainedUtf8Bytes(entry.line);
  bufferBytes -= bytes;
  return bytes;
}

export function appendDebugLogLine(line: string): void {
  const retainedLine = truncateRetainedUtf8(line, MAX_DEBUG_LINE_BYTES);
  const entry: DebugLogEntry = { seq: nextSeq++, at: Date.now(), line: retainedLine };
  buffer.push(entry);
  bufferBytes += retainedUtf8Bytes(retainedLine);
  while (buffer.length > MAX_LINES) removeOldestEntry();
  enforceAppOwnedMemoryBudget();
  for (const listener of listeners.keys()) {
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
  let registration = listeners.get(listener);
  if (!registration) {
    const lease = subscriberGate.tryAcquire();
    if (!lease) throw new ResourceAdmissionError("debug_subscribers", MAX_DEBUG_SUBSCRIBERS);
    registration = { lease };
    listeners.set(listener, registration);
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    if (listeners.get(listener) !== registration) return;
    listeners.delete(listener);
    registration.lease.release();
  };
}

export function debugBufferMetrics(): { entries: number; bytes: number; subscribers: AdmissionMetrics; oldestAt: number | null } {
  return { entries: buffer.length, bytes: bufferBytes, subscribers: subscriberGate.metrics(), oldestAt: buffer[0]?.at ?? null };
}

export function evictOldestDebugEntryForBudget(): number {
  return removeOldestEntry();
}

/** Test isolation. */
export function resetDebugLogBufferForTests(): void {
  buffer.length = 0;
  bufferBytes = 0;
  for (const registration of listeners.values()) registration.lease.release();
  listeners.clear();
  nextSeq = 1;
}
import { createAdmissionGate, ResourceAdmissionError, retainedUtf8Bytes, truncateRetainedUtf8, type AdmissionLease, type AdmissionMetrics } from "./admission";
import { enforceAppOwnedMemoryBudget } from "./app-owned-memory";
