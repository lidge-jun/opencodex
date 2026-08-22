import { namespacedToolName } from "../types";
import { collectResponsesToolGroups } from "./tool-groups";

const ROUTED_CUSTOM_TOOL_PASSTHROUGH = new Set(["apply_patch"]);
const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function customToolInput(argumentsText: unknown): string {
  if (typeof argumentsText !== "string") return "";
  try {
    const parsed = JSON.parse(argumentsText) as unknown;
    if (isPlainObject(parsed) && typeof parsed.input === "string") return parsed.input;
  } catch { /* malformed arguments stay visible to the client */ }
  return argumentsText;
}

function customToolWireName(namespace: string | undefined, name: string): string {
  return namespace === BUILTIN_FUNCTIONS_NAMESPACE ? name : namespacedToolName(namespace, name);
}

/** Final upstream identity of a call, including a namespace restored by an earlier rewrite. */
export function routedCustomToolWireName(value: unknown): string | undefined {
  if (!isPlainObject(value) || typeof value.name !== "string") return undefined;
  return customToolWireName(
    typeof value.namespace === "string" ? value.namespace : undefined,
    value.name,
  );
}

/**
 * Names of converted custom declarations after namespace lowering. Restoration uses these exact
 * wire identities so same-named function and custom children in different namespaces stay distinct.
 */
function collectRoutedCustomToolWireNames(body: unknown): Set<string> {
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
        && !ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(tool.name)
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
          && !ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(child.name)
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

export function collectRoutedCustomToolNames(body: unknown): Set<string> {
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
      && !ROUTED_CUSTOM_TOOL_PASSTHROUGH.has(value.name)
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
): unknown {
  if (Array.isArray(value)) return value.map(entry => rewriteForUpstream(entry, names, callIds));
  if (!isPlainObject(value)) return value;

  if (value.type === "custom" && typeof value.name === "string" && names.has(value.name)) {
    const { format: _format, ...rest } = value;
    const isDefinition = typeof value.description === "string"
      || isPlainObject(value.format)
      || isPlainObject(value.parameters);
    if (!isDefinition) return { ...rest, type: "function" };
    const inputDescription = value.name === "exec"
      ? "JavaScript source for unified exec. Use await tools.exec_command(...) for shell commands and text(...) to return textual output; do not provide a bare shell command."
      : "Raw input for this client-executed custom tool.";
    return {
      ...rest,
      type: "function",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: inputDescription,
          },
        },
        required: ["input"],
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
    return {
      ...rest,
      type: "function_call",
      arguments: JSON.stringify({ input: typeof input === "string" ? input : "" }),
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
    const rewritten = rewriteForUpstream(entry, names, callIds);
    next[key] = rewritten;
    changed ||= rewritten !== entry;
  }
  return changed ? next : value;
}

export function rewriteRoutedCustomToolsForUpstream(body: unknown): {
  body: unknown;
  names: Set<string>;
} {
  const conversionNames = collectRoutedCustomToolNames(body);
  const names = collectRoutedCustomToolWireNames(body);
  if (conversionNames.size === 0) return { body, names };
  const callIds = new Set<string>();
  collectConvertedCallIds(body, conversionNames, callIds);
  return { body: rewriteForUpstream(body, conversionNames, callIds), names };
}

export function restoreRoutedCustomCalls(
  value: unknown,
  names: ReadonlySet<string>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(entry => {
      const result = restoreRoutedCustomCalls(entry, names);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreRoutedCustomCalls(entry, names);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  const wireName = routedCustomToolWireName(value);
  if (value.type === "function_call" && wireName !== undefined && names.has(wireName)) {
    restored.type = "custom_tool_call";
    restored.id = customToolItemId(value.id);
    restored.input = customToolInput(value.arguments);
    delete restored.arguments;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreRoutedCustomCallsInJson(
  text: string,
  names: ReadonlySet<string>,
): string {
  if (names.size === 0) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreRoutedCustomCalls(payload, names);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

export function unwrapRoutedCustomToolArguments(argumentsText: unknown): string {
  return customToolInput(argumentsText);
}
