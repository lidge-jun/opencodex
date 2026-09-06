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

/** Recognize Codex external task input without repairing ordinary orphaned tool results. */
export function externalTaskInputContent(item: unknown): string | OcxContentPart[] | undefined {
  if (!isObj(item) || item.type !== "function_call_output" || "call_id" in item) return undefined;
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
