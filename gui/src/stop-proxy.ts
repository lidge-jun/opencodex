export interface ProxyStopOutcome {
  accepted: boolean;
  message?: string;
}

interface ProxyStopPayload {
  success?: unknown;
  message?: unknown;
  error?: unknown;
}

const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export interface ProxyStopOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  formatFailure?: (status: number) => string;
}

function failureMessage(
  payload: ProxyStopPayload | null,
  status: number,
  formatFailure: (status: number) => string,
): string {
  if (typeof payload?.message === "string" && payload.message.trim()) return payload.message;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error;
  return formatFailure(status);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : error instanceof Error && error.name === "AbortError";
}

/**
 * A dropped connection is expected once shutdown starts. A received response, however,
 * is authoritative: either a non-2xx status or `{ success: false }` means the UI must
 * leave its pending state and surface the server's restore error.
 */
export async function requestProxyStop(
  apiBase: string,
  options: ProxyStopOptions = {},
): Promise<ProxyStopOutcome> {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_STOP_TIMEOUT_MS,
    formatFailure = status => `Failed to stop proxy (HTTP ${status}).`,
  } = options;
  let response: Response;
  try {
    response = await fetchFn(`${apiBase}/api/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (isAbortError(error)) return { accepted: true };
    return { accepted: true };
  }

  const payload = await response.json().catch(() => null) as ProxyStopPayload | null;
  if (!response.ok || payload?.success === false) {
    return { accepted: false, message: failureMessage(payload, response.status, formatFailure) };
  }
  return { accepted: true };
}
