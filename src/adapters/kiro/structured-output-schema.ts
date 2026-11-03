/**
 * Full validation for strict structured output (`strict: true`) on Kiro.
 *
 * A strict caller is promised a value that conforms to the whole schema, which the light root
 * checks in structured-output.ts cannot keep: `{"title":42,"extra":true}` passes a root `type` and
 * `required` check against a schema that wants a string title and forbids extra keys. Kiro's wire
 * cannot constrain decoding, so the emulation enforces the contract afterwards instead.
 *
 * Every schema this module accepts is validated exactly and in bounded work; anything else is
 * refused before a request is sent, because relaying a value the proxy could not check would break
 * the promise strict mode makes. The supported subset:
 *
 * - `type` (a known type or a non-empty array of them), `properties`, `required`,
 *   `additionalProperties` (boolean or schema), `items` (one schema), `enum`, `const`, `anyOf`.
 *   A `const` or `enum` literal that contains a number is refused: the request reaches this module
 *   already parsed, so a literal such as `1.0000000000000001` arrives as `1`, and an exact equality
 *   check would accept a value the caller excluded.
 * - `$ref` only as `#/$defs/<name>` or `#/definitions/<name>`, naming a definition in the root's
 *   `$defs`/`definitions`. `$defs`/`definitions` are accepted only at the root. Root-relative
 *   references (`#`, `#/properties/...`), references into annotations and remote references are
 *   refused, and so is a cycle of references and `anyOf` branches that consumes none of the value.
 * - `minLength`, `maxLength`, `minItems`, `maxItems` as non-negative safe integers.
 * - `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` as finite numbers that are either
 *   safe integers or non-integers with at most 15 significant digits. This is a heuristic: a bound
 *   written with more digits than a double holds can still arrive rounded, so a value within about
 *   one unit in the last place of the bound may be judged on the wrong side. The model's numbers
 *   are compared against their original text exactly.
 * - `multipleOf`, `pattern` and `patternProperties` are refused. `multipleOf` is exact equality on a
 *   possibly rounded number, and a regular expression evaluated against model output can take
 *   super-linear time on the request path.
 *
 * Annotations (`title`, `description`, `default`, ...) carry no assertion and are ignored.
 *
 * Work is bounded per value: one validation may visit at most
 * {@link KIRO_STRICT_BASE_VISITS} schema nodes plus {@link KIRO_STRICT_VISITS_PER_VALUE_NODE} per JSON
 * value in the answer, and nest at most {@link KIRO_STRICT_MAX_DEPTH} schema levels deep across
 * references, `anyOf` branches, properties and items. A value that needs more is reported as
 * non-conforming, so a recursive `anyOf` cannot branch exponentially and a deep value cannot
 * exhaust the stack.
 */
import {
  compareKiroDecimal,
  isKiroDecimalInteger,
  kiroDecimal,
  type KiroDecimal,
  type KiroJsonValue,
} from "./structured-output-json";

type JsonRecord = Record<string, unknown>;

/** Schema-node visits every validation may spend regardless of the value's size. */
export const KIRO_STRICT_BASE_VISITS = 10_000;
/** Extra schema-node visits granted per JSON value in the answer. */
export const KIRO_STRICT_VISITS_PER_VALUE_NODE = 16;
/** One depth limit across references, anyOf branches, properties and items. */
export const KIRO_STRICT_MAX_DEPTH = 128;
/** Deepest schema nesting accepted at the boundary. */
const MAX_SCHEMA_DEPTH = 64;
/** Schema nodes accepted at the boundary; preparation work is linear in this. */
const MAX_SCHEMA_NODES = 10_000;
/** JSON values accepted across every `const`/`enum` literal of one schema. */
const MAX_LITERAL_NODES = 10_000;

const KNOWN_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ANNOTATIONS = new Set([
  "title", "description", "default", "examples", "$schema", "$comment", "deprecated", "readOnly", "writeOnly",
]);
const COUNTS = ["minLength", "maxLength", "minItems", "maxItems"] as const;
const BOUNDS = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum"] as const;
const REF = /^#\/(\$defs|definitions)\/([^/]+)$/;

/** One schema position, prepared once at the boundary. */
interface StrictNode {
  never?: true;
  ref?: StrictNode;
  types?: string[];
  enumValues?: unknown[];
  constValue?: { value: unknown };
  anyOf?: StrictNode[];
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: KiroDecimal;
  maximum?: KiroDecimal;
  exclusiveMinimum?: KiroDecimal;
  exclusiveMaximum?: KiroDecimal;
  items?: StrictNode;
  required?: string[];
  properties?: Map<string, StrictNode>;
  closed?: true;
  additional?: StrictNode;
}

/** A plain JSON object: not null and not an array. */
function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * JSON Schema keyword names a refusal may name. Any other key is the caller's own text and is not
 * echoed: a refusal names a keyword only from this fixed vocabulary.
 */
const NAMEABLE_KEYWORDS = new Set([
  "schema", "type", "properties", "required", "additionalProperties", "items", "enum", "const", "anyOf",
  "oneOf", "allOf", "not", "if", "then", "else", "$ref", "$defs", "definitions", "$anchor", "$dynamicRef",
  "$dynamicAnchor", "$id", "$recursiveRef", "$recursiveAnchor", "multipleOf", "pattern", "patternProperties",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength", "minItems",
  "maxItems", "minProperties", "maxProperties", "uniqueItems", "contains", "minContains", "maxContains",
  "prefixItems", "additionalItems", "unevaluatedItems", "unevaluatedProperties", "propertyNames",
  "dependentRequired", "dependentSchemas", "dependencies", "format", "contentEncoding",
  "contentMediaType", "contentSchema",
]);

class Unsupported extends Error {
  readonly keyword: string | undefined;
  constructor(keyword: string) {
    super("unsupported strict schema keyword");
    this.keyword = NAMEABLE_KEYWORDS.has(keyword) ? keyword : undefined;
  }
}

/** Whether a schema number still states what the caller wrote after JSON.parse rounded it. */
function isFaithfulNumber(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (Number.isInteger(value)) return Number.isSafeInteger(value);
  return kiroDecimal(String(value)).digits.length <= 15;
}

/**
 * The JSON values in a `const`/`enum` literal, or -1 when it contains a number. Iterative, so a deep
 * literal is safe; it stops counting at `limit`.
 */
function literalNodes(literal: unknown, limit: number): number {
  const stack = [literal];
  let count = 0;
  while (stack.length > 0 && count <= limit) {
    const item = stack.pop();
    count += 1;
    if (typeof item === "number") return -1;
    if (Array.isArray(item)) for (const child of item) stack.push(child);
    else if (isRecord(item)) for (const child of Object.values(item)) stack.push(child);
  }
  return count;
}

/** A prepared strict schema: the root node of its validation graph. */
interface PreparedSchema {
  root: StrictNode;
}

/** Build the validation graph for `schema`, or throw {@link Unsupported} naming the first keyword it cannot enforce. */
function prepare(schema: JsonRecord): PreparedSchema {
  const definitions = new Map<string, StrictNode>();
  const pending: Array<[StrictNode, unknown]> = [];
  for (const section of ["$defs", "definitions"] as const) {
    if (!Object.hasOwn(schema, section)) continue;
    const defs = schema[section];
    if (!isRecord(defs)) throw new Unsupported(section);
    for (const [name, def] of Object.entries(defs)) {
      const node: StrictNode = {};
      definitions.set(`${section}/${name}`, node);
      pending.push([node, def]);
    }
  }
  const nodes: StrictNode[] = [];
  let literalBudget = MAX_LITERAL_NODES;
  /** Charge a literal against the schema-wide cap; a number or an oversized literal is refused. */
  const admitLiteral = (literal: unknown, key: string): void => {
    const count = literalNodes(literal, literalBudget);
    if (count < 0 || count > literalBudget) throw new Unsupported(key);
    literalBudget -= count;
  };

  const resolve = (ref: unknown): StrictNode => {
    if (typeof ref !== "string") throw new Unsupported("$ref");
    // Percent-decode the whole fragment before reading pointer segments: an encoded "/" is a
    // segment separator, so `#/$defs/a%2Fb` points into definition `a`, which is outside the subset.
    let decoded: string;
    try {
      decoded = decodeURIComponent(ref);
    } catch {
      throw new Unsupported("$ref");
    }
    const match = REF.exec(decoded);
    if (!match) throw new Unsupported("$ref");
    // JSON Pointer defines only `~0` and `~1`; any other `~` makes the pointer invalid.
    if (/~(?![01])/.test(match[2]!)) throw new Unsupported("$ref");
    const name = match[2]!.replaceAll("~1", "/").replaceAll("~0", "~");
    const target = definitions.get(`${match[1]}/${name}`);
    if (!target) throw new Unsupported("$ref");
    return target;
  };

  const build = (raw: unknown, depth: number, keyword: string, node: StrictNode = {}, root = false): StrictNode => {
    if (depth > MAX_SCHEMA_DEPTH || nodes.length >= MAX_SCHEMA_NODES) throw new Unsupported(keyword);
    nodes.push(node);
    if (raw === false) node.never = true;
    if (typeof raw === "boolean") return node;
    if (!isRecord(raw)) throw new Unsupported("schema");
    // Drafts disagree on whether keywords beside `$ref` apply (draft-07 ignores them, 2019-09 and
    // later apply them), so a `$ref` with an assertion beside it has no single meaning to enforce.
    if (Object.hasOwn(raw, "$ref")
      && Object.keys(raw).some(key => key !== "$ref" && key !== "$defs" && key !== "definitions" && !ANNOTATIONS.has(key))) {
      throw new Unsupported("$ref");
    }
    for (const [key, arg] of Object.entries(raw)) {
      if (ANNOTATIONS.has(key)) continue;
      switch (key) {
        case "$defs":
        case "definitions":
          if (!root) throw new Unsupported(key);
          break;
        // A nested `$id` starts a new resource that `#/...` references would resolve against, and
        // anchors name targets this resolver does not follow; only a root `$id` (same document) is kept.
        case "$id":
          if (!root) throw new Unsupported(key);
          break;
        case "$anchor":
        case "$dynamicAnchor":
          throw new Unsupported(key);
        case "type": {
          const types = Array.isArray(arg) ? arg : [arg];
          // Distinct known types only, so a type list is at most seven entries long.
          if (types.length === 0 || new Set(types).size !== types.length
            || !types.every(t => typeof t === "string" && KNOWN_TYPES.has(t))) throw new Unsupported(key);
          node.types = types as string[];
          break;
        }
        case "properties":
          if (!isRecord(arg)) throw new Unsupported(key);
          node.properties = new Map(Object.entries(arg).map(([name, child]) => [name, build(child, depth + 1, key)]));
          break;
        case "required":
          if (!(Array.isArray(arg) && arg.every(k => typeof k === "string"))) throw new Unsupported(key);
          node.required = arg as string[];
          break;
        case "additionalProperties":
          if (arg === false) node.closed = true;
          else if (arg !== true) node.additional = build(arg, depth + 1, key);
          break;
        case "items":
          if (Array.isArray(arg)) throw new Unsupported(key);
          node.items = build(arg, depth + 1, key);
          break;
        case "enum":
          if (!Array.isArray(arg)) throw new Unsupported(key);
          admitLiteral(arg, key);
          node.enumValues = arg;
          break;
        case "const":
          admitLiteral(arg, key);
          node.constValue = { value: arg };
          break;
        case "anyOf":
          if (!Array.isArray(arg) || arg.length === 0) throw new Unsupported(key);
          node.anyOf = arg.map(branch => build(branch, depth + 1, key));
          break;
        case "$ref":
          node.ref = resolve(arg);
          break;
        default:
          if ((COUNTS as readonly string[]).includes(key)) {
            if (!(Number.isSafeInteger(arg) && (arg as number) >= 0)) throw new Unsupported(key);
            node[key as (typeof COUNTS)[number]] = arg as number;
          } else if ((BOUNDS as readonly string[]).includes(key)) {
            if (!isFaithfulNumber(arg)) throw new Unsupported(key);
            node[key as (typeof BOUNDS)[number]] = kiroDecimal(String(arg));
          } else throw new Unsupported(key);
      }
    }
    return node;
  };

  for (const [node, def] of pending) build(def, 1, "$ref", node);
  const root = build(schema, 0, "schema", {}, true);
  assertNoEmptyCycle(nodes);
  return { root };
}

/**
 * Refuse a cycle of `$ref` and `anyOf` edges: following it consumes none of the value, so it can
 * never decide anything. Recursion through `properties`, `items` or `additionalProperties` is fine.
 */
function assertNoEmptyCycle(nodes: StrictNode[]): void {
  const state = new Map<StrictNode, 1 | 2>();
  // Each frame builds its node's edge list once, so the walk is linear in nodes plus edges.
  const edges = (node: StrictNode): StrictNode[] => [...(node.ref ? [node.ref] : []), ...(node.anyOf ?? [])];
  for (const start of nodes) {
    if (state.has(start)) continue;
    const stack: Array<[StrictNode, StrictNode[], number]> = [[start, edges(start), 0]];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = frame[1][frame[2]++];
      if (next === undefined) {
        state.set(frame[0], 2);
        stack.pop();
      } else if (state.get(next) === 1) throw new Unsupported("$ref");
      else if (!state.has(next)) {
        state.set(next, 1);
        stack.push([next, edges(next), 0]);
      }
    }
  }
}

const prepared = new WeakMap<JsonRecord, PreparedSchema>();

/** The prepared graph for `schema`, built once per schema object. */
function preparedFor(schema: JsonRecord): PreparedSchema {
  let plan = prepared.get(schema);
  if (!plan) {
    plan = prepare(schema);
    prepared.set(schema, plan);
  }
  return plan;
}

/** Throw the structured-output refusal when a strict schema needs a check this emulation does not have. */
export function assertKiroStrictSchemaSupported(schema: JsonRecord): void {
  try {
    preparedFor(schema);
  } catch (error) {
    if (!(error instanceof Unsupported)) throw error;
    throw new Error(error.keyword === undefined
      ? "Kiro does not support Responses structured output: the strict schema uses a keyword that cannot be enforced"
      : `Kiro does not support Responses structured output: strict schema keyword ${JSON.stringify(error.keyword)} cannot be enforced`);
  }
}

/** Whether a parsed JSON value has the given JSON Schema type. */
/** A number value's decimal, parsed once per value however many nodes inspect it. */
const decimals = new WeakMap<KiroJsonValue, KiroDecimal>();
function decimalOf(value: KiroJsonValue & { kind: "number" }): KiroDecimal {
  let decimal = decimals.get(value);
  if (!decimal) {
    decimal = kiroDecimal(value.lexeme);
    decimals.set(value, decimal);
  }
  return decimal;
}

function hasType(value: KiroJsonValue, type: string): boolean {
  switch (type) {
    case "object": return value.kind === "object";
    case "array": return value.kind === "array";
    case "string": return value.kind === "string";
    case "number": return value.kind === "number";
    case "integer": return value.kind === "number" && isKiroDecimalInteger(decimalOf(value));
    case "boolean": return value.kind === "boolean";
    case "null": return value.kind === "null";
    default: return false;
  }
}

/** Whether the model's value equals a schema literal, comparing numbers exactly by their decimal value. */
function literalEquals(literal: unknown, value: KiroJsonValue, charge: (cost: number) => void): boolean {
  // Every comparison step is charged, so one large literal referenced from many places cannot
  // multiply work past the validation budget. Long strings cost in proportion to their length.
  charge(1);
  switch (value.kind) {
    case "null": return literal === null;
    case "boolean": return literal === value.value;
    case "string":
      charge(Math.floor(value.value.length / 256));
      return literal === value.value;
    case "number":
      return typeof literal === "number"
        && compareKiroDecimal(kiroDecimal(String(literal)), kiroDecimal(value.lexeme)) === 0;
    case "array":
      return Array.isArray(literal) && literal.length === value.items.length
        && value.items.every((item, i) => literalEquals(literal[i], item, charge));
    case "object": {
      if (!isRecord(literal)) return false;
      const keys = Object.keys(literal);
      charge(keys.length);
      return keys.length === value.entries.size
        && keys.every(key => value.entries.has(key) && literalEquals(literal[key], value.entries.get(key)!, charge));
    }
  }
}

/** Code points in a string value, counted once per value however many nodes check its length. */
const codePointLengths = new WeakMap<KiroJsonValue, number>();
function codePointLength(value: KiroJsonValue & { kind: "string" }): number {
  let length = codePointLengths.get(value);
  if (length === undefined) {
    length = 0;
    for (const _ of value.value) length += 1;
    codePointLengths.set(value, length);
  }
  return length;
}

class OverBudget extends Error {
  constructor(readonly problem: string) {
    super(problem);
  }
}

/** The outcome of one strict validation, with the schema-node visits it spent. */
export interface KiroStrictValidation {
  problem?: string;
  visits: number;
  budget: number;
}

/**
 * Validate `value` (holding `valueNodes` JSON values) against the strict `schema`.
 *
 * Problems are fixed categories. They never quote a property name, a path or any other text from
 * the model's answer or the caller's schema, because they reach the caller and diagnostics.
 */
export function validateKiroStrictValue(schema: JsonRecord, value: KiroJsonValue, valueNodes: number): KiroStrictValidation {
  const { root } = preparedFor(schema);
  const budget = KIRO_STRICT_BASE_VISITS + KIRO_STRICT_VISITS_PER_VALUE_NODE * valueNodes;
  let visits = 0;
  const spend = (cost = 1): void => {
    visits += cost;
    if (visits > budget) throw new OverBudget("validating the value needs more work than strict validation allows");
  };

  const check = (node: StrictNode, value: KiroJsonValue, depth: number): string | undefined => {
    spend();
    if (depth > KIRO_STRICT_MAX_DEPTH) throw new OverBudget("the value nests deeper than strict validation allows");
    if (node.never) return "a value is present where none is allowed";
    if (node.ref) {
      const problem = check(node.ref, value, depth + 1);
      if (problem) return problem;
    }
    if (node.types) {
      // An integer check walks the number's digits; long lexemes are charged in proportion.
      if (value.kind === "number" && node.types.includes("integer")) spend(Math.floor(value.lexeme.length / 256));
      if (!node.types.some(type => hasType(value, type))) return `expected a JSON ${node.types.join(" or ")}`;
    }
    if (node.enumValues && !node.enumValues.some(option => literalEquals(option, value, spend))) return "expected one of the enum values";
    if (node.constValue && !literalEquals(node.constValue.value, value, spend)) return "expected the const value";
    if (node.anyOf && !node.anyOf.some(branch => check(branch, value, depth + 1) === undefined)) {
      return "matched no anyOf branch";
    }
    if (value.kind === "string") {
      if (node.minLength !== undefined || node.maxLength !== undefined) {
        // Counting code points walks the string, so repeated checks of one long string are charged,
        // and only a node with a length constraint counts at all.
        spend(Math.floor(value.value.length / 256));
        const length = codePointLength(value);
        if (node.minLength !== undefined && length < node.minLength) return "a string is shorter than minLength";
        if (node.maxLength !== undefined && length > node.maxLength) return "a string is longer than maxLength";
      }
    }
    if (value.kind === "number" && (node.minimum || node.maximum || node.exclusiveMinimum || node.exclusiveMaximum)) {
      // Bound comparisons walk the digits too: parsed once per value, charged on every use.
      spend(Math.floor(value.lexeme.length / 256));
      const number = decimalOf(value);
      if (node.minimum && compareKiroDecimal(number, node.minimum) < 0) return "a number is below minimum";
      if (node.maximum && compareKiroDecimal(number, node.maximum) > 0) return "a number is above maximum";
      if (node.exclusiveMinimum && compareKiroDecimal(number, node.exclusiveMinimum) <= 0) return "a number is not above exclusiveMinimum";
      if (node.exclusiveMaximum && compareKiroDecimal(number, node.exclusiveMaximum) >= 0) return "a number is not below exclusiveMaximum";
    }
    if (value.kind === "array") {
      if (node.minItems !== undefined && value.items.length < node.minItems) return "an array has fewer than minItems";
      if (node.maxItems !== undefined && value.items.length > node.maxItems) return "an array has more than maxItems";
      if (node.items) {
        for (const item of value.items) {
          const problem = check(node.items, item, depth + 1);
          if (problem) return problem;
        }
      }
    }
    if (value.kind === "object") {
      // Each pass over `required` and over the entries is charged, so a failing anyOf that re-checks
      // one large object or one long `required` list stays within the budget.
      spend(node.required?.length ?? 0);
      if (node.required?.some(key => !value.entries.has(key))) return "an object is missing a required property";
      spend(value.entries.size);
      for (const [key, child] of value.entries) {
        const declared = node.properties?.get(key);
        if (!declared && node.closed) return "an object has a property the schema does not allow";
        const childNode = declared ?? node.additional;
        if (!childNode) continue;
        const problem = check(childNode, child, depth + 1);
        if (problem) return problem;
      }
    }
    return undefined;
  };

  try {
    const problem = check(root, value, 0);
    return { ...(problem !== undefined ? { problem } : {}), visits, budget };
  } catch (error) {
    if (!(error instanceof OverBudget)) throw error;
    return { problem: error.problem, visits, budget };
  }
}

/** The first way `value` breaks the strict `schema`, or undefined when it conforms. */
export function kiroStrictSchemaProblem(schema: JsonRecord, value: KiroJsonValue, valueNodes: number): string | undefined {
  return validateKiroStrictValue(schema, value, valueNodes).problem;
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
export function rewriteKiroWrappedRefs(schema: unknown, root = true): unknown {
  if (Array.isArray(schema)) return schema.map(item => rewriteKiroWrappedRefs(item, false));
  if (!isRecord(schema)) return schema;
  // A nested `$id` starts its own resource: references inside it are relative to that resource,
  // which moves along with it, so they stay as written.
  if (!root && typeof schema.$id === "string") return schema;
  // fromEntries defines own properties, so a key such as "__proto__" stays a key.
  return Object.fromEntries(Object.entries(schema).map(([key, child]): [string, unknown] => {
    if (SCHEMA_MAPS.has(key) && isRecord(child)) {
      return [key, Object.fromEntries(Object.entries(child).map(([name, sub]) => [name, rewriteKiroWrappedRefs(sub, false)]))];
    }
    if (LITERAL_KEYS.has(key)) return [key, child];
    if (key === "$ref" && typeof child === "string") return [key, movedRef(child)];
    return [key, rewriteKiroWrappedRefs(child, false)];
  }));
}

/** One reference rewritten for the wrapped document. */
function movedRef(ref: string): string {
  // Judge the decoded pointer: `#%2Fitems` is root-relative and `#/%24defs/item` names the hoisted
  // `$defs`, exactly like their unencoded forms. Prefixing the raw remainder keeps its encoding.
  let decoded = ref;
  try { decoded = decodeURIComponent(ref); } catch { /* an undecodable pointer is judged as written */ }
  if (decoded !== "#" && !decoded.startsWith("#/")) return ref;
  // The definition containers themselves, and anything under them, stay at the wrapper root.
  if (["#/$defs", "#/definitions"].some(container => decoded === container || decoded.startsWith(`${container}/`))) return ref;
  return `#/properties/value${ref.slice(1)}`;
}
