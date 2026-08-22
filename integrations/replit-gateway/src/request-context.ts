import { createLinkedAbortController, createTimeoutSignal } from "./cancel";

export interface RelayExecutionContext {
  clientSignal: AbortSignal;
  upstreamSignal: AbortSignal;
  callerAborted: () => boolean;
  clientTimedOut: () => boolean;
  upstreamTimedOut: () => boolean;
  cleanup: () => void;
}

export function createRelayExecutionContext(options: {
  clientSignal: AbortSignal;
  clientTimeoutMs: number;
  upstreamTimeoutMs: number;
}): RelayExecutionContext {
  const clientTimeout = createTimeoutSignal(options.clientTimeoutMs, options.clientSignal);
  const linked = createLinkedAbortController(clientTimeout.signal);
  const upstreamTimeout = createTimeoutSignal(options.upstreamTimeoutMs, linked.controller.signal);

  const cleanup = () => {
    upstreamTimeout.dispose();
    linked.dispose();
    clientTimeout.dispose();
  };

  return {
    clientSignal: clientTimeout.signal,
    upstreamSignal: upstreamTimeout.signal,
    callerAborted: () => options.clientSignal.aborted && !clientTimeout.timedOut(),
    clientTimedOut: () => clientTimeout.timedOut(),
    upstreamTimedOut: () => upstreamTimeout.timedOut(),
    cleanup,
  };
}
