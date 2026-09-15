import type {
  AdapterEvent,
  OcxMessagePhase,
  OcxProviderContinuationState,
  OcxProviderOpaqueToolCallMetadata,
  OcxReasoningReplayScopeRef,
  OcxUsage,
} from "../types";
import {
  adapterFailureFromMessage,
  classifyError,
  cyberPolicyErrorType,
  CYBER_POLICY_ERROR_CODE,
  isCyberPolicyCode,
  type OcxErrorPayload,
} from "../lib/errors";
import { redactSecretString } from "../lib/redact";
import { usageDisplayTotalTokens } from "../usage/totals";

export function uuid(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** Test-only: bound the abandoned-owned-budget watchdog delay (null restores). */
export let ownedBudgetAbandonedMs = 10 * 60 * 1000;
const OWNED_BUDGET_ABANDONED_DEFAULT_MS = ownedBudgetAbandonedMs;
export function setOwnedBudgetAbandonedMsForTests(ms: number | null): void {
  ownedBudgetAbandonedMs = ms ?? OWNED_BUDGET_ABANDONED_DEFAULT_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function responsesUsage(usage: OcxUsage | undefined): Record<string, unknown> {
  // input_tokens_details / output_tokens_details are ALWAYS emitted (zero defaults):
  // strict Responses clients deserialize them as required fields — grok-build's pinned
  // async-openai fork (rev 95b52ebd, response_usage.rs) has non-Option InputTokenDetails/
  // OutputTokenDetails, so omitting them turns a successful turn into a hard exit after
  // response.completed ("missing field `input_tokens_details`", verified live 2026-07-23).
  if (!usage) {
    return {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 0 },
    };
  }
  // inputTokens is already inclusive of cache read/write (types.ts convention). Stateful
  // providers may report an absolute active-context checkpoint separately from their
  // per-attempt usage. Split that checkpoint into input + output without adding output twice.
  const inputTokens = usage.contextTotalTokens !== undefined
    ? Math.max(0, usage.contextTotalTokens - usage.outputTokens)
    : usage.inputTokens;
  // openai/codex#41980 parity: unknown upstream usage fields (subscription metadata, future
  // counters) pass through the rebuild. Normalized values stay authoritative for the known
  // keys (they are derived from the same raw values, so this never disagrees with upstream).
  const raw: Record<string, unknown> = usage.rawUsage ?? {};
  // cache_write_tokens is a KNOWN key: it is emitted only from the validated normalized
  // value below, never copied through raw (an unknown-shaped value must not leak into the
  // normalized contract).
  const rawInputDetails = isRecord(raw.input_tokens_details)
    ? Object.fromEntries(Object.entries(raw.input_tokens_details as Record<string, unknown>)
      .filter(([key]) => key !== "cache_write_tokens"))
    : {} as Record<string, unknown>;
  const rawOutputDetails = isRecord(raw.output_tokens_details)
    ? raw.output_tokens_details as Record<string, unknown>
    : {} as Record<string, unknown>;
  const out: Record<string, unknown> = {
    ...Object.fromEntries(Object.entries(raw).filter(([key]) =>
      key !== "input_tokens" && key !== "output_tokens" && key !== "total_tokens"
      && key !== "input_tokens_details" && key !== "output_tokens_details")),
    input_tokens: inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.contextTotalTokens !== undefined
      ? usage.contextTotalTokens
      : usageDisplayTotalTokens(usage) ?? inputTokens + usage.outputTokens,
  };
  // cached_tokens carries cache READS only, matching OpenAI semantics, and is always present
  // (zero default) for strict clients. Clamp to inputTokens so a provider's absolute
  // checkpoint can never report more cache reads than input.
  const inputDetails: Record<string, unknown> = {
    ...rawInputDetails,
    cached_tokens: Math.min(usage.cachedInputTokens ?? 0, inputTokens),
  };
  if (usage.cacheCreationInputTokens !== undefined) {
    const cacheRead = typeof inputDetails.cached_tokens === "number" ? inputDetails.cached_tokens : 0;
    inputDetails.cache_write_tokens = Math.min(
      usage.cacheCreationInputTokens,
      Math.max(0, inputTokens - cacheRead),
    );
  }
  out.input_tokens_details = inputDetails;
  out.output_tokens_details = { ...rawOutputDetails, reasoning_tokens: usage.reasoningOutputTokens ?? 0 };
  return out;
}

/**
 * Whether assembled function-call arguments are usable JSON.
 * An empty buffer is valid (no-arg tools send no deltas). Non-empty must parse —
 * once fragments have been streamed to the client they cannot be repaired the way
 * non-stream adapters degrade a bad payload to `{}`.
 */
export function toolCallArgumentsUsable(args: string): boolean {
  if (args.length === 0) return true;
  const trimmed = args.trim();
  if (!trimmed) return false;
  try {
    JSON.parse(args);
    return true;
  } catch {
    return false;
  }
}

export function adapterFailureFromEvent(event: Extract<AdapterEvent, { type: "error" }>): { httpStatus: number; error: OcxErrorPayload } {
  const message = redactSecretString(event.message);
  if (event.status === undefined && event.errorType === undefined && event.code === undefined) {
    return adapterFailureFromMessage(message);
  }
  const fallback = adapterFailureFromMessage(message);
  let httpStatus = event.status ?? fallback.httpStatus;
  const error = classifyError(httpStatus, event.errorType ?? fallback.error.type, message);
  if (event.errorType !== undefined) error.type = event.errorType;
  if (event.code !== undefined) error.code = event.code;
  // Codex maps cyber_policy on HTTP 400 (body) or mid-stream code; never leave it as 502.
  if (isCyberPolicyCode(error.code) || isCyberPolicyCode(event.code)) {
    error.code = CYBER_POLICY_ERROR_CODE;
    error.type = cyberPolicyErrorType(event.errorType);
    httpStatus = 400;
  }
  return { httpStatus, error };
}

/**
 * Build the native `WebSearchAction::Search` payload from the queries that ran.
 *
 * Every action carries BOTH keys: `{ query, queries }`, where `query` is the first
 * member. Empty → `{ query: "", queries: [""] }`.
 *
 * Carrying both is load-bearing in both directions. DeepSeek's native Responses parser
 * makes `queries` a required field, and Console Go's upstream validator makes `query` a
 * required field — so a replayed `web_search_call` carried in the history of every
 * subsequent turn fails deserialization with `missing field 'queries'` (#930) or 400s
 * with `missing required field 'query'` unless both keys are present. Carrying both keys
 * in every case satisfies both strict parsers; the trade-off is that a multi-query batch
 * loses the "<first> ..." ellipsis in codex-rs and shows the first query as the label.
 *
 * That trade is deliberate: a cosmetic label against a conversation that 400s on every
 * subsequent turn. Do not restore the old batch-omits-`query` shape to win the ellipsis
 * back — it reopens #3071.
 *
 * This fixes items created from here on. History recorded before it is repaired at the
 * replay boundary by `backfillWebSearchQueries()` in the Responses adapter.
 */
export function webSearchAction(queries: string[]): Record<string, unknown> {
  const first = queries[0] ?? "";
  return { type: "search", query: first, queries: queries.length > 0 ? queries : [first] };
}

export interface OutputItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

/** Accumulates string fragments and their total byte length without concatenating. */
export interface StringChunks {
  chunks: string[];
  bytes: number;
}
export const emptyChunks = (): StringChunks => ({ chunks: [], bytes: 0 });
export const joinChunks = (sc: StringChunks): string => sc.chunks.join("");
