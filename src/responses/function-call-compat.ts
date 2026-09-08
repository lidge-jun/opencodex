import { coerceIntegerToolArguments } from "../lib/tool-argument-integers";
import { namespacedToolName } from "../types/tools";
import { rewriteRoutedNamespaceToolsForUpstream } from "./namespace-tool-compat";
import { collectResponsesToolGroups } from "./tool-groups";

export interface FunctionCallRepairSchema {
  name: string;
  namespace?: string;
  parameters?: Record<string, unknown>;
}

/** Keys are canonical original identities, never a bare-name fallback for a namespace. */
export type FunctionCallRepairSchemas = ReadonlyMap<string, FunctionCallRepairSchema>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** JSON object member order is immaterial; array elements retain their exact order. */
function sameSchemaValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length
      && left.every((value, index) => sameSchemaValue(value, right[index]));
  }
  if (!isObject(left) || !isObject(right)) return false;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length
    && keys.every(key => Object.hasOwn(right, key) && sameSchemaValue(left[key], right[key]));
}

function namespaceOf(value: unknown): string | undefined {
  return typeof value === "string" && value !== "functions" ? value : undefined;
}

function selectorAllows(
  selector: unknown,
  lowered: unknown,
  wireName: string,
  identity: FunctionCallRepairSchema,
): boolean {
  if (!isObject(selector) || selector.type !== "function" || typeof selector.name !== "string") return false;
  if ("namespace" in selector) {
    if (typeof selector.namespace !== "string" || selector.namespace.length === 0) return false;
    return namespaceOf(selector.namespace) === identity.namespace && selector.name === identity.name;
  }
  return isObject(lowered) && lowered.type === "function" && lowered.name === wireName;
}

/** Caller supplies currentTurnWireToolCatalogBody BEFORE provider schema lowering. */
export function collectFunctionCallRepairSchemas(body: unknown): Map<string, FunctionCallRepairSchema> {
  const schemas = new Map<string, FunctionCallRepairSchema>();
  if (!isObject(body)) return schemas;
  const groups = collectResponsesToolGroups(body);
  if (Array.isArray(body.input)) {
    for (const entry of body.input) {
      if (isObject(entry) && entry.type === "tool_search_output" && Array.isArray(entry.tools)) groups.push(entry.tools);
    }
  }
  // Reuse namespace selector resolution, retaining schemas from the original objects below.
  // This local catalog view includes loaded definitions without revisiting replay history or
  // teaching the shared tool-group collector a new transport-wide interpretation.
  const lowered = rewriteRoutedNamespaceToolsForUpstream({ ...body, tools: groups.flat(), input: [] }).body;
  const choice = body.tool_choice;
  const loweredChoice = isObject(lowered) ? lowered.tool_choice : undefined;
  const occupied = new Map<string, { kind: unknown; identity: FunctionCallRepairSchema } | null>();
  const register = (tool: unknown, namespace?: string): void => {
    if (!isObject(tool) || typeof tool.name !== "string" || tool.name.length === 0) return;
    const identity: FunctionCallRepairSchema = {
      name: tool.name,
      ...(namespace ? { namespace } : {}),
      ...(isObject(tool.parameters) ? { parameters: tool.parameters } : {}),
    };
    const key = namespacedToolName(namespace, tool.name);
    if (occupied.has(key)) {
      const previous = occupied.get(key);
      // Conflicting duplicate declarations cannot choose a schema by insertion order.
      if (!previous || previous.kind !== tool.type
        || previous.identity.namespace !== namespace
        || previous.identity.name !== tool.name
        || !sameSchemaValue(previous.identity.parameters, identity.parameters)) {
        occupied.set(key, null);
      }
    } else occupied.set(key, { kind: tool.type, identity });
  };
  for (const group of groups) {
    for (const tool of group) {
      if (!isObject(tool)) continue;
      if (tool.type === "namespace") {
        if (typeof tool.name !== "string" || !tool.name || !Array.isArray(tool.tools)) continue;
        for (const child of tool.tools) register(child, namespaceOf(tool.name));
      } else if (tool.type === "function" && isObject(tool.function)) {
        register({ ...tool.function, type: "function" });
      } else register(tool);
    }
  }
  for (const [key, entry] of occupied) {
    if (!entry || entry.kind !== "function") continue;
    let allowed = choice === undefined || choice === "auto" || choice === "required";
    if (isObject(choice)) {
      if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
        const selectors = isObject(loweredChoice) && Array.isArray(loweredChoice.tools) ? loweredChoice.tools : [];
        allowed = choice.tools.some((selector, index) => selectorAllows(selector, selectors[index], key, entry.identity));
      } else allowed = selectorAllows(choice, loweredChoice, key, entry.identity);
    }
    if (allowed) schemas.set(key, entry.identity);
  }
  return schemas;
}

function repairItem(item: unknown, schemas: FunctionCallRepairSchemas, completed: boolean): unknown {
  if (!isObject(item) || item.type !== "function_call" || typeof item.name !== "string"
    || typeof item.arguments !== "string") return item;
  if (item.status !== "completed" && !(item.status === undefined && completed)) return item;
  if ("namespace" in item && (typeof item.namespace !== "string" || !item.namespace)) return item;
  const namespace = namespaceOf(item.namespace);
  const schema = schemas.get(namespacedToolName(namespace, item.name));
  if (!schema) return item;
  // An explicit namespace is an identity coordinate, not another spelling to guess at.
  if ("namespace" in item && (schema.namespace !== namespace || schema.name !== item.name)) return item;
  const raw = item.arguments;
  if (raw !== "") {
    try {
      let unsafe = false;
      JSON.parse(raw, (_key, value: unknown) => {
        if (typeof value === "number" && (!Number.isFinite(value)
          || (Number.isInteger(value) && !Number.isSafeInteger(value)))) unsafe = true;
        return value;
      });
      // Re-stringifying another repaired field must not round an unsafe sibling number.
      if (unsafe) return item;
    } catch { return item; }
  }
  const argumentsText = coerceIntegerToolArguments(raw || "{}", schema.parameters, schema.namespace ? undefined : schema.name);
  return argumentsText === raw ? item : { ...item, arguments: argumentsText };
}

/** Only executable completion slots are visited; metadata and custom input are opaque. */
export function repairFunctionCalls(
  value: unknown,
  schemas: FunctionCallRepairSchemas,
): { value: unknown; changed: boolean } {
  if (schemas.size === 0 || !isObject(value)) return { value, changed: false };
  if (typeof value.status === "string" && ["failed", "incomplete", "cancelled", "in_progress", "queued"].includes(value.status)) return { value, changed: false };
  let next: unknown = value;
  if (value.type === "function_call") next = repairItem(value, schemas, false);
  else if (value.type === "response.output_item.done") {
    const item = repairItem(value.item, schemas, true);
    if (item !== value.item) next = { ...value, item };
  } else if (value.type === "response.completed" && isObject(value.response)) {
    const response = value.response;
    if ((response.status === undefined || response.status === "completed") && Array.isArray(response.output)) {
      const original = response.output;
      const output = original.map(item => repairItem(item, schemas, true));
      if (output.some((item, index) => item !== original[index])) next = { ...value, response: { ...response, output } };
    }
  } else if (typeof value.type !== "string" || !value.type.startsWith("response.")) {
    if (Array.isArray(value.output)) {
      const original = value.output;
      const output = original.map(item => repairItem(item, schemas, value.status === "completed"));
      if (output.some((item, index) => item !== original[index])) next = { ...value, output };
    }
  }
  return { value: next, changed: next !== value };
}

export function repairFunctionCallsInJson(text: string, schemas: FunctionCallRepairSchemas): string {
  if (schemas.size === 0) return text;
  let payload: unknown;
  try { payload = JSON.parse(text); } catch { return text; }
  const repaired = repairFunctionCalls(payload, schemas);
  return repaired.changed ? JSON.stringify(repaired.value) : text;
}
