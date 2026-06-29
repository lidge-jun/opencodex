type Schema = Record<string, unknown>;

// Gemini / Antigravity (CCA) accept only an OpenAPI-3.0 subset for function `parameters`. Codex
// emits full JSON-Schema (draft 2020-12) tool definitions, so passing them through verbatim makes
// CCA reject the whole request with "Request contains an invalid argument" / "Unknown name ...".
// Every keyword below was confirmed live against the Antigravity backend to trigger a 400.
const DROPPED_SCHEMA_KEYS = new Set([
  "$schema", "$id", "$comment", "$ref", "$defs", "definitions",
  "examples", "patternProperties", "if", "then", "else",
  "uniqueItems", "additionalItems", "unevaluatedProperties", "unevaluatedItems",
  "dependentRequired", "dependentSchemas", "propertyNames", "contains",
]);

const MAX_DEREF_DEPTH = 64;

function resolveRef(ref: string, defs: Map<string, unknown>): unknown {
  // Only local pointers into the schema's own $defs/definitions are supported (e.g.
  // "#/$defs/Foo"). Anything else cannot be inlined, so it collapses to an unconstrained object.
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  return defs.get(decodeURIComponent(match[1].replace(/~1/g, "/").replace(/~0/g, "~")));
}

function collectDefs(root: unknown, defs: Map<string, unknown>): void {
  if (!root || typeof root !== "object") return;
  for (const bag of ["$defs", "definitions"] as const) {
    const group = (root as Schema)[bag];
    if (group && typeof group === "object" && !Array.isArray(group)) {
      for (const [name, value] of Object.entries(group as Schema)) {
        if (!defs.has(name)) defs.set(name, value);
      }
    }
  }
}

function normalizeType(value: unknown, out: Schema): void {
  // JSON-Schema allows `type` to be an array (e.g. ["string","null"]); OpenAPI 3.0 does not.
  // Collapse to the first non-null type and mark the field nullable when "null" was present.
  if (!Array.isArray(value)) {
    out.type = value;
    return;
  }
  const nonNull = value.filter(t => t !== "null");
  if (value.includes("null")) out.nullable = true;
  if (nonNull.length > 0) out.type = nonNull[0];
}

function sanitize(node: unknown, defs: Map<string, unknown>, depth: number): unknown {
  if (Array.isArray(node)) return node.map(item => sanitize(item, defs, depth));
  if (!node || typeof node !== "object") return node;
  const input = node as Schema;

  if (typeof input.$ref === "string" && depth < MAX_DEREF_DEPTH) {
    const target = resolveRef(input.$ref, defs);
    if (target && typeof target === "object") {
      const merged: Schema = { ...(target as Schema) };
      for (const [key, value] of Object.entries(input)) {
        if (key !== "$ref") merged[key] = value;
      }
      return sanitize(merged, defs, depth + 1);
    }
  }

  const out: Schema = {};
  for (const [key, value] of Object.entries(input)) {
    if (DROPPED_SCHEMA_KEYS.has(key)) continue;
    if (key === "type") { normalizeType(value, out); continue; }
    if (key === "const") { out.enum = [value]; continue; }
    if (key === "exclusiveMinimum" && typeof value === "number") { out.minimum = value; continue; }
    if (key === "exclusiveMaximum" && typeof value === "number") { out.maximum = value; continue; }
    if (key === "additionalProperties") {
      // A boolean additionalProperties is accepted, but a nested schema is only meaningful with
      // its own sanitize pass.
      out.additionalProperties = typeof value === "boolean" ? value : sanitize(value, defs, depth);
      continue;
    }
    out[key] = sanitize(value, defs, depth);
  }
  return out;
}

export function sanitizeGeminiToolParameters(parameters: unknown): Record<string, unknown> {
  const defs = new Map<string, unknown>();
  collectDefs(parameters, defs);
  const result = sanitize(parameters, defs, 0);
  return result && typeof result === "object" && !Array.isArray(result)
    ? result as Record<string, unknown>
    : { type: "object" };
}
