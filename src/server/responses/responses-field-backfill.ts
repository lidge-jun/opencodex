/**
 * Stateless SSE block rewrite that backfills the `annotations` field on
 * `output_text` content parts in Responses SSE events.
 *
 * The Responses API spec defines `annotations` as a required field on
 * `OutputTextContent` (it is `Vec<Annotation>`, not `Option<Vec>`). Some
 * upstream relays omit it when there are no annotations, which is technically
 * spec-non-compliant. Strict deserializers — any client that follows the
 * schema without `#[serde(default)]` on that field — fail with
 * `missing field `annotations`` when the field is absent.
 *
 * This rewrite scans every SSE event for output_text content parts — whether
 * they appear in item.content[], part, or response.output[].content[] — and
 * adds annotations: [] if missing.
 *
 * Stateless: no retained buffers, no lifecycle tracking, no fail-closed.
 * Existing values are always authoritative; only absent fields are added.
 * The field is always valid on the wire, so adding it when absent is safe
 * for all clients including Codex CLI/App.
 */

import {
  replaceSseDataPayload,
  sseDataPayload,
  type SseBlockRewrite,
} from "../sse-payload-rewrite";
import { isCompactionItemType } from "../../responses/compaction";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Wire prefixes for Responses output item ids, matching OpenAI's id shapes. */
const ITEM_ID_PREFIXES: Readonly<Record<string, string>> = {
  message: "msg_",
  reasoning: "rs_",
  function_call: "fc_",
  custom_tool_call: "ctc_",
  // A routed tool_search lowering is restored to `tool_search_call` without an id, so this
  // backfill is what names it. The generic `item_` fallback is not merely cosmetic here:
  // `stripInvalidItemIds` in the Responses adapter deletes any id whose prefix does not match
  // the type, so an `item_`-named tool_search_call silently loses its id on the NEXT turn and
  // the client sees an item it cannot correlate. The prefixes here must stay a superset of the
  // ones that serializer enforces.
  tool_search_call: "tsc_",
  web_search_call: "ws_",
  file_search_call: "fs_",
  code_interpreter_call: "ci_",
  computer_call: "cc_",
  // The Responses wire type is `image_generation_call`; `image_gen_call` is kept only so a
  // relay that emits the short spelling is not silently demoted to the generic `item_`.
  image_generation_call: "ig_",
  image_gen_call: "ig_",
};

/**
 * Backfill a required id on an output item when absent. Strict Responses
 * decoders (e.g. grok-build serde types) fail with "missing field id" when a
 * message or reasoning item has no id, which some upstream relays omit. The
 * generated id is deterministic per (type, output index) so it stays stable
 * across streaming events that reference the same item.
 */
function backfillItemId(item: Record<string, unknown>, slot: ItemIdSlot): Record<string, unknown> {
  if (typeof item.id === "string" && item.id.length > 0) return item;
  const type = typeof item.type === "string" ? item.type : "";
  const prefix = Object.prototype.hasOwnProperty.call(ITEM_ID_PREFIXES, type) ? ITEM_ID_PREFIXES[type] : "item_";
  return { ...item, id: prefix + "ocx_" + (slot.kind === "index" ? String(slot.index) : "fallback_" + slot.ordinal) };
}

/**
 * Which namespace a synthesized id comes from.
 *
 * Keeping the fallback counter in the SAME numeric namespace as real output indexes only
 * pushed the collision out of reach rather than removing it: a response whose real index
 * happened to be 1_000_001 would produce the same id as the first malformed-index fallback,
 * and a duplicate id is exactly what this backfill exists to prevent. The namespaces are now
 * lexically disjoint, so no index value can ever collide with a fallback.
 */
type ItemIdSlot = { kind: "index"; index: number } | { kind: "fallback"; ordinal: number };

/**
 * Monotonic ordinal for an event whose `output_index` is absent or malformed.
 *
 * Process-global rather than per-response because this module is stateless by design and the
 * value only has to be unique, not meaningful. It carries its own `fallback_` namespace, so
 * uniqueness no longer depends on a real index never reaching some arbitrary ceiling.
 */
let syntheticItemOrdinal = 0;
function nextSyntheticItemSlot(): ItemIdSlot {
  syntheticItemOrdinal += 1;
  return { kind: "fallback", ordinal: syntheticItemOrdinal };
}

/**
 * Backfill annotations: [] on an output_text content part if missing.
 * Returns the same object reference if no change is needed.
 */
function backfillOutputTextPart(part: Record<string, unknown>): Record<string, unknown> {
  if (part.type !== "output_text") return part;
  // Only add annotations when the key is entirely absent — preserve any
  // existing value (even null or a malformed type) so we never overwrite
  // what the upstream actually sent.
  if ("annotations" in part) return part;
  return { ...part, annotations: [] };
}

/**
 * Walk a content array and backfill output_text parts.
 * Returns the same array reference if nothing changed.
 */
function backfillContentArray(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  let changed = false;
  const repaired = content.map((part) => {
    if (!isPlainObject(part)) return part;
    const next = backfillOutputTextPart(part);
    if (next !== part) changed = true;
    return next;
  });
  return changed ? repaired : content;
}

/**
 * Walk an output item and backfill output_text parts in its content.
 * Also backfills a missing required id on the item itself.
 * Returns the same object reference if nothing changed.
 */
function backfillOutputItem(item: unknown, slot: ItemIdSlot): unknown {
  if (!isPlainObject(item)) return item;
  // The compact wire family is the `/v1/responses/compact` format, not a Responses output item.
  // Those items have no `id` in that contract, so synthesizing one changes a response body the
  // client compares exactly — and the client replays the item on every later turn, where the
  // minting backend rejects it as modified. The backfill exists to satisfy strict Responses
  // decoders; a shape those decoders never see is outside its remit.
  if (isCompactionItemType(item.type)) return item;
  const content = item.content;
  const repaired = backfillContentArray(content);
  const withId = backfillItemId(item, slot);
  if (repaired === content && withId === item) return item;
  return { ...withId, ...(repaired === content ? {} : { content: repaired }) };
}

/**
 * Walk a response object's output[] and backfill output_text parts.
 * Returns the same object reference if nothing changed.
 */
function backfillResponseOutput(response: unknown): unknown {
  if (!isPlainObject(response)) return response;
  const output = response.output;
  if (!Array.isArray(output)) return response;
  let changed = false;
  const repaired = output.map((item, idx) => {
    if (!isPlainObject(item)) return item;
    const next = backfillOutputItem(item, { kind: "index", index: idx });
    if (next !== item) changed = true;
    return next;
  });
  return changed ? { ...response, output: repaired } : response;
}

/**
 * Statelessly rewrite one SSE event: backfill annotations
 * on any output_text content part found in the event payload.
 */
function rewriteEvent(event: Record<string, unknown>): Record<string, unknown> {
  const type = typeof event.type === "string" ? event.type : "";
  let next = event;
  let changed = false;

  // output_item.added / output_item.done: item.content[] -> output_text parts
  if ((type === "response.output_item.added" || type === "response.output_item.done")
    && isPlainObject(event.item)) {
    const rawIndex = event.output_index;
    // A malformed or absent `output_index` must not collapse to 0: two such events would then
    // both synthesize `msg_ocx_0`, and duplicate ids are the very thing this backfill exists to
    // prevent. Fall back to a per-process counter so the synthesized id stays unique. Position
    // is not recoverable in that case, but a unique id is what strict decoders require, and a
    // well-formed stream still gets the stable index-derived id.
    const item = typeof rawIndex === "number" && Number.isInteger(rawIndex) && rawIndex >= 0
      ? backfillOutputItem(event.item, { kind: "index", index: rawIndex })
      : backfillOutputItem(event.item, nextSyntheticItemSlot());
    if (item !== event.item) {
      next = { ...next, item };
      changed = true;
    }
  }

  // content_part.added / content_part.done: part -> output_text
  if ((type === "response.content_part.added" || type === "response.content_part.done")
    && isPlainObject(event.part)) {
    const part = backfillOutputTextPart(event.part);
    if (part !== event.part) {
      next = { ...next, part };
      changed = true;
    }
  }

  // response.created / in_progress / completed / incomplete / failed:
  // response.output[].content[] -> output_text parts
  if (isPlainObject(event.response)) {
    const response = backfillResponseOutput(event.response);
    if (response !== event.response) {
      next = { ...next, response };
      changed = true;
    }
  }

  return changed ? next : event;
}

/**
 * Create a stateless SSE block rewrite that backfills annotations and
 * on output_text content parts. Unconditional: the field is a required
 * canonical Responses field, so adding it when absent is safe for all
 * clients.
 */
export function createResponsesFieldBackfillBlockRewrite(): SseBlockRewrite {
  const rewrite: SseBlockRewrite = (block: string): readonly string[] => {
    const payload = sseDataPayload(block);
    if (payload === null) return [block];
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return [block];
    }
    if (!isPlainObject(event)) return [block];
    const rewritten = rewriteEvent(event);
    if (rewritten === event) return [block];
    return [replaceSseDataPayload(block, JSON.stringify(rewritten))];
  };
  return rewrite;
}

/**
 * Backfill annotations on a non-streaming Responses JSON
 * object. Mirrors the SSE block rewrite for the bounded-JSON passthrough
 * path. Returns the original string if no change is needed.
 */
export function backfillResponsesFieldsJson(payload: string): string {
  let response: unknown;
  try {
    response = JSON.parse(payload);
  } catch {
    return payload;
  }
  if (!isPlainObject(response)) return payload;
  const repaired = backfillResponseOutput(response);
  if (repaired === response) return payload;
  return JSON.stringify(repaired);
}
