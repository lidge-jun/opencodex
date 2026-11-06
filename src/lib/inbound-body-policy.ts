/** Admission accounting for raised HTTP bodies; these values do not cap RSS. */
export const DEFAULT_CONCURRENT_INBOUND_BODY_BYTES = 512 * 1024 * 1024;
export const MAX_CONCURRENT_INBOUND_BODY_BYTES = 2 * 1024 * 1024 * 1024;

/** Keep hand edits bounded; omission, zero and invalid values retain the old default. */
export function resolveConcurrentInboundBodyLimitBytes(configured?: number): number {
  if (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured <= 0) {
    return DEFAULT_CONCURRENT_INBOUND_BODY_BYTES;
  }
  return Math.min(MAX_CONCURRENT_INBOUND_BODY_BYTES, Math.max(DEFAULT_CONCURRENT_INBOUND_BODY_BYTES, configured));
}
