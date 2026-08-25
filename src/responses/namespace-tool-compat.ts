import { namespacedToolName } from "../types";
import { collectResponsesToolGroups } from "./tool-groups";

export interface RoutedNamespaceToolIdentity {
  namespace: string;
  name: string;
  /**
   * The kind the tool was DECLARED as. Restoration and `tool_choice` matching both
   * need it: a wire name identifies which tool, not which kind of call may carry it,
   * so without this a tool declared `function` could be selected by a `custom`
   * selector and come back as a `custom_tool_call` — the same name/kind mismatch
   * that motivated narrowing the alias map in the first place.
   */
  kind: "function" | "custom";
}

export type RoutedNamespaceToolAliases = ReadonlyMap<string, RoutedNamespaceToolIdentity>;

const BUILTIN_FUNCTIONS_NAMESPACE = "functions";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function namespaceIdentity(namespace: string, name: string): string {
  return `${namespace}\u0000${name}`;
}

/**
 * A name that can become a wire tool name. Control characters are rejected because the identity
 * key below joins namespace and name with NUL: a name carrying one could otherwise forge another
 * tool's identity and silently take over its wire name.
 */
function isRepresentableName(name: unknown): name is string {
  if (typeof name !== "string" || name.length === 0) return false;
  for (let index = 0; index < name.length; index += 1) {
    const code = name.charCodeAt(index);
    // C0 controls and DEL, written as code points so this source never carries one itself.
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

type NamespaceGroup = {
  namespace: string;
  /** Children that can be lowered to a flat declaration; unrepresentable ones are omitted. */
  children: Record<string, unknown>[];
};

/**
 * Read a private namespace group, or return undefined when the value is not one.
 *
 * Children that cannot be expressed as a flat declaration — a nested group, a missing name, a
 * control character in the name — are dropped, and a group left with no children is dropped whole
 * by the rewrite. Preserving the private `namespace` shape instead would lose every tool in the
 * request rather than one: the strict gateways this layer exists for reject that tool type before
 * inference, which is the failure the layer was written to prevent.
 */
function parseNamespaceGroup(tool: unknown): NamespaceGroup | undefined {
  if (
    !isPlainObject(tool)
    || tool.type !== "namespace"
    || !isRepresentableName(tool.name)
    || !Array.isArray(tool.tools)
  ) return undefined;
  const children: Record<string, unknown>[] = [];
  for (const child of tool.tools) {
    if (!isPlainObject(child) || child.type === "namespace" || !isRepresentableName(child.name)) continue;
    children.push(child);
  }
  return { namespace: tool.name, children };
}

/**
 * Wire identity of a lowered tool. A `functions` child and an identical top-level declaration share
 * one identity because they denote the same logical tool: `buildTools` flattens the reserved group
 * without a namespace, so the parser already treats them as one and tolerates the duplicate.
 */
function loweredIdentity(namespace: string, name: string): string {
  return namespace === BUILTIN_FUNCTIONS_NAMESPACE
    ? namespaceIdentity(BUILTIN_FUNCTIONS_NAMESPACE, name)
    : namespaceIdentity(namespace, name);
}

function loweredWireName(namespace: string, name: string): string {
  return namespace === BUILTIN_FUNCTIONS_NAMESPACE ? name : namespacedToolName(namespace, name);
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
  bareWireNames: Set<string>;
  identities: Map<string, string>;
  selectors: Map<string, string | null>;
};

/** Two distinct logical tools would occupy one wire name; the caller maps this to a 400. */
export class NamespaceToolCollisionError extends Error {}

function buildRewritePlan(groups: readonly unknown[][]): NamespaceRewritePlan {
  const aliases = new Map<string, RoutedNamespaceToolIdentity>();
  const bareWireNames = new Set<string>();
  const identities = new Map<string, string>();
  const selectors = new Map<string, string | null>();
  const wireOwners = new Map<string, string>();

  for (const group of groups) {
    for (const tool of group) {
      if (isPlainObject(tool) && tool.type !== "namespace" && isRepresentableName(tool.name)) {
        // A bare declaration is the reserved group's flattened form, so it claims that identity:
        // declaring the same tool both ways is the duplicate the parser already tolerates, not a
        // collision, and `promoteClientLoadedTools` produces exactly that shape.
        wireOwners.set(tool.name, loweredIdentity(BUILTIN_FUNCTIONS_NAMESPACE, tool.name));
        bareWireNames.add(tool.name);
        addSelector(selectors, tool.name, tool.name);
      }
    }
  }

  for (const group of groups) {
    for (const tool of group) {
      const parsed = parseNamespaceGroup(tool);
      if (!parsed) continue;
      for (const child of parsed.children) {
        const childName = child.name as string;
        const identity = loweredIdentity(parsed.namespace, childName);
        const wireName = loweredWireName(parsed.namespace, childName);
        const owner = wireOwners.get(wireName);
        if (owner !== undefined && owner !== identity) {
          throw new NamespaceToolCollisionError(
            `namespace tool wire-name collision for "${wireName}"; rename one of the colliding tools`,
          );
        }
        wireOwners.set(wireName, identity);
        identities.set(identity, wireName);
        addSelector(selectors, wireName, wireName);
        addSelector(selectors, `${parsed.namespace}.${childName}`, wireName);
        addSelector(selectors, childName, wireName);
        if (parsed.namespace !== BUILTIN_FUNCTIONS_NAMESPACE) {
          // A child declared `custom` stays custom; everything else lowers to a
          // function, which is how `buildTools` flattens it upstream.
          const kind = child.type === "custom" ? "custom" : "function";
          aliases.set(wireName, { namespace: parsed.namespace, name: childName, kind });
        }
      }
    }
  }

  return { aliases, bareWireNames, identities, selectors };
}

/**
 * Lower every namespace group in one tool container. `emitted` is shared across the whole body so
 * a tool declared both bare and under `functions` is written once rather than twice.
 *
 * No `type: "namespace"` value survives this pass, including a group this layer cannot read:
 * relaying the private shape is what the strict gateway rejects.
 */
function rewriteToolList(
  tools: unknown[],
  plan: NamespaceRewritePlan,
  emitted: Set<string>,
): unknown[] {
  let changed = false;
  const rewritten: unknown[] = [];
  for (const tool of tools) {
    if (isPlainObject(tool) && tool.type === "namespace") {
      changed = true;
      const parsed = parseNamespaceGroup(tool);
      if (!parsed) continue;
      for (const child of parsed.children) {
        const wireName = plan.identities.get(loweredIdentity(parsed.namespace, child.name as string));
        // A bare declaration is the canonical representation of a `functions` child. Decide that
        // from the complete catalog rather than whichever container happens to be rewritten first.
        if (
          wireName === undefined
          || (parsed.namespace === BUILTIN_FUNCTIONS_NAMESPACE && plan.bareWireNames.has(wireName))
          || emitted.has(wireName)
        ) continue;
        emitted.add(wireName);
        rewritten.push(wireName === child.name ? child : { ...child, name: wireName });
      }
      continue;
    }
    if (isPlainObject(tool) && isRepresentableName(tool.name)) {
      if (emitted.has(tool.name)) {
        changed = true;
        continue;
      }
      emitted.add(tool.name);
    }
    rewritten.push(tool);
  }
  return changed ? rewritten : tools;
}

/**
 * Resolve one `{namespace?, name}` reference to its wire name and drop the private `namespace` key.
 *
 * `bareFallback` is for tool_choice, where a bare name is a selector the caller expects resolved
 * against the catalog. Replayed call items pass `false`: a history item records which tool actually
 * ran, so resolving a bare name through a same-named namespace child would rewrite history on a
 * coincidence rather than translate it.
 *
 * An explicit namespace is always lowered, even when this turn's catalog no longer declares that
 * group — a compaction turn drops the whole catalog, and a catalog can change mid-session. Leaving
 * the key in place ships a Codex-private field to a gateway that rejects unknown fields, which is
 * the failure this layer exists to prevent, and this layer's own response restoration is what put
 * the key on the item.
 */
/**
 * A selector's `namespace` is either absent — meaning "unqualified, resolve the bare
 * name" — or a string naming the group. A present-but-non-string value is neither, and
 * a malformed selector must not authorize anything: not through the unqualified
 * fallback, and not by happening to carry an already-flattened wire name, which would
 * otherwise match the alias map exactly and arm it anyway.
 */
function hasMalformedNamespace(value: Record<string, unknown>): boolean {
  return "namespace" in value && typeof value.namespace !== "string";
}

function rewriteNamedSelector(
  value: unknown,
  plan: NamespaceRewritePlan,
  bareFallback: boolean,
): unknown {
  if (!isPlainObject(value) || typeof value.name !== "string") return value;
  // Malformed: hand it back untouched so no rewrite occurs. Authorization rejects it
  // separately — returning it unchanged is not by itself enough, because the name it
  // carries may already BE a wire name.
  if (hasMalformedNamespace(value)) return value;
  const namespace = value.namespace;
  if (typeof namespace !== "string") {
    if (!bareFallback) return value;
    const wireName = plan.selectors.get(value.name) ?? undefined;
    return wireName === undefined || wireName === value.name ? value : { ...value, name: wireName };
  }
  const { namespace: _dropped, ...rest } = value;
  const wireName = plan.identities.get(loweredIdentity(namespace, value.name))
    ?? loweredWireName(namespace, value.name);
  return { ...rest, name: wireName };
}

function rewriteToolChoice(value: unknown, plan: NamespaceRewritePlan): unknown {
  if (!isPlainObject(value)) return value;
  if ((value.type === "function" || value.type === "custom") && typeof value.name === "string") {
    return rewriteNamedSelector(value, plan, true);
  }
  if (value.type !== "allowed_tools" || !Array.isArray(value.tools)) return value;
  let changed = false;
  const tools = value.tools.map(tool => {
    if (!isPlainObject(tool) || typeof tool.name !== "string") return tool;
    const rewritten = rewriteNamedSelector(tool, plan, true);
    changed ||= rewritten !== tool;
    return rewritten;
  });
  return changed ? { ...value, tools } : value;
}

/**
 * Keep response restoration inside the caller's per-turn tool authorization boundary. The
 * upstream sees every flattened declaration even when `tool_choice` narrows the tools it may call,
 * so its output cannot be trusted merely because a wire name appeared in that catalog.
 */
function authorizedAliases(
  aliases: Map<string, RoutedNamespaceToolIdentity>,
  toolChoice: unknown,
): Map<string, RoutedNamespaceToolIdentity> {
  if (toolChoice === undefined || toolChoice === "auto" || toolChoice === "required") return aliases;
  if (toolChoice === "none" || !isPlainObject(toolChoice)) return new Map();

  // name -> the kind the selector claimed. A selector authorizes a tool only when it
  // names it AND agrees about what kind of tool it is.
  let authorized: Map<string, "function" | "custom">;
  if (
    (toolChoice.type === "function" || toolChoice.type === "custom")
    && typeof toolChoice.name === "string"
  ) {
    // A malformed namespace makes the whole selector untrustworthy, even when its
    // name is already a flattened wire name that would match the alias map exactly.
    if (hasMalformedNamespace(toolChoice)) return new Map();
    authorized = new Map([[toolChoice.name, toolChoice.type]]);
  } else if (toolChoice.type === "allowed_tools" && Array.isArray(toolChoice.tools)) {
    authorized = new Map();
    for (const tool of toolChoice.tools) {
      // Match the top-level branch above: only a function/custom selector can
      // authorize a client namespace call. `allowed_tools` entries are typed
      // `{type: string}` by the schema, so the accepted set is open-ended and
      // an allowlist is the only closure that also covers kinds added later.
      // Without this, `{type: "file_search", name: "<wire-name>"}` keeps the
      // alias, and an upstream `function_call` carrying that name is restored
      // into a namespace call the caller never permitted.
      if (!isPlainObject(tool)) continue;
      if (tool.type !== "function" && tool.type !== "custom") continue;
      if (typeof tool.name !== "string") continue;
      if (hasMalformedNamespace(tool)) continue;
      authorized.set(tool.name, tool.type);
    }
  } else {
    // An explicit selector for another tool kind does not authorize a client namespace call.
    return new Map();
  }

  // The kind must agree too. A wire name says WHICH tool, not what kind of call may
  // carry it, so a `custom` selector naming a tool declared `function` is the same
  // name/kind mismatch as a `file_search` selector naming it — narrower, but the
  // same class, and `allowed_tools[].type` accepts any string so both are reachable.
  return new Map(
    [...aliases].filter(([wireName, identity]) => authorized.get(wireName) === identity.kind),
  );
}

function rewriteInputItem(item: unknown, plan: NamespaceRewritePlan, emitted: Set<string>): unknown {
  if (!isPlainObject(item)) return item;
  if (item.type === "additional_tools" && Array.isArray(item.tools)) {
    const tools = rewriteToolList(item.tools, plan, emitted);
    return tools === item.tools ? item : { ...item, tools };
  }
  if (
    (item.type === "function_call" || item.type === "custom_tool_call")
    && typeof item.name === "string"
  ) return rewriteNamedSelector(item, plan, false);
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

  // Deliberately not gated on the plan being non-empty: a turn whose catalog is absent can still
  // replay call items carrying a private `namespace`.
  const emitted = new Set<string>();
  const tools = Array.isArray(body.tools) ? rewriteToolList(body.tools, plan, emitted) : body.tools;

  let input = body.input;
  if (Array.isArray(body.input)) {
    let inputChanged = false;
    const rewrittenInput = body.input.map(item => {
      const next = rewriteInputItem(item, plan, emitted);
      if (next !== item) inputChanged = true;
      return next;
    });
    if (inputChanged) input = rewrittenInput;
  }

  const toolChoice = rewriteToolChoice(body.tool_choice, plan);
  return {
    body: {
      ...body,
      ...(tools !== body.tools ? { tools } : {}),
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== body.tool_choice ? { tool_choice: toolChoice } : {}),
    },
    aliases: authorizedAliases(plan.aliases, toolChoice),
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
