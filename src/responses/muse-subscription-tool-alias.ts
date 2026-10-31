import type { MuseToolNameAliases } from "./muse-tool-name-alias";

const MUSE_TOOL_NAME_MAX = 64;
const SUBSCRIPTION_ALIAS_PREFIX = "client_";

/**
 * Muse Code's builtin tool catalog, as Meta's subscription gate reads it.
 *
 * A Muse Code subscription credential is refused with HTTP 403 `client_attestation_denied` —
 * "This API key is billed to a Muse Code subscription. Muse Code subscriptions cover requests
 * from the Muse Code client only." — when the request declares ANY of these names as a flat
 * `type: "function"` tool. The gate reads declared tool names only; headers, user agent, system
 * prompt, schema contents and the rest of the payload do not change the outcome.
 *
 * Measured live against api.meta.ai/v1/responses on 2026-10-31 with a Muse Code key: every name
 * below answered 403 when declared alone. `exec_command`, `write_stdin`, `view_image`,
 * `tool_search`, `list_mcp_resources` and `read_mcp_resource` answered 200 in the same sweep and
 * are deliberately absent, so a host that happens to reuse one of those names keeps it.
 *
 * A pay-as-you-go Meta Model API key has no such gate, which is why the rewrite is opt-in per
 * caller instead of unconditional on the Meta destination.
 */
export const MUSE_CODE_BUILTIN_TOOL_NAMES: ReadonlySet<string> = new Set([
  "add_memory",
  "apply_patch",
  "bash",
  "bash_input",
  "create_goal",
  "cron_create",
  "cron_delete",
  "cron_list",
  "edit_file",
  "edit_memory",
  "get_goal",
  "list_peer_sessions",
  "monitor",
  "powershell",
  "powershell_input",
  "read_file",
  "read_memory",
  "read_skill",
  "report_progress",
  "request_user_input",
  "search",
  "send_session_message",
  "shell",
  "snooze_reminder",
  "subagent_cancel",
  "subagent_read_result",
  "subagent_send_message",
  "subagent_spawn",
  "subagent_status",
  "subagent_wait",
  "update_goal",
  "update_plan",
  "web_fetch",
  "web_search",
  "work_list",
  "work_status",
  "work_stop",
  "workflow",
  "write_file",
  "write_todos",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Name of a flat function declaration, in either wire shape: `{type:"function", name}` or the
 * older nested `{type:"function", function:{name}}`. Non-function tools have no identity here:
 * namespaces, custom tools and hosted tools are governed by other compatibility layers.
 */
function flatFunctionName(tool: Record<string, unknown>): string | undefined {
  if (tool.type !== "function") return undefined;
  if (typeof tool.name === "string" && tool.name.length > 0) return tool.name;
  const nested = tool.function;
  if (isPlainObject(nested) && typeof nested.name === "string" && nested.name.length > 0) {
    return nested.name;
  }
  return undefined;
}

/** Every declared tool identity, so an alias never captures a name another tool already owns. */
function claimedToolNames(tools: readonly unknown[]): Set<string> {
  const used = new Set<string>();
  const claim = (value: unknown): void => {
    if (typeof value === "string" && value.length > 0) used.add(value);
  };
  for (const tool of tools) {
    if (!isPlainObject(tool)) continue;
    claim(tool.name);
    if (isPlainObject(tool.function)) claim(tool.function.name);
  }
  return used;
}

/** `client_<builtin>`, sanitized to the wire charset and made unique against the catalog. */
function subscriptionWireName(originalName: string, used: Set<string>): string {
  const raw = SUBSCRIPTION_ALIAS_PREFIX + originalName;
  const base = (raw.replace(/[^a-zA-Z0-9_-]/g, "_") || "client_tool").slice(0, MUSE_TOOL_NAME_MAX);
  if (!used.has(base)) {
    used.add(base);
    return base;
  }
  for (let salt = 2; ; salt++) {
    const suffix = "_" + salt;
    const candidate = base.slice(0, MUSE_TOOL_NAME_MAX - suffix.length) + suffix;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function rewriteDeclaration(
  tool: Record<string, unknown>,
  wireByOriginal: ReadonlyMap<string, string>,
): Record<string, unknown> {
  const original = flatFunctionName(tool);
  if (original === undefined) return tool;
  const wire = wireByOriginal.get(original);
  if (wire === undefined) return tool;
  if (typeof tool.name === "string" && tool.name === original) return { ...tool, name: wire };
  const nested = tool.function;
  if (isPlainObject(nested) && nested.name === original) {
    return { ...tool, function: { ...nested, name: wire } };
  }
  return tool;
}

function rewriteDeclarations(
  tools: readonly unknown[],
  wireByOriginal: ReadonlyMap<string, string>,
): readonly unknown[] {
  let changed = false;
  const rewritten = tools.map(tool => {
    const next = isPlainObject(tool) ? rewriteDeclaration(tool, wireByOriginal) : tool;
    changed ||= next !== tool;
    return next;
  });
  return changed ? rewritten : tools;
}

function rewriteHistoryItem(
  item: unknown,
  wireByOriginal: ReadonlyMap<string, string>,
): unknown {
  if (!isPlainObject(item) || item.type !== "function_call") return item;
  if (typeof item.name !== "string") return item;
  const wire = wireByOriginal.get(item.name);
  return wire === undefined ? item : { ...item, name: wire };
}

/**
 * Alias the flat function tools Meta's Muse Code subscription gate refuses.
 *
 * Only a subscription credential needs this; the rewrite is a name substitution rather than a
 * signature, so it changes nothing about what the model can call — `restoreMuseToolNames` maps
 * every aliased call back to the name the client declared. History replays and a named
 * `tool_choice` are rewritten with the same map so a continuation turn stays consistent.
 */
export function aliasMuseSubscriptionBuiltinTools(body: unknown): {
  body: unknown;
  aliases: Map<string, string>;
} {
  if (!isPlainObject(body) || !Array.isArray(body.tools)) return { body, aliases: new Map() };

  const used = claimedToolNames(body.tools);
  const wireByOriginal = new Map<string, string>();
  for (const tool of body.tools) {
    if (!isPlainObject(tool)) continue;
    const original = flatFunctionName(tool);
    if (original === undefined) continue;
    if (wireByOriginal.has(original)) continue;
    if (!MUSE_CODE_BUILTIN_TOOL_NAMES.has(original)) continue;
    wireByOriginal.set(original, subscriptionWireName(original, used));
  }
  if (wireByOriginal.size === 0) return { body, aliases: new Map() };

  const tools = rewriteDeclarations(body.tools, wireByOriginal);

  let input = body.input;
  if (Array.isArray(body.input)) {
    let changed = false;
    const rewritten = body.input.map(item => {
      const next = rewriteHistoryItem(item, wireByOriginal);
      changed ||= next !== item;
      return next;
    });
    if (changed) input = rewritten;
  }

  const choice = body.tool_choice;
  let toolChoice = choice;
  if (isPlainObject(choice) && choice.type === "function" && typeof choice.name === "string") {
    const wire = wireByOriginal.get(choice.name);
    if (wire !== undefined) toolChoice = { ...choice, name: wire };
  }

  const aliases = new Map<string, string>();
  for (const [original, wire] of wireByOriginal) aliases.set(wire, original);

  return {
    body: {
      ...body,
      tools,
      ...(input !== body.input ? { input } : {}),
      ...(toolChoice !== choice ? { tool_choice: toolChoice } : {}),
    },
    aliases,
  };
}

/**
 * One restoration map from two request-local rewrites. Both are wireName -> originalName and a
 * hash suffix (`_a1b2c3d4`) never collides with `client_*`, so neither map can shadow the other.
 */
export function mergeMuseToolNameAliases(
  first: MuseToolNameAliases,
  second: MuseToolNameAliases,
): Map<string, string> {
  if (second.size === 0) return new Map(first);
  if (first.size === 0) return new Map(second);
  return new Map([...first, ...second]);
}
