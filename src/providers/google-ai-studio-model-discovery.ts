import {
  extractModelEnvelopeRows,
  isValidModelDiscoveryModelId,
  type ProviderModelItemsResult,
  type ProviderModelsApiItem,
} from "./model-discovery";

const GOOGLE_MODEL_PREFIX = "models/";
const MAX_GENERATION_METHODS = 32;
const MAX_GENERATION_METHOD_LENGTH = 64;

function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

export function extractGoogleAiStudioModelItems(
  value: unknown,
  maxModels: number,
): ProviderModelItemsResult {
  const envelope = extractModelEnvelopeRows(value, maxModels, ["models"]);
  if (!envelope.ok) return envelope;

  const items: ProviderModelsApiItem[] = [];
  const seen = new Set<string>();
  for (const raw of envelope.rows) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "invalid_shape" };
    }
    const name = Reflect.get(raw, "name");
    const generationMethods = Reflect.get(raw, "supportedGenerationMethods");
    if (!isValidModelDiscoveryModelId(name)) {
      return { ok: false, reason: "invalid_shape" };
    }
    if (generationMethods === undefined) continue;
    if (
      !Array.isArray(generationMethods)
      || generationMethods.length > MAX_GENERATION_METHODS
      || generationMethods.some(method => typeof method !== "string" || method.length > MAX_GENERATION_METHOD_LENGTH)
    ) {
      return { ok: false, reason: "invalid_shape" };
    }
    if (!generationMethods.includes("generateContent")) continue;

    const id = name.startsWith(GOOGLE_MODEL_PREFIX)
      ? name.slice(GOOGLE_MODEL_PREFIX.length)
      : name;
    if (!isValidModelDiscoveryModelId(id) || seen.has(id)) continue;
    seen.add(id);

    const inputTokenLimit = positiveSafeInteger(Reflect.get(raw, "inputTokenLimit"));
    const outputTokenLimit = positiveSafeInteger(Reflect.get(raw, "outputTokenLimit"));
    items.push({
      id,
      owned_by: "google",
      ...(inputTokenLimit !== undefined
        ? { context_length: inputTokenLimit, max_input_tokens: inputTokenLimit }
        : {}),
      ...(outputTokenLimit !== undefined ? { max_output_tokens: outputTokenLimit } : {}),
    });
  }
  return { ok: true, items, rawCount: envelope.rows.length };
}
