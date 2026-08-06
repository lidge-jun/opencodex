/**
 * Cheap request-side evidence extraction for policy routing (RI-05).
 *
 * Extracts only what the request body can prove: whether the caller asked for
 * tools and whether the input contains image parts. Context-window size is
 * left unknown at routing time (documented limitation) - the dry-run API/CLI
 * remains the evidence-inspection surface for context-sensitive profiles.
 */

import type { PolicyRequestEvidence } from "./evaluator";

/**
 * Walk a body fragment for image parts. Real request shapes nest image blocks:
 * Responses puts them under `input[].content[]` (type `input_image`), Chat
 * Completions under `messages[].content[]` (type `image_url`), and Claude
 * Messages under `messages[].content[]` (type `image`), so the scan recurses
 * into arrays and `content` fields instead of only checking the top level.
 */
function containsImagePart(value: unknown): boolean {
  if (typeof value === "string") return false;
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsImagePart);
  const record = value as Record<string, unknown>;
  if (record.type === "image" || record.type === "input_image") return true;
  if (record.image_url !== undefined || record.image !== undefined) return true;
  if (record.content !== undefined && containsImagePart(record.content)) return true;
  return false;
}

function inputContainsImage(input: unknown): boolean {
  if (typeof input === "string") return false;
  if (!Array.isArray(input)) return false;
  return input.some(containsImagePart);
}

export function evidenceFromBody(body: unknown): PolicyRequestEvidence {
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  const record = body as Record<string, unknown>;
  const tools = Array.isArray(record.tools) && record.tools.length > 0;
  const image = inputContainsImage(record.input) || inputContainsImage(record.messages);
  return {
    ...(tools ? { toolsRequired: true } : {}),
    ...(image ? { imageInputRequired: true } : {}),
  };
}
