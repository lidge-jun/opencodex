import { namespacedToolName, normalizeDeclaredToolName } from "../types";
import {
  normalizeApplyPatchDelimiters,
  repairFreeformToolInput,
  unwrapFreeformToolInput,
} from "./apply-patch-envelope";
import { compileCodeModeHelperInput } from "./code-mode-helper-compat";
import { collectResponsesToolGroups } from "./tool-groups";

type ProjectedField = "code" | "patch" | "input";
export type RoutedCustomToolProjection = "legacy" | "direct-first";

const ROUTED_CUSTOM_TOOL_PASSTHROUGH = new Set(["apply_patch"]);
const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

function routedCustomToolPassesThrough(
  name: string,
  supportsResponsesCustomTools: boolean | undefined,
  projection: RoutedCustomToolProjection = "legacy",
): boolean {
  return projection !== "direct-first"
    && supportsResponsesCustomTools !== false
    && ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(name);
}

export function projectedCustomToolField(name: string): ProjectedField {
  if (name === "exec") return "code";
  if (name === "apply_patch") return "patch";
  return "input";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function customToolWireName(namespace: string | undefined, name: string): string {
  return namespace === BUILTIN_FUNCTIONS_NAMESPACE ? name : namespacedToolName(namespace, name);
}

function toolChoiceAllowsRoutedCustomTool(
  body: unknown,
  wireName: string,
  candidateNames: ReadonlySet<string>,
): boolean {
  if (!isPlainObject(body)) return true;
  const choice = body.tool_choice;
  if (choice === undefined || choice === null || choice === "auto" || choice === "required") {
    return true;
  }
  if (choice === "none") return false;
  if (!isPlainObject(choice)) return true;

  const selectorAllows = (selector: unknown): boolean => {
    if (!isPlainObject(selector) || typeof selector.name !== "string") return false;
    if (selector.type !== "custom") return false;
    if (typeof selector.namespace === "string") {
      return customToolWireName(selector.namespace, selector.name) === wireName;
    }
    if (selector.name === wireName) return true;
    const suffix = `__${selector.name}`;
    const candidates = [...candidateNames].filter(name => name.endsWith(suffix));
    return candidates.length === 1 && candidates[0] === wireName;
  };

  if (choice.type === "function" || choice.type === "custom") return selectorAllows(choice);
  if (choice.type === "allowed_tools" && Array.isArray(choice.tools)) {
    return choice.tools.some(selectorAllows);
  }
  return false;
}

/** Final upstream identity of a call, including a namespace restored by an earlier rewrite. */
export function routedCustomToolWireName(value: unknown): string | undefined {
  if (!isPlainObject(value) || typeof value.name !== "string") return undefined;
  return customToolWireName(
    typeof value.namespace === "string" ? value.namespace : undefined,
    value.name,
  );
}

/** Resolve a provider-emitted wire name to the routed custom tool the client declared. */
export function routedCustomToolTargetName(
  value: unknown,
  names: ReadonlySet<string>,
  declaredNames?: ReadonlySet<string>,
): string | undefined {
  const wireName = routedCustomToolWireName(value);
  if (wireName === undefined) return undefined;
  if (names.has(wireName)) return wireName;
  if (!isPlainObject(value) || typeof value.namespace === "string") return undefined;
  const normalized = normalizeDeclaredToolName(wireName, declaredNames);
  return normalized !== wireName && names.has(normalized) ? normalized : undefined;
}

/**
 * Names of custom declarations after namespace lowering. The selection flag separates converted
 * names from native passthrough names while keeping same-named function and custom children distinct.
 */
function collectRoutedCustomToolWireNames(
  body: unknown,
  supportsResponsesCustomTools?: boolean,
  passthrough = false,
  projection: RoutedCustomToolProjection = "legacy",
): Set<string> {
  const names = new Set<string>();
  const groups = collectResponsesToolGroups(body);
  const bareWireNames = new Set<string>();
  for (const group of groups) {
    for (const tool of group) {
      if (
        isPlainObject(tool)
        && tool.type !== "namespace"
        && typeof tool.name === "string"
      ) bareWireNames.add(tool.name);
    }
  }

  for (const group of groups) {
    for (const tool of group) {
      if (!isPlainObject(tool)) continue;
      if (
        tool.type === "custom"
        && typeof tool.name === "string"
        && routedCustomToolPassesThrough(tool.name, supportsResponsesCustomTools, projection) === passthrough
      ) {
        names.add(tool.name);
        continue;
      }
      if (tool.type !== "namespace" || typeof tool.name !== "string" || !Array.isArray(tool.tools)) {
        continue;
      }
      for (const child of tool.tools) {
        if (
          isPlainObject(child)
          && child.type === "custom"
          && typeof child.name === "string"
          && routedCustomToolPassesThrough(child.name, supportsResponsesCustomTools, projection) === passthrough
          && (!passthrough || tool.name === BUILTIN_FUNCTIONS_NAMESPACE)
          && !(tool.name === BUILTIN_FUNCTIONS_NAMESPACE && bareWireNames.has(child.name))
        ) names.add(customToolWireName(tool.name, child.name));
      }
    }
  }
  return names;
}
export function customToolItemId(id: unknown): unknown {
  if (typeof id !== "string") return id;
  return id.startsWith("fc_") ? `ctc_${id.slice(3)}` : id;
}

export function collectRoutedCustomToolNames(
  body: unknown,
  supportsOrProjection?: boolean | RoutedCustomToolProjection,
  explicitProjection: RoutedCustomToolProjection = "legacy",
): Set<string> {
  const supportsResponsesCustomTools = typeof supportsOrProjection === "boolean"
    ? supportsOrProjection
    : undefined;
  const projection = typeof supportsOrProjection === "string"
    ? supportsOrProjection
    : explicitProjection;
  const names = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (!isPlainObject(value)) return;
    if (
      value.type === "custom"
      && typeof value.name === "string"
      && !routedCustomToolPassesThrough(value.name, supportsResponsesCustomTools, projection)
    ) {
      names.add(value.name);
    }
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(body);
  return names;
}

function collectConvertedCallIds(value: unknown, names: ReadonlySet<string>, out: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectConvertedCallIds(entry, names, out);
    return;
  }
  if (!isPlainObject(value)) return;
  if (
    (value.type === "custom_tool_call" || value.type === "function_call")
    && typeof value.name === "string"
    && names.has(value.name)
    && typeof value.call_id === "string"
  ) {
    out.add(value.call_id);
  }
  for (const entry of Object.values(value)) collectConvertedCallIds(entry, names, out);
}

function rewriteForUpstream(
  value: unknown,
  names: ReadonlySet<string>,
  callIds: ReadonlySet<string>,
  projection: RoutedCustomToolProjection,
): unknown {
  if (Array.isArray(value)) return value.map(entry => rewriteForUpstream(entry, names, callIds, projection));
  if (!isPlainObject(value)) return value;

  if (value.type === "custom" && typeof value.name === "string" && names.has(value.name)) {
    const { format: _format, ...rest } = value;
    const isDefinition = typeof value.description === "string"
      || isPlainObject(value.format)
      || isPlainObject(value.parameters);
    if (!isDefinition) return { ...rest, type: "function" };
    const field = projection === "direct-first" ? projectedCustomToolField(value.name) : "input";
    const inputDescription = field === "code"
      ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
      : field === "patch"
        ? "Patch text for apply_patch, beginning exactly with `*** Begin Patch`."
        : "Raw input for this client-executed custom tool.";
    return {
      ...rest,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          [field]: {
            type: "string",
            description: inputDescription,
          },
        },
        required: [field],
        additionalProperties: false,
      },
    };
  }

  if (
    value.type === "custom_tool_call"
    && typeof value.name === "string"
    && names.has(value.name)
  ) {
    const { input, id: _id, ...rest } = value;
    const field = projection === "direct-first" ? projectedCustomToolField(value.name) : "input";
    return {
      ...rest,
      type: "function_call",
      arguments: JSON.stringify({ [field]: typeof input === "string" ? input : "" }),
    };
  }

  if (
    value.type === "custom_tool_call_output"
    && typeof value.call_id === "string"
    && callIds.has(value.call_id)
  ) {
    return { ...value, type: "function_call_output" };
  }

  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const rewritten = rewriteForUpstream(entry, names, callIds, projection);
    next[key] = rewritten;
    changed ||= rewritten !== entry;
  }
  return changed ? next : value;
}

function directFirstToolOrder(body: unknown): unknown {
  if (!isPlainObject(body)) return body;
  let changed = false;
  const next = { ...body };
  const moveExecLast = (value: unknown): unknown => {
    if (!Array.isArray(value)) return value;
    const direct = value.filter(entry => !(isPlainObject(entry) && entry.name === "exec"));
    const exec = value.filter(entry => isPlainObject(entry) && entry.name === "exec");
    if (exec.length === 0) return value;
    const ordered = [...direct, ...exec];
    return ordered.every((entry, index) => entry === value[index]) ? value : ordered;
  };
  const tools = moveExecLast(body.tools);
  if (tools !== body.tools) {
    next.tools = tools;
    changed = true;
  }
  if (Array.isArray(body.input)) {
    const originalInput = body.input;
    const input = originalInput.map(item => {
      if (!isPlainObject(item) || item.type !== "additional_tools") return item;
      const additional = moveExecLast(item.tools);
      return additional === item.tools ? item : { ...item, tools: additional };
    });
    if (input.some((item, index) => item !== originalInput[index])) {
      next.input = input;
      changed = true;
    }
  }
  return changed ? next : body;
}

export function rewriteRoutedCustomToolsForUpstream(
  body: unknown,
  supportsOrProjection?: boolean | RoutedCustomToolProjection,
  explicitProjection: RoutedCustomToolProjection = "legacy",
): {
  body: unknown;
  names: Set<string>;
  repairNames: Set<string>;
} {
  const supportsResponsesCustomTools = typeof supportsOrProjection === "boolean"
    ? supportsOrProjection
    : undefined;
  const projection = typeof supportsOrProjection === "string"
    ? supportsOrProjection
    : explicitProjection;
  const conversionNames = collectRoutedCustomToolNames(
    body,
    supportsResponsesCustomTools,
    projection,
  );
  const names = collectRoutedCustomToolWireNames(
    body,
    supportsResponsesCustomTools,
    false,
    projection,
  );
  const repairNames = collectRoutedCustomToolWireNames(
    body,
    supportsResponsesCustomTools,
    true,
    projection,
  );
  for (const name of repairNames) {
    if (!toolChoiceAllowsRoutedCustomTool(body, name, repairNames)) repairNames.delete(name);
  }
  if (conversionNames.size === 0) return { body, names, repairNames };
  const callIds = new Set<string>();
  collectConvertedCallIds(body, conversionNames, callIds);
  const rewritten = rewriteForUpstream(body, conversionNames, callIds, projection);
  return {
    body: projection === "direct-first" ? directFirstToolOrder(rewritten) : rewritten,
    names,
    repairNames,
  };
}

export function restoreRoutedCustomCalls(
  value: unknown,
  names: ReadonlySet<string>,
  repairNames: ReadonlySet<string> = new Set(),
  declaredNames?: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (!isPlainObject(value)) return { value, changed: false };

  const restoreItem = (item: unknown): { value: unknown; changed: boolean } => {
    if (!isPlainObject(item)) return { value: item, changed: false };
    const wireName = routedCustomToolWireName(item);
    const targetName = routedCustomToolTargetName(item, names, declaredNames);
    if (
      (item.type === "function_call" || item.type === "custom_tool_call")
      && typeof item.name === "string"
      && wireName !== undefined
      && targetName !== undefined
    ) {
      const sourceInput = item.type === "function_call" ? item.arguments : item.input;
      const aliased = targetName !== wireName;
      const restored: Record<string, unknown> = {
        ...item,
        type: "custom_tool_call",
        id: customToolItemId(item.id),
        name: aliased ? targetName : item.name,
        input: aliased && sourceInput !== ""
          ? compileCodeModeHelperInput(sourceInput, item.name)
          : unwrapRoutedCustomToolArguments(
            sourceInput,
            targetName,
            typeof item.namespace === "string" ? item.namespace : undefined,
          ),
      };
      delete restored.arguments;
      if (aliased) delete restored.namespace;
      return { value: restored, changed: true };
    }
    if (
      item.type === "custom_tool_call"
      && typeof item.name === "string"
      && wireName !== undefined
      && repairNames.has(wireName)
      && typeof item.input === "string"
    ) {
      const input = normalizeApplyPatchDelimiters(item.input);
      if (input !== item.input) return { value: { ...item, input }, changed: true };
    }
    return { value: item, changed: false };
  };

  const restoreOutput = (output: unknown): { value: unknown; changed: boolean } => {
    if (!Array.isArray(output)) return { value: output, changed: false };
    let changed = false;
    const restored = output.map(item => {
      const result = restoreItem(item);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value: output, changed: false };
  };

  let changed = false;
  const restored: Record<string, unknown> = { ...value };
  const output = restoreOutput(value.output);
  if (output.changed) {
    restored.output = output.value;
    changed = true;
  }

  if (
    (value.type === "response.output_item.added" || value.type === "response.output_item.done")
    && isPlainObject(value.item)
  ) {
    const item = restoreItem(value.item);
    if (item.changed) {
      restored.item = item.value;
      changed = true;
    }
  }

  if (
    typeof value.type === "string"
    && value.type.startsWith("response.")
    && isPlainObject(value.response)
  ) {
    const response = restoreRoutedCustomCalls(value.response, names, repairNames, declaredNames);
    if (response.changed) {
      restored.response = response.value;
      changed = true;
    }
  }

  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreRoutedCustomCallsInJson(
  text: string,
  names: ReadonlySet<string>,
  repairNames: ReadonlySet<string> = new Set(),
  declaredNames?: ReadonlySet<string>,
): string {
  if (names.size === 0 && repairNames.size === 0) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreRoutedCustomCalls(payload, names, repairNames, declaredNames);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

export function unwrapRoutedCustomToolArguments(
  argumentsText: unknown,
  toolName = "",
  namespace?: string,
): string {
  if (!toolName) return unwrapFreeformToolInput(argumentsText);
  let projected = argumentsText;
  if (typeof argumentsText === "string") {
    try {
      const parsed = JSON.parse(argumentsText) as unknown;
      const field = projectedCustomToolField(toolName);
      if (isPlainObject(parsed) && typeof parsed[field] === "string") {
        projected = JSON.stringify({ input: parsed[field] });
      }
    } catch { /* malformed arguments stay visible */ }
  }
  return repairFreeformToolInput(projected, toolName, namespace);
}
