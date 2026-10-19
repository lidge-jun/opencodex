import { bridgeToResponsesSSE, formatErrorResponse } from "../../bridge";
import { OLLAMA_LATE_ATTRIBUTION_LIMIT_MESSAGE } from "../../adapters/ollama-native";
import { isThroughputLimitText } from "../../claude/outbound";
import { isDefiniteContextOverflow } from "../../combos/failover";
import { classifyError } from "../../lib/errors";
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
 * plain bad request stays what it was, and rate-window wording ("too many tokens per minute")
 * never reads as an overflow: compacting does not fix a throughput limit. An adapter that already
 * classified its own failure as `context_length_exceeded` keeps that verdict whatever status it
 * rode on. The local translator limit is excluded: compacting cannot shrink a buffer this proxy owns.
 */
export function isSidecarContextOverflow(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  if (code === "translation_buffer_limit" || code === "rate_limit_exceeded") return false;
  if (code === "context_length_exceeded") return true;
  if (status === 413) return true;
  return (status === 400 || status === 422) && !isThroughputLimitText(message)
    && isDefiniteContextOverflow(status, message);
}

/**
 * The in-stream terminal for a sidecar overflow. A bare 413 carries no provider wording worth
 * keeping and gets the proxy-owned message. A worded verdict keeps its own status and message:
 * that is the evidence combo failover reads to try a larger-context target, and replacing it
 * would end the chain at the first target that was merely too small.
 */
export function sidecarContextOverflowEvent(
  status: number | undefined,
  message: string,
): Extract<AdapterEvent, { type: "error" }> {
  return status === undefined || !message || (status === 413 && !isDefiniteContextOverflow(413, message))
    ? contextOverflowEvent()
    : { ...contextOverflowEvent(message), status };
}

/** One sidecar loop failure, with what the loop knew when it raised it. */
export interface SidecarLoopFailure {
  status: number;
  message: string;
  event?: Extract<AdapterEvent, { type: "error" }>;
  /** The provider's own `error.code`, read from a bounded display-safe body. */
  upstreamCode?: string;
  /** The failed response was marked non-replayable: the provider may already have run the turn. */
  nonReplayable?: boolean;
}

/**
 * The overflow terminal a sidecar loop failure should end with, or `undefined` to keep the
 * failure as it is. A non-replayable failure keeps its verdict: an overflow would invite a
 * compacted resend of a turn the provider may already have run. An adapter event marked
 * `retryable: false` under any other code is that adapter's own verdict and is not reread.
 */
export function sidecarLoopOverflowEvent(
  failure: SidecarLoopFailure,
): Extract<AdapterEvent, { type: "error" }> | undefined {
  if (failure.nonReplayable) return undefined;
  const code = failure.event?.code ?? failure.upstreamCode;
  if (failure.event?.retryable === false && code !== "context_length_exceeded") return undefined;
  if (!isSidecarContextOverflow(failure.status, failure.message, code)) return undefined;
  return sidecarContextOverflowEvent(failure.event?.status ?? failure.status, failure.message);
}

/**
 * The in-stream terminal for a sidecar loop failure that carries no adapter event, or
 * `undefined` to keep the loop's existing generic event. An overflow ends as the overflow
 * terminal. A failure this classifier deliberately kept (non-replayable, or an upstream
 * `rate_limit_exceeded`) gets an explicit code whenever the bridge's wording heuristics would
 * otherwise rename it `context_length_exceeded` and undo that verdict on the wire.
 */
export function sidecarLoopTerminalEvent(
  failure: SidecarLoopFailure,
): Extract<AdapterEvent, { type: "error" }> | undefined {
  const overflow = sidecarLoopOverflowEvent(failure);
  if (overflow || failure.event) return overflow;
  if (classifyError(failure.status, "upstream_error", failure.message).code !== "context_length_exceeded") return undefined;
  const rateLimited = failure.upstreamCode === "rate_limit_exceeded";
  return {
    type: "error",
    status: failure.status,
    message: failure.message,
    errorType: rateLimited ? "rate_limit_error" : "upstream_error",
    code: failure.upstreamCode ?? "upstream_error",
    ...(failure.nonReplayable ? { retryable: false } : {}),
  };
}

/** Read a provider's `error.code` from an already bounded, display-safe error body. */
export function upstreamErrorCode(text: string): string | undefined {
  try {
    const code = (JSON.parse(text) as { error?: { code?: unknown } } | null)?.error?.code;
    return typeof code === "string" && code.length <= 128 ? code : undefined;
  } catch {
    return undefined;
  }
}

const sidecarOverflowResponses = new WeakSet<Response>();

/** Tag a loop's first-iteration JSON failure that the sidecar boundary should map to an overflow. */
export function markSidecarContextOverflow(response: Response, failure: SidecarLoopFailure): Response {
  if (sidecarLoopOverflowEvent(failure)) sidecarOverflowResponses.add(response);
  return response;
}

/**
 * Map a sidecar loop's pre-stream HTTP failure onto the main path's overflow contract (#7316).
 *
 * Both loops answer a failed first iteration with their own small JSON error, so the overflow
 * would otherwise reach Codex as a bare non-2xx that it resends unchanged through its retry
 * budget. The loop classified the failure while it still had the provider's status, wording,
 * code and replay verdict, and tagged the response; anything untagged is returned untouched.
 * Combo attempts do not come through here: the combo layer reads the raw failure for its hop
 * decision and maps a final 413 itself. A failure answered with `x-should-retry: false` keeps
 * its status and header, so that contract never turns into an invitation to resend.
 */
export function sidecarContextOverflowResponse(
  response: Response,
  options: { stream: boolean; modelId: string; translatorBudget: TranslatorBudget },
): Response {
  if (response.ok || !sidecarOverflowResponses.has(response)) return response;
  if (response.headers.get("x-should-retry") === "false") return response;
  void response.body?.cancel().catch(() => {});
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
