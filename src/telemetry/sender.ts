import { signalWithTimeout } from "../lib/abort";
import { validateTelemetryPayloadV1, type TelemetryPayloadV1 } from "./contract";

export const TELEMETRY_COLLECTOR_ENDPOINT = "https://telemetry.opencodex.me/v1/events";
export const TELEMETRY_SEND_TIMEOUT_MS = 10_000;

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
      signal: deadline.signal,
    });
    if (!response.ok) {
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
