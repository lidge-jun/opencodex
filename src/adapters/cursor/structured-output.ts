import type { OcxRequestOptions } from "../../types";

/** Cursor has no native Responses text.format equivalent: repeat its contract in the active action. */
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
