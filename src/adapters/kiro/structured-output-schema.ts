/**
 * Full validation for strict structured output (`strict: true`) on Kiro.
 *
 * A strict caller is promised a value that conforms to the whole schema, which the light root
 * checks in structured-output.ts cannot keep: `{"title":42,"extra":true}` passes a root `type` and
 * `required` check against a schema that wants a string title and forbids extra keys. Kiro's wire
 * cannot constrain decoding, so the emulation enforces the contract afterwards instead.
 *
 * The validated vocabulary is the OpenAI strict subset (type and type arrays, properties,
 * required, additionalProperties, enum, const, items, anyOf, local $ref with $defs/definitions)
 * plus the string, number and array bounds that are as cheap to check. A strict schema that uses
 * any other assertion (format, oneOf, allOf, not, tuple items, remote references, ...) is refused
 * before a request is sent, because relaying a value the proxy could not check would break the
 * promise strict mode makes. Annotations carry no assertion and are ignored.
 */

type JsonRecord = Record<string, unknown>;

const KNOWN_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const VALIDATED = new Set([
  "type", "properties", "required", "additionalProperties", "enum", "const", "items", "anyOf",
  "$ref", "$defs", "definitions", "minLength", "maxLength", "pattern", "minimum", "maximum",
  "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
]);
const ANNOTATIONS = new Set([
  "title", "description", "default", "examples", "$schema", "$id", "$comment", "deprecated", "readOnly", "writeOnly",
]);
const NUMERIC_ARGS = new Set([
  "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems",
]);
/** Ref-free recursion without consuming any of the value is a schema cycle such as `{"$ref":"#"}`. */
const MAX_DEPTH = 512;

/** A plain JSON object: not null and not an array. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Resolve a local JSON Pointer reference (`#`, `#/$defs/x`, ...) against `root`. */
function resolveRef(root: JsonRecord, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    const token = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(node) && /^\d+$/.test(token)) node = node[Number(token)];
    else if (isRecord(node) && Object.hasOwn(node, token)) node = node[token];
    else return undefined;
  }
  return node;
}

/** The first keyword in `schema` the strict validator cannot enforce, or undefined when every one is covered. */
function unsupportedKeyword(root: JsonRecord, schema: unknown): string | undefined {
  if (typeof schema === "boolean") return undefined;
  if (!isRecord(schema)) return "schema";
  for (const [key, arg] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!VALIDATED.has(key)) return key;
    if (NUMERIC_ARGS.has(key) && typeof arg !== "number") return key;
    if (key === "pattern" && typeof arg !== "string") return key;
    if (key === "type") {
      const types = Array.isArray(arg) ? arg : [arg];
      if (types.length === 0 || !types.every(t => typeof t === "string" && KNOWN_TYPES.has(t))) return key;
    }
    if (key === "required" && !(Array.isArray(arg) && arg.every(k => typeof k === "string"))) return key;
    if (key === "enum" && !Array.isArray(arg)) return key;
    if (key === "$ref" && (typeof arg !== "string" || resolveRef(root, arg) === undefined)) return key;
    if (key === "anyOf") {
      if (!Array.isArray(arg) || arg.length === 0) return key;
      for (const branch of arg) {
        const inner = unsupportedKeyword(root, branch);
        if (inner) return inner;
      }
    }
    if (key === "items" || key === "additionalProperties") {
      if (key === "items" && Array.isArray(arg)) return key;
      const inner = unsupportedKeyword(root, arg);
      if (inner) return inner;
    }
    if (key === "properties" || key === "$defs" || key === "definitions") {
      if (!isRecord(arg)) return key;
      for (const child of Object.values(arg)) {
        const inner = unsupportedKeyword(root, child);
        if (inner) return inner;
      }
    }
  }
  return undefined;
}

/** Throw the structured-output refusal when a strict schema needs a check this emulation does not have. */
export function assertKiroStrictSchemaSupported(schema: JsonRecord): void {
  const keyword = unsupportedKeyword(schema, schema);
  if (keyword !== undefined) {
    throw new Error(`Kiro does not support Responses structured output: strict schema keyword ${JSON.stringify(keyword)} cannot be enforced`);
  }
}

/** Whether a parsed JSON value has the given JSON Schema type. */
function hasType(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

/** Structural equality of two parsed JSON values, as `const` and `enum` compare them. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => jsonEqual(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && jsonEqual(a[key], b[key]));
}

/** `path` extended by an object key, dotted when the key is an identifier. */
function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/** The first way `value` breaks `schema`, as "path: reason", or undefined when it conforms. */
function problemAt(root: JsonRecord, schema: unknown, value: unknown, path: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return `${path}: the schema recurses without consuming the value`;
  if (schema === false) return `${path}: no value is allowed here`;
  if (!isRecord(schema)) return undefined;
  if (typeof schema.$ref === "string") {
    const problem = problemAt(root, resolveRef(root, schema.$ref), value, path, depth + 1);
    if (problem) return problem;
  }
  if (schema.type !== undefined) {
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type]) as string[];
    if (!types.some(type => hasType(value, type))) return `${path}: expected a JSON ${types.join(" or ")}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(option => jsonEqual(option, value))) {
    return `${path}: expected one of the enum values`;
  }
  if (Object.hasOwn(schema, "const") && !jsonEqual(schema.const, value)) return `${path}: expected the const value`;
  if (Array.isArray(schema.anyOf)
    && !schema.anyOf.some(branch => problemAt(root, branch, value, path, depth + 1) === undefined)) {
    return `${path}: matched no anyOf branch`;
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return `${path}: shorter than minLength`;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return `${path}: longer than maxLength`;
    if (typeof schema.pattern === "string" && !new RegExp(schema.pattern, "u").test(value)) return `${path}: does not match pattern`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) return `${path}: below minimum`;
    if (typeof schema.maximum === "number" && value > schema.maximum) return `${path}: above maximum`;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return `${path}: not above exclusiveMinimum`;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return `${path}: not below exclusiveMaximum`;
    if (typeof schema.multipleOf === "number" && !Number.isInteger(value / schema.multipleOf)) return `${path}: not a multiple of multipleOf`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return `${path}: fewer than minItems`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path}: more than maxItems`;
    if (schema.items !== undefined) {
      for (const [index, item] of value.entries()) {
        const problem = problemAt(root, schema.items, item, `${path}[${index}]`, 0);
        if (problem) return problem;
      }
    }
  }
  if (isRecord(value)) {
    const missing = Array.isArray(schema.required)
      ? schema.required.find(key => typeof key === "string" && !Object.hasOwn(value, key))
      : undefined;
    if (missing !== undefined) return `${path}: missing required property ${JSON.stringify(missing)}`;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(value)) {
      const declared = Object.hasOwn(properties, key);
      if (!declared && schema.additionalProperties === false) return `${path}: unexpected property ${JSON.stringify(key)}`;
      const childSchema = declared ? properties[key] : schema.additionalProperties;
      const problem = problemAt(root, childSchema, child, childPath(path, key), 0);
      if (problem) return problem;
    }
  }
  return undefined;
}

/** The first way `value` breaks the strict `schema`, or undefined when it conforms. */
export function kiroStrictSchemaProblem(schema: JsonRecord, value: unknown): string | undefined {
  return problemAt(schema, schema, value, "$", 0);
}

/** Keys whose values are JSON data, never schemas, so a `$ref`-named key inside them is left alone. */
const LITERAL_KEYS = new Set(["const", "enum", "default", "examples"]);
/** Keys whose values map names to schemas; a name such as "const" is not a keyword there. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);

/**
 * Point every local `$ref` at the original root after the schema moves under `properties.value`.
 *
 * `#` and root-relative pointers such as `#/items` now resolve against the wrapper, so they gain
 * the `/properties/value` prefix. `#/$defs/...` and `#/definitions/...` keep their target because
 * the wrapper hoists the definitions to its own root.
 */
export function rewriteKiroWrappedRefs(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(rewriteKiroWrappedRefs);
  if (!isRecord(schema)) return schema;
  const out: JsonRecord = {};
  for (const [key, child] of Object.entries(schema)) {
    if (SCHEMA_MAPS.has(key) && isRecord(child)) {
      out[key] = Object.fromEntries(Object.entries(child).map(([name, sub]) => [name, rewriteKiroWrappedRefs(sub)]));
    } else if (LITERAL_KEYS.has(key)) out[key] = child;
    else if (key === "$ref" && typeof child === "string") out[key] = movedRef(child);
    else out[key] = rewriteKiroWrappedRefs(child);
  }
  return out;
}

/** One reference rewritten for the wrapped document. */
function movedRef(ref: string): string {
  if (ref !== "#" && !ref.startsWith("#/")) return ref;
  if (ref.startsWith("#/$defs/") || ref.startsWith("#/definitions/")) return ref;
  return `#/properties/value${ref.slice(1)}`;
}
