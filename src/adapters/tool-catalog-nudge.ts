import {
  namespacedToolName,
  toolChoiceToolPredicate,
  type OcxRequestOptions,
  type OcxTool,
  type OcxProviderConfig,
} from "../types";

// Tool names that exist only in OTHER agent harnesses (Claude Code and friends). Naming one
// here tells a routed model not to call it unless this turn's catalog really lists it.
//
// `apply_patch` is deliberately absent: it is Codex's own first-class edit tool, not a
// neighbor's. Under Codex code mode it is reachable as a nested `tools.apply_patch(...)`
// helper declared inside the `exec` tool description rather than as a top-level wire tool,
// so a flat catalog check cannot see it and forbidding it pushed routed models into
// `python3` heredoc edits. The sibling list in `./cursor/tool-definitions.ts` never
// included it either.
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS"] as const;

function quoteNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(", ");
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => name.trim().length > 0))];
}

function isOpenAIOrChatGPTHost(hostname: string): boolean {
  return hostname === "openai.com"
    || hostname.endsWith(".openai.com")
    || hostname === "chatgpt.com"
    || hostname.endsWith(".chatgpt.com");
}

export function shouldInjectNonOpenAIToolCatalogNudge(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    return !isOpenAIOrChatGPTHost(new URL(provider.baseUrl).hostname);
  } catch {
    return true;
  }
}

export function buildNonOpenAIToolCatalogNudgeFromNames(
  wireNames: readonly string[] | undefined,
  toWireName: (name: string) => string = name => name,
): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  // Compare in the catalog's own coordinate system. `advertised` holds WIRE names, so a
  // provider that rewrites them (Claude OAuth `custom_`, Anthropic compat `cx_`) would never
  // match a bare neighbor name and would forbid tools the turn actually advertises — the
  // catalog would list `custom_apply_patch` while the same sentence banned `apply_patch`.
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(
    name => !advertised.has(name) && !advertised.has(toWireName(name)),
  );

  return [
    "Tool contract: use the current tool catalog as ground truth.",
    `Valid tool names for this turn are exactly ${quoteNames(names)}.`,
    "Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
    unavailableNeighborNames.length > 0
      ? `Do not use neighboring-agent tool names ${quoteNames(unavailableNeighborNames)} unless this turn's catalog lists those exact names.`
      : undefined,
    "If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
    "Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
  ].filter((line): line is string => typeof line === "string").join(" ");
}

export function buildNonOpenAIToolCatalogNudgeForTools(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
  toWireName: (tool: Pick<OcxTool, "namespace" | "name">) => string = tool => namespacedToolName(tool.namespace, tool.name),
): string | undefined {
  const visibleNames = tools
    ?.filter(toolChoiceToolPredicate(toolChoice))
    .map(toWireName);
  // Neighbor names are bare and un-namespaced, so probe the same transform with a bare tool.
  return buildNonOpenAIToolCatalogNudgeFromNames(
    visibleNames,
    name => toWireName({ name }),
  );
}
