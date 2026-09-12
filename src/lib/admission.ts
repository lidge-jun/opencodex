export const RETAINED_TRUNCATION_MARKER = "\n…[truncated by opencodex]";

export class ResourceAdmissionError extends Error {
  readonly code: string = "server_busy";

  constructor(readonly resource: string, readonly limit: number) {
    super(`${resource} capacity reached (${limit})`);
    this.name = "ResourceAdmissionError";
  }
}

export interface AdmissionMetrics {
  active: number;
  peak: number;
  admitted: number;
  rejected: number;
  releaseMisses: number;
}

export interface AdmissionLease {
  release(): void;
}

export interface AdmissionReservation<T> extends AdmissionLease {
  bind(value: T): void;
}

export function createAdmissionGate(name: string, limit: number): {
  tryAcquire(): AdmissionLease | null;
  metrics(): Readonly<AdmissionMetrics>;
} {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError(`${name} admission limit must be positive`);
  const state: AdmissionMetrics = { active: 0, peak: 0, admitted: 0, rejected: 0, releaseMisses: 0 };
  return {
    tryAcquire() {
      if (state.active >= limit) {
        state.rejected += 1;
        return null;
      }
      state.active += 1;
      state.admitted += 1;
      state.peak = Math.max(state.peak, state.active);
      let active = true;
      return {
        release() {
          if (!active) {
            return;
          }
          active = false;
          state.active -= 1;
        },
      };
    },
    metrics() {
      return { ...state };
    },
  };
}

export function retainedUtf8Bytes(value: string): number {
  // Keep TextEncoder's runtime coercion for legacy callers outside the string-typed contract.
  // Template coercion rejects Symbols; String(value) would silently accept them.
  return Buffer.byteLength(typeof value === "string" ? value : value === undefined ? "" : `${value}`, "utf8");
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let end = 0;
  while (end < value.length) {
    const code = value.charCodeAt(end);
    const next = value.charCodeAt(end + 1);
    const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
    // An unpaired surrogate encodes as a three-byte replacement, like TextEncoder.
    const size = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : pair ? 4 : 3;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += pair ? 2 : 1;
  }
  return value.slice(0, end);
}

export function truncateRetainedUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer");
  if (retainedUtf8Bytes(value) <= maxBytes) return value;
  const markerBytes = retainedUtf8Bytes(RETAINED_TRUNCATION_MARKER);
  if (markerBytes > maxBytes) return utf8Prefix(RETAINED_TRUNCATION_MARKER, maxBytes);
  return utf8Prefix(value, maxBytes - markerBytes) + RETAINED_TRUNCATION_MARKER;
}
