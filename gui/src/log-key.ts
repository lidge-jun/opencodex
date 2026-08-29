export interface LogKeyed {
  requestId?: string;
  timestamp: number;
  model: string;
  provider: string;
  status: number;
  durationMs: number;
}

/** Stable identity key. Uses requestId when present; composite fallback otherwise. */
export function logKey(log: LogKeyed): string {
  if (log.requestId) return `logKey:rid:${log.requestId}`;
  return `logKey:f:${log.timestamp}|${log.model}|${log.provider}|${log.status}|${log.durationMs}`;
}
