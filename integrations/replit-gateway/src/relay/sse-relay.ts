import {
  SSE_HEARTBEAT_COMMENT,
  SSE_HEARTBEAT_INTERVAL_MS,
} from "./relay-constants";
import { collectForwardableResponseHeaders, isEventStreamResponse } from "./request-forward";
import { createSseLineBoundaryState, updateSseLineBoundaryState, canInjectSseHeartbeat } from "./sse-line-boundary";

export interface RelayStreamSignals {
  clientSignal: AbortSignal;
  upstreamSignal: AbortSignal;
}

export interface RelayedSseStreamOptions extends RelayStreamSignals {
  heartbeatIntervalMs?: number;
}

interface StreamControllerState {
  settled: boolean;
  lineBoundary: ReturnType<typeof createSseLineBoundaryState>;
  heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
}

function createSettledGuard() {
  let settled = false;
  return {
    isSettled: () => settled,
    settle: () => {
      if (settled) return false;
      settled = true;
      return true;
    },
  };
}

export function createRelayedSseStream(
  upstreamBody: ReadableStream<Uint8Array>,
  options: RelayedSseStreamOptions,
): ReadableStream<Uint8Array> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const heartbeatBytes = new TextEncoder().encode(SSE_HEARTBEAT_COMMENT);
  const reader = upstreamBody.getReader();
  const guard = createSettledGuard();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const state: StreamControllerState = {
        settled: false,
        lineBoundary: createSseLineBoundaryState(),
        heartbeatTimer: undefined,
      };

      const clearHeartbeat = () => {
        if (state.heartbeatTimer !== undefined) {
          clearTimeout(state.heartbeatTimer);
          state.heartbeatTimer = undefined;
        }
      };

      const safeClose = () => {
        if (!guard.settle()) return;
        state.settled = true;
        clearHeartbeat();
        try {
          controller.close();
        } catch {
          // already closed/cancelled
        }
      };

      const safeEnqueue = (bytes: Uint8Array) => {
        if (guard.isSettled()) return;
        controller.enqueue(bytes);
      };

      const scheduleHeartbeat = () => {
        clearHeartbeat();
        if (guard.isSettled()) return;
        state.heartbeatTimer = setTimeout(() => {
          if (guard.isSettled()) return;
          if (options.clientSignal.aborted || options.upstreamSignal.aborted) {
            return;
          }
          if (canInjectSseHeartbeat(state.lineBoundary)) {
            safeEnqueue(heartbeatBytes);
            scheduleHeartbeat();
            return;
          }
          if (state.lineBoundary.pendingCr && state.lineBoundary.atBoundary) {
            safeEnqueue(heartbeatBytes);
            scheduleHeartbeat();
            return;
          }
          scheduleHeartbeat();
        }, heartbeatIntervalMs);
      };

      const abortReader = () => {
        clearHeartbeat();
        reader.cancel().catch(() => {});
        safeClose();
      };

      options.clientSignal.addEventListener("abort", abortReader, { once: true });
      options.upstreamSignal.addEventListener("abort", abortReader, { once: true });

      scheduleHeartbeat();

      try {
        while (!guard.isSettled()) {
          const { done, value } = await reader.read();
          if (done) {
            safeClose();
            break;
          }
          clearHeartbeat();
          if (value) {
            safeEnqueue(value);
            state.lineBoundary = updateSseLineBoundaryState(state.lineBoundary, value);
          }
          if (!guard.isSettled()) {
            scheduleHeartbeat();
          }
        }
      } catch {
        safeClose();
      } finally {
        options.clientSignal.removeEventListener("abort", abortReader);
        options.upstreamSignal.removeEventListener("abort", abortReader);
        clearHeartbeat();
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
      guard.settle();
    },
  });
}

export function createRelayedByteStream(
  upstreamBody: ReadableStream<Uint8Array>,
  signals: RelayStreamSignals,
): ReadableStream<Uint8Array> {
  const reader = upstreamBody.getReader();
  const guard = createSettledGuard();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const abortReader = () => {
        reader.cancel().catch(() => {});
        if (guard.settle()) {
          try {
            controller.close();
          } catch {
            // already closed/cancelled
          }
        }
      };
      signals.clientSignal.addEventListener("abort", abortReader, { once: true });
      signals.upstreamSignal.addEventListener("abort", abortReader, { once: true });

      try {
        while (!guard.isSettled()) {
          const { done, value } = await reader.read();
          if (done) {
            if (guard.settle()) controller.close();
            break;
          }
          if (value && !guard.isSettled()) {
            controller.enqueue(value);
          }
        }
      } catch {
        if (guard.settle()) {
          try {
            controller.close();
          } catch {
            // already closed/cancelled
          }
        }
      } finally {
        signals.clientSignal.removeEventListener("abort", abortReader);
        signals.upstreamSignal.removeEventListener("abort", abortReader);
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
      guard.settle();
    },
  });
}

export function createRelayedResponse(
  upstream: Response,
  signals: RelayStreamSignals,
  options?: { heartbeatIntervalMs?: number },
): Response {
  const headers = collectForwardableResponseHeaders(upstream.headers);
  if (!upstream.body) {
    return new Response(null, { status: upstream.status, headers });
  }

  const body = isEventStreamResponse(upstream)
    ? createRelayedSseStream(upstream.body, { ...signals, ...options })
    : createRelayedByteStream(upstream.body, signals);

  return new Response(body, { status: upstream.status, headers });
}

export { attachResponseLifecycle, wrapStreamWithFinalizer } from "./response-lifecycle";
