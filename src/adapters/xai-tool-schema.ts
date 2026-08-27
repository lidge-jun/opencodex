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

/** A tool this proxy had to omit is still named by `tool_choice`; the caller maps this to a 400. */
export class XaiToolSchemaCompatibilityError extends Error {}

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

/**
 * A root union expands combinatorially: n nested binary unions yield 2^n variants, and a
 * diamond of `$ref`s amplifies node count the same way without ever cycling. Either one can
 * exhaust memory before the schema is judged unflattenable, so depth, node, and variant
 * budgets bound the walk. Exceeding any of them omits that one function — the same fallback
 * an unflattenable schema already takes. Mirrors the node budgets in openai-chat.ts.
 */
const XAI_MAX_SCHEMA_DEPTH = 64;
const XAI_MAX_SCHEMA_NODES = 4_096;
const XAI_MAX_ROOT_VARIANTS = 256;

/** Mutable walk budget, shared across ref resolution and root-union expansion for one tool. */
interface XaiSchemaBudget {
  remainingNodes: number;
  remainingVariants: number;
}

/** One budget per tool: a large catalog must not let one schema spend another's allowance. */
function createXaiSchemaBudget(): XaiSchemaBudget {
  return { remainingNodes: XAI_MAX_SCHEMA_NODES, remainingVariants: XAI_MAX_ROOT_VARIANTS };
}

function decodeJsonPointerToken(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** Resolve a local `#/`-rooted JSON Pointer against `root`; undefined when it does not resolve. */
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

/** Resolve local `#/` `$ref`s. Unresolvable, cyclic, or over-budget refs return undefined. */
function resolveXaiSchemaRefs(
  schema: unknown,
  root: Record<string, unknown>,
  budget: XaiSchemaBudget,
  stack: Set<string> = new Set(),
  depth = 0,
): unknown | undefined {
  if (!isSchemaObject(schema)) return schema;
  if (depth >= XAI_MAX_SCHEMA_DEPTH || budget.remainingNodes <= 0) return undefined;
  budget.remainingNodes -= 1;
  if (typeof schema.$ref === "string") {
    const ref = schema.$ref;
    if (stack.has(ref)) return undefined;
    const target = lookupLocalJsonPointer(root, ref);
    if (target === undefined) return undefined;
    stack.add(ref);
    const resolvedTarget = resolveXaiSchemaRefs(target, root, budget, stack, depth + 1);
    stack.delete(ref);
    if (resolvedTarget === undefined) return undefined;
    const rest: Record<string, unknown> = { ...schema };
    delete rest.$ref;
    if (Object.keys(rest).length === 0) return resolvedTarget;
    const resolvedRest = resolveXaiSchemaRefs(rest, root, budget, stack, depth + 1);
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
        const next = resolveXaiSchemaRefs(item, root, budget, stack, depth + 1);
        if (next === undefined) return undefined;
        items.push(next);
      }
      resolved[key] = items;
      continue;
    }
    if (key === "properties" && isSchemaObject(value)) {
      const properties: Record<string, unknown> = {};
      for (const [name, property] of Object.entries(value)) {
        const next = resolveXaiSchemaRefs(property, root, budget, stack, depth + 1);
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

/** A variant is mergeable only when it is an object whose every key the merger preserves. */
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

/** Values a schema pins through `const`/`enum`, or undefined when it pins none. */
function xaiLiteralValues(schema: unknown): unknown[] | undefined {
  if (!isSchemaObject(schema)) return undefined;
  if (Object.hasOwn(schema, "const")) return [schema.const];
  if (Array.isArray(schema.enum)) return schema.enum;
  return undefined;
}

/** JSON type name for a literal, so it can be compared against a `type` keyword. */
function xaiJsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return "object";
}

/** Types a schema declares, or undefined when it constrains none. */
function xaiDeclaredTypes(schema: unknown): Set<string> | undefined {
  if (!isSchemaObject(schema)) return undefined;
  const type = schema.type;
  if (typeof type === "string") return new Set([type]);
  if (Array.isArray(type) && type.every(item => typeof item === "string")) return new Set(type as string[]);
  return undefined;
}

/** `integer` is a subset of `number`, so those two names overlap rather than exclude. */
function xaiTypesOverlap(left: string, right: string): boolean {
  if (left === right) return true;
  return (left === "integer" && right === "number") || (left === "number" && right === "integer");
}

/**
 * Conservative mutual-exclusion test: true only when no instance can satisfy both schemas.
 * Proof comes from disjoint literal sets or disjoint declared types; anything it cannot prove
 * is reported as overlapping so the caller refuses the merge instead of widening the schema.
 */
function xaiSchemasAreProvablyDisjoint(left: unknown, right: unknown): boolean {
  const leftValues = xaiLiteralValues(left);
  const rightValues = xaiLiteralValues(right);
  if (leftValues && rightValues) {
    const seen = new Set(rightValues.map(value => JSON.stringify(value)));
    return leftValues.every(value => !seen.has(JSON.stringify(value)));
  }
  const leftTypes = xaiDeclaredTypes(left);
  const rightTypes = xaiDeclaredTypes(right);
  const literalsExcludedByTypes = (values: unknown[], types: Set<string>): boolean =>
    values.every(value => ![...types].some(type => xaiTypesOverlap(xaiJsonTypeOf(value), type)));
  if (leftValues && rightTypes) return literalsExcludedByTypes(leftValues, rightTypes);
  if (rightValues && leftTypes) return literalsExcludedByTypes(rightValues, leftTypes);
  if (leftTypes && rightTypes) {
    return ![...leftTypes].some(leftType => [...rightTypes].some(rightType => xaiTypesOverlap(leftType, rightType)));
  }
  return false;
}

/** Every pair provably disjoint, so a union over them accepts each instance exactly once. */
function xaiSchemasArePairwiseDisjoint(schemas: unknown[]): boolean {
  for (let i = 0; i < schemas.length; i += 1) {
    for (let j = i + 1; j < schemas.length; j += 1) {
      if (!xaiSchemasAreProvablyDisjoint(schemas[i], schemas[j])) return false;
    }
  }
  return true;
}

/** Deduplicate schemas by serialized shape, preserving first-seen order. */
function uniqueXaiSchemas(values: unknown[]): unknown[] {
  const unique: unknown[] = [];
  const serialized = new Set<string>();
  for (const value of values) {
    const key = JSON.stringify(value);
    if (serialized.has(key)) continue;
    serialized.add(key);
    unique.push(value);
  }
  return unique;
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
  const unique = uniqueXaiSchemas(permissive);
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

/** Flattened root variants, plus the shape of the union tree they came from. */
interface XaiRootExpansion {
  variants: Record<string, unknown>[];
  /** This node was itself a union, as opposed to a plain object leaf. */
  isUnion: boolean;
  /**
   * True when a `oneOf` was expanded anywhere in the tree. `oneOf` rejects an instance that
   * matches more than one branch, so its variants must stay mutually exclusive after merging;
   * `anyOf` carries no such obligation.
   */
  exclusive: boolean;
  /**
   * True when a branch was itself a union. Nested `anyOf` flattens associatively and stays
   * exact, but a `oneOf` mixed into a nest no longer maps onto one flat variant list: its
   * exclusivity binds only its own branch group, which a merged root cannot express.
   */
  nestedUnion: boolean;
}

function expandXaiRootObjectSchemas(
  schema: unknown,
  budget: XaiSchemaBudget,
  depth = 0,
): XaiRootExpansion | undefined {
  if (!isSchemaObject(schema) || depth >= XAI_MAX_SCHEMA_DEPTH) return undefined;
  const compositionKey = ["oneOf", "anyOf"].find(key => Array.isArray(schema[key]));
  if (!compositionKey) {
    if (schema.type !== undefined && schema.type !== "object") return undefined;
    if (budget.remainingVariants <= 0) return undefined;
    budget.remainingVariants -= 1;
    return { variants: [{ ...schema, type: "object" }], isUnion: false, exclusive: false, nestedUnion: false };
  }

  const siblings = Object.fromEntries(Object.entries(schema).filter(([key]) => key !== compositionKey));
  const branches = schema[compositionKey];
  if (!Array.isArray(branches)) return undefined;
  const expanded: Record<string, unknown>[] = [];
  let exclusive = compositionKey === "oneOf";
  let nestedUnion = false;
  for (const branch of branches) {
    const nested = expandXaiRootObjectSchemas(branch, budget, depth + 1);
    if (!nested) return undefined;
    exclusive ||= nested.exclusive;
    nestedUnion ||= nested.isUnion || nested.nestedUnion;
    for (const variant of nested.variants) expanded.push(composeXaiObjectSchemas(siblings, variant));
  }
  return expanded.length > 0 ? { variants: expanded, isUnion: true, exclusive, nestedUnion } : undefined;
}

/**
 * The Grok CLI proxy rejects a function parameter schema whose root remains oneOf/anyOf.
 * Flatten only when the merge is lossless: local $refs resolve inside the walk budget, every
 * variant is a concrete object whose keys we can preserve, required sets match,
 * additionalProperties does not change meaning, every property name exists on every variant,
 * and at most one property schema differs.
 *
 * A `oneOf` carries one more obligation than `anyOf`: it rejects an instance matching several
 * branches. Only the destination's ROOT rejects a union, so exclusivity survives by moving the
 * union down onto the one differing property rather than by widening it — with every other
 * property, the required set, and additionalProperties already identical across branches, a
 * property-level `oneOf` accepts exactly what the root `oneOf` accepted. Branches that are
 * provably disjoint keep emitting `anyOf`, since there the two keywords describe the same set.
 * The remaining hole is an optional discriminator: absent, it matches every branch, which the
 * root `oneOf` rejects and a per-property union would accept, so that property is promoted into
 * `required`.
 *
 * Two deliberate widenings remain, and both widen only from the EMPTY set. A `oneOf` listing the
 * same branch twice accepts nothing at all. Neither does a root `additionalProperties: false`
 * placed over branches that declare properties the root itself does not: the restriction cannot
 * see into an applicator, so it forbids the very keys those branches require (same for a `$ref`
 * target's restriction against a sibling's properties). No author intends either, no root object
 * schema can express "accepts nothing", and the emitted schema still carries the restriction — so
 * the tool stays usable instead of disappearing over a source-schema bug. A union whose branch
 * properties ARE declared on the root is satisfiable and is normalized losslessly, which is why
 * the presence of `additionalProperties` alone is not grounds to refuse.
 */
export function normalizeXaiToolParameters(parameters: unknown): Record<string, unknown> | undefined {
  if (!isSchemaObject(parameters)) return undefined;
  const budget = createXaiSchemaBudget();
  const resolved = resolveXaiSchemaRefs(parameters, parameters, budget);
  if (!isSchemaObject(resolved)) return undefined;

  const normalizedRoot = { ...resolved };
  delete normalizedRoot.$schema;

  const expansion = expandXaiRootObjectSchemas(normalizedRoot, budget);
  if (!expansion) return undefined;
  const { variants, exclusive, nestedUnion } = expansion;
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

  const properties: Record<string, unknown> = {};
  const differingNames: string[] = [];
  for (const [name, values] of propertyValues) {
    const unique = uniqueXaiSchemas(values);
    if (unique.length === 1) {
      properties[name] = unique[0];
      continue;
    }
    // A `oneOf` nested among other unions binds exclusivity to its own branch group only, so a
    // single flat variant list cannot say what the original said — in either direction. Refuse.
    if (exclusive && nestedUnion) return undefined;
    differingNames.push(name);
    // Disjoint branches make `anyOf` and `oneOf` describe the same set, so prefer the keyword
    // already proven on this wire; overlapping branches need the exclusivity kept verbatim.
    properties[name] = exclusive && !xaiSchemasArePairwiseDisjoint(unique)
      ? { oneOf: unique }
      : { anyOf: unique };
  }

  let required = stringRequiredFields(variants[0]?.required);
  if (exclusive && differingNames.length > 0) {
    required = [...new Set([...required, ...differingNames])];
  }

  return {
    ...metadata,
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    ...("value" in additionalProperties ? { additionalProperties: additionalProperties.value } : {}),
  };
}
