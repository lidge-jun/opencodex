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

const KNOWN_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const ANNOTATIONS = new Set([
  "title", "description", "default", "examples", "$schema", "$id", "$comment", "deprecated", "readOnly", "writeOnly",
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

class Unsupported extends Error {
  constructor(readonly keyword: string) {
    super(keyword);
  }
}

/** Whether a schema number still states what the caller wrote after JSON.parse rounded it. */
function isFaithfulNumber(value: unknown): value is number {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (Number.isInteger(value)) return Number.isSafeInteger(value);
  return kiroDecimal(String(value)).digits.length <= 15;
}

/** Whether a const/enum literal contains a number anywhere. Iterative, so a deep literal is safe. */
function containsNumber(literal: unknown): boolean {
  const stack = [literal];
  while (stack.length > 0) {
    const item = stack.pop();
    if (typeof item === "number") return true;
    if (Array.isArray(item)) for (const child of item) stack.push(child);
    else if (isRecord(item)) for (const child of Object.values(item)) stack.push(child);
  }
  return false;
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

  const resolve = (ref: unknown): StrictNode => {
    const match = typeof ref === "string" ? REF.exec(ref) : null;
    if (!match) throw new Unsupported("$ref");
    let name: string;
    try {
      name = decodeURIComponent(match[2]!).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      throw new Unsupported("$ref");
    }
    const target = definitions.get(`${match[1]}/${name}`);
    if (!target) throw new Unsupported("$ref");
    return target;
  };

  const build = (raw: unknown, depth: number, keyword: string, node: StrictNode = {}, root = false): StrictNode => {
    if (depth > MAX_SCHEMA_DEPTH) throw new Unsupported(keyword);
    nodes.push(node);
    if (raw === false) node.never = true;
    if (typeof raw === "boolean") return node;
    if (!isRecord(raw)) throw new Unsupported("schema");
    for (const [key, arg] of Object.entries(raw)) {
      if (ANNOTATIONS.has(key)) continue;
      switch (key) {
        case "$defs":
        case "definitions":
          if (!root) throw new Unsupported(key);
          break;
        case "type": {
          const types = Array.isArray(arg) ? arg : [arg];
          if (types.length === 0 || !types.every(t => typeof t === "string" && KNOWN_TYPES.has(t))) throw new Unsupported(key);
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
          if (!Array.isArray(arg) || containsNumber(arg)) throw new Unsupported(key);
          node.enumValues = arg;
          break;
        case "const":
          if (containsNumber(arg)) throw new Unsupported(key);
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
  const edges = (node: StrictNode): StrictNode[] => [...(node.ref ? [node.ref] : []), ...(node.anyOf ?? [])];
  for (const start of nodes) {
    if (state.has(start)) continue;
    const stack: Array<[StrictNode, number]> = [[start, 0]];
    state.set(start, 1);
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = edges(frame[0])[frame[1]++];
      if (next === undefined) {
        state.set(frame[0], 2);
        stack.pop();
      } else if (state.get(next) === 1) throw new Unsupported("$ref");
      else if (!state.has(next)) {
        state.set(next, 1);
        stack.push([next, 0]);
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
    throw new Error(`Kiro does not support Responses structured output: strict schema keyword ${JSON.stringify(error.keyword)} cannot be enforced`);
  }
}

/** Whether a parsed JSON value has the given JSON Schema type. */
function hasType(value: KiroJsonValue, type: string): boolean {
  switch (type) {
    case "object": return value.kind === "object";
    case "array": return value.kind === "array";
    case "string": return value.kind === "string";
    case "number": return value.kind === "number";
    case "integer": return value.kind === "number" && isKiroDecimalInteger(kiroDecimal(value.lexeme));
    case "boolean": return value.kind === "boolean";
    case "null": return value.kind === "null";
    default: return false;
  }
}

/** Whether the model's value equals a schema literal, comparing numbers exactly by their decimal value. */
function literalEquals(literal: unknown, value: KiroJsonValue): boolean {
  switch (value.kind) {
    case "null": return literal === null;
    case "boolean":
    case "string": return literal === value.value;
    case "number":
      return typeof literal === "number"
        && compareKiroDecimal(kiroDecimal(String(literal)), kiroDecimal(value.lexeme)) === 0;
    case "array":
      return Array.isArray(literal) && literal.length === value.items.length
        && value.items.every((item, i) => literalEquals(literal[i], item));
    case "object": {
      if (!isRecord(literal)) return false;
      const keys = Object.keys(literal);
      return keys.length === value.entries.size
        && keys.every(key => value.entries.has(key) && literalEquals(literal[key], value.entries.get(key)!));
    }
  }
}

/** `path` extended by an object key, dotted when the key is an identifier. */
function childPath(path: string, key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
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

/** Validate `value` (holding `valueNodes` JSON values) against the strict `schema`. */
export function validateKiroStrictValue(schema: JsonRecord, value: KiroJsonValue, valueNodes: number): KiroStrictValidation {
  const { root } = preparedFor(schema);
  const budget = KIRO_STRICT_BASE_VISITS + KIRO_STRICT_VISITS_PER_VALUE_NODE * valueNodes;
  let visits = 0;
  const spend = (path: string, cost = 1): void => {
    visits += cost;
    if (visits > budget) throw new OverBudget(`${path}: validating the value needs more work than strict validation allows`);
  };

  const check = (node: StrictNode, value: KiroJsonValue, path: string, depth: number): string | undefined => {
    spend(path);
    if (depth > KIRO_STRICT_MAX_DEPTH) throw new OverBudget(`${path}: the value nests deeper than strict validation allows`);
    if (node.never) return `${path}: no value is allowed here`;
    if (node.ref) {
      const problem = check(node.ref, value, path, depth + 1);
      if (problem) return problem;
    }
    if (node.types && !node.types.some(type => hasType(value, type))) return `${path}: expected a JSON ${node.types.join(" or ")}`;
    if (node.enumValues) {
      spend(path, node.enumValues.length);
      if (!node.enumValues.some(option => literalEquals(option, value))) return `${path}: expected one of the enum values`;
    }
    if (node.constValue && !literalEquals(node.constValue.value, value)) return `${path}: expected the const value`;
    if (node.anyOf && !node.anyOf.some(branch => check(branch, value, path, depth + 1) === undefined)) {
      return `${path}: matched no anyOf branch`;
    }
    if (value.kind === "string") {
      const length = [...value.value].length;
      if (node.minLength !== undefined && length < node.minLength) return `${path}: shorter than minLength`;
      if (node.maxLength !== undefined && length > node.maxLength) return `${path}: longer than maxLength`;
    }
    if (value.kind === "number") {
      const number = kiroDecimal(value.lexeme);
      if (node.minimum && compareKiroDecimal(number, node.minimum) < 0) return `${path}: below minimum`;
      if (node.maximum && compareKiroDecimal(number, node.maximum) > 0) return `${path}: above maximum`;
      if (node.exclusiveMinimum && compareKiroDecimal(number, node.exclusiveMinimum) <= 0) return `${path}: not above exclusiveMinimum`;
      if (node.exclusiveMaximum && compareKiroDecimal(number, node.exclusiveMaximum) >= 0) return `${path}: not below exclusiveMaximum`;
    }
    if (value.kind === "array") {
      if (node.minItems !== undefined && value.items.length < node.minItems) return `${path}: fewer than minItems`;
      if (node.maxItems !== undefined && value.items.length > node.maxItems) return `${path}: more than maxItems`;
      if (node.items) {
        for (const [index, item] of value.items.entries()) {
          const problem = check(node.items, item, `${path}[${index}]`, depth + 1);
          if (problem) return problem;
        }
      }
    }
    if (value.kind === "object") {
      const missing = node.required?.find(key => !value.entries.has(key));
      if (missing !== undefined) return `${path}: missing required property ${JSON.stringify(missing)}`;
      for (const [key, child] of value.entries) {
        const declared = node.properties?.get(key);
        if (!declared && node.closed) return `${path}: unexpected property ${JSON.stringify(key)}`;
        const childNode = declared ?? node.additional;
        if (!childNode) continue;
        const problem = check(childNode, child, childPath(path, key), depth + 1);
        if (problem) return problem;
      }
    }
    return undefined;
  };

  try {
    const problem = check(root, value, "$", 0);
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
