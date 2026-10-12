import type { OcxProviderConfig } from "../../types";

export function isDeepseekArtifactTarget(provider: OcxProviderConfig, name: string, namespace?: string): boolean {
  if (name !== "Artifact" || namespace) return false;
  try {
    return new URL(provider.baseUrl).hostname === "api.deepseek.com";
  } catch {
    return false;
  }
}

const NAME_BAGS = new Set(["properties", "$defs", "definitions", "patternProperties", "dependentSchemas"]);
const SCHEMA_CHILDREN = new Set(["items", "additionalProperties", "additionalItems", "allOf", "oneOf", "not", "if", "then", "else", "contains", "propertyNames", "prefixItems", "unevaluatedItems", "unevaluatedProperties"]);

/** DeepSeek rejects Artifact regex/union constraints. Relax them only on this built-in tool.
 * Walk schema positions, preserving property names and literal defaults/examples verbatim.
 * An explicit stack avoids recursion on caller-controlled schema nesting.
 */
export function relaxDeepseekArtifactSchema(schema: unknown): unknown {
  let result: unknown;
  const pending: Array<{ value: unknown; names?: boolean; assign: (value: unknown) => void }> = [
    { value: schema, assign: value => { result = value; } },
  ];
  while (pending.length) {
    const { value, names, assign } = pending.pop()!;
    if (!value || typeof value !== "object") { assign(value); continue; }
    if (Array.isArray(value)) {
      const out: unknown[] = new Array(value.length);
      assign(out);
      value.forEach((child, index) => pending.push({ value: child, assign: next => { out[index] = next; } }));
      continue;
    }
    const out: Record<string, unknown> = Object.create(null);
    assign(out);
    for (const [key, child] of Object.entries(value)) {
      if (!names && (key === "pattern" || key === "anyOf")) continue;
      if (names || NAME_BAGS.has(key) || SCHEMA_CHILDREN.has(key)) {
        pending.push({ value: child, names: !names && NAME_BAGS.has(key), assign: next => { out[key] = next; } });
      } else {
        out[key] = child;
      }
    }
  }
  return result;
}
