export function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolve a local `#/`-rooted JSON Pointer against `root`; undefined when it does not resolve. */
export function lookupLocalJsonPointer(root: unknown, ref: string): unknown {
  if (ref === "#" || ref === "#/") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const token of ref.slice(2).split("/").map(decodeJsonPointerToken)) {
    if (!isSchemaObject(current) || !Object.hasOwn(current, token)) return undefined;
    current = current[token];
  }
  return current;
}

/** Values a schema pins through `const`/`enum`, or undefined when it pins none. */
function xaiLiteralValues(schema: unknown): unknown[] | undefined {
  if (!isSchemaObject(schema)) return undefined;
  if (Object.hasOwn(schema, "const")) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return undefined;
}

/** JSON type name for a literal, so it can be compared against a `type` keyword. */
function xaiJsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "object";
}

/** Types a schema declares, or undefined when it constrains none. */
function xaiDeclaredTypes(schema: unknown): Set<string> | undefined {
  if (!isSchemaObject(schema)) return undefined;
  const type = schema.type;
  if (typeof type === "string") return new Set([type]);
  if (Array.isArray(type) && type.every(item => typeof item === "string")) return new Set(type as string[]);
  return undefined;
}

/** `integer` is a subset of `number`, so those two names overlap rather than exclude. */
function xaiTypesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return (left === "integer" && right === "number") || (left === "number" && right === "integer");
}

/**
 * Conservative mutual-exclusion test: true only when no instance can satisfy both schemas.
 * Proof comes from disjoint literal sets or disjoint declared types; anything it cannot prove
 * is reported as overlapping so the caller refuses the merge instead of widening the schema.
 */
function xaiSchemasAreProvablyDisjoint(left: unknown, right: unknown): boolean {
  const leftValues = xaiLiteralValues(left);
  const rightValues = xaiLiteralValues(right);
  if (leftValues && rightValues) {
    const seen = new Set(rightValues.map(value => JSON.stringify(value)));
    return leftValues.every(value => !seen.has(JSON.stringify(value)));
  }
  const leftTypes = xaiDeclaredTypes(left);
  const rightTypes = xaiDeclaredTypes(right);
  const literalsExcludedByTypes = (values: unknown[], types: Set<string>): boolean =>
    values.every(value => ![...types].some(type => xaiTypesOverlap(xaiJsonTypeOf(value), type)));
  if (leftValues && rightTypes) return literalsExcludedByTypes(leftValues, rightTypes);
  if (rightValues && leftTypes) return literalsExcludedByTypes(rightValues, leftTypes);
  if (leftTypes && rightTypes) {
    return ![...leftTypes].some(leftType => [...rightTypes].some(rightType => xaiTypesOverlap(leftType, rightType)));
  }
  return false;
}

/** Every pair provably disjoint, so a union over them accepts each instance exactly once. */
export function xaiSchemasArePairwiseDisjoint(schemas: unknown[]): boolean {
  for (let i = 0; i < schemas.length; i += 1) {
    for (let j = i + 1; j < schemas.length; j += 1) {
      if (!xaiSchemasAreProvablyDisjoint(schemas[i], schemas[j])) return false;
    }
  }
  return true;
}
