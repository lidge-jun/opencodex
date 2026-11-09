import { signalWithTimeout } from "../lib/abort";
import { validateTelemetryPayloadV1, type TelemetryPayloadV1 } from "./contract";

export const TELEMETRY_COLLECTOR_ENDPOINT = "https://telemetry.opencodex.me/v1/events";
export const TELEMETRY_SEND_TIMEOUT_MS = 10_000;
export const TELEMETRY_DEFAULT_RETRY_AFTER_MS = 15 * 60 * 1000;
export const TELEMETRY_RETRY_JITTER_MS = 5 * 60 * 1000;
const MAX_RETRY_AFTER_MS = 7 * 86_400_000;

export interface TelemetrySendOptions {
  endpoint?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: number;
}

export interface TelemetrySendResult {
  ok: boolean;
  status?: number;
  error?: string;
  retryAfterMs?: number;
}

/**
 * Parse an HTTP `Retry-After` header value (delta-seconds or HTTP-date) into milliseconds.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, now = Date.now()): number | null {
  if (typeof headerValue !== "string") return null;
  const trimmed = headerValue.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const targetMs = Date.parse(trimmed);
  if (Number.isNaN(targetMs) || targetMs <= now) return null;
  return Math.min(targetMs - now, MAX_RETRY_AFTER_MS);
}

let testOverrides: TelemetrySendOptions | null = null;

export function setTelemetrySenderOverridesForTests(overrides: TelemetrySendOptions | null): void {
  testOverrides = overrides;
}

export async function sendTelemetryPayload(
  payload: TelemetryPayloadV1,
  options: TelemetrySendOptions = {},
): Promise<TelemetrySendResult> {
  const now = options.now ?? testOverrides?.now ?? Date.now();
  const validated = validateTelemetryPayloadV1(payload, now);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  const endpoint = options.endpoint ?? testOverrides?.endpoint ?? TELEMETRY_COLLECTOR_ENDPOINT;
  const fetchImpl = options.fetch ?? testOverrides?.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? testOverrides?.timeoutMs ?? TELEMETRY_SEND_TIMEOUT_MS;
  const parentSignal = options.signal ?? testOverrides?.signal;

  const deadline = signalWithTimeout(timeoutMs, parentSignal);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(validated.payload),
      // The collector URL is a constant; a redirect would send the report to another host.
      redirect: "error",
      signal: deadline.signal,
    });
    if (!response.ok) {
      if (response.status === 429 || response.status === 503) {
        const headerRetryMs = parseRetryAfterMs(response.headers?.get?.("retry-after"), now);
        const retryAfterMs = headerRetryMs
          ?? (TELEMETRY_DEFAULT_RETRY_AFTER_MS + Math.floor(Math.random() * TELEMETRY_RETRY_JITTER_MS));
        return {
          ok: false,
          status: response.status,
          error: `collector responded ${response.status}`,
          retryAfterMs,
        };
      }
      return { ok: false, status: response.status, error: `collector responded ${response.status}` };
    }
    return { ok: true, status: response.status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    deadline.cleanup();
  }
}
