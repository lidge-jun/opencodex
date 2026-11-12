import { stripResponsesOnlyEncryptedMarker } from "./responses-tool-schema";

/**
 * Anthropic rejects a root-level missing `type` and root-level `oneOf`/`anyOf`/`allOf` in
 * `input_schema`. Normalize the root only: ensure `type:"object"` + `properties`, flatten root
 * composition while preserving nested schemas. Shared by the anthropic and command-code adapters.
 *
 * Known limitation: Object.assign on branch properties means later branches overwrite earlier
 * ones when the same property name appears with different schemas.
 */
export function normalizeAnthropicInputSchema(schema: unknown): Record<string, unknown> {
  const stripped = stripResponsesOnlyEncryptedMarker(schema);
  const obj = stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? stripped as Record<string, unknown>
    : {};
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasRootComposition = compositionKeys.some(key => Array.isArray(obj[key]));
  const type = obj.type;
  const rootObjectType = type === "object" || (Array.isArray(type) && type.includes("object"));

  if (!hasRootComposition) {
    const normalized: Record<string, unknown> = rootObjectType && type === "object"
      ? { ...obj }
      : { ...obj, type: "object" };
    if (normalized.properties === undefined || normalized.properties === null) {
      normalized.properties = {};
    }
    return normalized;
  }

  const properties: Record<string, unknown> = {};
  const required = new Set<string>();
  if (obj.properties && typeof obj.properties === "object" && !Array.isArray(obj.properties)) {
    Object.assign(properties, obj.properties as Record<string, unknown>);
  }
  if (Array.isArray(obj.required)) {
    for (const item of obj.required) if (typeof item === "string") required.add(item);
  }

  for (const key of compositionKeys) {
    const variants = obj[key];
    if (!Array.isArray(variants)) continue;
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      if (!variant || typeof variant !== "object" || Array.isArray(variant)) continue;
      const v = variant as Record<string, unknown>;
      if (v.properties && typeof v.properties === "object" && !Array.isArray(v.properties)) {
        Object.assign(properties, v.properties as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(v.required)) {
        for (const item of v.required) if (typeof item === "string") required.add(item);
      }
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "type" || key === "properties" || key === "required") continue;
    normalized[key] = value;
  }
  normalized.type = "object";
  normalized.properties = properties;
  if (required.size > 0) normalized.required = [...required];
  return normalized;
}
