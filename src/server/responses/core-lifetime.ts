import type { TranslatorBudget } from "../../lib/translator-budget";
import {
  isNativePassthroughSseResponse,
  markNativePassthroughSseResponse,
  isEagerRelaySseResponse,
  markEagerRelaySseResponse,
} from "../relay";

// runTurn adapters own an event queue and perform their combo preflight before
// bridging. A second byte-stream reader would reinterpret that transport's
// already-committed event boundary and can replay custom adapter work.
export const runTurnAdapterSseResponses = new WeakSet<Response>();


// Whole-body policy for non-streaming upstream JSON responses (see the application/json
// branch of the passthrough return path). 32 MiB matches the continuation snapshot read
// bound and is far above any legitimate non-streaming completion, including base64 image
// payloads. The stall deadlines only govern the body transfer — generation time before
// the response headers is untouched. Generation after early/chunked headers but before
// the first body byte previously used the 30-second inactivity deadline; this call site
// gives it the full body deadline instead.
export const MAX_UPSTREAM_JSON_BODY_BYTES = 32 * 1024 * 1024;

export const UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS = 180_000;

export const UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS = 30_000;

export const UPSTREAM_JSON_BODY_READ_OPTIONS = {
  maxBytes: MAX_UPSTREAM_JSON_BODY_BYTES,
  totalTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
  inactivityTimeoutMs: UPSTREAM_JSON_BODY_INACTIVITY_TIMEOUT_MS,
  firstByteTimeoutMs: UPSTREAM_JSON_BODY_TOTAL_TIMEOUT_MS,
};




export function finalizeOwnedTranslatorBudget(response: Response, budget: TranslatorBudget): Response {
  if (!response.body) {
    budget.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    budget.dispose();
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finalize();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finalize(); }
    },
  });
  const finalizedResponse = new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  if (isNativePassthroughSseResponse(response)) {
    markNativePassthroughSseResponse(finalizedResponse);
  }
  if (isEagerRelaySseResponse(response)) {
    markEagerRelaySseResponse(finalizedResponse);
  }
  return finalizedResponse;
}




export function linkAbortSignal(upstream: AbortController, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  if (signal.aborted) {
    upstream.abort(signal.reason);
    return () => {};
  }
  const onAbort = () => upstream.abort(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
