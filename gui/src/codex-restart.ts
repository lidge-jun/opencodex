import type {
  CodexRestartCode,
  CodexRestartResponse,
} from "../../src/lib/codex-restart-contract";
import { isCodexRestartResponse } from "../../src/lib/codex-restart-contract";

// Re-exported so callers import the vocabulary from one place.
export type { CodexRestartCode, CodexRestartResponse };

// Enumeration can shell out to ps, procfs, or PowerShell CIM, and the request also
// rewrites the catalog first, so this is slower than an ordinary management call.
const DEFAULT_TIMEOUT_MS = 30_000;

export interface CodexRestartOutcome {
  ok: boolean;
  result?: CodexRestartResponse;
  /** Localized by the caller through the format* options. */
  message?: string;
}

export interface CodexRestartOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  formatFailure?: (status: number) => string;
  formatUnreachable?: () => string;
  formatMalformed?: () => string;
  /**
   * Separate from `formatUnreachable`: a timeout does NOT mean nothing happened.
   * The request is abandoned client-side, but the proxy never sees the abort, so
   * a catalog sync that ran long can still stop app-servers afterwards. Telling
   * the user "could not reach the proxy" there would be a lie they act on.
   */
  formatTimeout?: () => string;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError" || error.name === "TimeoutError"
    : error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function requestCodexRestart(
  apiBase: string,
  options: CodexRestartOptions = {},
): Promise<CodexRestartOutcome> {
  const {
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    formatFailure = status => `Failed to restart Codex (HTTP ${status}).`,
    formatUnreachable = () => "Could not reach the proxy.",
    formatMalformed = () => "The proxy returned an unexpected response.",
    formatTimeout = () => "The proxy did not answer in time. It may still be working.",
  } = options;

  let response: Response;
  try {
    response = await fetchFn(`${apiBase}/api/system/codex-restart`, {
      method: "POST",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Unlike stop-proxy, a dropped connection here is a real failure: this route
    // does not kill the process serving it, so silence means something broke.
    // A timeout is reported separately because the work may still be running.
    return { ok: false, message: isAbortError(error) ? formatTimeout() : formatUnreachable() };
  }

  if (!response.ok) return { ok: false, message: formatFailure(response.status) };

  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    // A body that arrives late enough to trip the same timeout is not a malformed
    // response; say so honestly rather than blaming the payload.
    return { ok: false, message: isAbortError(error) ? formatTimeout() : formatMalformed() };
  }

  // A parseable 2xx body of the wrong shape must not reach the caller: the caller
  // indexes into the pid arrays, and a contradictory body would be reported as a
  // success that never happened.
  if (!isCodexRestartResponse(payload)) return { ok: false, message: formatMalformed() };
  return { ok: true, result: payload };
}
