import { diagnoseInvalidToolCalls, isRecord, type InvalidToolCallDiagnostic } from "./tool-call-validation";
import type { AdapterEvent, OcxUsage } from "../../types";

export function stopReasonFor(finishReason: unknown): "max_tokens" | "content_filter" | undefined {
  return finishReason === "length"
    ? "max_tokens"
    : finishReason === "content_filter"
      ? "content_filter"
      : undefined;
}

export function reasoningTextFrom(record: Record<string, unknown>): string | undefined {
  return typeof record.reasoning_content === "string" && record.reasoning_content.length > 0
    ? record.reasoning_content
    : typeof record.reasoning === "string" && record.reasoning.length > 0
      ? record.reasoning
      : undefined;
}

export interface ReasoningDetailSegment {
  key: string;
  text: string;
}

/**
 * Structured `reasoning_details` array (MiniMax M-series with `reasoning_split`).
 * Each segment's key scopes cumulative-snapshot tracking: upstream repeats the
 * full text-so-far under a stable `id`/`index` instead of sending increments.
 */
export function reasoningDetailSegmentsFrom(record: Record<string, unknown>): ReasoningDetailSegment[] {
  const raw = record.reasoning_details;
  if (!Array.isArray(raw)) return [];
  const segments: ReasoningDetailSegment[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item: unknown = raw[i];
    if (!isRecord(item)) continue;
    if (typeof item.text !== "string" || item.text.length === 0) continue;
    const key = typeof item.id === "string" && item.id.length > 0
      ? `id:${item.id}`
      : typeof item.index === "number"
        ? `i:${item.index}`
        : `n:${i}`;
    segments.push({ key, text: item.text });
  }
  return segments;
}

/** Single-segment `reasoning_details` entry for replaying preserved reasoning (MiniMax wire shape). */
export function reasoningDetailSegmentForWire(text: string): Record<string, unknown> {
  return { type: "reasoning.text", id: "reasoning-text-1", format: "MiniMax-response-v1", index: 0, text };
}

export function invalidChoicesEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message: "upstream response contained invalid choices",
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function invalidToolCallsEvent(
  rawToolCalls: unknown,
  mode: "stream" | "response",
  usage?: OcxUsage,
  diagnosticOverride?: InvalidToolCallDiagnostic,
): Extract<AdapterEvent, { type: "error" }> {
  // The streamed accumulator knows things a rescan cannot: which field on which pending call
  // was actually rejected. Without the override, a stream carrying accepted padding on call 0
  // and a real defect on call 1 blames call 0, because the stateless scan stops at the first
  // structurally odd value it sees.
  const diagnostic = diagnosticOverride ?? diagnoseInvalidToolCalls(rawToolCalls, mode);
  const detail = diagnostic
    ? ` (${diagnostic.reason}${diagnostic.callIndex !== undefined ? `; callIndex=${diagnostic.callIndex}` : ""}; valueType=${diagnostic.valueType})`
    : "";
  return {
    type: "error",
    status: 502,
    errorType: "upstream_error",
    message: `upstream response contained invalid tool calls${detail}`,
    ...(usage !== undefined ? { usage } : {}),
  };
}

/**
 * A streamed tool call is only dispatchable once the upstream has named the function.
 *
 * The OpenAI streaming convention puts `function.name` in the first chunk for a tool-call
 * index and leaves later chunks carrying only `arguments` deltas, so a stream that never
 * sends a name is non-conforming for every provider rather than quirky for one. The
 * reference implementations accumulate such a call with an empty name and let the caller
 * fail; we sit at the boundary where it would become a Codex tool-call contract event, so
 * the equivalent is to refuse to emit it.
 *
 * Failing closed rather than dropping is deliberate, and matches #1325: a claimed tool call
 * that silently disappears can leave the matching result orphaned on the next turn. Naming
 * it ourselves is worse still — the id is synthesizable because it is an opaque correlation
 * handle, but a function name is a guess at intent.
 */
export function unnamedToolCallEvent(usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message: "upstream streamed a tool call without a function name — cannot dispatch",
    ...(usage !== undefined ? { usage } : {}),
  };
}

export function usageFromOpenAIChat(usage: Record<string, unknown> | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  const promptDetails = usage.prompt_tokens_details as Record<string, number> | undefined;
  const completionDetails = usage.completion_tokens_details as Record<string, number> | undefined;
  return {
    inputTokens: typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0,
    outputTokens: typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0,
    ...(promptDetails?.cached_tokens !== undefined ? { cachedInputTokens: promptDetails.cached_tokens } : {}),
    ...(completionDetails?.reasoning_tokens !== undefined ? { reasoningOutputTokens: completionDetails.reasoning_tokens } : {}),
  };
}
