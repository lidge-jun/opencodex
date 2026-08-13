type Schema = Record<string, unknown>;

// Google documents this function-schema subset: type, nullable, required, format, description,
// properties, items, enum, anyOf, $ref, and $defs. We inline local refs and normalize anyOf, so
// only the eight scalar/container keywords below are ever emitted. Building from an allowlist
// prevents new MCP/JSON-Schema annotations from turning into provider-wide 400 responses.
const ALLOWED_TYPES = new Set(["string", "integer", "number", "boolean", "array", "object"]);
const MAX_SCHEMA_DEPTH = 24; // Google's documented nesting limit is 32; leave headroom for CCA.
const MAX_DEREF_DEPTH = 16;
const MAX_SCHEMA_NODES = 1_024;
const BUDGET_EXHAUSTED = Symbol("schema-budget-exhausted");
const MERGED_SCHEMA_KEYS = [
  "type",
  "nullable",
  "description",
  "format",
  "enum",
  "const",
  "properties",
  "items",
  "required",
  "anyOf",
] as const;

type SanitizeResult = Schema | typeof BUDGET_EXHAUSTED;

interface SanitizeState {
  activeRefs: Set<string>;
  remainingNodes: number;
}

function isRecord(value: unknown): value is Schema {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function resolveRef(ref: string, defs: Map<string, unknown>): unknown {
  // Only local pointers into the schema's own $defs/definitions are safe to inline.
  const match = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(ref);
  if (!match) return undefined;
  try {
    return defs.get(decodeURIComponent(match[1].replace(/~1/g, "/").replace(/~0/g, "~")));
  } catch {
    return undefined;
  }
}

function collectDefs(root: unknown, defs: Map<string, unknown>): void {
  if (!isRecord(root)) return;
  for (const bag of ["$defs", "definitions"] as const) {
    const group = root[bag];
    if (!isRecord(group)) continue;
    for (const [name, value] of Object.entries(group)) {
      if (!defs.has(name)) defs.set(name, value);
    }
  }
}

function mergeRefTarget(target: Schema, overlay: Schema): Schema {
  const merged: Schema = {};
  if (Object.hasOwn(target, "$ref")) merged.$ref = target.$ref;
  for (const key of MERGED_SCHEMA_KEYS) {
    if (Object.hasOwn(overlay, key)) merged[key] = overlay[key];
    else if (Object.hasOwn(target, key)) merged[key] = target[key];
  }
  return merged;
}

function normalizeType(value: unknown, out: Schema, preserveNullType: boolean): void {
  const candidates = Array.isArray(value) ? value : [value];
  let sawNull = false;

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const type = candidate.toLowerCase();
    if (type === "null") {
      sawNull = true;
    } else if (out.type === undefined && ALLOWED_TYPES.has(type)) {
      out.type = type;
    }
  }

  if (!sawNull) return;
  if (out.type !== undefined) out.nullable = true;
  else if (preserveNullType) out.type = "null";
  else out.nullable = true;
}

function sanitizeEnum(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const values = [...new Set(value.filter((item): item is string => typeof item === "string"))];
  return values.length > 0 ? values : undefined;
}

function normalizeAnyOf(
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  state: SanitizeState,
): Schema {
  if (!Array.isArray(value) || value.length === 0) return {};
  const schemas: Schema[] = [];
  for (let index = 0; index < value.length; index++) {
    if (state.remainingNodes <= 0) return {};
    const schema = sanitizeSchema(value[index], defs, depth + 1, refDepth, true, state);
    if (schema === BUDGET_EXHAUSTED) return {};
    schemas.push(schema);
  }

  const nonNullSchemas = schemas.filter(schema => schema.type !== "null");
  const nullSchemas = schemas.filter(schema => schema.type === "null");
  if (
    nonNullSchemas.length === 1
    && nullSchemas.length > 0
    && nullSchemas.every(schema => Object.keys(schema).every(key => key === "type"))
  ) {
    return { ...nonNullSchemas[0], nullable: true };
  }

  const type = schemas[0]?.type;
  const sameType = schemas.length > 0 && schemas.every(schema => schema.type === type);
  const enumOnly = schemas.every(schema => {
    const allowedKeys = type === undefined ? new Set(["enum"]) : new Set(["type", "enum"]);
    return Array.isArray(schema.enum) && Object.keys(schema).every(key => allowedKeys.has(key));
  });
  if (sameType && enumOnly && type !== "null") {
    const values = sanitizeEnum(schemas.flatMap(schema => schema.enum as unknown[]));
    if (values) return { ...(typeof type === "string" ? { type } : {}), enum: values };
  }

  // CCA's Claude bridge turns typed anyOf branches into an invalid input_schema. Widen only this
  // node when a union cannot be collapsed losslessly; parent annotations and structure survive.
  return {};
}

function sanitizeProperties(
  value: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  state: SanitizeState,
): Record<string, Schema> | undefined {
  if (!isRecord(value)) return undefined;
  const properties: Record<string, Schema> = Object.create(null) as Record<string, Schema>;
  for (const name in value) {
    if (!Object.hasOwn(value, name)) continue;
    if (state.remainingNodes <= 0) break;
    // Property names form a name bag and must never be interpreted as schema keywords.
    const schema = sanitizeSchema(value[name], defs, depth + 1, refDepth, false, state);
    if (schema === BUDGET_EXHAUSTED) break;
    properties[name] = schema;
  }
  return properties;
}

function sanitizeSchema(
  node: unknown,
  defs: Map<string, unknown>,
  depth: number,
  refDepth: number,
  preserveNullType: boolean,
  state: SanitizeState,
): SanitizeResult {
  if (state.remainingNodes <= 0) return BUDGET_EXHAUSTED;
  state.remainingNodes -= 1;
  if (depth >= MAX_SCHEMA_DEPTH || !isRecord(node)) return {};

  if (typeof node.$ref === "string" && refDepth < MAX_DEREF_DEPTH) {
    const target = resolveRef(node.$ref, defs);
    if (isRecord(target)) {
      if (state.activeRefs.has(node.$ref)) return {};
      state.activeRefs.add(node.$ref);
      // Select only inputs the sanitizer can consume. Spreading an untrusted definition here would
      // enumerate and allocate every unsupported annotation before the node budget can stop work.
      const merged = mergeRefTarget(target, node);
      try {
        return sanitizeSchema(merged, defs, depth, refDepth + 1, preserveNullType, state);
      } finally {
        state.activeRefs.delete(node.$ref);
      }
    }
  }

  const out: Schema = {};
  normalizeType(node.type, out, preserveNullType);

  if (typeof node.nullable === "boolean") out.nullable = node.nullable;
  if (typeof node.description === "string") out.description = node.description;
  if (typeof node.format === "string") out.format = node.format;

  const enumValues = sanitizeEnum(node.enum ?? (typeof node.const === "string" ? [node.const] : undefined));
  if (enumValues) out.enum = enumValues;

  const properties = sanitizeProperties(node.properties, defs, depth, refDepth, state);
  if (properties) out.properties = properties;

  if (properties && Array.isArray(node.required)) {
    const required = [...new Set(node.required.filter((item): item is string => (
      typeof item === "string" && Object.hasOwn(properties, item)
    )))];
    if (required.length > 0) out.required = required;
  }

  if (state.remainingNodes <= 0) return out;

  if (isRecord(node.items)) {
    const items = sanitizeSchema(node.items, defs, depth + 1, refDepth, false, state);
    if (items !== BUDGET_EXHAUSTED) out.items = items;
  }

  if (state.remainingNodes <= 0) return out;
  if (node.anyOf !== undefined) {
    Object.assign(out, normalizeAnyOf(node.anyOf, defs, depth, refDepth, state));
  }
  return out;
}

export function sanitizeGeminiToolParameters(parameters: unknown): Record<string, unknown> {
  try {
    const defs = new Map<string, unknown>();
    collectDefs(parameters, defs);
    const state: SanitizeState = {
      activeRefs: new Set(),
      remainingNodes: MAX_SCHEMA_NODES,
    };
    const sanitized = sanitizeSchema(parameters, defs, 0, 0, false, state);
    const root = sanitized === BUDGET_EXHAUSTED ? {} : sanitized;

    // Function arguments are always an object. Claude additionally rejects root composition and a
    // missing root type even when those forms are valid general-purpose JSON Schema.
    root.type = "object";
    if (!isRecord(root.properties)) root.properties = {};
    return root;
  } catch {
    // Last-resort containment: no third-party schema may break every tool in the request.
    return { type: "object", properties: {} };
  }
}
