import { stripResponsesOnlyEncryptedMarker } from "./responses-tool-schema";

/**
 * Anthropic rejects a root-level missing `type` and root-level `oneOf`/`anyOf`/`allOf` in
 * `input_schema`. Normalize the root only: ensure `type:"object"` + `properties`, flatten root
 * composition while preserving nested schemas, and inline local `#/$defs`/`#/definitions` refs
 * before flattening so a referenced branch keeps its parameters and required members. A `$ref`
 * with siblings merges both property maps, unions `required`, and keeps a property declared on
 * both sides conjunctive under `allOf`. Shared by the anthropic and command-code adapters.
 *
 * Flattening root alternatives is lossy: later branches win for a same-named property, and
 * `oneOf`/`anyOf` branch `required` members are not promoted because no branch is guaranteed.
 * A root `oneOf` whose branches declare `action.enum: ["read"]` and `action.enum: ["write"]`
 * yields a schema that permits only `"write"`. Covered by
 * tests/providers/command-code-tool-schema.test.ts and
 * tests/adapters/anthropic/anthropic-tool-schema.test.ts.
 */

const LOCAL_REF_PREFIX = "#/";

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

function resolveLocalPointer(root: Record<string, unknown>, pointer: string): Record<string, unknown> | undefined {
  if (!pointer.startsWith(LOCAL_REF_PREFIX)) return undefined;
  let node: unknown = root;
  for (const segment of pointer.slice(2).split("/")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as Record<string, unknown>)[decodePointerSegment(segment)];
  }
  return node && typeof node === "object" && !Array.isArray(node)
    ? node as Record<string, unknown>
    : undefined;
}

function asSchemaMap(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * JSON Schema applies a `$ref` sibling's keywords alongside the referenced schema rather than
 * replacing them. Spread would let a sibling that adds one parameter drop the referenced ones, so
 * merge both `properties` maps, union `required`, and keep both constraints under `allOf` when a
 * property appears on both sides.
 */
function mergeRefSiblings(
  resolved: Record<string, unknown>,
  siblings: Record<string, unknown>,
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...resolved, ...siblings };

  const resolvedProperties = asSchemaMap(resolved.properties);
  const siblingProperties = asSchemaMap(siblings.properties);
  if (resolvedProperties || siblingProperties) {
    // Null prototype keeps a parameter named "__proto__" as data instead of replacing the prototype.
    const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const [name, schema] of Object.entries(resolvedProperties ?? {})) properties[name] = schema;
    for (const [name, schema] of Object.entries(siblingProperties ?? {})) {
      const existing = properties[name];
      properties[name] = existing === undefined ? schema : { allOf: [existing, schema] };
    }
    merged.properties = properties;
  }

  const required = new Set<string>();
  for (const source of [resolved.required, siblings.required]) {
    if (!Array.isArray(source)) continue;
    for (const item of source) if (typeof item === "string") required.add(item);
  }
  if (required.size > 0) merged.required = [...required];
  else delete merged.required;

  return merged;
}

/** Inline a local `#/...` reference so root-composition branches keep their definitions. */
function dereferenceLocal(
  node: unknown,
  root: Record<string, unknown>,
  seen: Set<string>,
): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref !== "string" || !ref.startsWith(LOCAL_REF_PREFIX) || seen.has(ref)) return record;
  const target = resolveLocalPointer(root, ref);
  if (!target) return record;
  const nextSeen = new Set(seen);
  nextSeen.add(ref);
  const resolved = dereferenceLocal(target, root, nextSeen) ?? target;
  const { $ref: _ignored, ...siblings } = record;
  return mergeRefSiblings(resolved, siblings);
}

export function normalizeAnthropicInputSchema(schema: unknown): Record<string, unknown> {
  const stripped = stripResponsesOnlyEncryptedMarker(schema);
  const obj = stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? stripped as Record<string, unknown>
    : {};
  const root = dereferenceLocal(obj, obj, new Set()) ?? obj;
  const compositionKeys = ["oneOf", "anyOf", "allOf"] as const;
  const hasRootComposition = compositionKeys.some(key => Array.isArray(root[key]));
  const type = root.type;
  const rootObjectType = type === "object" || (Array.isArray(type) && type.includes("object"));

  if (!hasRootComposition) {
    const normalized: Record<string, unknown> = rootObjectType && type === "object"
      ? { ...root }
      : { ...root, type: "object" };
    if (normalized.properties === undefined || normalized.properties === null) {
      normalized.properties = {};
    }
    return normalized;
  }

  // Null prototype keeps a parameter literally named "__proto__" as data instead of letting
  // Object.assign replace this object's prototype and drop the parameter from JSON output.
  const properties: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const required = new Set<string>();
  if (root.properties && typeof root.properties === "object" && !Array.isArray(root.properties)) {
    Object.assign(properties, root.properties as Record<string, unknown>);
  }
  if (Array.isArray(root.required)) {
    for (const item of root.required) if (typeof item === "string") required.add(item);
  }

  for (const key of compositionKeys) {
    const variants = root[key];
    if (!Array.isArray(variants)) continue;
    const mergeRequired = key === "allOf";
    for (const variant of variants) {
      const v = dereferenceLocal(variant, root, new Set());
      if (!v) continue;
      if (v.properties && typeof v.properties === "object" && !Array.isArray(v.properties)) {
        Object.assign(properties, v.properties as Record<string, unknown>);
      }
      if (mergeRequired && Array.isArray(v.required)) {
        for (const item of v.required) if (typeof item === "string") required.add(item);
      }
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(root)) {
    if (key === "oneOf" || key === "anyOf" || key === "allOf") continue;
    if (key === "type" || key === "properties" || key === "required") continue;
    normalized[key] = value;
  }
  normalized.type = "object";
  normalized.properties = properties;
  if (required.size > 0) normalized.required = [...required];
  return normalized;
}

