import type { CursorRunRequest, CursorServerMessage } from "./types";
import type { CursorTransport, CursorTransportFactory, CursorTransportFactoryInput } from "./transport";
import { abortError, sleepWithAbort } from "../../lib/upstream-retry";
import { debugProviderDiagnostic } from "../../lib/debug";
import { safeCursorErrorMessage } from "./cursor-errors";

// Compat: historical name for the shared abortable sleep, kept for external callers.
export { sleepWithAbort as abortAwareSleep } from "../../lib/upstream-retry";

export const CURSOR_RETRY_ATTEMPTS = 3;
export const CURSOR_RETRY_BASE_MS = 250;
export const CURSOR_RETRY_MAX_MS = 2_000;

/**
 * True only for clearly transient failures that occur BEFORE the run request is committed to the
 * wire (connection refused/reset/timeout, immediate HTTP/2 GOAWAY, gRPC/Connect "unavailable").
 * Conservative by design: auth, invalid-request, and anything ambiguous is non-retryable so we
 * never replay a turn the Cursor server might already have accepted.
 */
export function isRetryableCursorError(err: unknown): boolean {
  const code = typeof err === "object" && err && "code" in err ? String((err as { code?: unknown }).code ?? "") : "";
  const message = err instanceof Error ? err.message : typeof err === "string" ? err : "";
  const haystack = `${code} ${message}`.toLowerCase();
  if (/auth|unauthor|forbidden|invalid|permission|denied|not found|unsupported/.test(haystack)) return false;
  if (/resource.exhausted|resource_exhausted|rate limit|too many requests|throttl/.test(haystack)) return false;
  if (haystack.includes("nghttp2_cancel") || haystack.includes("stream suspended")) return false;
  return (
    haystack.includes("econnreset") ||
    haystack.includes("econnrefused") ||
    haystack.includes("etimedout") ||
    haystack.includes("enetunreach") ||
    haystack.includes("eai_again") ||
    haystack.includes("goaway") ||
    (haystack.includes("nghttp2") && !haystack.includes("nghttp2_cancel")) ||
    haystack.includes("socket hang up") ||
    haystack.includes("connection reset") ||
    haystack.includes("unavailable") ||
    haystack.includes("timed out")
  );
}

export function cursorRetryDelayMs(attempt: number): number {
  const exp = Math.min(CURSOR_RETRY_BASE_MS * 2 ** attempt, CURSOR_RETRY_MAX_MS);
  return Math.floor(exp * (0.8 + Math.random() * 0.4));
}

/**
 * A transport is safe to retry only if it explicitly reports the run request was never committed.
 * A transport without `requestCommitted` is treated as committed (not retryable) — fail safe.
 */
function requestUncommitted(transport: CursorTransport): boolean {
  return typeof transport.requestCommitted === "function" && transport.requestCommitted() === false;
}

/**
 * Run a Cursor turn with bounded retry on pre-commit transient failures.
 *
 * `onEvent` receives every server message. Retry happens only when ALL hold:
 *  - nothing has been emitted yet this turn,
 *  - the failing transport reports the run request was not committed to the wire,
 *  - the error is a transient pre-commit failure.
 * Otherwise the error propagates (the adapter maps it to a user-facing message).
 */
export async function runCursorTurnWithRetry(
  makeTransport: (input: CursorTransportFactoryInput) => CursorTransport,
  input: CursorTransportFactoryInput,
  request: CursorRunRequest,
  signal: AbortSignal | undefined,
  onEvent: (message: CursorServerMessage, transport: CursorTransport) => void,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < CURSOR_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    const transport = makeTransport(input);
    let emittedAny = false;
    try {
      for await (const message of transport.run(request, signal)) {
        emittedAny = true;
        onEvent(message, transport);
      }
      return;
    } catch (err) {
      lastError = err;
      const canRetry =
        !emittedAny &&
        attempt < CURSOR_RETRY_ATTEMPTS - 1 &&
        !signal?.aborted &&
        requestUncommitted(transport) &&
        isRetryableCursorError(err);
      if (!canRetry) {
        debugProviderDiagnostic("cursor", "no-retry", {
          attempt,
          reason: safeCursorErrorMessage(err instanceof Error ? err.message : String(err)),
          emittedAny,
          committed: !requestUncommitted(transport),
          aborted: !!signal?.aborted,
        });
        throw err;
      }
      const backoffMs = cursorRetryDelayMs(attempt);
      debugProviderDiagnostic("cursor", "retry", {
        attempt,
        reason: safeCursorErrorMessage(err instanceof Error ? err.message : String(err)),
        backoffMs,
      });
      await sleepWithAbort(backoffMs, signal);
    } finally {
      await transport.close?.();
    }
  }
  throw lastError ?? new Error("Cursor transport failed");
}

export type { CursorTransportFactory };
