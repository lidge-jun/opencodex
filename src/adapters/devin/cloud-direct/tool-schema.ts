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
const SCHEMA_MAP_KEYS = new Set(['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies']);
/** Keys that describe the whole node and stay on it rather than moving into each branch. */
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples', 'example', '$comment', 'deprecated']);

function rewriteMap(map: unknown): unknown {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return map;
  // A draft-7 `dependencies` entry may be a list of property names, which is data.
  return Object.fromEntries(Object.entries(map).map(([name, schema]) => [name, Array.isArray(schema) ? schema : rewrite(schema)]));
}

type Schema = Record<string, unknown>;
const isSchema = (value: unknown): value is Schema => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * Replace a type array with an equivalent type-only union. Constraints remain on
 * the surrounding node so nested schemas are represented exactly once rather
 * than copied into every branch.
 */
function splitTypeArray(node: Schema, types: unknown[]): Schema {
  const annotations: Schema = {};
  const rest: Schema = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'type' || key === 'anyOf') continue;
    Object.defineProperty(ANNOTATION_KEYS.has(key) ? annotations : rest, key, { value, enumerable: true, writable: true, configurable: true });
  }
  const concrete = types.filter((type) => type !== 'null');
  // An outer enum/const is still binding after the type array is split.
  const allowsNull = concrete.length < types.length
    && (!Array.isArray(rest.enum) || rest.enum.includes(null))
    && (!Object.hasOwn(rest, 'const') || rest.const === null);
  const branches = concrete.map((type) => ({ type }));
  if (allowsNull || branches.length === 0) branches.push({ type: 'null' });
  const typeConstraint: Schema = branches.length === 1 ? branches[0]! : { anyOf: branches };
  const existing = Array.isArray(node.anyOf) ? node.anyOf : undefined;
  if (!existing) return { ...annotations, ...rest, ...typeConstraint };
  // Keep existing applicators and constraints at their original JSON Pointer
  // locations. Appending only the type constraint also preserves allOf indices,
  // resource scopes, and the sibling annotations read by unevaluated* keywords.
  const allOf = Array.isArray(rest.allOf) ? rest.allOf : [];
  return { ...annotations, ...rest, anyOf: existing, allOf: [...allOf, typeConstraint] };
}

function rewrite(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(rewrite);
  if (!isSchema(node)) return node;
  // fromEntries defines own properties, so a "__proto__" key stays data.
  const out: Schema = Object.fromEntries(
    Object.entries(node).map(([key, value]) => [
      key,
      DATA_KEYS.has(key) ? value : SCHEMA_MAP_KEYS.has(key) ? rewriteMap(value) : rewrite(value),
    ]),
  );
  if (!Array.isArray(out.type)) return out;
  const types = out.type as unknown[];
  if (types.length === 0) {
    delete out.type;
    return out;
  }
  return splitTypeArray(out, types);
}

/** Rewrite type arrays for Gemini uids; every other model gets the schema unchanged. */
export function normalizeDevinToolParameters(modelUid: string, parameters: unknown): unknown {
  return isDevinGeminiModelUid(modelUid) ? rewrite(parameters) : parameters;
}
