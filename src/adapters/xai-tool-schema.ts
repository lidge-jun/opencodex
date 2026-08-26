import type { OcxProviderConfig } from "../types";

function isSchemaObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isXaiSchemaTarget(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    // Public api.x.ai accepts native root object unions. Only the Grok CLI proxy
    // 400s on a root oneOf/anyOf, so flattening/omitting is scoped to that host.
    return new URL(provider.baseUrl).hostname === "cli-chat-proxy.grok.com";
  } catch {
    return false;
  }
}

function stringRequiredFields(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Variant keys the merger can keep. Anything else is refused, not silently dropped. */
const XAI_VARIANT_MERGE_KEYS = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "description",
  "title",
  "$comment",
  "$defs",
  "definitions",
]);

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

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

/** Resolve local `#/` `$ref`s. Unresolvable or cyclic refs return undefined. */
function resolveXaiSchemaRefs(
  schema: unknown,
  root: Record<string, unknown>,
  stack: Set<string> = new Set(),
): unknown | undefined {
  if (!isSchemaObject(schema)) return schema;
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (stack.has(ref)) return undefined;
    const target = lookupLocalJsonPointer(root, ref);
    if (target === undefined) return undefined;
    stack.add(ref);
    const resolvedTarget = resolveXaiSchemaRefs(target, root, stack);
    stack.delete(ref);
    if (resolvedTarget === undefined) return undefined;
    const rest: Record<string, unknown> = { ...schema };
    delete rest.$ref;
    if (Object.keys(rest).length === 0) return resolvedTarget;
    const resolvedRest = resolveXaiSchemaRefs(rest, root, stack);
    if (resolvedRest === undefined || !isSchemaObject(resolvedTarget) || !isSchemaObject(resolvedRest)) {
      return undefined;
    }
    return composeXaiObjectSchemas(resolvedTarget, resolvedRest);
  }

  const resolved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    if ((key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      const items: unknown[] = [];
      for (const item of value) {
        const next = resolveXaiSchemaRefs(item, root, stack);
        if (next === undefined) return undefined;
        items.push(next);
      }
      resolved[key] = items;
      continue;
    }
    if (key === "properties" && isSchemaObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value)) {
        const next = resolveXaiSchemaRefs(property, root, stack);
        if (next === undefined) return undefined;
        properties[name] = next;
      }
      resolved[key] = properties;
      continue;
    }
    resolved[key] = value;
  }
  return resolved;
}

function xaiVariantIsConcreteObject(variant: Record<string, unknown>): boolean {
  if (variant.type !== undefined && variant.type !== "object") return false;
  return Object.keys(variant).every(key => XAI_VARIANT_MERGE_KEYS.has(key));
}

function variantProperties(variant: Record<string, unknown>): Record<string, unknown> {
  return isSchemaObject(variant.properties) ? variant.properties : {};
}

/**
 * Independent per-property anyOf is lossless only when every property name exists
 * on every variant (absence is meaningful under xAI's default additionalProperties:
 * false, and promoting a branch-local key also tightens explicit-true variants)
 * and at most one property schema differs.
 */
function xaiPropertyMergeIsLossless(variants: Record<string, unknown>[]): boolean {
  const names = new Set<string>();
  const props = variants.map(variant => {
    const properties = variantProperties(variant);
    for (const name of Object.keys(properties)) names.add(name);
    return properties;
  });
  let schemaConflicts = 0;
  for (const name of names) {
    const values = props.map(property => property[name]);
    if (values.some(value => value === undefined)) return false;
    if (values.some(value => JSON.stringify(value) !== JSON.stringify(values[0]))) schemaConflicts += 1;
  }
  return schemaConflicts <= 1;
}

function xaiRequiredSetsMatch(variants: Record<string, unknown>[]): boolean {
  const serialized = variants.map(variant => [...stringRequiredFields(variant.required)].sort().join("\0"));
  return serialized.every(value => value === serialized[0]);
}

function mergeXaiAdditionalProperties(
  variants: Record<string, unknown>[],
): { ok: true; value?: unknown } | { ok: false } {
  const values = variants.map(variant => variant.additionalProperties);
  const explicit = values.filter(value => value !== undefined);
  if (explicit.length === 0) return { ok: true };
  if (explicit.length !== values.length) return { ok: false };
  const hasFalse = explicit.some(value => value === false);
  const permissive = explicit.filter(value => value !== false);
  if (hasFalse && permissive.length > 0) return { ok: false };
  if (hasFalse) return { ok: true, value: false };
  const unique: unknown[] = [];
  const seen = new Set<string>();
  for (const value of permissive) {
    const key = JSON.stringify(value);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(value);
  }
  if (unique.length !== 1) return { ok: false };
  return { ok: true, value: unique[0] };
}

/** Compose root siblings into a branch so properties/required are not overwritten. */
function composeXaiObjectSchemas(
  inherited: Record<string, unknown>,
  branch: Record<string, unknown>,
): Record<string, unknown> {
  const composed: Record<string, unknown> = { ...inherited, ...branch };
  const inheritedProps = isSchemaObject(inherited.properties) ? inherited.properties : undefined;
  const branchProps = isSchemaObject(branch.properties) ? branch.properties : undefined;
  if (inheritedProps || branchProps) {
    const properties: Record<string, unknown> = { ...(inheritedProps ?? {}) };
    for (const [name, value] of Object.entries(branchProps ?? {})) {
      const inheritedValue = inheritedProps?.[name];
      properties[name] = inheritedValue !== undefined && JSON.stringify(inheritedValue) !== JSON.stringify(value)
        ? { allOf: [inheritedValue, value] }
        : value;
    }
    composed.properties = properties;
  }
  const required = [...new Set([
    ...stringRequiredFields(inherited.required),
    ...stringRequiredFields(branch.required),
  ])];
  if (required.length > 0) composed.required = required;
  else delete composed.required;
  return composed;
}

function expandXaiRootObjectSchemas(schema: unknown): Record<string, unknown>[] | undefined {
  if (!isSchemaObject(schema)) return undefined;
  const compositionKey = ["oneOf", "anyOf"].find(key => Array.isArray(schema[key]));
  if (!compositionKey) {
    if (schema.type !== undefined && schema.type !== "object") return undefined;
    return [{ ...schema, type: "object" }];
  }

  const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== compositionKey));
  const branches = schema[compositionKey];
  if (!Array.isArray(branches)) return undefined;
  const expanded: Record<string, unknown>[] = [];
  for (const branch of branches) {
    const variants = expandXaiRootObjectSchemas(branch);
    if (!variants) return undefined;
    for (const variant of variants) expanded.push(composeXaiObjectSchemas(siblings, variant));
  }
  return expanded.length > 0 ? expanded : undefined;
}

function mergeXaiPropertySchemas(values: unknown[]): unknown {
  const unique: unknown[] = [];
  const serialized = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (serialized.has(key)) continue;
    serialized.add(key);
    unique.push(value);
  }
  return unique.length === 1 ? unique[0] : { anyOf: unique };
}

/**
 * The Grok CLI proxy rejects a function parameter schema whose root remains oneOf/anyOf.
 * Flatten only when the merge is lossless: local $refs resolve, every variant is a concrete
 * object whose keys we can preserve, required sets match, additionalProperties does not change
 * meaning, every property name exists on every variant, and at most one property schema
 * differs. Otherwise omit the tool rather than emit a weaker schema.
 */
export function normalizeXaiToolParameters(parameters: unknown): Record<string, unknown> | undefined {
  if (!isSchemaObject(parameters)) return undefined;
  const resolved = resolveXaiSchemaRefs(parameters, parameters);
  if (!isSchemaObject(resolved)) return undefined;

  const normalizedRoot = { ...resolved };
  delete normalizedRoot.$schema;

  const variants = expandXaiRootObjectSchemas(normalizedRoot);
  if (!variants) return undefined;
  if (variants.length === 1) {
    return xaiVariantIsConcreteObject(variants[0]) ? variants[0] : undefined;
  }
  if (!variants.every(xaiVariantIsConcreteObject) || !xaiRequiredSetsMatch(variants)) return undefined;
  const additionalProperties = mergeXaiAdditionalProperties(variants);
  if (!additionalProperties.ok) return undefined;
  if (!xaiPropertyMergeIsLossless(variants)) return undefined;

  const metadata = Object.fromEntries(Object.entries(normalizedRoot).filter(([key]) => key !== "oneOf" && key !== "anyOf" && key !== "type"));
  delete metadata.properties;
  delete metadata.required;
  delete metadata.additionalProperties;

  const propertyValues = new Map<string, unknown[]>();
  for (const variant of variants) {
    if (!isSchemaObject(variant.properties)) continue;
    for (const [name, value] of Object.entries(variant.properties)) {
      const values = propertyValues.get(name) ?? [];
      values.push(value);
      propertyValues.set(name, values);
    }
  }

  const properties = Object.fromEntries(
    [...propertyValues].map(([name, values]) => [name, mergeXaiPropertySchemas(values)]),
  );
  const required = stringRequiredFields(variants[0]?.required);

  return {
    ...metadata,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...("value" in additionalProperties ? { additionalProperties: additionalProperties.value } : {}),
  };
}
