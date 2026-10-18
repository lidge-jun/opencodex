import { anthropicRejectionPolicy, bindAnthropicRejectionPolicy, rejectedAnthropicPayloads } from "../../adapters/anthropic-rejection-memo";
import { normalizeUpstreamErrorText, readDisplaySafeErrorText } from "./core-errors";
import { sanitizeNonReplayableUpstreamError } from "./non-replayable-error";
import { isLikelyRealAnthropicThinkingSignature } from "../../adapters/anthropic";
import type { AdapterEvent, OcxParsedRequest } from "../../types";
import { upstreamErrorMessageFromPayload } from "../../lib/errors";
import { readBoundedResponseBody } from "../../lib/bounded-body";
import { isNonReplayableResponse } from "../../lib/upstream-retry";
import { rememberReasoningReplayOpaqueBlobRejection } from "../../responses/reasoning-replay-cache";
import { prepareOpaqueBlobRecovery, type OpaqueBlobRecoveryGuard } from "./core-opaque-recovery";

/** Only the explicit conversation-binding refusal authorizes removing signed history. */
export function isAnthropicThinkingSignatureBindingRejectionMessage(message: string): boolean {
  return message.includes("Invalid `signature` in `thinking` block")
    && message.includes("The block is bound to a different conversation");
}

function carriesThinkingState(parsed: OcxParsedRequest): boolean {
  return parsed.context.messages.some(message => message.role === "assistant"
    && message.content.some(part => part.type === "thinking"
      && (isLikelyRealAnthropicThinkingSignature(part.signature)
        || part.redacted?.some(data => typeof data === "string" && data.length > 0))));
}

/** One request owns both the HTTP refusal and initial-event recovery, never a fresh retry guard. */
export function createAnthropicThinkingRecovery(
  parsed: OcxParsedRequest,
  signal: AbortSignal,
  guard: OpaqueBlobRecoveryGuard,
  canRetry: () => boolean,
) {
  let rejectedScope: OcxParsedRequest["_reasoningReplayScope"];
  let rejectedPayloads: ReadonlySet<string> | undefined;
  let armed = false;
  let outputSeen = false;
  let completed = false;
  let failed = false;
  let remembered = false;

  const prepare = (message: string, adapterName: string, attempt = parsed, response?: Response): boolean => {
    if (signal.aborted || !canRetry() || adapterName !== "anthropic" || guard.attempted
      || parsed._stripReasoningEncryptedContent === true || !carriesThinkingState(attempt)
      || !isAnthropicThinkingSignatureBindingRejectionMessage(message)) return false;
    rejectedPayloads = rejectedAnthropicPayloads(response);
    // A real send must prove that it serialized opaque history; otherwise rebuilding could
    // repeat the same request. Direct event-policy callers have no HTTP body to identify.
    if (response && !rejectedPayloads?.size) return false;
    const previous = anthropicRejectionPolicy(parsed);
    if (rejectedPayloads && previous?.mode === "selective") {
      const merged = new Set(previous.fingerprints);
      for (const payload of rejectedPayloads) merged.add(payload);
      rejectedPayloads = merged.size <= 256 ? merged : undefined;
    }
    guard.attempted = true;
    armed = true;
    const scope = parsed._reasoningReplayScope;
    rejectedScope = scope ? { ...scope, current: scope.current ? { ...scope.current } : undefined } : undefined;
    if (!rejectedPayloads) {
      prepareOpaqueBlobRecovery(parsed);
      if (attempt !== parsed) prepareOpaqueBlobRecovery(attempt);
    }
    const policy = rejectedPayloads ? { mode: "selective" as const, fingerprints: rejectedPayloads } : { mode: "blanket" as const };
    bindAnthropicRejectionPolicy(parsed, policy);
    bindAnthropicRejectionPolicy(attempt, policy);
    return true;
  };

  const prepareHttp = async (response: Response, adapterName: string, attempt = parsed): Promise<boolean> => {
    if (signal.aborted || !canRetry() || response.status !== 400 || isNonReplayableResponse(response)
      || adapterName !== "anthropic" || guard.attempted
      || parsed._stripReasoningEncryptedContent === true || !carriesThinkingState(attempt)) return false;
    try {
      const body = await readBoundedResponseBody(response.clone(), { signal });
      if (!body.displaySafe || body.truncated) return false;
      const message = upstreamErrorMessageFromPayload(JSON.parse(body.text) as unknown);
      return typeof message === "string" && prepare(message, adapterName, attempt, response);
    } catch {
      return false;
    }
  };

  const observe = (event: AdapterEvent): void => {
    if (!armed) return;
    if (event.type === "error" || event.type === "incomplete") failed = true;
    if (event.type === "done") completed = true;
    if ((event.type === "text_delta" && event.text.length > 0) || event.type === "tool_call_end") outputSeen = true;
  };

  async function* wrap(
    events: AsyncIterable<AdapterEvent>,
    retry: () => AsyncIterable<AdapterEvent>,
    adapterName: () => string,
    replayAllowed = true,
    response?: Response,
    attempt = parsed,
  ): AsyncGenerator<AdapterEvent> {
    let source = events;
    let replaySafe = replayAllowed;
    while (true) {
      const iterator = source[Symbol.asyncIterator]();
      let recovered = false;
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) return;
          const event = next.value;
          if (replaySafe && event.type === "error" && prepare(event.message, adapterName(), attempt, response)) {
            // Close the rejected body before acquiring another dispatch/pacing slot.
            await iterator.return?.();
            source = retry();
            recovered = true;
            break;
          }
          // Even hidden reasoning, boundaries, and tool activity fence a replay. A heartbeat
          // carrying a side-effect latch is never evidence that a turn is safe to repeat.
          replaySafe &&= event.type === "heartbeat" && event.replayUnsafe !== true;
          observe(event);
          yield event;
        }
      } finally {
        if (!recovered) await iterator.return?.();
      }
    }
  }

  const rememberSuccess = (response: Readonly<Record<string, unknown>>): void => {
    // HTTP 200, EOF, or a guard-generated completion alone cannot prove the stripped send worked.
    // The delivery owner calls this only after its bridge/fold validated a successful terminal.
    if (!armed || remembered || signal.aborted || failed || !completed || !outputSeen
      || response.status !== "completed" || !Array.isArray(response.output) || response.output.length === 0
      || !rejectedScope
      || rejectedScope.clientThreadId !== parsed._reasoningReplayScope?.clientThreadId
      || JSON.stringify(rejectedScope.current) !== JSON.stringify(parsed._reasoningReplayScope?.current)) return;
    remembered = true;
    rememberReasoningReplayOpaqueBlobRejection(rejectedScope, rejectedPayloads);
  };
  // The search owner supplies only a fully validated current iteration, never search-card output.
  const observeIteration = (events: readonly AdapterEvent[]): void => {
    outputSeen = false;
    completed = false;
    for (const event of events) observe(event);
  };
  const projectHttpFailure = async (response: Response, abortSignal: AbortSignal): Promise<Extract<AdapterEvent, { type: "error" }>> => {
    const nonReplayable = isNonReplayableResponse(response);
    if (nonReplayable) response = await sanitizeNonReplayableUpstreamError(response, abortSignal);
    const text = await readDisplaySafeErrorText(response, abortSignal, `Provider error ${response.status}`);
    const error = normalizeUpstreamErrorText(text, `Provider error ${response.status}`);
    return { type: "error", status: response.status, message: error.message ?? error.safeText,
      errorType: error.type ?? "upstream_error", ...(error.code ? { code: error.code } : {}),
      ...(nonReplayable ? { retryable: false } : {}) };
  };
  return { prepareHttp, prepareEvent: prepare, observeIteration, projectHttpFailure, wrap, rememberSuccess };
}
