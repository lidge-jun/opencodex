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
  return new TextEncoder().encode(value).byteLength;
}

function utf8Prefix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  let bytes = 0;
  let result = "";
  for (const character of value) {
    const size = retainedUtf8Bytes(character);
    if (bytes + size > maxBytes) break;
    result += character;
    bytes += size;
  }
  return result;
}

export function truncateRetainedUtf8(value: string, maxBytes: number): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative integer");
  if (retainedUtf8Bytes(value) <= maxBytes) return value;
  const markerBytes = retainedUtf8Bytes(RETAINED_TRUNCATION_MARKER);
  if (markerBytes > maxBytes) return utf8Prefix(RETAINED_TRUNCATION_MARKER, maxBytes);
  return utf8Prefix(value, maxBytes - markerBytes) + RETAINED_TRUNCATION_MARKER;
}
