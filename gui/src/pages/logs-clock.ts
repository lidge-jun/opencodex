/** Proxy epoch sampled by GET /api/logs, paired with the browser's monotonic receipt time. */
export interface LogsClockAnchor {
  generatedAt: number;
  receivedAt: number;
}

/** Legacy arrays and envelopes without a valid server sample do not replace an anchor. */
export function logsClockAnchor(generatedAt: unknown, receivedAt: number): LogsClockAnchor | undefined {
  return typeof generatedAt === "number" && Number.isFinite(generatedAt) && generatedAt >= 0
    ? { generatedAt, receivedAt }
    : undefined;
}

/** Older proxies retain browser-wall-clock behavior until this resource supplies a sample. */
export function logsClockNow(anchor: LogsClockAnchor | undefined, monotonicNow: number, wallNow: number): number {
  return anchor ? anchor.generatedAt + Math.max(0, monotonicNow - anchor.receivedAt) : wallNow;
}
