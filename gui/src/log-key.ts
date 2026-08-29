/**
 * Stable identity key for a log entry. Used by the clear-view boundary to track
 * which entries have been dismissed. When `requestId` is present it is the key;
 * otherwise a deterministic composite of immutable fields avoids false merges
 * without copying the entire log array.
 */
export interface LogKeyed {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs: number;
}

export function logKey(log: LogKeyed): string {
  if (log.requestId) return `logKey:rid:${log.requestId}`;
  return `logKey:f:${log.timestamp}|${log.model}|${log.provider}|${log.status}|${log.durationMs}`;
}
