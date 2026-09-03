import type { AdapterEvent, OcxConfig, OcxUsage } from "../../types";
import { sanitizeLogMetadataString } from "../../lib/redact";

/**
 * Empty-completion guard for Responses turns (port of codex-router's
 * empty-completion-guard + single retry, PR #145).
 *
 * Failure mode: the upstream answers 200 and completes the turn but never
 * produced output text or a tool call (a reasoning-only stream that ends with
 * nothing is the canonical shape). The client has no code path for "the model
 * said nothing", so it silently records the turn as done — the "random stop"
 * nobody can explain. The guard holds pre-content events (reasoning deltas
 * are deliberately NOT content), and when a terminal event arrives with no
 * content it suppresses the terminal and retries the IDENTICAL turn once
 * (same request bytes, same headers). If the retry is also empty — or fails
 * upstream — the client sees a stated failure instead of a second silent
 * success.
 *
 * The retry is explicitly enabled by top-level config. The environment switch
 * is a disable-only emergency override: OCX_EMPTY_COMPLETION_RETRY=0 restores
 * the previous relay behavior without editing the persisted config.
 */
export const EMPTY_COMPLETION_RETRY_ENV = "OCX_EMPTY_COMPLETION_RETRY";

/**
 * The observability notice for a turn that ended empty with the retry guard off.
 *
 * Both labels are caller-supplied: the request names its provider and model. Interpolated raw,
 * a model name carrying newlines or terminal escapes writes additional lines into whatever
 * reads this warning, so a caller could forge log records it never produced. Both are reduced
 * to bounded single-line metadata first.
 */
export function emptyCompletionNotice(providerName: unknown, modelId: unknown): string {
  const provider = sanitizeLogMetadataString(providerName) ?? "unknown";
  const model = sanitizeLogMetadataString(modelId) ?? "unknown";
  return `[opencodex] ${provider}/${model} completed with no output text and no tool call. `
    + "Set \"emptyCompletionRetry\": true to retry such turns once.";
}

/** Retained pre-content events are bounded independently by count and encoded size. */
export const EMPTY_COMPLETION_MAX_BUFFERED_EVENTS = 1_024;
export const EMPTY_COMPLETION_MAX_BUFFERED_BYTES = 1_048_576;

export function emptyCompletionRetryEnabled(
  config: Pick<OcxConfig, "emptyCompletionRetry">,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return config.emptyCompletionRetry === true && env[EMPTY_COMPLETION_RETRY_ENV] !== "0";
}

/** Surfaced when the single retry was also empty or failed upstream. */
export const EMPTY_COMPLETION_RETRY_FAILED_CODE = "empty_completion_retry_failed";

/**
 * Observe an event stream for the empty-completion shape WITHOUT changing it (#2472).
 *
 * The guard above is opt-in, so with the default configuration a turn that completes with no
 * output text and no tool call passes through untouched and the client records a silent
 * success. That is the reported symptom: an empty result nobody can explain, with no trace
 * that the proxy saw anything unusual.
 *
 * This is deliberately a passthrough observer, not a second guard. Retrying by default would
 * re-send a turn that may have already had billable side effects; the honest default is to
 * leave the stream alone and make the occurrence visible, so a user can correlate it and
 * decide whether to enable the retry.
 */
export async function* observeEmptyCompletion(
  events: AsyncIterable<AdapterEvent>,
  onEmptyTurn: () => void,
): AsyncGenerator<AdapterEvent> {
  let sawContent = false;
  let sawTerminal = false;
  for await (const event of events) {
    // Reasoning is deliberately NOT content, matching the guard: a reasoning-only stream that
    // ends with nothing is the canonical shape of this failure.
    if (isContentEvent(event)) sawContent = true;
    if (isTerminalEvent(event)) {
      sawTerminal = true;
      // Only a successful terminal is the silent failure. `error` and `incomplete` are already
      // a stated outcome the client can render, so flagging them would be noise.
      if (!sawContent && event.type === "done") onEmptyTurn();
    }
    yield event;
  }
  // A stream that ends before any terminal is the pre-output EOF variant of the same failure.
  if (!sawContent && !sawTerminal) onEmptyTurn();
}

/**
 * Terminal stop reasons the bridge renders as a visible `response.incomplete`
 * (max_tokens / content_filter). Those are already a stated failure, not the
 * silent empty success this guard exists to catch, and retrying the identical
 * request would burn tokens for the same truncated result.
 */
const VISIBLE_INCOMPLETE_STOP_REASONS = new Set(["max_tokens", "content_filter"]);
const UTF8_ENCODER = new TextEncoder();

function retainedEventBytes(event: AdapterEvent): number {
  return UTF8_ENCODER.encode(JSON.stringify(event)).byteLength;
}

function isReasoningEvent(event: AdapterEvent): boolean {
  return event.type === "thinking_delta"
    || event.type === "thinking_signature"
    || event.type === "redacted_thinking"
    || event.type === "kiro_redacted_reasoning"
    || event.type === "reasoning_raw_delta";
}

function isTerminalEvent(
  event: AdapterEvent,
): event is Extract<AdapterEvent, { type: "done" | "incomplete" | "error" }> {
  return event.type === "done" || event.type === "incomplete" || event.type === "error";
}

/**
 * Content means something the client can act on: output text or a tool call
 * (web-search cells included). Reasoning deltas are deliberately not content —
 * a turn that streams only reasoning and then completes with nothing is
 * exactly the empty completion this guard exists to catch. Empty text deltas
 * (some batch adapters always carry `""`) are not content either.
 */
export function isContentEvent(event: AdapterEvent): boolean {
  switch (event.type) {
    case "text_delta":
      return event.text.length > 0;
    case "tool_call_start":
    case "tool_call_delta":
    case "tool_call_end":
    case "web_search_call_begin":
    case "web_search_call_end":
      return true;
    default:
      return false;
  }
}

export function emptyCompletionRetryFailedEvent(
  usage?: OcxUsage,
  retryFailedUpstream = false,
): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    status: 502,
    errorType: "upstream_error",
    code: EMPTY_COMPLETION_RETRY_FAILED_CODE,
    message: retryFailedUpstream
      ? "The model returned an empty completion and the retry failed upstream."
      : "The model returned an empty completion. opencodex retried once and the completion was empty again.",
    ...(usage ? { usage } : {}),
  };
}

/**
 * Sum two usage snapshots. Same semantics as terminal-guard's mergeUsage and
 * request-log's aggregateAttemptUsage: token totals add across the attempts;
 * `estimated` wins when either attempt only estimated.
 */
export function mergeUsage(
  first: OcxUsage | undefined,
  second: OcxUsage | undefined,
): OcxUsage | undefined {
  if (!first) return second;
  if (!second) return first;
  const sumOptional = (key: keyof OcxUsage): number | undefined => {
    const left = first[key];
    const right = second[key];
    return typeof left === "number" || typeof right === "number"
      ? (typeof left === "number" ? left : 0) + (typeof right === "number" ? right : 0)
      : undefined;
  };
  const cachedInputTokens = sumOptional("cachedInputTokens");
  const cacheReadInputTokens = sumOptional("cacheReadInputTokens");
  const cacheCreationInputTokens = sumOptional("cacheCreationInputTokens");
  const reasoningOutputTokens = sumOptional("reasoningOutputTokens");
  const contextTotalTokens = second.contextTotalTokens ?? first.contextTotalTokens;
  const inputTokens = first.inputTokens + second.inputTokens;
  const outputTokens = first.outputTokens + second.outputTokens;
  // The attempt that produced the content owns the raw wire usage (openai/codex#41980);
  // an empty first attempt may still be the only one that saw it.
  const rawUsage = second.rawUsage ?? first.rawUsage;
  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    ...(contextTotalTokens !== undefined ? { contextTotalTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheReadInputTokens !== undefined ? { cacheReadInputTokens } : {}),
    ...(cacheCreationInputTokens !== undefined ? { cacheCreationInputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(first.estimated || second.estimated ? { estimated: true } : {}),
    ...(rawUsage !== undefined ? { rawUsage } : {}),
  };
}

export interface EmptyCompletionGuardOptions {
  firstEvents: AsyncIterable<AdapterEvent>;
  /**
   * Re-run the IDENTICAL turn: same request body, same headers, same signal.
   * Receives no arguments — the request must not be modified between attempts.
   */
  continuation: () => AsyncIterable<AdapterEvent> | Promise<AsyncIterable<AdapterEvent>>;
  /** How many times an empty completion is retried; default 1 (the router's single retry). */
  maxRetries?: number;
}

/**
 * Watch an adapter event stream for the empty-completion failure mode. Events
 * are held until the turn produces content or ends: reasoning and other
 * pre-content events stay buffered (released in order on first content), the
 * terminal is withheld, and an empty terminal or pre-output EOF triggers one
 * identical-turn retry through `continuation`. Usage is merged across attempts
 * so the bridge and request log meter the whole turn, not just the attempt that
 * succeeded.
 *
 * Heartbeats always pass through untouched: they feed the bridge's stall
 * watchdog, so holding them behind the content gate would trip false
 * upstream_stall_timeout failures on slow reasoning-only turns.
 */
export async function* guardEmptyCompletionEventStream(
  options: EmptyCompletionGuardOptions,
): AsyncGenerator<AdapterEvent> {
  const maxRetries = Math.max(0, Math.floor(options.maxRetries ?? 1));
  let source = options.firstEvents;
  let held: AdapterEvent[] = [];
  let heldBytes = 0;
  let sawContent = false;
  let passthrough = false;
  let retries = 0;
  let usage: OcxUsage | undefined;

  const withUsage = (event: AdapterEvent & { usage?: OcxUsage }): AdapterEvent => {
    const merged = mergeUsage(usage, event.usage);
    return merged ? { ...event, ...(merged ? { usage: merged } : {}) } : event;
  };
  const releaseHeld = (): AdapterEvent[] => {
    const released = held;
    held = [];
    heldBytes = 0;
    return released;
  };

  while (true) {
    let terminalSeen = false;
    for await (const event of source) {
      if (event.type === "heartbeat") {
        yield event;
        continue;
      }
      if (sawContent || passthrough) {
        // Buffered content is already flowing; everything downstream passes
        // through. Every terminal carries usage merged across every attempt.
        if (isTerminalEvent(event)) {
          yield withUsage(event);
          return;
        }
        yield event;
        continue;
      }
      if (isContentEvent(event)) {
        sawContent = true;
        yield* releaseHeld();
        yield event;
        continue;
      }
      if (event.type === "done") {
        usage = mergeUsage(usage, event.usage);
        if (event.stopReason !== undefined && VISIBLE_INCOMPLETE_STOP_REASONS.has(event.stopReason)) {
          // Rendered as response.incomplete: a stated failure, not the silent
          // empty success this guard exists to catch.
          yield* releaseHeld();
          yield { ...event, ...(usage ? { usage } : {}) };
          return;
        }
        if (retries < maxRetries) {
          // Suppress the terminal: the client must never see a completed event
          // for a turn that produced nothing. Retry the identical turn.
          retries += 1;
          try {
            source = await options.continuation();
          } catch {
            yield emptyCompletionRetryFailedEvent(usage, true);
            return;
          }
          terminalSeen = true;
          break;
        }
        // The retry was also empty: a stated failure, not a second silent
        // success.
        yield emptyCompletionRetryFailedEvent(usage);
        return;
      }
      if (event.type === "error") {
        if (retries > 0 && event.status !== 499) {
          // The retry failed upstream. Its body cannot reach the client (the
          // 200 head went out with the first attempt), so state the failure in
          // the stream's own error framing — same move as the router's
          // empty_completion_retry_failed. Client cancels (499) pass through.
          yield emptyCompletionRetryFailedEvent(mergeUsage(usage, event.usage), true);
          return;
        }
        yield* releaseHeld();
        yield withUsage(event);
        return;
      }
      if (event.type === "incomplete") {
        // A structured incomplete is already a visible failure; never convert
        // it into an empty completion.
        yield* releaseHeld();
        yield withUsage(event);
        return;
      }
      const eventBytes = retainedEventBytes(event);
      if (held.length + 1 > EMPTY_COMPLETION_MAX_BUFFERED_EVENTS
        || heldBytes + eventBytes > EMPTY_COMPLETION_MAX_BUFFERED_BYTES) {
        // Preserve data rather than retaining without bound: release the prefix,
        // emit this event, and stop attempting an empty-completion retry for the turn.
        yield* releaseHeld();
        yield event;
        passthrough = true;
        continue;
      }
      held.push(event);
      heldBytes += eventBytes;
      // The bridge watchdog sees only yielded events. Feed it while reasoning is
      // held so a long reasoning-only prefix remains live without exposing it early.
      if (isReasoningEvent(event)) yield { type: "heartbeat" };
    }
    if (!terminalSeen) {
      // A terminal-less EOF before text or a tool call is replay-safe: nothing
      // actionable reached the client. Retry once, then surface a stated error
      // instead of letting the bridge reduce the turn to adapter_eof.
      if (!sawContent && !passthrough && retries < maxRetries) {
        retries += 1;
        try {
          source = await options.continuation();
        } catch {
          yield emptyCompletionRetryFailedEvent(usage, true);
          return;
        }
        continue;
      }
      if (!sawContent && retries > 0) {
        yield emptyCompletionRetryFailedEvent(usage, true);
        return;
      }
      // Post-output EOF remains incomplete; replaying could duplicate text or
      // executable tool calls.
      yield* releaseHeld();
      return;
    }
  }
}
