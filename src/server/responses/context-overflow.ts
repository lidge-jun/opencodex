import { bridgeToResponsesSSE } from "../../bridge";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent } from "../../types";

export const PROVIDER_INPUT_TOO_LARGE_MESSAGE =
  "The provider rejected this turn because its input exceeds the provider size or context limit. Reduce the current input or compact the conversation before retrying.";

async function* contextOverflowEvents(): AsyncGenerator<AdapterEvent> {
  yield {
    type: "error",
    message: PROVIDER_INPUT_TOO_LARGE_MESSAGE,
    status: 413,
    errorType: "invalid_request_error",
    code: "context_length_exceeded",
    retryable: false,
  };
}

/**
 * Convert a pre-stream provider 413 into the terminal Responses event Codex understands.
 *
 * Codex treats an HTTP 413 as an unexpected, retryable transport failure and resends the
 * same oversized body through its reconnect budget. A `response.failed` event carrying
 * `context_length_exceeded` is instead terminal and marks the client context as full, so
 * its next-turn compaction policy can run. The message is proxy-owned on purpose: upstream
 * 413 bodies can echo request data and are not needed to classify an unambiguous status.
 */
export function streamingContextOverflowResponse(
  modelId: string,
  translatorBudget: TranslatorBudget,
): Response {
  return new Response(bridgeToResponsesSSE(
    contextOverflowEvents(),
    modelId,
    undefined,
    undefined,
    undefined,
    undefined,
    2_000,
    { translatorBudget },
  ), {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
