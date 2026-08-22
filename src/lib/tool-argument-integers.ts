// Schema-aware repair for tool arguments whose serialized representation disagrees
// with the declared schema in a way that has exactly one faithful reading.
//
// Case 1 — integer fields arriving as integral floats (issue #1611).
//
// Grok serializes integer tool-call arguments through a float representation, so
// `yield_time_ms: 120000` leaves the provider as `120000.0`. Codex declares those
// fields as Rust integer types, so it rejects the call BEFORE running the tool:
//
//   failed to parse function arguments: invalid type: floating point `120000.0`, expected u64
//
// That is a hard failure, not a degradation — the model gets no result and retries
// the same float. Nothing on the routed path reconciled argument values against the
// declared schema, so the `.0` passed straight through.
//
// The boundary this file draws is INTENT, not convenience:
//   - an integral float in an integer-typed field is a representation artifact, and
//     `120000.0` has exactly one integer reading, so it is repaired;
//   - `1.5` in an integer field is a genuine disagreement with the schema and is left
//     alone so it still fails, rather than being truncated into a plausible lie.
//
// Case 2 — string fields arriving as bare integers (issue #1938).
//
// Cursor-served models emit `{"cell_id": 4}` where the schema declares
// `{"type": "string"}`. Codex rejects the call before the tool runs (invalid type:
// integer `4`, expected a string), and the model never self-corrects, so every such
// call is a hard failure loop. A safely-integral JSON number in a string-declared
// field has exactly one faithful string reading (`4` -> `"4"`), so it is repaired
// under the same intent boundary:
//   - only when the field declares `string` and no numeric type (a
//     `["integer","string"]` union accepts the number as-is and is left alone);
//   - a non-integral number (`4.5`) in a string field is a genuine disagreement and
//     is left alone so it still fails;
//   - beyond 2^53-1 the parsed value may differ from the serialized text, so the
//     original bytes stay.
//
// Anything without a declared `integer`/`string` type is never touched.

/** JSON Schema subset we need; provider tool schemas are untrusted input. */
type SchemaNode = Record<string, unknown>;

function asSchema(value: unknown): SchemaNode | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as SchemaNode
    : undefined;
}

/** True when the node declares `integer`, including `["integer","null"]` unions. */
function declaresInteger(schema: SchemaNode): boolean {
  const type = schema.type;
  if (type === "integer") return true;
  return Array.isArray(type) && type.includes("integer");
}

/** True when the node declares `string`, including `["string","null"]` unions. */
function declaresString(schema: SchemaNode): boolean {
  const type = schema.type;
  if (type === "string") return true;
  return Array.isArray(type) && type.includes("string");
}

/** True when the node accepts a JSON number (`integer` or `number`), so a numeric
 * value is already schema-valid and must not be rewritten into a string. */
function declaresNumeric(schema: SchemaNode): boolean {
  const type = schema.type;
  if (type === "integer" || type === "number") return true;
  return Array.isArray(type) && (type.includes("integer") || type.includes("number"));
}

/**
 * Resolve a local `$ref` (`#/$defs/Foo`, `#/definitions/Foo`).
 *
 * Only same-document refs are followed: a remote ref is not fetchable here, and a
 * schema we cannot resolve must leave its values untouched rather than guessed at.
 */
function resolveRef(schema: SchemaNode, root: SchemaNode, seen: Set<string>): SchemaNode | undefined {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/")) return schema;
  if (seen.has(ref)) return undefined; // cyclic $ref: stop rather than recurse forever
  seen.add(ref);
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    const current = asSchema(node);
    if (!current) return undefined;
    node = current[segment];
  }
  const resolved = asSchema(node);
  return resolved ? resolveRef(resolved, root, seen) : undefined;
}

/** Composition keywords whose branches may carry the integer declaration. */
const COMPOSITION_KEYS = ["anyOf", "oneOf", "allOf"] as const;

function compositionBranches(schema: SchemaNode): SchemaNode[] {
  const branches: SchemaNode[] = [];
  for (const key of COMPOSITION_KEYS) {
    const value = schema[key];
    if (!Array.isArray(value)) continue;
    for (const branch of value) {
      const node = asSchema(branch);
      if (node) branches.push(node);
    }
  }
  return branches;
}

/**
 * A JS number can only represent integers exactly up to 2^53-1. Beyond that a
 * rewrite would emit a silently different value, so the original text stays.
 */
function safelyIntegral(value: number): boolean {
  return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
}

interface CoerceResult {
  value: unknown;
  changed: boolean;
}

function coerceValue(value: unknown, schema: SchemaNode | undefined, root: SchemaNode, depth: number): CoerceResult {
  // A hostile or deeply nested schema must not blow the stack.
  if (depth > 64) return { value, changed: false };
  const resolved = schema ? resolveRef(schema, root, new Set()) : undefined;

  if (typeof value === "number") {
    if (!resolved) return { value, changed: false };
    const branches = compositionBranches(resolved);
    const integerDeclared = declaresInteger(resolved) || branches.some(declaresInteger);
    if (!integerDeclared && safelyIntegral(value)) {
      // Issue #1938: a bare integer in a string-only field has exactly one faithful
      // string reading. A field that also accepts a numeric type keeps the number.
      const stringDeclared = declaresString(resolved) || branches.some(declaresString);
      const numericDeclared = declaresNumeric(resolved) || branches.some(declaresNumeric);
      if (stringDeclared && !numericDeclared) {
        return { value: String(value), changed: true };
      }
    }
    // Not an integer field, already an integer, non-integral, or unrepresentable:
    // in every one of those cases the received value is the right thing to keep.
    if (!integerDeclared || !safelyIntegral(value)) return { value, changed: false };
    // `120000.0` and `120000` are the same JS number; the difference is only in the
    // serialized text, which is repaired by re-stringifying the parsed value.
    return { value, changed: true };
  }

  if (Array.isArray(value)) {
    const itemSchema = resolved ? asSchema(resolved.items) : undefined;
    let changed = false;
    const next = value.map(entry => {
      const result = coerceValue(entry, itemSchema, root, depth + 1);
      if (result.changed) changed = true;
      return result.value;
    });
    return changed ? { value: next, changed } : { value, changed: false };
  }

  const object = asSchema(value);
  if (!object) return { value, changed: false };

  const properties = resolved ? asSchema(resolved.properties) : undefined;
  const additional = resolved ? asSchema(resolved.additionalProperties) : undefined;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(object)) {
    const childSchema = asSchema(properties?.[key]) ?? additional;
    const result = coerceValue(entry, childSchema, root, depth + 1);
    if (result.changed) changed = true;
    next[key] = result.value;
  }
  return changed ? { value: next, changed } : { value, changed: false };
}

/**
 * Repair integral floats in a tool-call arguments STRING against the tool's declared
 * parameter schema.
 *
 * Returns the original string unchanged when there is no schema, the payload does not
 * parse, or nothing needed repair — so an unaffected call keeps its exact bytes and
 * this stays a no-op for every provider that already emits real integers.
 */
export function coerceIntegerToolArguments(
  args: string,
  parameters: Record<string, unknown> | undefined,
): string {
  if (!parameters || !args) return args;
  // Cheap reject: a payload with no digit cannot need either repair (integral-float
  // -> integer, or bare-integer -> string).
  if (!/\d/.test(args)) return args;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    // Malformed or still-streaming arguments are not this function's problem; the
    // existing paths already handle them.
    return args;
  }
  const root = parameters as SchemaNode;
  const result = coerceValue(parsed, root, root, 0);
  if (!result.changed) return args;
  return JSON.stringify(result.value);
}
