// Based on Anthropic SDK's transformJSONSchema, preserving root $defs required by root $ref:
// https://github.com/anthropics/anthropic-sdk-typescript/blob/main/src/lib/transform-json-schema.ts
const SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function take(schema: Record<string, unknown>, key: string): unknown {
  const value = schema[key];
  delete schema[key];
  return value;
}

function normalizeSubschema(value: unknown): unknown {
  return isRecord(value) ? normalizeSchema(value) : value;
}

function normalizeSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  const defs = take(schema, "$defs");
  if (isRecord(defs)) {
    normalized.$defs = Object.fromEntries(
      Object.entries(defs).map(([name, definition]) => [name, normalizeSubschema(definition)]),
    );
  }

  const ref = take(schema, "$ref");
  if (ref !== undefined) {
    normalized.$ref = ref;
    return normalized;
  }

  const type = take(schema, "type");
  const anyOf = schema.anyOf;
  const oneOf = schema.oneOf;
  const allOf = schema.allOf;

  if (Array.isArray(anyOf)) {
    take(schema, "anyOf");
    normalized.anyOf = anyOf.map(normalizeSubschema);
  } else if (Array.isArray(oneOf)) {
    take(schema, "oneOf");
    normalized.anyOf = oneOf.map(normalizeSubschema);
  } else if (Array.isArray(allOf)) {
    take(schema, "allOf");
    normalized.allOf = allOf.map(normalizeSubschema);
  } else {
    if (type === undefined) {
      throw new Error("JSON schema must have a type defined if anyOf/oneOf/allOf are not used");
    }
    normalized.type = type;
  }

  const description = take(schema, "description");
  if (description !== undefined) {
    normalized.description = description;
  }

  const title = take(schema, "title");
  if (title !== undefined) {
    normalized.title = title;
  }

  if (type === "object") {
    const properties = take(schema, "properties");
    normalized.properties = isRecord(properties)
      ? Object.fromEntries(
          Object.entries(properties).map(([name, property]) => [name, normalizeSubschema(property)]),
        )
      : {};
    take(schema, "additionalProperties");
    normalized.additionalProperties = false;

    const required = take(schema, "required");
    if (required !== undefined) {
      normalized.required = required;
    }
  } else if (type === "string") {
    const format = take(schema, "format");
    if (typeof format === "string" && SUPPORTED_STRING_FORMATS.has(format)) {
      normalized.format = format;
    } else if (format !== undefined) {
      schema.format = format;
    }
  } else if (type === "array") {
    const items = take(schema, "items");
    if (items !== undefined) {
      normalized.items = normalizeSubschema(items);
    }

    const minItems = take(schema, "minItems");
    if (minItems === 0 || minItems === 1) {
      normalized.minItems = minItems;
    } else if (minItems !== undefined) {
      schema.minItems = minItems;
    }
  }

  const unsupported = Object.entries(schema);
  if (unsupported.length > 0) {
    const existingDescription =
      typeof normalized.description === "string" ? `${normalized.description}\n\n` : "";
    normalized.description = `${existingDescription}{${unsupported
      .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
      .join(", ")}}`;
  }

  return normalized;
}

export function normalizeAnthropicOutputSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  return normalizeSchema(structuredClone(schema));
}

export function isAnthropicOutputSchema(schema: Record<string, unknown>): boolean {
  try {
    normalizeAnthropicOutputSchema(schema);
    return true;
  } catch {
    return false;
  }
}

// Anthropic accepts `uri`, but OpenAI strict Structured Outputs documents a narrower
// string-format set. Keep this separate from SUPPORTED_STRING_FORMATS: changing the Anthropic
// normalizer to satisfy the translated OpenAI route would silently remove native guidance.
const OPENAI_STRICT_STRING_FORMATS = new Set([
  "date-time", "time", "date", "duration", "email", "hostname", "ipv4", "ipv6", "uuid",
]);

const OPENAI_STRICT_COMMON_KEYWORDS = new Set([
  "$defs", "definitions", "$ref", "type", "title", "description", "enum", "const", "anyOf",
]);
const OPENAI_STRICT_OBJECT_KEYWORDS = new Set([
  "properties", "patternProperties", "required", "additionalProperties",
]);
const OPENAI_STRICT_STRING_KEYWORDS = new Set(["pattern", "format"]);
const OPENAI_STRICT_NUMBER_KEYWORDS = new Set([
  "multipleOf", "maximum", "exclusiveMaximum", "minimum", "exclusiveMinimum",
]);
const OPENAI_STRICT_ARRAY_KEYWORDS = new Set(["items", "minItems", "maxItems"]);
const OPENAI_STRICT_TYPES = new Set(["string", "number", "boolean", "integer", "object", "array", "null"]);
// Fine-tuned models implement a narrower documented Structured Outputs subset. Falling back to
// non-strict keeps the caller's schema intact; deleting these constraints would silently widen it.
const OPENAI_FINE_TUNED_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties", "pattern", "format",
  ...OPENAI_STRICT_NUMBER_KEYWORDS,
  "minItems", "maxItems",
]);

function openAiStrictSchemaTypes(value: unknown): Set<string> | null {
  if (value === undefined) return new Set();
  const values = typeof value === "string" ? [value] : value;
  if (!Array.isArray(values) || values.length === 0
    || values.some(type => typeof type !== "string" || !OPENAI_STRICT_TYPES.has(type))) return null;
  const types = new Set(values);
  if (types.size !== values.length) return null;
  // OpenAI documents unions through anyOf; the type-array shorthand is reserved for nullable fields.
  if (types.size > 1 && (types.size !== 2 || !types.has("null"))) return null;
  return types;
}

function hasOnlyOpenAiStrictKeywords(node: Record<string, unknown>, types: Set<string>): boolean {
  for (const key of Object.keys(node)) {
    if (OPENAI_STRICT_COMMON_KEYWORDS.has(key)) continue;
    if (types.has("object") && OPENAI_STRICT_OBJECT_KEYWORDS.has(key)) continue;
    if (types.has("string") && OPENAI_STRICT_STRING_KEYWORDS.has(key)) continue;
    if ((types.has("number") || types.has("integer")) && OPENAI_STRICT_NUMBER_KEYWORDS.has(key)) continue;
    if (types.has("array") && OPENAI_STRICT_ARRAY_KEYWORDS.has(key)) continue;
    return false;
  }
  return true;
}

/**
 * Can this schema preserve its object contract under OpenAI strict mode?
 *
 * OpenAI's structured-output strict mode demands exactly that, and rejects anything else with
 * `'required' is required to be supplied and to be an array including every key in properties`.
 * Anthropic has no such rule, so a caller's legal optional field makes an otherwise identical
 * schema a 400 on one vendor and fine on the other.
 *
 * A caller that marks a field optional means it. Rewriting `required` to satisfy strict mode
 * would silently change the contract the caller asked for, so the only honest answer is to stop
 * claiming strict for these schemas -- the schema is still sent and still honoured as guidance.
 */
export function satisfiesOpenAiStrictSchema(value: unknown, fineTuned = false): boolean {
  // Callers pass one schema node. Boolean/null/array schemas are outside the documented
  // Structured Outputs subset; schema lists such as anyOf are validated explicitly below.
  if (!isRecord(value)) return false;
  const node = value;
  // This is a compatibility proof, so it fails closed on unknown schema keywords instead of
  // maintaining an inevitably incomplete denylist. The original schema is still forwarded.
  const types = openAiStrictSchemaTypes(node.type);
  if (!types || !hasOnlyOpenAiStrictKeywords(node, types)) return false;
  if (fineTuned && Object.keys(node).some(key => OPENAI_FINE_TUNED_UNSUPPORTED_KEYWORDS.has(key))) {
    return false;
  }
  if (Object.hasOwn(node, "$ref") && typeof node.$ref !== "string") return false;
  if (Object.hasOwn(node, "title") && typeof node.title !== "string") return false;
  if (Object.hasOwn(node, "description") && typeof node.description !== "string") return false;
  if (Object.hasOwn(node, "enum") && (!Array.isArray(node.enum) || node.enum.length === 0)) return false;
  if (Object.hasOwn(node, "format")) {
    if (typeof node.format !== "string" || !OPENAI_STRICT_STRING_FORMATS.has(node.format)) {
      return false;
    }
  }
  if (Object.hasOwn(node, "pattern") && typeof node.pattern !== "string") return false;
  for (const key of OPENAI_STRICT_NUMBER_KEYWORDS) {
    const constraint = node[key];
    if (Object.hasOwn(node, key) && (typeof constraint !== "number" || !Number.isFinite(constraint))) return false;
  }
  // JSON Schema requires a strictly positive divisor; a zero or negative one is a schema the
  // destination rejects, so it cannot be certified strict.
  if (Object.hasOwn(node, "multipleOf") && (node.multipleOf as number) <= 0) return false;
  for (const key of ["minItems", "maxItems"]) {
    const constraint = node[key];
    if (Object.hasOwn(node, key)
      && (typeof constraint !== "number" || !Number.isInteger(constraint) || constraint < 0)) return false;
  }
  const properties = node.properties;
  const objectType = types.has("object");
  if (objectType || Object.hasOwn(node, "properties")) {
    // An object node must list every property in `required` AND close itself to extras. The
    // caller's schema is forwarded verbatim -- `isAnthropicOutputSchema` normalizes a CLONE for
    // its own acceptance check -- so an object that never said `additionalProperties: false`
    // reaches the wire without it and is refused, however complete its `required` is.
    // Anthropic's acceptance probe fills a missing/malformed property map on its clone;
    // that must not certify the unchanged bare object which actually reaches the wire.
    if (!isRecord(properties) || node.additionalProperties !== false) return false;
    // Strict mode also requires `required` to be supplied at all, even for an empty
    // `properties` map, so a missing array is not the same as an empty one.
    if (!Array.isArray(node.required)) return false;
    const keys = Object.keys(properties);
    const required: unknown[] = node.required;
    const requiredKeys = new Set(required);
    if (required.length !== keys.length || keys.some(key => !requiredKeys.has(key))) return false;
  }
  // Walk schema positions, not arbitrary JSON values: a property named `not` or an enum/const
  // value containing `properties` is data, not another schema node to certify or reject.
  for (const key of ["properties", "$defs", "definitions", "patternProperties"]) {
    if (!Object.hasOwn(node, key)) continue;
    const entries = node[key];
    if (!isRecord(entries)
      || !Object.values(entries).every(entry => satisfiesOpenAiStrictSchema(entry, fineTuned))) return false;
  }
  if (Object.hasOwn(node, "items") && !satisfiesOpenAiStrictSchema(node.items, fineTuned)) return false;
  if (Object.hasOwn(node, "anyOf")) {
    const anyOf = node.anyOf;
    if (!Array.isArray(anyOf) || anyOf.length === 0
      || !anyOf.every(entry => satisfiesOpenAiStrictSchema(entry, fineTuned))) {
      return false;
    }
  }
  return true;
}
