/** Conservative JSON Schema subset for text that would become a client-executable tool call. */
const ANNOTATIONS = new Set(["$schema", "$id", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly"]);
const CONSTRAINTS = new Set([
  "type", "enum", "const", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf",
  "minLength", "maxLength", "minItems", "maxItems", "uniqueItems", "items",
  "minProperties", "maxProperties", "properties", "required", "additionalProperties",
  "anyOf", "oneOf", "allOf",
]);

function same(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key =>
    Object.hasOwn(right, key) && same((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    case "object": return value !== null && typeof value === "object" && !Array.isArray(value);
    case "array": return Array.isArray(value);
    default: return false;
  }
}

function validBound(value: unknown, bound: unknown, compare: (actual: number, limit: number) => boolean): boolean {
  return bound === undefined || (typeof bound === "number" && typeof value === "number" && compare(value, bound));
}

function supportedSchema(schema: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (typeof schema === "boolean") return true;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const rule = schema as Record<string, unknown>;
  if (Object.keys(rule).some(key => !ANNOTATIONS.has(key) && !CONSTRAINTS.has(key))) return false;
  if (rule.properties !== undefined) {
    if (!rule.properties || typeof rule.properties !== "object" || Array.isArray(rule.properties)) return false;
    if (!Object.values(rule.properties).every(child => supportedSchema(child, depth + 1))) return false;
  }
  for (const keyword of ["items", "additionalProperties"] as const) {
    if (rule[keyword] !== undefined && !supportedSchema(rule[keyword], depth + 1)) return false;
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    if (rule[keyword] !== undefined && (!Array.isArray(rule[keyword]) ||
        rule[keyword].length === 0 || !rule[keyword].every(child => supportedSchema(child, depth + 1)))) return false;
  }
  return true;
}

/** Unknown assertion keywords, malformed schemas and deep recursion fail closed. */
export function validatesRestoredValue(value: unknown, schema: unknown): boolean {
  return supportedSchema(schema, 0) && validateNode(value, schema, 0);
}

function validateNode(value: unknown, schema: unknown, depth: number): boolean {
  if (depth > 16) return false;
  if (typeof schema === "boolean") return schema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return false;
  const rule = schema as Record<string, unknown>;
  if (rule.type !== undefined) {
    const types = typeof rule.type === "string" ? [rule.type] : rule.type;
    if (!Array.isArray(types) || types.length === 0 || !types.every(type => typeof type === "string") ||
        !types.some(type => matchesType(value, type))) return false;
  }
  if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.some(option => same(value, option)))) return false;
  if (Object.hasOwn(rule, "const") && !same(value, rule.const)) return false;
  for (const [keyword, compare] of [
    ["minimum", (a: number, b: number) => a >= b],
    ["maximum", (a: number, b: number) => a <= b],
    ["exclusiveMinimum", (a: number, b: number) => a > b],
    ["exclusiveMaximum", (a: number, b: number) => a < b],
  ] as const) if (!validBound(value, rule[keyword], compare)) return false;
  if (rule.multipleOf !== undefined &&
      (typeof value !== "number" || typeof rule.multipleOf !== "number" || rule.multipleOf <= 0 ||
       !Number.isInteger(value / rule.multipleOf))) return false;
  if (rule.minLength !== undefined && !validBound(typeof value === "string" ? [...value].length : undefined, rule.minLength, (a, b) => a >= b)) return false;
  if (rule.maxLength !== undefined && !validBound(typeof value === "string" ? [...value].length : undefined, rule.maxLength, (a, b) => a <= b)) return false;
  if (rule.minItems !== undefined && !validBound(Array.isArray(value) ? value.length : undefined, rule.minItems, (a, b) => a >= b)) return false;
  if (rule.maxItems !== undefined && !validBound(Array.isArray(value) ? value.length : undefined, rule.maxItems, (a, b) => a <= b)) return false;
  if (rule.uniqueItems !== undefined) {
    if (typeof rule.uniqueItems !== "boolean" || !Array.isArray(value)) return false;
    if (rule.uniqueItems && value.some((item, index) => value.slice(index + 1).some(other => same(item, other)))) return false;
  }
  if (rule.items !== undefined && (!Array.isArray(value) || !value.every(item => validateNode(item, rule.items, depth + 1)))) return false;
  const object = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  if (rule.minProperties !== undefined && !validBound(object ? Object.keys(object).length : undefined, rule.minProperties, (a, b) => a >= b)) return false;
  if (rule.maxProperties !== undefined && !validBound(object ? Object.keys(object).length : undefined, rule.maxProperties, (a, b) => a <= b)) return false;
  if (rule.required !== undefined && (!object || !Array.isArray(rule.required) ||
      !rule.required.every(key => typeof key === "string" && Object.hasOwn(object, key)))) return false;
  if (rule.properties !== undefined && (!object || !rule.properties || typeof rule.properties !== "object" || Array.isArray(rule.properties))) return false;
  const properties = rule.properties as Record<string, unknown> | undefined;
  if (object) for (const [key, item] of Object.entries(object)) {
    if (properties && Object.hasOwn(properties, key)) {
      if (!validateNode(item, properties[key], depth + 1)) return false;
    } else if (rule.additionalProperties !== undefined && !validateNode(item, rule.additionalProperties, depth + 1)) return false;
  }
  if (rule.additionalProperties !== undefined && !object) return false;
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = rule[keyword];
    if (branches === undefined) continue;
    if (!Array.isArray(branches) || branches.length === 0) return false;
    const matches = branches.filter(branch => validateNode(value, branch, depth + 1)).length;
    if (keyword === "anyOf" && matches < 1 || keyword === "oneOf" && matches !== 1 || keyword === "allOf" && matches !== branches.length) return false;
  }
  return true;
}
