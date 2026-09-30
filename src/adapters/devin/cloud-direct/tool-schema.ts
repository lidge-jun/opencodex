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
 * `{type: [T, "null"], ...rest}` becomes `{anyOf: [{...rest, type: T}, {type: "null"}]}`,
 * so type-specific keywords (items, properties, ...) stay attached to their type.
 * An existing anyOf is folded in branch by branch when no branch contradicts an
 * outer keyword, and kept beside the split under allOf when one does.
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
  const existing = Array.isArray(node.anyOf) ? node.anyOf : undefined;
  // Boolean constraints apply to every type, including null. A bare null branch
  // would bypass them, so keep the type split and the outer schema conjunctive.
  if (allowsNull && ['not', 'allOf', 'oneOf', 'if', 'then', 'else'].some((key) => key in rest)) {
    return {
      ...annotations,
      allOf: [splitTypeArray({ type: types }, types), existing ? { ...rest, anyOf: existing } : rest],
    };
  }
  // Folding merges each branch into the outer keywords, which is only exact when
  // they never disagree: `{maxLength: 5, anyOf: [{maxLength: 50}]}` folded would
  // loosen the outer limit. On a disagreement keep both constraints under allOf,
  // which this backend accepts (live: gemini-3-8-flash-medium).
  if (existing?.some((branch) => isSchema(branch) && (
    Object.keys(branch).some((key) => key !== 'type' && key in rest && JSON.stringify(branch[key]) !== JSON.stringify(rest[key]))
    // Keep an existing null branch's own constraints; folding it to {type:"null"}
    // would admit values that its enum, const, or nested schema rejects.
    || (allowsNull && branch.type === 'null' && Object.keys(branch).some((key) => key !== 'type'))
    || (allowsNull && branch.type === undefined && ['enum', 'const', 'not', 'allOf', 'oneOf'].some((key) => key in branch))
  ))) {
    return { ...annotations, allOf: [splitTypeArray({ ...rest, type: types }, types), { anyOf: existing }] };
  }
  const branches: unknown[] = [];
  let nullReachable = allowsNull && !existing;
  if (!existing) {
    for (const type of concrete) branches.push({ ...rest, type });
  } else {
    for (const branch of existing) {
      if (!isSchema(branch)) continue;
      if (branch.type === undefined) {
        for (const type of concrete) branches.push({ ...rest, ...branch, type });
        if (allowsNull) nullReachable = true;
      } else if (branch.type === 'null') {
        if (allowsNull) nullReachable = true;
      } else if (concrete.includes(branch.type)) {
        branches.push({ ...rest, ...branch });
      }
    }
  }
  if (nullReachable) branches.push({ type: 'null' });
  // The two unions are disjoint. Keep both constraints rather than drop the type union,
  // which would let the anyOf branches admit types the node never allowed.
  if (branches.length === 0) return { ...annotations, allOf: [splitTypeArray({ ...rest, type: types }, types), { anyOf: existing }] };
  if (branches.length === 1 && isSchema(branches[0])) return { ...annotations, ...branches[0] };
  return { ...annotations, anyOf: branches };
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
