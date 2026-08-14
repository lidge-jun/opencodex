// Schema-aware repair for integer tool arguments that arrive as floats (issue #1611).
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
// Anything without a declared `integer` type is never touched.

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
    const integerDeclared = declaresInteger(resolved)
      || compositionBranches(resolved).some(declaresInteger);
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
  // Cheap reject: a payload with no fractional-looking number cannot need repair.
  if (!/\d\.\d/.test(args)) return args;
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
