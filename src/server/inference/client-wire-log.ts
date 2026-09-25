import {
  addFinalRequestLog,
  httpStatusForRequestLogTerminal,
  inspectResponseLogSsePayloadParsed,
  type RequestLogContext,
  type RequestLogEntry,
} from "../request-log";
import type { ClientWireLog } from "./client-wire";

/**
 * The deferred request log of a client-wire response. It records what the Responses SSE tap
 * (`trackSseForRequestLog`) records for a bridged body, from the facts the producer reports
 * instead of from the body: the same payload inspection until the terminal, the same terminal
 * transport phase and status mapping, and 499 for a client cancel before any terminal. The row
 * is written once.
 */
export function recordClientWireRequestLog(
  log: ClientWireLog,
  requestId: string,
  start: number,
  logCtx: RequestLogContext,
  addLog: (entry: RequestLogEntry) => void,
): void {
  let logged = false;
  const inspect = (payload: Record<string, unknown>) => {
    try {
      inspectResponseLogSsePayloadParsed(logCtx, JSON.stringify(payload), payload);
    } catch { /* request log metadata is best-effort */ }
  };
  log.subscribe(event => {
    if (logged) return;
    if (event.kind === "observe") {
      inspect(event.payload);
      return;
    }
    logged = true;
    if (event.kind === "cancel") {
      addFinalRequestLog(requestId, start, logCtx, 499, { closeReason: "client_cancel" }, addLog);
      return;
    }
    inspect(event.payload);
    logCtx.transportPhase = "terminal_sse";
    logCtx.terminalSource = "upstream";
    addFinalRequestLog(requestId, start, logCtx, httpStatusForRequestLogTerminal(event.status, logCtx), {
      terminalStatus: event.status,
      closeReason: "terminal",
    }, addLog);
  });
}
