const schemaMaps = new Set(["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]);
const schemaLists = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
const schemaValues = new Set(["items", "additionalProperties", "unevaluatedProperties", "contains", "not", "if", "then", "else", "propertyNames"]);
const jsonTypes = new Set(["string", "number", "integer", "boolean", "object", "array", "null"]);

/** Normalize schemas only; defaults, examples and property names are data, never schemas. */
export function workBuddySchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 64) throw new Error("WorkBuddy AI tool schema exceeds maximum depth");
  if (value === false) return { not: {} };
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>, out = { ...input };
  for (const [key, child] of Object.entries(input)) {
    if (schemaMaps.has(key) && child && typeof child === "object" && !Array.isArray(child)) {
      out[key] = Object.fromEntries(Object.entries(child).map(([name, schema]) => [name, workBuddySchema(schema, depth + 1)]));
    } else if (schemaLists.has(key) && Array.isArray(child)) {
      out[key] = child.map(schema => workBuddySchema(schema, depth + 1));
    } else if (schemaValues.has(key)) {
      if ((key === "additionalProperties" || key === "unevaluatedProperties") && typeof child === "boolean") continue;
      out[key] = key === "items" && Array.isArray(child)
        ? { anyOf: child.map(schema => workBuddySchema(schema, depth + 1)) } : workBuddySchema(child, depth + 1);
    }
  }
  if (typeof out.pattern === "string") out.pattern = out.pattern.replace(/\\\\|\\0(?![0-9])/g, match => match === "\\0" ? "\\u0000" : match);
  if (out.required !== undefined && !Array.isArray(out.required)) delete out.required;
  if (typeof out.type === "string") {
    out.type = out.type.toLowerCase();
    if (!jsonTypes.has(out.type as string)) delete out.type;
  }
  if (Array.isArray(out.enum)) {
    if (!out.enum.length) delete out.enum;
    else if (out.type === undefined) {
      const groups = new Map<string, unknown[]>();
      for (const item of out.enum) {
        const type = item === null ? "null" : Array.isArray(item) ? "array" : typeof item;
        const values = groups.get(type) ?? []; values.push(item); groups.set(type, values);
      }
      if (groups.size === 1) out.type = groups.keys().next().value;
      else {
        const union = { anyOf: [...groups].map(([type, values]) => ({ type, enum: values })) };
        out.allOf = [...(Array.isArray(out.allOf) ? out.allOf : []), union];
        delete out.enum;
      }
    }
  }
  return out;
}

export function workBuddyToolParameters(value: unknown): Record<string, unknown> {
  const out = workBuddySchema(value);
  const properties: Record<string, unknown> = { ...(out.properties as Record<string, unknown> ?? {}) };
  const required = new Set(Array.isArray(out.required) ? out.required.filter(x => typeof x === "string") : []);
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    for (const variant of Array.isArray(out[key]) ? out[key] : []) {
      const row = variant as Record<string, unknown>;
      Object.assign(properties, row.properties);
      if (key === "allOf" && Array.isArray(row.required)) for (const field of row.required) if (typeof field === "string") required.add(field);
    }
    delete out[key];
  }
  return { ...out, type: "object", properties, ...(required.size ? { required: [...required] } : {}) };
}
