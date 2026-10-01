import type { OcxRequestOptions } from "../../types";

/**
 * Render a Responses final-output contract as prompt guidance for Cursor's Connect wire.
 * This fallback does not enforce JSON decoding or validate the model's response.
 * @param format The requested JSON object/schema format, or undefined for ordinary text.
 * @returns Final-answer instructions, including a supplied schema, or an empty string.
 */
export function cursorStructuredOutputInstructions(format: OcxRequestOptions["textFormat"]): string {
  if (!format) return "";
  const schema = format.type === "json_schema" && format.schema
    ? `\nYour final JSON must conform to this JSON Schema:\n${JSON.stringify(format.schema)}`
    : "";
  const kind = format.type === "json_object" ? "JSON object" : "JSON value";
  return `[Final response format]\nWhen ready to answer, return only a valid ${kind}: no Markdown, no code fences, no headings or prose outside the JSON. `
    + "This requirement applies to your final answer, not intermediate tool calls."
    + schema;
}
