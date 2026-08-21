import type { SsePayloadRewrite } from "./sse-payload-rewrite";

/**
 * Route content-channel reasoning from native-Responses upstreams through the
 * expandable summary channel (issue #45).
 *
 * Codex renders the expandable reasoning trace from the Responses reasoning
 * item's `summary[]` channel. DeepSeek's native `/responses` endpoint emits
 * raw thinking on the content channel instead (`response.reasoning_text.delta`
 * plus items with `content: [{type: "reasoning_text", text}]` and an empty
 * `summary`), so routed DeepSeek turns showed the "Worked for Xs" timer with
 * nothing to expand. Native OpenAI upstreams already emit summary-channel
 * events; this rewrite is a no-op for them (no reasoning_text events to
 * rewrite) and only engages when the upstream produces content-channel
 * reasoning.
 *
 * Replay compatibility: Codex echoes the reasoning item it received back into
 * the next request's input. DeepSeek's Responses API accepts summary-shaped
 * reasoning input items (verified live), so the rewrite round-trips.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function reasoningTextOf(item: Record<string, unknown>): string {
  if (!Array.isArray(item.content)) return "";
  return item.content
    .filter((part): part is Record<string, unknown> => isPlainObject(part) && part.type === "reasoning_text")
    .map(part => (typeof part.text === "string" ? part.text : ""))
    .join("");
}

/** Move a reasoning item's content channel into the summary channel. */
function reasoningItemToSummaryShape(item: Record<string, unknown>): Record<string, unknown> {
  if (item.type !== "reasoning") return item;
  // `encrypted_content` is opaque, state-bearing provider data, so the entire item must retain its
  // upstream shape unless that backend has an explicit replay contract permitting a rewrite. This
  // defensively protects content-channel backends that do issue blobs when the client replays the
  // stored item. The delta rewrite can still provide the expandable trace for the live turn.
  // DeepSeek — the provider this rewrite was verified against — is `statelessResponses` and issues
  // no blob, so it is unaffected.
  if (typeof item.encrypted_content === "string" && item.encrypted_content.length > 0) return item;
  const text = reasoningTextOf(item);
  // Items that already use the summary channel (or carry no content text at
  // all) are left untouched: rewriting them could clear a valid summary.
  if (text.length === 0) return item;
  const next: Record<string, unknown> = { ...item };
  delete next.content;
  next.summary = [{ type: "summary_text", text }];
  return next;
}

/**
 * Rewrite one parsed SSE payload in place of the content channel, or return
 * `null` when nothing changed (caller keeps the original payload).
 */
function rewritePayload(payload: Record<string, unknown>): Record<string, unknown> | null {
  switch (payload.type) {
    case "response.reasoning_text.delta": {
      const next: Record<string, unknown> = {
        type: "response.reasoning_summary_text.delta",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        delta: payload.delta,
      };
      if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
      return next;
    }
    case "response.reasoning_text.done": {
      const next: Record<string, unknown> = {
        type: "response.reasoning_summary_text.done",
        item_id: payload.item_id,
        output_index: payload.output_index,
        summary_index: 0,
        text: payload.text,
      };
      if (payload.sequence_number !== undefined) next.sequence_number = payload.sequence_number;
      return next;
    }
    default: {
      let changed = false;
      const next: Record<string, unknown> = { ...payload };
      if (isPlainObject(next.item) && next.item.type === "reasoning") {
        const rewritten = reasoningItemToSummaryShape(next.item);
        if (rewritten !== next.item) {
          next.item = rewritten;
          changed = true;
        }
      }
      // SSE event shape: {type: "response.completed", response: {output}}.
      const response = isPlainObject(next.response) ? { ...next.response } : null;
      if (response && Array.isArray(response.output)) {
        const output = response.output.map(item => {
          if (!isPlainObject(item) || item.type !== "reasoning") return item;
          const rewritten = reasoningItemToSummaryShape(item);
          if (rewritten !== item) changed = true;
          return rewritten;
        });
        if (changed) {
          response.output = output;
          next.response = response;
        }
      }
      // Bare response document shape (non-streaming passthrough):
      // {object: "response", output: [...]}.
      if (Array.isArray(next.output)) {
        const output = next.output.map(item => {
          if (!isPlainObject(item) || item.type !== "reasoning") return item;
          const rewritten = reasoningItemToSummaryShape(item);
          if (rewritten !== item) changed = true;
          return rewritten;
        });
        if (changed) next.output = output;
      }
      return changed ? next : null;
    }
  }
}

/** Payload rewrite for passthrough relays whose upstream emits content-channel reasoning. */
export function createReasoningSummaryChannelPayloadRewrite(): SsePayloadRewrite {
  return (payload: string): string => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      return payload;
    }
    if (!isPlainObject(parsed)) return payload;
    const rewritten = rewritePayload(parsed);
    return rewritten !== null ? JSON.stringify(rewritten) : payload;
  };
}

/**
 * Object-level variant for the non-streaming passthrough: the bounded-JSON
 * relay bypasses the SSE payload rewrite, so reasoning items inside a full
 * Responses JSON document need the same normalization before plain JSON
 * serialization or forced JSON-to-SSE reframing. Returns the same reference
 * when nothing changed.
 */
export function rewriteReasoningSummaryInJson(value: unknown): unknown {
  if (!isPlainObject(value)) return value;
  const rewritten = rewritePayload(value);
  return rewritten !== null ? rewritten : value;
}

/** String-level variant of {@link rewriteReasoningSummaryInJson}. */
export function rewriteReasoningSummaryInJsonString(json: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  const rewritten = rewriteReasoningSummaryInJson(parsed);
  return rewritten === parsed ? json : JSON.stringify(rewritten);
}

/**
 * True when a routed native-Responses provider emits content-channel reasoning
 * (raw `reasoning_text`) instead of the summary channel. DeepSeek's
 * `/responses` endpoint is the current example: it ships raw thinking with an
 * empty `summary` and keeps `preserveReasoningContentModels` so multi-turn
 * replays round-trip.
 */
export function routeUsesContentChannelReasoning(
  provider: { statelessResponses?: boolean; preserveReasoningContentModels?: string[] },
  modelId: string,
): boolean {
  if (provider.statelessResponses === true) return true;
  const preserved = provider.preserveReasoningContentModels;
  const normalizedModelId = modelId.toLowerCase();
  return Array.isArray(preserved)
    && preserved.some(id => id.toLowerCase() === normalizedModelId);
}
