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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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
 * Returns the same object reference if nothing changed.
 */
function backfillOutputItem(item: unknown): unknown {
  if (!isPlainObject(item)) return item;
  const content = item.content;
  const repaired = backfillContentArray(content);
  if (repaired === content) return item;
  return { ...item, content: repaired };
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
  const repaired = output.map((item) => {
    if (!isPlainObject(item)) return item;
    const next = backfillOutputItem(item);
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
    const item = backfillOutputItem(event.item);
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
