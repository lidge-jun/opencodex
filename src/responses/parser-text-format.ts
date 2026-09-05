import type { OcxRequestOptions } from "../types";
import { isObj } from "./parser-content";

/**
 * The Responses `text.format` object when it requests structured output (json_schema or
 * json_object), undefined otherwise. Acceptance is identical to the boolean detector this
 * replaces; unknown or malformed formats are ignored, never rejected, so the native
 * passthrough keeps forwarding whatever the caller sent via `_rawBody`.
 */
export function parseTextFormat(text: unknown): OcxRequestOptions["textFormat"] {
  if (!isObj(text)) return undefined;
  const format = (text as { format?: unknown }).format;
  if (!isObj(format)) return undefined;
  const f = format as { type?: unknown; name?: unknown; description?: unknown; schema?: unknown; strict?: unknown };
  if (f.type === "json_object") return { type: "json_object" };
  if (f.type !== "json_schema") return undefined;
  return {
    type: "json_schema",
    ...(typeof f.name === "string" ? { name: f.name } : {}),
    ...(typeof f.description === "string" ? { description: f.description } : {}),
    ...(isObj(f.schema) ? { schema: f.schema as Record<string, unknown> } : {}),
    ...(typeof f.strict === "boolean" ? { strict: f.strict } : {}),
  };
}
