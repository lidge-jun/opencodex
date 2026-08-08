/** Hard process-wide limits shared by all live model-discovery parsers. */
export const MODEL_DISCOVERY_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MODEL_DISCOVERY_MAX_MODELS = 2_000;
export const MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH = 1_024;

const MODEL_DISCOVERY_MODEL_ID_CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/** Reject model IDs that cannot safely be published as callable catalog selectors. */
export function isValidModelDiscoveryModelId(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const normalized = value.trim();
  return Boolean(normalized)
    && normalized === value
    && normalized.length <= MODEL_DISCOVERY_MAX_MODEL_ID_LENGTH
    && !MODEL_DISCOVERY_MODEL_ID_CONTROL_CHARS.test(normalized);
}
