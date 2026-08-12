import type { SsePayloadRewrite } from "./sse-payload-rewrite";

function rewriteResponseObjectModel(value: unknown, responseModelId: string): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  if (typeof response.model !== "string" || response.model === responseModelId) return false;
  response.model = responseModelId;
  return true;
}

/** Rewrite only existing Responses model metadata; unrelated and malformed payloads stay byte-identical. */
export function rewriteResponsesModelJson(json: string, responseModelId: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json;
  const record = parsed as Record<string, unknown>;
  const rootChanged = rewriteResponseObjectModel(record, responseModelId);
  const nestedChanged = rewriteResponseObjectModel(record.response, responseModelId);
  const changed = rootChanged || nestedChanged;
  return changed ? JSON.stringify(record) : json;
}

export function createResponsesModelPayloadRewrite(responseModelId: string): SsePayloadRewrite {
  return payload => rewriteResponsesModelJson(payload, responseModelId);
}
