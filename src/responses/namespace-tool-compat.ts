import { namespacedToolName } from "../types";

export interface NamespaceToolTarget {
  namespace: string;
  name: string;
}

export class NamespaceToolCompatibilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NamespaceToolCompatibilityError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function toolGroups(body: Record<string, unknown>): unknown[][] {
  const groups: unknown[][] = [];
  if (Array.isArray(body.tools)) groups.push(body.tools);
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isObject(item) && item.type === "additional_tools" && Array.isArray(item.tools)) {
        groups.push(item.tools);
      }
    }
  }
  return groups;
}

function namespaceAlias(namespace: string, name: string): string {
  return namespace === "functions" ? name : namespacedToolName(namespace, name);
}

/**
 * xAI's Responses endpoint does not accept Codex's client-only `namespace` tool container.
 * Flatten only containers whose children remain callable without loss. Anything malformed,
 * unsupported, or collision-prone fails closed instead of dropping a tool or widening access.
 */
export function rewriteNamespaceToolsForXai(body: unknown): {
  body: unknown;
  aliases: Map<string, NamespaceToolTarget>;
} {
  if (!isObject(body)) return { body, aliases: new Map() };
  const groups = toolGroups(body);
  if (!groups.some(group => group.some(tool => isObject(tool) && tool.type === "namespace"))) {
    return { body, aliases: new Map() };
  }

  const flatNames = new Set<string>();
  for (const group of groups) {
    for (const tool of group) {
      if (isObject(tool) && tool.type !== "namespace" && typeof tool.name === "string") {
        flatNames.add(tool.name);
      }
    }
  }

  const aliases = new Map<string, NamespaceToolTarget>();
  const emittedNamespaceNames = new Map<string, NamespaceToolTarget>();
  const rewriteGroup = (group: unknown[]): unknown[] => {
    const rewritten: unknown[] = [];
    for (const tool of group) {
      if (!isObject(tool) || tool.type !== "namespace") {
        rewritten.push(tool);
        continue;
      }
      if (typeof tool.name !== "string" || tool.name.length === 0 || !Array.isArray(tool.tools)) {
        throw new NamespaceToolCompatibilityError("xAI namespace tool requires a non-empty name and tools array");
      }
      const namespace = tool.name;
      for (const child of tool.tools) {
        if (!isObject(child) || child.type !== "function" || typeof child.name !== "string" || child.name.length === 0) {
          throw new NamespaceToolCompatibilityError(
            `xAI cannot safely flatten unsupported child in namespace ${namespace}`,
          );
        }
        const alias = namespaceAlias(namespace, child.name);
        if (flatNames.has(alias)) {
          throw new NamespaceToolCompatibilityError(`xAI namespace tool alias collides with ${alias}`);
        }
        const target = { namespace, name: child.name };
        const previous = emittedNamespaceNames.get(alias);
        if (previous && (previous.namespace !== namespace || previous.name !== child.name)) {
          throw new NamespaceToolCompatibilityError(`xAI namespace tool alias is ambiguous: ${alias}`);
        }
        if (previous) {
          throw new NamespaceToolCompatibilityError(`xAI namespace tool alias is duplicated: ${alias}`);
        }
        emittedNamespaceNames.set(alias, target);
        if (namespace !== "functions") aliases.set(alias, target);
        rewritten.push({ ...child, name: alias });
      }
    }
    return rewritten;
  };

  let tools = body.tools;
  if (Array.isArray(tools)) tools = rewriteGroup(tools);
  let input = body.input;
  if (Array.isArray(input)) {
    input = input.map(item => {
      if (!isObject(item)) return item;
      if (item.type === "additional_tools" && Array.isArray(item.tools)) {
        return { ...item, tools: rewriteGroup(item.tools) };
      }
      if (item.type === "function_call" && typeof item.namespace === "string" && typeof item.name === "string") {
        const alias = namespaceAlias(item.namespace, item.name);
        const target = emittedNamespaceNames.get(alias);
        if (!target || target.namespace !== item.namespace || target.name !== item.name) {
          throw new NamespaceToolCompatibilityError(`xAI namespace history references undeclared tool ${alias}`);
        }
        const { namespace: _namespace, ...rest } = item;
        return { ...rest, name: alias };
      }
      return item;
    });
  }

  const rewriteChoiceEntry = (entry: unknown): unknown => {
    if (!isObject(entry) || typeof entry.namespace !== "string" || typeof entry.name !== "string") return entry;
    const alias = namespaceAlias(entry.namespace, entry.name);
    const target = emittedNamespaceNames.get(alias);
    if (!target || target.namespace !== entry.namespace || target.name !== entry.name) {
      throw new NamespaceToolCompatibilityError(`xAI namespace tool choice references undeclared tool ${alias}`);
    }
    const { namespace: _namespace, ...rest } = entry;
    return { ...rest, name: alias };
  };
  let toolChoice = body.tool_choice;
  if (isObject(toolChoice)) {
    if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
      toolChoice = { ...toolChoice, tools: toolChoice.tools.map(rewriteChoiceEntry) };
    } else {
      toolChoice = rewriteChoiceEntry(toolChoice);
    }
  }

  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    aliases,
  };
}

export function restoreNamespaceToolCalls(
  value: unknown,
  aliases: ReadonlyMap<string, NamespaceToolTarget>,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(item => {
      const result = restoreNamespaceToolCalls(item, aliases);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isObject(value)) return { value, changed: false };
  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const result = restoreNamespaceToolCalls(item, aliases);
    restored[key] = result.value;
    changed ||= result.changed;
  }
  const target = value.type === "function_call" && typeof value.name === "string"
    ? aliases.get(value.name)
    : undefined;
  if (target) {
    restored.name = target.name;
    restored.namespace = target.namespace;
    changed = true;
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreNamespaceToolCallsInJson(
  text: string,
  aliases: ReadonlyMap<string, NamespaceToolTarget>,
): string {
  if (aliases.size === 0) return text;
  try {
    const restored = restoreNamespaceToolCalls(JSON.parse(text), aliases);
    return restored.changed ? JSON.stringify(restored.value) : text;
  } catch {
    return text;
  }
}
