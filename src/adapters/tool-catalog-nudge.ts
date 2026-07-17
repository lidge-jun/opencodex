import {
  isAllowedToolChoice,
  namespacedToolName,
  toolAllowedByChoice,
  toolChoiceAliases,
  type OcxRequestOptions,
  type OcxTool,
  type OcxProviderConfig,
} from "../types";

const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS", "apply_patch"] as const;

function quoteNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(", ");
}

function uniqueNames(names: readonly string[]): string[] {
  return [...new Set(names.filter(name => name.trim().length > 0))];
}

function toolChoiceAllows(tool: Pick<OcxTool, "namespace" | "name">, toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if (isAllowedToolChoice(toolChoice)) return toolAllowedByChoice(tool, new Set(toolChoice.allowedTools));
  return toolChoiceAliases(tool).includes(toolChoice.name);
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

export function buildNonOpenAIToolCatalogNudgeFromNames(wireNames: readonly string[] | undefined): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertised.has(name));

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
  const visibleNames = tools?.flatMap(tool =>
    toolChoiceAllows(tool, toolChoice) ? [toWireName(tool)] : [],
  );
  return buildNonOpenAIToolCatalogNudgeFromNames(visibleNames);
}
