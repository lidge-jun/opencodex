/**
 * Final request-log ownership for a native ingress that converts an inner Chat response.
 *
 * The inner Chat path keeps its own observation, attempt and usage accounting and its own
 * callback ordering. Its final-log requests are intercepted: the first one is recorded as the
 * physical attempt's settlement and nothing is written. The native handler, which alone knows
 * whether its conversion succeeded or the client went away, commits exactly once through the
 * ordinary writer. Later inner requests stay inert, so a delayed callback cannot add a row.
 */
import type { ResponsesTerminalStatus } from "../bridge";
import {
  addRequestLog,
  commitInterceptedFinalRequestLog,
  interceptFinalRequestLog,
  type RequestLogContext,
  type RequestLogEntry,
} from "./request-log";

/** How long a known outer outcome waits for a missing inner settlement before cutting off. */
export const NATIVE_FINAL_LOG_FALLBACK_MS = 100;
export const NATIVE_FINAL_LOG_CUTOFF_CODE = "observation_barrier_timeout";

export interface NativeFinalOutcome {
  status: number;
  terminalStatus?: ResponsesTerminalStatus;
  closeReason: NonNullable<RequestLogEntry["closeReason"]>;
}

export interface NativeFinalLog {
  /** True once the inner path requested its final log. */
  innerSettled(): boolean;
  /**
   * Call once the outer outcome is known. Resolves true when the inner path has settled, or
   * false when the bounded fallback elapsed first. Never waits on an upstream cancellation.
   */
  waitForInner(): Promise<boolean>;
  /** Write the single row. Returns false when a row was already committed. */
  commit(outcome: NativeFinalOutcome): boolean;
}

export function createNativeFinalLog(
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  options: { fallbackMs?: number; addLog?: (entry: RequestLogEntry) => void } = {},
): NativeFinalLog {
  const fallbackMs = options.fallbackMs ?? NATIVE_FINAL_LOG_FALLBACK_MS;
  let innerStatus: number | undefined;
  let wake: (() => void) | undefined;
  let waiting: Promise<boolean> | undefined;
  let committed = false;
  interceptFinalRequestLog(logCtx, status => {
    if (innerStatus !== undefined) return;
    innerStatus = status;
    // Resolved on a later microtask, so observations the inner producer makes later in the same
    // synchronous pass (a relay's completed-response hook, for example) land before the commit.
    wake?.();
  });
  return {
    innerSettled: () => innerStatus !== undefined,
    waitForInner() {
      waiting ??= innerStatus !== undefined
        ? Promise.resolve(true)
        : new Promise<boolean>(resolve => {
          const timer = setTimeout(() => { wake = undefined; resolve(innerStatus !== undefined); }, fallbackMs);
          wake = () => { clearTimeout(timer); wake = undefined; resolve(true); };
        });
      return waiting;
    },
    commit(outcome) {
      if (committed) return false;
      committed = true;
      // Upstream evidence stays on the context so the final writer can classify it; the row
      // projection (src/usage/error-detail.ts) removes upstream-authored text before any writer.
      let { status, terminalStatus } = outcome;
      if (innerStatus === undefined) {
        // Cut off before the inner path settled: what it observed so far is not a complete
        // account. Drop it, so the row reads unreported and the terminal send settles as
        // unresolved rather than being priced from a partial count, and never report success.
        delete logCtx.usage;
        delete logCtx.usageLogInputTokens;
        if (logCtx.activeAttempt) delete logCtx.activeAttempt.usage;
        logCtx.errorCode = NATIVE_FINAL_LOG_CUTOFF_CODE;
        if (status < 400) { status = 502; terminalStatus = "failed"; }
      }
      commitInterceptedFinalRequestLog(requestId, start, logCtx, status, {
        ...(terminalStatus ? { terminalStatus } : {}),
        closeReason: status === 499 ? "client_cancel" : outcome.closeReason,
      }, innerStatus ?? status, options.addLog ?? addRequestLog);
      return true;
    },
  };
}
