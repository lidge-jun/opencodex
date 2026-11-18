import { stripResponsesOnlyEncryptedMarker } from "./responses-tool-schema";

/**
 * Anthropic rejects a root-level missing `type` and root-level `oneOf`/`anyOf`/`allOf` in
 * `input_schema`. Normalize the root only: ensure `type:"object"` + `properties`, flatten root
 * composition while preserving nested schemas, and inline local `#/...` refs (RFC 6901: the
 * fragment is percent-decoded, numeric tokens index arrays) before flattening so a referenced
 * branch keeps its parameters and required members. A `$ref` with siblings merges both property
 * maps, unions `required`, and keeps a property declared on both sides conjunctive under
 * `allOf`; composition on both sides is kept, not replaced. A property met twice on an all-`allOf`
 * path is conjoined the same way. Composition branches and direct alias hops share one 4096-step
 * budget. Shared by the anthropic and command-code adapters; Command Code's text-call recovery
 * matches markup against the normalized schema and validates it against the declared one too.
 *
 * Flattening root alternatives is lossy: later branches win for a same-named property, and
 * `oneOf`/`anyOf` branch `required` members are not promoted because no branch is guaranteed.
 * A root `oneOf` whose branches declare `action.enum: ["read"]` and `action.enum: ["write"]`
 * yields a schema that permits only `"write"`. Covered by
 * tests/providers/command-code-tool-schema.test.ts and
 * tests/adapters/anthropic/anthropic-tool-schema.test.ts.
 */

const LOCAL_REF_PREFIX = "#/";
const COMPOSITION_KEYS = ["oneOf", "anyOf", "allOf"] as const;
/** Branch visits allowed while expanding root composition; shared ref graphs multiply. */
const ROOT_COMPOSITION_EXPANSION_LIMIT = 4096;
const ROOT_COMPOSITION_LIMIT_MESSAGE =
  "tool input schema reference expansion exceeded the supported limit";
/** Shared work budget: composition branches and direct `$ref` alias hops both count against it. */
interface ExpansionBudget { count: number }

function spend(budget: ExpansionBudget): void {
  budget.count += 1;
  if (budget.count > ROOT_COMPOSITION_EXPANSION_LIMIT) throw new Error(ROOT_COMPOSITION_LIMIT_MESSAGE);
}

function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}

/**
 * RFC 6901: a URI fragment is percent-decoded before it is split into tokens, each token then
 * undoes `~1`/`~0`, and a canonical decimal token selects an array element. A malformed escape
 * or a path that does not resolve leaves the reference unresolved.
 */
function resolveLocalPointer(root: Record<string, unknown>, pointer: string): Record<string, unknown> | undefined {
  if (!pointer.startsWith(LOCAL_REF_PREFIX)) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pointer.slice(2));
  } catch {
    return undefined;
  }
  let node: unknown = root;
  for (const segment of decoded.split("/")) {
    const token = decodePointerSegment(segment);
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return undefined;
      node = node[Number(token)];
      continue;
    }
    if (!node || typeof node !== "object" || !Object.hasOwn(node, token)) return undefined;
    node = (node as Record<string, unknown>)[token];
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

/** Conjunctions this module built, so a later collision extends them instead of nesting. */
const builtConjunctions = new WeakSet<object>();

/**
 * Both schemas apply. A conjunction built here gains one more member; a caller's own `allOf`
 * schema stays a single member so its meaning is not spliced into ours.
 */
function conjoin(existing: unknown, schema: unknown): Record<string, unknown> {
  const members = existing && typeof existing === "object" && builtConjunctions.has(existing)
    ? [...((existing as { allOf: unknown[] }).allOf)]
    : [existing];
  if (!members.includes(schema)) members.push(schema);
  const conjunction = { allOf: members };
  builtConjunctions.add(conjunction);
  return conjunction;
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
      properties[name] = existing === undefined ? schema : conjoin(existing, schema);
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

  // The spread above lets a sibling's composition replace the referenced schema's. Both sides
  // apply, so concatenate `allOf` and keep each side's `oneOf`/`anyOf` as its own `allOf` entry.
  const allOf: unknown[] = [];
  for (const source of [resolved, siblings]) if (Array.isArray(source.allOf)) allOf.push(...source.allOf);
  for (const key of ["oneOf", "anyOf"] as const) {
    if (Array.isArray(resolved[key]) && Array.isArray(siblings[key])) {
      allOf.push({ [key]: resolved[key] }, { [key]: siblings[key] });
      delete merged[key];
    }
  }
  if (allOf.length > 0) merged.allOf = allOf;

  return merged;
}

/**
 * Inline a local `#/...` reference so root-composition branches keep their definitions. Each
 * alias hop spends the shared budget, so a long direct chain fails explicitly instead of
 * recursing until the stack or allocation gives out.
 */
function dereferenceLocal(
  node: unknown,
  root: Record<string, unknown>,
  seen: ReadonlySet<string>,
  budget: ExpansionBudget,
): Record<string, unknown> | undefined {
  if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
  const record = node as Record<string, unknown>;
  const ref = record.$ref;
  if (typeof ref !== "string" || !ref.startsWith(LOCAL_REF_PREFIX) || seen.has(ref)) return record;
  spend(budget);
  const target = resolveLocalPointer(root, ref);
  if (!target) return record;
  const nextSeen = new Set(seen);
  nextSeen.add(ref);
  const resolved = dereferenceLocal(target, root, nextSeen, budget) ?? target;
  const { $ref: _ignored, ...siblings } = record;
  return mergeRefSiblings(resolved, siblings);
}

/**
 * `allOf` applies every branch, so a property met twice on an all-`allOf` path keeps both
 * schemas under `allOf`. On a path through `oneOf`/`anyOf` the documented last-branch-wins
 * flattening still applies. The same schema object reached twice (a shared `$ref`) is kept once.
 */
function collectProperty(
  properties: Record<string, unknown>,
  name: string,
  schema: unknown,
  conjunctive: boolean,
): void {
  const existing = properties[name];
  if (existing === schema) return;
  properties[name] = conjunctive && existing !== undefined ? conjoin(existing, schema) : schema;
}

/**
 * Flatten root-equivalent composition, including composition that a resolved `$ref` branch
 * carries. Only a node standing where the root composition stands contributes; `properties`
 * and nested property schemas are never traversed. `chain` holds the refs already inlined on
 * this path, so a self- or mutually-recursive definition stops instead of recursing forever.
 * `visits` bounds the total expansion so a shared acyclic graph cannot multiply work; exceeding
 * it throws, and the adapter build then fails as an explicit invalid request.
 */
function collectRootComposition(
  node: Record<string, unknown>,
  root: Record<string, unknown>,
  chain: ReadonlySet<string>,
  mergeRequired: boolean,
  properties: Record<string, unknown>,
  required: Set<string>,
  budget: ExpansionBudget,
): void {
  for (const key of COMPOSITION_KEYS) {
    const variants = node[key];
    if (!Array.isArray(variants)) continue;
    const branchMergesRequired = mergeRequired && key === "allOf";
    for (const variant of variants) {
      const record = asSchemaMap(variant);
      if (!record) continue;
      const ref = typeof record.$ref === "string" ? record.$ref : undefined;
      if (ref && chain.has(ref)) continue;
      spend(budget);
      const resolved = dereferenceLocal(variant, root, chain, budget);
      if (!resolved) continue;
      const nextChain = ref ? new Set(chain).add(ref) : chain;
      const branchProperties = asSchemaMap(resolved.properties);
      if (branchProperties) {
        for (const [name, schema] of Object.entries(branchProperties)) {
          collectProperty(properties, name, schema, branchMergesRequired);
        }
      }
      if (branchMergesRequired && Array.isArray(resolved.required)) {
        for (const item of resolved.required) if (typeof item === "string") required.add(item);
      }
      collectRootComposition(resolved, root, nextChain, branchMergesRequired, properties, required, budget);
    }
  }
}

export function normalizeAnthropicInputSchema(schema: unknown): Record<string, unknown> {
  const stripped = stripResponsesOnlyEncryptedMarker(schema);
  const obj = stripped && typeof stripped === "object" && !Array.isArray(stripped)
    ? stripped as Record<string, unknown>
    : {};
  const budget: ExpansionBudget = { count: 0 };
  const root = dereferenceLocal(obj, obj, new Set(), budget) ?? obj;
  const hasRootComposition = COMPOSITION_KEYS.some(key => Array.isArray(root[key]));
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

  collectRootComposition(root, root, new Set(), true, properties, required, budget);

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
