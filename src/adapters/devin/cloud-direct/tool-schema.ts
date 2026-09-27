/**
 * Tool-schema compatibility for Gemini models behind GetChatMessage.
 *
 * Measured live on gemini-3-8-flash-medium: any schema node whose `type` is a
 * JSON-Schema type array (`["string", "null"]`) is refused with an opaque
 * `invalid_argument` on every turn, while the same union spelled as
 * `anyOf: [{type: "string"}, {type: "null"}]` is accepted, as are `$schema`,
 * `additionalProperties: false`, `const`, and `$ref`/`$defs`. Claude models
 * accept type arrays, so only the Gemini family is rewritten, and only that one
 * keyword: the full Google subset sanitizer would strip keywords this backend
 * accepts.
 */

export function isDevinGeminiModelUid(modelUid: string): boolean {
  return /^gemini-/i.test(modelUid) || /^MODEL_GOOGLE_GEMINI_/i.test(modelUid);
}

/** Keys whose values are instance data, not subschemas. */
const DATA_KEYS = new Set(['enum', 'const', 'default', 'examples', 'example']);
/** Keys whose values map arbitrary names (which may be "enum" or "default") to subschemas. */
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas']);

function rewriteMap(map: unknown): unknown {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return map;
  return Object.fromEntries(Object.entries(map).map(([name, schema]) => [name, rewrite(schema)]));
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (!node || typeof node !== 'object') return node;
  // fromEntries defines own properties, so a "__proto__" key stays data.
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(node as Record<string, unknown>).map(([key, value]) => [
      key,
      DATA_KEYS.has(key) ? value : SCHEMA_MAP_KEYS.has(key) ? rewriteMap(value) : rewrite(value),
    ]),
  );
  if (!Array.isArray(out.type)) return out;
  const types = out.type as unknown[];
  delete out.type;
  if (types.length === 1) return { ...out, type: types[0] };
  if (types.length === 0) return out;
  const union = types.map((type) => ({ type }));
  if (out.anyOf === undefined) return { ...out, anyOf: union };
  // Both constraints must hold, so an existing anyOf is kept beside the new one.
  const allOf = Array.isArray(out.allOf) ? out.allOf : [];
  return { ...out, allOf: [...allOf, { anyOf: union }] };
}

/** Rewrite type arrays for Gemini uids; every other model gets the schema unchanged. */
export function normalizeDevinToolParameters(modelUid: string, parameters: unknown): unknown {
  return isDevinGeminiModelUid(modelUid) ? rewrite(parameters) : parameters;
}
