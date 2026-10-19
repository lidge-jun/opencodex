import { bridgeToResponsesSSE, formatErrorResponse } from "../../bridge";
import { OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE } from "../../adapters/ollama-native";
import { isDefiniteContextOverflow } from "../../combos/failover";
import type { TranslatorBudget } from "../../lib/translator-budget";
import type { AdapterEvent } from "../../types";

/**
 * The Ollama late-attribution refusal as a client response: the existing translator-budget
 * wire shape (413 request_too_large) with only the proxy-owned constant as its message.
 * It is deliberately not a context overflow: compacting on the same route cannot shrink it.
 */
export function lateAttributionLimitResponse(): Response {
  return formatErrorResponse(413, "request_too_large", OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE, {
    code: "translation_buffer_limit",
  });
}

export const PROVIDER_INPUT_TOO_LARGE_MESSAGE =
  "The provider rejected this turn because its input exceeds the provider size or context limit. Reduce the current input or compact the conversation before retrying.";

/**
 * Preserve non-streaming HTTP failure semantics without exposing an upstream body. `message` is
 * replaced only for the proxy's own wording, never with upstream text: when every combo target
 * was refused by local input admission, no provider saw the turn and saying one did is false.
 */
export function jsonContextOverflowResponse(message = PROVIDER_INPUT_TOO_LARGE_MESSAGE): Response {
  return Response.json({
    error: {
      message,
      type: "invalid_request_error",
      code: "context_length_exceeded",
    },
  }, { status: 413, headers: { "Cache-Control": "no-store" } });
}

/** The terminal error event every context overflow is reported as, streaming or in-stream. */
export function contextOverflowEvent(
  message = PROVIDER_INPUT_TOO_LARGE_MESSAGE,
): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message,
    status: 413,
    errorType: "invalid_request_error",
    code: "context_length_exceeded",
    retryable: false,
  };
}

async function* contextOverflowEvents(message: string): AsyncGenerator<AdapterEvent> {
  yield contextOverflowEvent(message);
}

/**
 * Whether a web-search or image-bridge failure is the provider refusing an oversized input.
 *
 * An HTTP 413 is classified by status alone, exactly as the main path does. A 400/422 needs a
 * definite overflow phrase in the provider message (the rule combo failover already trusts), so a
 * plain bad request stays what it was. An adapter that already classified its own failure as
 * `context_length_exceeded` keeps that verdict whatever status it rode on. The local translator
 * limit is excluded: compacting cannot shrink a buffer this proxy owns.
 */
export function isSidecarContextOverflow(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  if (code === "translation_buffer_limit") return false;
  if (code === "context_length_exceeded") return true;
  if (status === 413) return true;
  return (status === 400 || status === 422) && isDefiniteContextOverflow(status, message);
}

/**
 * Map a sidecar loop's pre-stream HTTP failure onto the main path's overflow contract (#7316).
 *
 * Both loops answer a failed first iteration with their own small JSON error, so the overflow
 * would otherwise reach Codex as a bare non-2xx that it resends unchanged through its retry
 * budget. Any other failure is returned untouched. Combo attempts do not come through here:
 * the combo layer reads the raw failure for its hop decision and maps a final 413 itself.
 */
export async function sidecarContextOverflowResponse(
  response: Response,
  options: { stream: boolean; modelId: string; translatorBudget: TranslatorBudget },
): Promise<Response> {
  if (response.ok || !response.body) return response;
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) return response;
  // The loop's own small JSON envelope. It is read whole and re-served when it is not an
  // overflow; the caller re-wraps the body for lifetime tracking either way.
  let body: string;
  try { body = await response.text(); } catch { body = ""; }
  let message = "";
  let code: string | null | undefined;
  try {
    const payload = JSON.parse(body) as { error?: { message?: unknown; code?: unknown } };
    if (typeof payload?.error?.message === "string") message = payload.error.message;
    if (typeof payload?.error?.code === "string") code = payload.error.code;
  } catch {
    // Not the loop's own envelope; only the status can classify it.
  }
  if (!isSidecarContextOverflow(response.status, message, code)) {
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  }
  return options.stream
    ? streamingContextOverflowResponse(options.modelId, options.translatorBudget)
    : jsonContextOverflowResponse();
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
  message = PROVIDER_INPUT_TOO_LARGE_MESSAGE,
): Response {
  return new Response(bridgeToResponsesSSE(
    contextOverflowEvents(message),
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
