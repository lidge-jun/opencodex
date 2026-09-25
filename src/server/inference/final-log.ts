import { addFinalRequestLog, type RequestLogContext, type RequestLogEntry } from "../request-log";

/** The request-row identity an ingress hands down; absent when nothing records the request. */
export interface FinalRequestLogIds {
  requestId: string;
  start: number;
}

export type FinalRequestLogMeta = Pick<RequestLogEntry, "terminalStatus" | "closeReason">;

export interface FinalRequestLog {
  /** Write the final request row once. Every later call, from any path, is a no-op. */
  finish(status: number, meta?: FinalRequestLogMeta): void;
  /** True once `finish` has run, whether or not a row was written. */
  finished(): boolean;
}

/**
 * Finish-once ownership of one request's final log row. Terminal callbacks, cancellation and
 * the non-stream return race each other, and only the first of them may write the row.
 * Without log ids the claim still settles, so a caller's `finished()` check behaves the same
 * whether or not the request is recorded.
 */
export function createFinalRequestLog(
  logIds: FinalRequestLogIds | undefined,
  logCtx: RequestLogContext,
): FinalRequestLog {
  let done = false;
  return {
    finish: (status, meta) => {
      if (done) return;
      done = true;
      if (logIds) addFinalRequestLog(logIds.requestId, logIds.start, logCtx, status, meta);
    },
    finished: () => done,
  };
}
