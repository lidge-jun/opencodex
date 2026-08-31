/**
 * Shared wire text and emptiness contract for present-but-empty tool outputs.
 *
 * Both the OpenAI Chat and Responses adapters use this module so the two wires
 * cannot drift again: only a pure text/refusal part array whose joined content
 * trims empty is "present but empty". Image, file, encrypted-content and any
 * other non-text part is real output and is never replaced by the annotation.
 */

/** Wire text used when a present-but-empty tool output must stay visible to the model. */
export const EMPTY_TOOL_OUTPUT_ANNOTATION =
  "[ocx] empty tool output: the tool ran but produced no stdout or return value; do not treat this as success, failure, or user-provided input.";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Part types that carry wire text on either adapter (Chat uses `text`, Responses uses `input_text`/`output_text`). */
const TEXT_PART_TYPES = new Set(["text", "input_text", "output_text"]);

/**
 * True when every part is text/refusal and the joined text/refusal content trims
 * empty. An empty array is the array twin of a blank string. Any image, file,
 * encrypted-content or other non-text part makes the array non-empty so the
 * model still receives the real payload.
 */
export function isWhitespaceOnlyTextPartArray(parts: readonly unknown[]): boolean {
  if (parts.length === 0) return true;
  let joined = "";
  for (const part of parts) {
    if (!isPlainObject(part)) return false;
    if (typeof part.type === "string" && TEXT_PART_TYPES.has(part.type) && typeof part.text === "string") {
      joined += part.text;
      continue;
    }
    if (part.type === "refusal" && typeof part.refusal === "string") {
      joined += part.refusal;
      continue;
    }
    return false;
  }
  return joined.trim() === "";
}
