import { namespacedToolName, type AdapterEvent, type OcxParsedRequest, type OcxProviderConfig, type OcxUsage, type TierDecision } from "../../types";
import { stripItemIdsWhenUnstored } from "./request-strips";
import { isPlainObject } from "./internal";
import { stripPromptCacheBreakpoints } from "./prompt-cache";

/**
 * Remove `previous_response_id` before forwarding. Two triggers:
 * - the proxy expanded the request into a full input replay (the id is now redundant), or
 * - the target is the ChatGPT backend (`authMode: "forward"`), whose Codex REST endpoint
 *   categorically rejects the parameter with `{"detail":"Unsupported parameter:
 *   previous_response_id"}` (strict allowlist; it also rejects `metadata` and
 *   `max_output_tokens`). Codex only sends the id on WS turns, and ocx converts those to
 *   internal HTTP requests, so forwarding it upstream is a guaranteed 400 — stripping is
 *   strictly better even when the local replay state missed. API-key mode keeps the field on
 *   unexpanded requests: the platform `/v1/responses` supports real server-side storage.
 */
export function stripPreviousResponseId(body: unknown, strip: boolean): unknown {
  if (!strip || !isPlainObject(body) || !Object.prototype.hasOwnProperty.call(body, "previous_response_id")) return body;
  const { previous_response_id: _previousResponseId, ...rest } = body;
  return rest;
}

/** Apply the settled tier only to a fresh outbound object; `_rawBody` remains caller-owned. */
export function applyTierDecisionToResponsesBody(body: unknown, decision: TierDecision | undefined): unknown {
  if (!decision || decision.kind === "forward-caller" || !isPlainObject(body)) return body;
  const next: Record<string, unknown> = { ...body };
  if (decision.kind === "set") next.service_tier = decision.value;
  else delete next.service_tier;
  return next;
}

/**
 * Drop request parameters a stateless Responses upstream cannot implement, and pin
 * `store` false.
 *
 * `previous_response_id` is listed here as well as in `stripPreviousResponseId`
 * because that helper's strip is conditional on replay expansion, and it keeps the
 * field for API-key providers on the premise that the platform offers real
 * server-side storage. DeepSeek documents the opposite: "the API is stateless:
 * responses and conversations are not stored on the server", so the field can never
 * be honoured regardless of expansion state.
 *
 * `prompt` is a reference to a server-stored prompt template — the most stateful
 * field in the accepted schema.
 *
 * `service_tier` is deliberately NOT dropped: the final TierDecision is applied to a
 * detached outbound body before this sanitizer chain, and silently deleting a configured knob is
 * worse than forwarding a parameter the upstream ignores.
 *
 * MUST run before the composed sanitize chain below: `stripItemIdsWhenUnstored` keys
 * off `store === false`, and a stateless upstream cannot resolve a stored item id.
 * Returns a copy, so `parsed._rawBody` keeps the client's original `store` value and
 * the local replay cache still records the turn.
 */
export function stripStatefulResponsesParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const drop = ["previous_response_id", "conversation", "background", "metadata", "prompt"] as const;
  const present = drop.some(key => Object.prototype.hasOwnProperty.call(body, key));
  if (!present && body.store === false) return body;
  const next: Record<string, unknown> = { ...body };
  for (const key of drop) delete next[key];
  next.store = false;
  return next;
}

/**
 * Remove top-level parameters the ChatGPT backend (`authMode: "forward"`) rejects
 * with `{"detail":"Unsupported parameter: …"}` (strict allowlist). Codex CLI never
 * sends these — it controls output length via `reasoning.effort` — but third-party
 * Responses API clients (GJC, SDK wrappers) include `max_output_tokens` per the
 * public spec. `metadata` is likewise absent from the allowlist. No-op when the
 * body carries neither field, keeping the common Codex path allocation-free.
 */
export function stripUnsupportedForwardParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const hasMot = Object.prototype.hasOwnProperty.call(body, "max_output_tokens");
  const hasMeta = Object.prototype.hasOwnProperty.call(body, "metadata");
  if (!hasMot && !hasMeta) return body;
  const { max_output_tokens: _mot, metadata: _meta, ...rest } = body;
  return rest;
}

/** Sampling controls the canonical ChatGPT backend rejects; other forward gateways accept them. */
const CANONICAL_FORWARD_UNSUPPORTED_SAMPLING = ["temperature", "top_p", "stop", "user"] as const;

/**
 * Remove sampling controls only the canonical ChatGPT backend rejects.
 *
 * A translated Chat turn used to lose these at the Chat ingress for every provider on
 * the `openai-responses` adapter, which silently discarded caller intent on generic
 * key gateways that accept them. Deciding at the ingress was also unsound for combo
 * and policy routes, whose concrete child is chosen later — so the decision belongs
 * here, on the provider that actually receives the body.
 *
 * Returns a copy and never mutates, so `parsed._rawBody` stays caller-owned, and
 * no-ops when the body carries none of these keys.
 */
export function stripCanonicalForwardSamplingParams(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  if (!CANONICAL_FORWARD_UNSUPPORTED_SAMPLING.some(key => Object.prototype.hasOwnProperty.call(body, key))) {
    return body;
  }
  const next: Record<string, unknown> = { ...body };
  for (const key of CANONICAL_FORWARD_UNSUPPORTED_SAMPLING) delete next[key];
  return next;
}

/** Return the lossless text represented by one system message, or null when it is multimodal. */
function canonicalForwardSystemText(item: Record<string, unknown>): string | null {
  const content = item.content;
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  let text = "";
  for (const block of content) {
    if (!isPlainObject(block)) return null;
    if (block.type !== "input_text" && block.type !== "text") return null;
    if (typeof block.text !== "string") return null;
    text += block.text;
  }
  return text;
}

/** Only message items may carry privileged system instructions. */
function isCanonicalForwardSystemMessage(item: unknown): item is Record<string, unknown> {
  return isPlainObject(item)
    && (item.type === undefined || item.type === "message")
    && item.role === "system";
}

/**
 * The public Responses API accepts input system messages and `truncation`, but the canonical
 * ChatGPT Codex forward endpoint rejects both. Fold only fully textual system messages into the
 * existing top-level instructions and remove the unsupported flag at this destination boundary.
 *
 * The fold is atomic: if any system message contains a non-text block, keep every message in
 * place so the proxy never silently drops multimodal content. The backend may still reject that
 * unsupported shape, but it will not receive a partially rewritten prompt.
 */
export function normalizeCanonicalForwardPromptEnvelope(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  const stripTruncation = Object.hasOwn(body, "truncation");
  const input = Array.isArray(body.input) ? body.input : undefined;
  if (!input) {
    if (!stripTruncation) return body;
    const { truncation: _truncation, ...rest } = body;
    return rest;
  }

  const foldedText: string[] = [];
  let sawSystemMessage = false;
  let canFoldAllSystemMessages = true;
  for (const item of input) {
    if (!isCanonicalForwardSystemMessage(item)) continue;
    sawSystemMessage = true;
    const text = canonicalForwardSystemText(item);
    if (text === null) {
      canFoldAllSystemMessages = false;
      break;
    }
    foldedText.push(text);
  }
  if (!stripTruncation && (!sawSystemMessage || !canFoldAllSystemMessages)) return body;

  const next: Record<string, unknown> = { ...body };
  if (stripTruncation) delete next.truncation;
  if (sawSystemMessage && canFoldAllSystemMessages) {
    next.input = input.filter(item => !isCanonicalForwardSystemMessage(item));
    const folded = foldedText.join("\n\n");
    if (folded !== "") {
      const existing = typeof body.instructions === "string" ? body.instructions : "";
      next.instructions = existing !== "" ? `${existing}\n\n${folded}` : folded;
    }
  }
  return next;
}

/**
 * Posit Assistant can replay client-only cache markers and stored-item references on a
 * `store: false` continuation. The canonical ChatGPT Codex backend rejects both. Remove the
 * markers recursively and drop only `item_reference` rows that cannot name persisted state;
 * ordinary item ids are handled later by stripItemIdsWhenUnstored and tool call_id pairs remain.
 */
export function normalizeCanonicalForwardContinuationEnvelope(body: unknown): unknown {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return body;
  let input: unknown[] = body.input;
  let changed = false;
  if (body.store === false) {
    const withoutReferences = input.filter(item => !isPlainObject(item) || item.type !== "item_reference");
    if (withoutReferences.length !== input.length) {
      input = withoutReferences;
      changed = true;
    }
  }

  const markerRewrite = stripPromptCacheBreakpoints(input, { nodes: 0 });
  if (markerRewrite.complete && markerRewrite.changed) {
    input = markerRewrite.value as unknown[];
    changed = true;
  }
  return changed ? { ...body, input } : body;
}
