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

/**
 * Does every object in this schema list ALL of its properties as required?
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
export function satisfiesOpenAiStrictSchema(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(satisfiesOpenAiStrictSchema);
  if (!value || typeof value !== "object") return true;
  const node = value as Record<string, unknown>;
  // `allOf` is not supported under strict Structured Outputs at all, wherever it appears.
  if ("allOf" in node) return false;
  const properties = node.properties;
  if (isRecord(properties)) {
    // An object node must list every property in `required` AND close itself to extras. The
    // caller's schema is forwarded verbatim -- `isAnthropicOutputSchema` normalizes a CLONE for
    // its own acceptance check -- so an object that never said `additionalProperties: false`
    // reaches the wire without it and is refused, however complete its `required` is.
    if (node.additionalProperties !== false) return false;
    // Strict mode also requires `required` to be supplied at all, even for an empty
    // `properties` map, so a missing array is not the same as an empty one.
    if (!Array.isArray(node.required)) return false;
    const keys = Object.keys(properties);
    const required: unknown[] = node.required;
    if (keys.some(key => !required.includes(key))) return false;
  }
  return Object.values(node).every(satisfiesOpenAiStrictSchema);
}
