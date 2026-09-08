type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGuardrailsFailureEnvelope(value: JsonRecord): boolean {
  if (value.type === "error"
    || value.type === "response.failed"
    || value.type === "response.incomplete") return true;
  if (value.error !== undefined && value.error !== null) return true;
  if (value.last_error !== undefined && value.last_error !== null) return true;
  const response = isRecord(value.response) ? value.response : undefined;
  return [value.status, response?.status].some(status =>
    status === "failed" || status === "incomplete" || status === "cancelled");
}
