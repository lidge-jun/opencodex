import { namespacedToolName } from "../types";
import { collectResponsesToolGroups } from "./tool-groups";

export interface RoutedNamespaceToolIdentity {
  namespace: string;
  name: string;
}

export type RoutedNamespaceToolAliases = ReadonlyMap<string, RoutedNamespaceToolIdentity>;

const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function namespaceIdentity(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

function namespaceToolIdentity(tool: unknown): RoutedNamespaceToolIdentity | undefined {
  if (
    !isPlainObject(tool)
    || tool.type !== "namespace"
    || typeof tool.name !== "string"
    || tool.name.length === 0
    || !Array.isArray(tool.tools)
    || tool.tools.length === 0
  ) return undefined;
  return { namespace: tool.name, name: "" };
}

function namespaceChildren(tool: unknown): Record<string, unknown>[] | undefined {
  const identity = namespaceToolIdentity(tool);
  if (!identity || !isPlainObject(tool) || !Array.isArray(tool.tools)) return undefined;
  const children: Record<string, unknown>[] = [];
  for (const child of tool.tools) {
    if (
      !isPlainObject(child)
      || child.type === "namespace"
      || typeof child.name !== "string"
      || child.name.length === 0
    ) return undefined;
    children.push(child);
  }
  return children;
}

function addSelector(
  selectors: Map<string, string | null>,
  selector: string,
  wireName: string,
): void {
  const current = selectors.get(selector);
  if (current === undefined) selectors.set(selector, wireName);
  else if (current !== wireName) selectors.set(selector, null);
}

type NamespaceRewritePlan = {
  aliases: Map<string, RoutedNamespaceToolIdentity>;
  identities: Map<string, string>;
  selectors: Map<string, string | null>;
};

function buildRewritePlan(groups: readonly unknown[][]): NamespaceRewritePlan {
  const aliases = new Map<string, RoutedNamespaceToolIdentity>();
  const identities = new Map<string, string>();
  const selectors = new Map<string, string | null>();
  const directNames = new Set<string>();

  for (const group of groups) {
    for (const tool of group) {
      if (
        isPlainObject(tool)
        && tool.type !== "namespace"
        && typeof tool.name === "string"
        && tool.name.length > 0
      ) {
        directNames.add(tool.name);
        addSelector(selectors, tool.name, tool.name);
      }
    }
  }

  const wireOwners = new Map<string, string>();
  for (const name of directNames) wireOwners.set(name, `direct:${name}`);

  for (const group of groups) {
    for (const tool of group) {
      const parent = namespaceToolIdentity(tool);
      const children = namespaceChildren(tool);
      if (!parent || !children) continue;
      for (const child of children) {
        const childName = child.name as string;
        const identity = namespaceIdentity(parent.namespace, childName);
        const wireName = parent.namespace === BUILTIN_FUNCTIONS_NAMESPACE
          ? childName
          : namespacedToolName(parent.namespace, childName);
        const owner = wireOwners.get(wireName);
        if (owner !== undefined && owner !== identity) {
          throw new Error(
            `namespace tool wire-name collision for "${wireName}"; rename one of the colliding tools`,
          );
        }
        wireOwners.set(wireName, identity);
        identities.set(identity, wireName);
        addSelector(selectors, wireName, wireName);
        addSelector(selectors, `${parent.namespace}.${childName}`, wireName);
        addSelector(selectors, childName, wireName);
        if (parent.namespace !== BUILTIN_FUNCTIONS_NAMESPACE) {
          aliases.set(wireName, { namespace: parent.namespace, name: childName });
        }
      }
    }
  }

  return { aliases, identities, selectors };
}

function rewriteToolList(
  tools: unknown[],
  plan: NamespaceRewritePlan,
): { tools: unknown[]; changed: boolean } {
  let changed = false;
  const rewritten: unknown[] = [];
  for (const tool of tools) {
    const parent = namespaceToolIdentity(tool);
    const children = namespaceChildren(tool);
    if (!parent || !children) {
      rewritten.push(tool);
      continue;
    }
    changed = true;
    for (const child of children) {
      const identity = namespaceIdentity(parent.namespace, child.name as string);
      const wireName = plan.identities.get(identity);
      rewritten.push(wireName && wireName !== child.name ? { ...child, name: wireName } : child);
    }
  }
  return changed ? { tools: rewritten, changed: true } : { tools, changed: false };
}

function rewriteNamedSelector(value: unknown, plan: NamespaceRewritePlan): unknown {
  if (!isPlainObject(value) || typeof value.name !== "string") return value;
  const explicitNamespace = typeof value.namespace === "string" ? value.namespace : undefined;
  const wireName = explicitNamespace
    ? plan.identities.get(namespaceIdentity(explicitNamespace, value.name))
    : plan.selectors.get(value.name) ?? undefined;
  if (!wireName) return value;
  const { namespace: _namespace, ...rest } = value;
  return wireName === value.name && explicitNamespace === undefined
    ? value
    : { ...rest, name: wireName };
}

function rewriteToolChoice(value: unknown, plan: NamespaceRewritePlan): unknown {
  if (!isPlainObject(value)) return value;
  if ((value.type === "function" || value.type === "custom") && typeof value.name === "string") {
    return rewriteNamedSelector(value, plan);
  }
  if (value.type !== "allowed_tools" || !Array.isArray(value.tools)) return value;
  let changed = false;
  const tools = value.tools.map(tool => {
    if (
      !isPlainObject(tool)
      || (tool.type !== "function" && tool.type !== "custom")
      || typeof tool.name !== "string"
    ) return tool;
    const rewritten = rewriteNamedSelector(tool, plan);
    changed ||= rewritten !== tool;
    return rewritten;
  });
  return changed ? { ...value, tools } : value;
}

function rewriteInputItem(item: unknown, plan: NamespaceRewritePlan): unknown {
  if (!isPlainObject(item)) return item;
  if (item.type === "additional_tools" && Array.isArray(item.tools)) {
    const rewritten = rewriteToolList(item.tools, plan);
    return rewritten.changed ? { ...item, tools: rewritten.tools } : item;
  }
  if (
    (item.type === "function_call" || item.type === "custom_tool_call")
    && typeof item.name === "string"
  ) return rewriteNamedSelector(item, plan);
  return item;
}

/**
 * Lower Codex's private Responses namespace declarations for public/third-party gateways.
 *
 * Codex 0.147 groups ordinary tools under the reserved `functions` namespace; those children
 * become bare top-level declarations. Other namespaces use the same collision-checked
 * `<namespace>__<name>` wire identity as the chat adapters. The returned request-local aliases
 * are the only names response restoration is allowed to expand.
 */
export function rewriteRoutedNamespaceToolsForUpstream(body: unknown): {
  body: unknown;
  aliases: Map<string, RoutedNamespaceToolIdentity>;
} {
  if (!isPlainObject(body)) return { body, aliases: new Map() };
  const groups = collectResponsesToolGroups(body);
  const plan = buildRewritePlan(groups);
  if (plan.identities.size === 0) return { body, aliases: plan.aliases };

  let tools = body.tools;
  if (Array.isArray(body.tools)) tools = rewriteToolList(body.tools, plan).tools;

  let input = body.input;
  if (Array.isArray(body.input)) input = body.input.map(item => rewriteInputItem(item, plan));

  const toolChoice = rewriteToolChoice(body.tool_choice, plan);
  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    aliases: plan.aliases,
  };
}

export function restoreRoutedNamespaceCalls(
  value: unknown,
  aliases: RoutedNamespaceToolAliases,
): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const restored = value.map(entry => {
      const result = restoreRoutedNamespaceCalls(entry, aliases);
      changed ||= result.changed;
      return result.value;
    });
    return changed ? { value: restored, changed: true } : { value, changed: false };
  }
  if (!isPlainObject(value)) return { value, changed: false };

  let changed = false;
  const restored: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const result = restoreRoutedNamespaceCalls(entry, aliases);
    restored[key] = result.value;
    changed ||= result.changed;
  }

  if (
    (value.type === "function_call" || value.type === "custom_tool_call")
    && typeof value.name === "string"
  ) {
    const identity = aliases.get(value.name);
    if (identity) {
      restored.name = identity.name;
      restored.namespace = identity.namespace;
      changed = true;
    }
  }
  return changed ? { value: restored, changed: true } : { value, changed: false };
}

export function restoreRoutedNamespaceCallsInJson(
  text: string,
  aliases: RoutedNamespaceToolAliases,
): string {
  if (aliases.size === 0) return text;
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return text;
  }
  const restored = restoreRoutedNamespaceCalls(payload, aliases);
  return restored.changed ? JSON.stringify(restored.value) : text;
}

export function createRoutedNamespaceCallRestoreRewrite(
  aliases: RoutedNamespaceToolAliases,
): (payload: string) => string {
  return payload => restoreRoutedNamespaceCallsInJson(payload, aliases);
}
