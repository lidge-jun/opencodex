import { truncationReasonFor } from "./truncated-stop-reason";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeResponse(value: unknown): unknown {
  if (!record(value) || !record(value.incomplete_details)) return value;
  const details = value.incomplete_details;
  if (typeof details.reason !== "string") return value;
  const reason = truncationReasonFor(details.reason);
  return reason !== undefined && reason !== details.reason
    ? { ...value, incomplete_details: { ...details, reason } }
    : value;
}

/** Normalize only Responses metadata, never output content or unknown provider reasons. */
export function normalizeResponsesIncompleteReason<T>(payload: T): T {
  if (!record(payload)) return payload;
  const root = normalizeResponse(payload) as Record<string, unknown>;
  const response = normalizeResponse(root.response);
  return (response === root.response ? root : { ...root, response }) as T;
}

/** Identity for malformed JSON and unchanged metadata, preserving upstream framing on SSE. */
export function rewriteResponsesIncompleteReasonJson(json: string): string {
  let payload: unknown;
  try { payload = JSON.parse(json); } catch { return json; }
  const normalized = normalizeResponsesIncompleteReason(payload);
  return normalized === payload ? json : JSON.stringify(normalized);
}
