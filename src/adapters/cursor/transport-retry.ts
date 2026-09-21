import type { CursorRunRequest, CursorServerMessage } from "./types";
import type { CursorTransport, CursorTransportFactory, CursorTransportFactoryInput } from "./transport";
import type { RequestExecutionBudget } from "../../lib/request-execution-budget";
import type { AttemptRecoveryKind } from "../../usage/log";
import { SendBudgetExhaustedError, abortError, retryBackoffDelayMs, sleepWithAbort } from "../../lib/upstream-retry";
import { debugProviderDiagnostic } from "../../lib/debug";
import { isCursorRootEnvelopeError, safeCursorErrorMessage } from "./cursor-errors";

// Compat: historical name for the shared abortable sleep, kept for external callers.
export { sleepWithAbort as abortAwareSleep } from "../../lib/upstream-retry";

export const CURSOR_RETRY_ATTEMPTS = 3;
export const CURSOR_RETRY_BASE_MS = 250;
export const CURSOR_RETRY_MAX_MS = 2_000;

/**
 * Fixed identity for the Cursor upstream in the request budget's target ledger. A literal, not
 * anything derived from the turn: the ledger is read back in diagnostics, so it must not become
 * a place where a session or credential identity leaks.
 */
export const CURSOR_BUDGET_TARGET_KEY = "cursor";

/**
 * How one Cursor turn participates in the enclosing logical request (#4546).
 *
 * Both fields are optional and the whole object defaults to empty, which is what keeps a
 * context-free unit call unlimited: this transport is exercised directly by tests that build no
 * request at all, and a mandatory budget would have made every one of them a budget test.
 */
export interface CursorTurnExecutionOptions {
  /** Absent means unlimited; present means every retry is a physical send the request pays for. */
  sendBudget?: RequestExecutionBudget;
  /** Observes each physical run request; `ordinal` counts from 1 within this turn. */
  onPhysicalSend?: (send: { ordinal: number; recovery?: AttemptRecoveryKind }) => void;
}

/**
 * True only for clearly transient failures that occur BEFORE the run request is committed to the
 * wire (connection refused/reset/timeout, immediate HTTP/2 GOAWAY, gRPC/Connect "unavailable").
 * Conservative by design: auth, invalid-request, and anything ambiguous is non-retryable so we
 * never replay a turn the Cursor server might already have accepted.
 */
export function isRetryableCursorError(err: unknown): boolean {
  // Local envelope failures are deterministic: the same request produces the same rejection.
  // Checked before the text heuristics below, which would otherwise have to infer this from
  // wording.
  if (isCursorRootEnvelopeError(err)) return false;
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
  return retryBackoffDelayMs(attempt, {
    baseDelayMs: CURSOR_RETRY_BASE_MS,
    maxDelayMs: CURSOR_RETRY_MAX_MS,
  });
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
 *
 * `execution` carries the enclosing request's send budget. Each attempt here is a real re-send
 * of the whole turn, so an outer cap that counted one adapter entry counted at most a third of
 * what went upstream; when a budget is present every attempt is admitted against it and an
 * exhausted request stops before opening another transport (#4546).
 */
export async function runCursorTurnWithRetry(
  makeTransport: (input: CursorTransportFactoryInput) => CursorTransport,
  input: CursorTransportFactoryInput,
  request: CursorRunRequest,
  signal: AbortSignal | undefined,
  onEvent: (message: CursorServerMessage, transport: CursorTransport) => void,
  execution: CursorTurnExecutionOptions = {},
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) throw abortError(signal);
    // Admitted before the transport is built: a refused send must not open a connection, and
    // the refusal must reach the adapter as the typed exhaustion rather than as a run failure
    // that the retry predicate below could read as transient.
    const decision = execution.sendBudget?.reserveDispatch({
      sendClass: "transient",
      targetKey: CURSOR_BUDGET_TARGET_KEY,
    });
    if (decision && (!decision.allowed || !decision.permit.use())) {
      throw new SendBudgetExhaustedError(CURSOR_BUDGET_TARGET_KEY);
    }
    execution.onPhysicalSend?.({
      ordinal: attempt + 1,
      // Cursor retries only pre-commit transport failures, so every retry send is the
      // connection-reset class; there is no re-send of a turn the server may have accepted.
      ...(attempt > 0 ? { recovery: "connection-reset" as const } : {}),
    });
    const transport = makeTransport(input);
    let emittedAny = false;
    let closed = false;
    // Best-effort close: a cleanup failure must never replace the run outcome (or kill
    // a viable retry) — the caller needs the run error / success, not the close error.
    const closeOnce = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      try {
        await transport.close?.();
      } catch (err) {
        debugProviderDiagnostic("cursor", "close-error", {
          attempt,
          reason: safeCursorErrorMessage(err instanceof Error ? err.message : String(err)),
        });
      }
    };
    try {
      for await (const message of transport.run(request, signal)) {
        emittedAny = true;
        onEvent(message, transport);
      }
      return;
    } catch (err) {
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
      // End the failed attempt BEFORE the backoff: holding the dead transport open
      // through the sleep wastes its connection, and the next attempt must never
      // start before this one's close settles.
      await closeOnce();
      await sleepWithAbort(backoffMs, signal);
    } finally {
      await closeOnce();
    }
  }
}

export type { CursorTransportFactory };
