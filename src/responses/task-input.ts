import type { OcxContentPart } from "../types";
import { inputContentParts, isObj } from "./parser-content";

type TaskInputBlock =
  | { type: "input_text" | "output_text" | "text"; text: string }
  | { type: "input_image"; image_url: string; detail?: string };

const imageDetails = new Set(["auto", "low", "high", "original"]);

function nonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function supportedBlock(value: unknown): value is TaskInputBlock {
  if (!isObj(value)) return false;
  if (value.type === "input_text" || value.type === "output_text" || value.type === "text") {
    return typeof value.text === "string";
  }
  if (value.type !== "input_image" || !nonBlank(value.image_url)) return false;
  return value.detail === undefined || (typeof value.detail === "string" && imageDetails.has(value.detail));
}

/**
 * Does this item carry a pairing key? A tool result is paired by `call_id`; a seed is not.
 *
 * Presence of the FIELD is not presence of a KEY (#3807). Codex desktop seeds a sub-agent
 * thread with a lone `function_call_output` that some client builds emit with an explicit
 * `call_id: null` or `""` rather than omitting it. Those values can never pair with a
 * `function_call`, so treating them as a paired result sent the item to the guard in
 * core.ts and answered 400 for a turn that is really external task input.
 *
 * A wrong-typed key (number, object) is NOT relaxed: that is malformed input rather than
 * the absent-pairing seed shape, and it keeps the #3259 rejection.
 */
function hasPairingKey(item: Record<string, unknown>): boolean {
  if (!("call_id" in item)) return false;
  const callId = item.call_id;
  if (callId === null) return false;
  if (typeof callId === "string") return callId.trim().length > 0;
  return true;
}

/** Recognize Codex external task input without repairing ordinary orphaned tool results. */
export function externalTaskInputContent(item: unknown): string | OcxContentPart[] | undefined {
  if (!isObj(item) || item.type !== "function_call_output" || hasPairingKey(item)) return undefined;
  if (!nonBlank(item.id) || !nonBlank(item.name) || !nonBlank(item.namespace)) return undefined;
  const output = item.output;
  if (typeof output === "string") return nonBlank(output) ? output : undefined;
  if (!Array.isArray(output) || output.length === 0 || !output.every(supportedBlock)) return undefined;
  if (!output.some(block => block.type === "input_image" || nonBlank(block.text))) return undefined;
  // Validate the entire array first: the general converter intentionally drops unknown
  // blocks, while a partial external task would silently lose the caller's input.
  return inputContentParts(output.map(block =>
    block.type === "output_text" ? { ...block, type: "input_text" } : block,
  ));
}
