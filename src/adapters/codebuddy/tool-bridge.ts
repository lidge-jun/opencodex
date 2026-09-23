import { createHash } from "node:crypto";
import {
  namespacedToolName,
  toolChoiceToolPredicate,
  type OcxParsedRequest,
  type OcxTool,
  type OcxToolChoice,
} from "../../types";
import { stripResponsesOnlyEncryptedMarker } from "../responses-tool-schema";

export const CODEBUDDY_MCP_SERVER_NAME = "opencodex";
export const CODEBUDDY_MCP_TOOL_PREFIX = `mcp__${CODEBUDDY_MCP_SERVER_NAME}__`;

// These caps protect both the request path and the isolated MCP process. They sit
// below the adapter's 4 MiB total prompt cap so a maximal tool catalog cannot
// crowd the transcript and system prompt out of the request budget.
export const CODEBUDDY_TOOL_LIMITS = Object.freeze({
  maxTools: 128,
  // Captured tool_use blocks accepted in a single assistant turn. Kimi emits
  // parallel calls as sibling content blocks of one assistant message, all
  // streamed before message_stop; the capture-only MCP handler never returns,
  // so every block must be observed before the parent terminates the turn.
  // Each captured call is fully buffered under the per-call translator
  // budget, so this bound also caps per-turn capture memory.
  maxTurnToolCalls: 16,
  maxNameBytes: 512,
  maxDescriptionBytes: 64 * 1024,
  maxSchemaBytes: 224 * 1024,
  maxToolBytes: 256 * 1024,
  maxCatalogBytes: 2 * 1024 * 1024,
  maxSchemaDepth: 32,
  maxSchemaNodes: 4_096,
  maxPatternBytes: 8 * 1024,
});

// CodeBuddy renders MCP tools as `mcp__<server>__<tool>`. Keep the complete
// rendered name comfortably below the common 64-character function-name limit.
const MAX_CODEBUDDY_TOOL_ALIAS_CHARS = 40;
const CODEBUDDY_TOOL_ALIAS_HASH_CHARS = 16;
const CODEBUDDY_TOOL_ALIAS_PATTERN = /^[A-Za-z0-9_-]+$/;
const INVALID_TOOL_NAME_PATTERN = /[\s\u0000-\u001f\u007f]/u;
const INVALID_DESCRIPTION_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const JSON_SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);
const SCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;
const SCHEMA_VALUE_KEYWORDS = [
  "additionalItems",
  "additionalProperties",
  "contains",
  "contentSchema",
  "else",
  "if",
  "not",
  "propertyNames",
  "then",
  "unevaluatedItems",
  "unevaluatedProperties",
] as const;
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;
const NON_NEGATIVE_INTEGER_KEYWORDS = [
  "maxContains",
  "maxItems",
  "maxLength",
  "maxProperties",
  "minContains",
  "minItems",
  "minLength",
  "minProperties",
] as const;
const FINITE_NUMBER_KEYWORDS = [
  "exclusiveMaximum",
  "exclusiveMinimum",
  "maximum",
  "minimum",
] as const;
const STRING_KEYWORDS = [
  "$anchor",
  "$comment",
  "$id",
  "$schema",
  "$dynamicAnchor",
  "contentEncoding",
  "contentMediaType",
  "description",
  "format",
  "title",
] as const;
const BOOLEAN_KEYWORDS = ["deprecated", "nullable", "readOnly", "uniqueItems", "writeOnly"] as const;
const textEncoder = new TextEncoder();

export interface CodeBuddyMcpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface CodeBuddyToolBridge {
  tools: CodeBuddyMcpToolDefinition[];
  /** Exact nested-CLI-emitted MCP name -> Responses wire name. */
  emittedNameMap: Map<string, string>;
  requireToolCall: boolean;
}

interface PreparedTool {
  source: OcxTool;
  wireName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface JsonCloneState {
  active: WeakSet<object>;
  nodes: number;
}

function utf8Bytes(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  // `__proto__` is a valid JSON Schema property name. Defining it as data keeps
  // it from invoking Object.prototype's legacy setter while retaining a normal
  // object prototype for downstream SDKs.
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function invalidJson(reason: string): never {
  throw new Error(`invalid JSON value (${reason})`);
}

/**
 * Clone one schema into inert JSON data. A bounded recursive walk is safe here:
 * the depth check happens before descent, and the resulting maximum call depth
 * is fixed rather than attacker-controlled.
 */
function cloneBoundedJson(value: unknown, depth: number, state: JsonCloneState): unknown {
  if (depth > CODEBUDDY_TOOL_LIMITS.maxSchemaDepth) invalidJson("nesting is too deep");
  state.nodes += 1;
  if (state.nodes > CODEBUDDY_TOOL_LIMITS.maxSchemaNodes) invalidJson("node count is too large");

  if (value === null || typeof value === "boolean" || typeof value === "string") {
    if (typeof value === "string" && hasUnpairedSurrogate(value)) invalidJson("text contains an unpaired surrogate");
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalidJson("numbers must be finite");
    return value;
  }
  if (typeof value !== "object") invalidJson(`unsupported ${typeof value}`);

  const object = value as object;
  if (state.active.has(object)) invalidJson("cycles are not allowed");
  state.active.add(object);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) invalidJson("arrays must use the built-in prototype");
      if (value.length > CODEBUDDY_TOOL_LIMITS.maxSchemaNodes) invalidJson("array length is too large");

      const keys = Reflect.ownKeys(value);
      for (const key of keys) {
        if (key === "length") continue;
        if (typeof key !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(key)) {
          invalidJson("arrays may not have custom properties");
        }
        const index = Number(key);
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.length) {
          invalidJson("array index is invalid");
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
          invalidJson("array entries must be enumerable data properties");
        }
      }
      if (keys.length - 1 !== value.length) invalidJson("sparse arrays are not allowed");

      return value.map(entry => cloneBoundedJson(entry, depth + 1, state));
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidJson("objects must be plain records");
    const out: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") invalidJson("symbol keys are not allowed");
      if (hasUnpairedSurrogate(key)) invalidJson("property name contains an unpaired surrogate");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        invalidJson("object fields must be enumerable data properties");
      }
      defineDataProperty(out, key, cloneBoundedJson(descriptor.value, depth + 1, state));
    }
    return out;
  } finally {
    state.active.delete(object);
  }
}

function invalidSchema(reason: string): never {
  throw new Error(reason);
}

function assertStringArray(value: unknown, keyword: string, allowEmpty = true): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    invalidSchema(`${keyword} must be ${allowEmpty ? "an" : "a non-empty"} array of unique strings`);
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || seen.has(item)) {
      invalidSchema(`${keyword} must be ${allowEmpty ? "an" : "a non-empty"} array of unique strings`);
    }
    seen.add(item);
  }
  return value as string[];
}

function assertSchema(value: unknown, keyword: string): void {
  if (typeof value === "boolean") return;
  if (!isRecord(value)) invalidSchema(`${keyword} must contain a JSON Schema`);
  validateSchema(value);
}

function validateSchemaMap(value: unknown, keyword: string, validatePatterns = false): void {
  if (!isRecord(value)) invalidSchema(`${keyword} must be an object of JSON Schemas`);
  for (const [name, schema] of Object.entries(value)) {
    if (validatePatterns) validatePattern(name, `${keyword} key`);
    assertSchema(schema, `${keyword}.${name}`);
  }
}

function validatePattern(value: unknown, keyword = "pattern"): void {
  if (typeof value !== "string" || utf8Bytes(value) > CODEBUDDY_TOOL_LIMITS.maxPatternBytes) {
    invalidSchema(`${keyword} must be a bounded regular-expression string`);
  }
  try {
    new RegExp(value, "u");
  } catch {
    invalidSchema(`${keyword} is not a valid regular expression`);
  }
}

function validateSchema(schema: Record<string, unknown>): void {
  if (Object.hasOwn(schema, "type")) {
    const type = schema.type;
    if (typeof type === "string") {
      if (!JSON_SCHEMA_TYPES.has(type)) invalidSchema("type contains an unknown JSON Schema type");
    } else {
      const types = assertStringArray(type, "type", false);
      if (types.some(candidate => !JSON_SCHEMA_TYPES.has(candidate))) {
        invalidSchema("type contains an unknown JSON Schema type");
      }
    }
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) {
      validateSchemaMap(schema[keyword], keyword, keyword === "patternProperties");
    }
  }
  for (const keyword of SCHEMA_VALUE_KEYWORDS) {
    if (Object.hasOwn(schema, keyword)) assertSchema(schema[keyword], keyword);
  }
  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (!Array.isArray(value) || (keyword !== "prefixItems" && value.length === 0)) {
      invalidSchema(`${keyword} must be an array of JSON Schemas${keyword === "prefixItems" ? "" : " with at least one entry"}`);
    }
    for (const entry of value) assertSchema(entry, keyword);
  }

  if (Object.hasOwn(schema, "items")) {
    const items = schema.items;
    if (Array.isArray(items)) {
      for (const entry of items) assertSchema(entry, "items");
    } else {
      assertSchema(items, "items");
    }
  }
  if (Object.hasOwn(schema, "required")) assertStringArray(schema.required, "required");
  if (Object.hasOwn(schema, "enum")) {
    if (!Array.isArray(schema.enum) || schema.enum.length === 0) invalidSchema("enum must be a non-empty array");
  }
  if (Object.hasOwn(schema, "examples") && !Array.isArray(schema.examples)) {
    invalidSchema("examples must be an array");
  }

  for (const keyword of NON_NEGATIVE_INTEGER_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const value = schema[keyword];
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      invalidSchema(`${keyword} must be a non-negative safe integer`);
    }
  }
  for (const keyword of FINITE_NUMBER_KEYWORDS) {
    if (!Object.hasOwn(schema, keyword)) continue;
    if (typeof schema[keyword] !== "number" || !Number.isFinite(schema[keyword])) {
      invalidSchema(`${keyword} must be a finite number`);
    }
  }
  if (Object.hasOwn(schema, "multipleOf")) {
    if (typeof schema.multipleOf !== "number" || !Number.isFinite(schema.multipleOf) || schema.multipleOf <= 0) {
      invalidSchema("multipleOf must be a finite number greater than zero");
    }
  }

  for (const keyword of STRING_KEYWORDS) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== "string") {
      invalidSchema(`${keyword} must be a string`);
    }
  }
  for (const keyword of BOOLEAN_KEYWORDS) {
    if (Object.hasOwn(schema, keyword) && typeof schema[keyword] !== "boolean") {
      invalidSchema(`${keyword} must be a boolean`);
    }
  }
  if (Object.hasOwn(schema, "pattern")) validatePattern(schema.pattern);

  for (const keyword of ["$ref", "$dynamicRef"] as const) {
    if (!Object.hasOwn(schema, keyword)) continue;
    const ref = schema[keyword];
    // External references hand resolution authority to the nested runtime and
    // can turn a data-only catalog into network or filesystem access. Local
    // JSON Pointer/anchor references retain recursive and reusable schemas.
    if (typeof ref !== "string" || !ref.startsWith("#")) {
      invalidSchema(`${keyword} must be a local fragment reference`);
    }
  }

  if (Object.hasOwn(schema, "$vocabulary")) {
    if (!isRecord(schema.$vocabulary)) invalidSchema("$vocabulary must be an object");
    for (const enabled of Object.values(schema.$vocabulary)) {
      if (typeof enabled !== "boolean") invalidSchema("$vocabulary values must be booleans");
    }
  }
  if (Object.hasOwn(schema, "dependentRequired")) {
    if (!isRecord(schema.dependentRequired)) invalidSchema("dependentRequired must be an object");
    for (const [name, required] of Object.entries(schema.dependentRequired)) {
      assertStringArray(required, `dependentRequired.${name}`);
    }
  }
  if (Object.hasOwn(schema, "dependencies")) {
    if (!isRecord(schema.dependencies)) invalidSchema("dependencies must be an object");
    for (const [name, dependency] of Object.entries(schema.dependencies)) {
      if (Array.isArray(dependency)) assertStringArray(dependency, `dependencies.${name}`);
      else assertSchema(dependency, `dependencies.${name}`);
    }
  }

  for (const [minimum, maximum] of [
    ["minContains", "maxContains"],
    ["minItems", "maxItems"],
    ["minLength", "maxLength"],
    ["minProperties", "maxProperties"],
  ] as const) {
    if (
      typeof schema[minimum] === "number"
      && typeof schema[maximum] === "number"
      && schema[minimum] > schema[maximum]
    ) {
      invalidSchema(`${minimum} must not exceed ${maximum}`);
    }
  }
  if (
    typeof schema.minimum === "number"
    && typeof schema.maximum === "number"
    && schema.minimum > schema.maximum
  ) {
    invalidSchema("minimum must not exceed maximum");
  }
}

function normalizeInputSchema(parameters: unknown): Record<string, unknown> {
  if (!isRecord(parameters)) invalidSchema("the root must be an object schema");
  const cloned = cloneBoundedJson(parameters, 0, { active: new WeakSet(), nodes: 0 });
  if (!isRecord(cloned)) invalidSchema("the root must be an object schema");
  if (serializedBytes(cloned) > CODEBUDDY_TOOL_LIMITS.maxSchemaBytes) {
    throw new Error(`schema exceeds ${CODEBUDDY_TOOL_LIMITS.maxSchemaBytes} bytes`);
  }
  validateSchema(cloned);
  if (Object.hasOwn(cloned, "type") && cloned.type !== "object") {
    invalidSchema('the root type must be "object"');
  }

  const stripped = stripResponsesOnlyEncryptedMarker(cloned);
  if (!isRecord(stripped)) invalidSchema("the root must remain an object schema");
  if (!Object.hasOwn(stripped, "type")) stripped.type = "object";
  if (serializedBytes(stripped) > CODEBUDDY_TOOL_LIMITS.maxSchemaBytes) {
    throw new Error(`schema exceeds ${CODEBUDDY_TOOL_LIMITS.maxSchemaBytes} bytes`);
  }
  return stripped;
}

function shortHash(value: string, salt = 0): string {
  return createHash("sha256")
    .update(salt === 0 ? value : `${value}\0${salt}`)
    .digest("hex")
    .slice(0, CODEBUDDY_TOOL_ALIAS_HASH_CHARS);
}

function directCodeBuddyAlias(wireName: string): string | undefined {
  return CODEBUDDY_TOOL_ALIAS_PATTERN.test(wireName)
    && wireName.length <= MAX_CODEBUDDY_TOOL_ALIAS_CHARS
    ? wireName
    : undefined;
}

/**
 * Produce a deterministic MCP-safe alias while retaining a readable prefix.
 * `used` closes both normalization and truncated-hash collision domains.
 */
export function codeBuddyToolAlias(wireName: string, used = new Set<string>()): string {
  const direct = directCodeBuddyAlias(wireName);
  if (direct && !used.has(direct)) {
    used.add(direct);
    return direct;
  }

  const cleaned = wireName.replace(/[^A-Za-z0-9_-]/g, "_");
  const maxBaseChars = MAX_CODEBUDDY_TOOL_ALIAS_CHARS - CODEBUDDY_TOOL_ALIAS_HASH_CHARS - 1;
  const base = (cleaned || "tool").slice(0, maxBaseChars);
  for (let salt = 0; salt <= CODEBUDDY_TOOL_LIMITS.maxTools; salt++) {
    const candidate = `${base}_${shortHash(wireName, salt)}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
  throw new Error("CodeBuddy could not allocate a collision-free tool alias.");
}

/** Reserve direct names before hashing and sort the rest so request ordering cannot change aliases. */
function codeBuddyToolAliases(wireNames: readonly string[]): Map<string, string> {
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const wireName of wireNames) {
    const direct = directCodeBuddyAlias(wireName);
    if (direct) {
      aliases.set(wireName, direct);
      used.add(direct);
    }
  }
  const hashedNames = wireNames.filter(wireName => !aliases.has(wireName)).sort();
  for (const wireName of hashedNames) aliases.set(wireName, codeBuddyToolAlias(wireName, used));
  return aliases;
}

function requiresToolCall(choice: OcxToolChoice | undefined): boolean {
  return choice === "required"
    || (typeof choice === "object" && choice !== null && (
      "name" in choice || ("mode" in choice && choice.mode === "required")
    ));
}

function validateToolNamePart(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !hasUnpairedSurrogate(value)
    && !INVALID_TOOL_NAME_PATTERN.test(value);
}

function prepareTool(tool: OcxTool, index: number, seenWireNames: Set<string>): PreparedTool {
  if (!tool || typeof tool !== "object") throw new Error(`CodeBuddy tool ${index + 1} is not an object.`);
  if (!validateToolNamePart(tool.name) || (
    tool.namespace !== undefined && !validateToolNamePart(tool.namespace)
  )) {
    throw new Error(`CodeBuddy tool ${index + 1} has an invalid name or namespace.`);
  }
  const wireName = namespacedToolName(tool.namespace, tool.name);
  if (utf8Bytes(wireName) > CODEBUDDY_TOOL_LIMITS.maxNameBytes) {
    throw new Error(`CodeBuddy tool ${index + 1} name exceeds ${CODEBUDDY_TOOL_LIMITS.maxNameBytes} bytes.`);
  }
  if (seenWireNames.has(wireName)) {
    throw new Error(`CodeBuddy tool catalog contains a duplicate wire name: ${wireName}.`);
  }
  seenWireNames.add(wireName);

  if (typeof tool.description !== "string" || hasUnpairedSurrogate(tool.description)
    || INVALID_DESCRIPTION_CONTROL_PATTERN.test(tool.description)) {
    throw new Error(`CodeBuddy tool ${index + 1} has an invalid description.`);
  }
  const description = tool.description || `Tool: ${wireName}`;
  if (utf8Bytes(description) > CODEBUDDY_TOOL_LIMITS.maxDescriptionBytes) {
    throw new Error(`CodeBuddy tool ${index + 1} description exceeds ${CODEBUDDY_TOOL_LIMITS.maxDescriptionBytes} bytes.`);
  }

  let inputSchema: Record<string, unknown>;
  try {
    inputSchema = normalizeInputSchema(tool.parameters ?? {});
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown schema error";
    throw new Error(`CodeBuddy tool ${index + 1} has an invalid input schema: ${detail}.`);
  }
  return { source: tool, wireName, description, inputSchema };
}

function buildToolBridge(parsed: OcxParsedRequest): CodeBuddyToolBridge {
  const allTools = parsed.context.tools ?? [];
  if (!Array.isArray(allTools)) throw new Error("CodeBuddy tool catalog must be an array.");

  const choice = parsed.options.toolChoice;
  const requireToolCall = requiresToolCall(choice);
  // `none` is an authorization decision, so do not traverse or validate a
  // catalog that the nested CLI must never see. Besides avoiding needless
  // work, this prevents an unselected malformed or oversized definition from
  // turning an explicitly tool-free request into a local adapter failure.
  if (choice === "none") {
    return { tools: [], emittedNameMap: new Map(), requireToolCall: false };
  }

  // Named and allowed-tools choices still need the complete identity view to
  // reject ambiguous shorthand, but schema/description/size validation belongs
  // only to definitions that can actually be advertised. `auto`/`required`
  // select the whole catalog and therefore retain the original full boundary.
  // Non-object entries have no selectable identity. Ignore them for a selective
  // choice; if the choice names nothing else, the required-choice check below
  // still fails closed. Unfiltered modes retain them so prepareTool rejects the
  // malformed catalog as before.
  const identityCatalog = typeof choice === "object" && choice !== null
    ? allTools.filter(tool => tool !== null && typeof tool === "object")
    : allTools;
  const allows = toolChoiceToolPredicate(choice, identityCatalog);
  const selected = identityCatalog
    .map((tool, index) => ({ index, tool }))
    .filter(({ tool }) => allows(tool));
  if (requireToolCall && selected.length === 0) {
    throw new Error("CodeBuddy tool_choice requires a tool, but no matching tool is available.");
  }
  if (selected.length > CODEBUDDY_TOOL_LIMITS.maxTools) {
    throw new Error(`CodeBuddy tool catalog exceeds the ${CODEBUDDY_TOOL_LIMITS.maxTools}-tool limit.`);
  }

  const seenWireNames = new Set<string>();
  const prepared = selected.map(({ index, tool }) => prepareTool(tool, index, seenWireNames));
  const aliases = codeBuddyToolAliases(prepared.map(tool => tool.wireName));
  const definitions = prepared.map((tool, index): CodeBuddyMcpToolDefinition => {
    const definition = {
      name: aliases.get(tool.wireName)!,
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    if (serializedBytes(definition) > CODEBUDDY_TOOL_LIMITS.maxToolBytes) {
      throw new Error(`CodeBuddy tool ${index + 1} definition exceeds ${CODEBUDDY_TOOL_LIMITS.maxToolBytes} bytes.`);
    }
    return definition;
  });
  if (serializedBytes(definitions) > CODEBUDDY_TOOL_LIMITS.maxCatalogBytes) {
    throw new Error(`CodeBuddy tool catalog exceeds ${CODEBUDDY_TOOL_LIMITS.maxCatalogBytes} bytes.`);
  }

  const emittedNameMap = new Map<string, string>();
  const tools = prepared.map((preparedTool, index) => {
    const definition = definitions[index];
    const emittedName = `${CODEBUDDY_MCP_TOOL_PREFIX}${definition.name}`;
    if (emittedNameMap.has(emittedName)) {
      throw new Error("CodeBuddy tool catalog contains a colliding emitted alias.");
    }
    emittedNameMap.set(emittedName, preparedTool.wireName);
    return definition;
  });

  return { tools, emittedNameMap, requireToolCall };
}

export function buildCodeBuddyToolBridge(parsed: OcxParsedRequest): CodeBuddyToolBridge {
  return buildToolBridge(parsed);
}
