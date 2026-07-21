import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxRequestOptions, OcxTool } from "../../types";
import { namespacedToolName } from "../../types";
import { McpToolDefinitionSchema, McpToolsSchema, type McpToolDefinition } from "./gen/agent_pb";

export const OCX_RESPONSES_TOOL_PROVIDER = "opencodex-responses";
export const CODEX_EXEC_COMMAND_TOOL = "exec_command";
export const CODEX_APPLY_PATCH_TOOL = "apply_patch";
export const CURSOR_EXEC_COMMAND_TOOL = CODEX_EXEC_COMMAND_TOOL;
export const CURSOR_SHELL_ALIAS_SYSTEM_NOTE = 'Shell commands use the `exec_command` tool with JSON arguments like {"cmd":"..."}.';
export const CURSOR_SHELL_ALIAS_USER_HINT = "Use exec_command for this shell command.";
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS"] as const;

export const CURSOR_GENERIC_TOOL_USE_USER_HINT = [
  "For generic tool-use/count demos, satisfy the request with repeated `exec_command` calls for harmless commands.",
  "`exec_command` is the Codex Responses bridge exec tool exposed through Cursor's tool protocol; do not describe it as an external MCP server tool.",
  "Do not use `run_shell` unless this turn's tool catalog lists it.",
  "A request for N tools means N separate `exec_command` invocations/results; never satisfy it with one chained shell command such as `cmd1 && cmd2`.",
  "For independent read-only or output-only commands, emit all requested `exec_command` calls in the same response before waiting when the runtime supports parallel tool calls.",
  "The Cursor bridge may suspend after the first returned bridge tool call, so emit sibling calls together before any result is needed.",
  "If parallel emission is unavailable, continue with separate `exec_command` calls until the requested count has returned.",
  "Do not use `tool_search`, external MCP, or resource discovery just to pad the count unless explicitly asked.",
  "Do not suggest or switch to neighboring-agent tools such as `Grep`, `Read`, `Glob`, `Bash`, or `LS` unless this turn's catalog lists those exact names.",
].join(" ");

export const CURSOR_EXEC_COMMAND_INPUT_SCHEMA = {
  type: "object",
  properties: {
    cmd: { type: "string", description: "Shell command to execute." },
    workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
    shell: { type: "string", description: "Shell binary to launch. Defaults to the user's default shell." },
    tty: { type: "boolean", description: "True allocates a PTY for the command; false or omitted uses plain pipes." },
    yield_time_ms: { type: "number", description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
    max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
  },
  required: ["cmd"],
  additionalProperties: false,
} as const;

function isBareCodexExecCommandTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return !tool.namespace && tool.name === CODEX_EXEC_COMMAND_TOOL;
}

export function cursorRequestHasShellAlias(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined): boolean {
  return tools?.some(isBareCodexExecCommandTool) ?? false;
}

export function cursorRequestAdvertisesApplyPatch(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): boolean {
  return tools?.some(tool => !tool.namespace && tool.name === CODEX_APPLY_PATCH_TOOL && tool.freeform === true && cursorToolAllowedByChoice(tool, toolChoice)) ?? false;
}

export function cursorToolWireName(tool: Pick<OcxTool, "namespace" | "name">): string {
  return namespacedToolName(tool.namespace, tool.name);
}

/**
 * Cursor's harness shows MCP tools to the model as `mcp_<providerIdentifier>_<toolName>`; models
 * sometimes call that display name verbatim instead of the advertised short name (live 20:41/21:00
 * sessions: `mcp_opencodex-responses_exec_command`). Fold the display prefix back to the advertised
 * wire name so both spellings resolve to the same client tool instead of "unknown Responses tool".
 */
const CURSOR_MCP_DISPLAY_PREFIX = `mcp_${OCX_RESPONSES_TOOL_PROVIDER}_`;

export function normalizeCursorWireName(name: string): string {
  return name.startsWith(CURSOR_MCP_DISPLAY_PREFIX) ? name.slice(CURSOR_MCP_DISPLAY_PREFIX.length) : name;
}

export function responsesToolNameFromCursorWire(name: string, cursorToolNameMap?: ReadonlyMap<string, string>): string {
  const normalized = normalizeCursorWireName(name);
  return cursorToolNameMap?.get(normalized) ?? normalized;
}

export function cursorToolInputSchema(tool: OcxTool): unknown {
  return isBareCodexExecCommandTool(tool) ? CURSOR_EXEC_COMMAND_INPUT_SCHEMA : (tool.parameters ?? {});
}

function activeTextMentionsExecCommand(text: string): boolean {
  return /\bexec_command\b/i.test(text);
}

function looksLikeShellCommandRequest(text: string): boolean {
  const hasKnownCommand = /(?:^|[\s`$])(?:echo|pwd|ls|cat|grep|rg|find|python3?|node|bun|npm|pnpm|yarn|git|curl|wget|chmod|mkdir|rm|cp|mv|touch|docker|kubectl|make|cargo|go|pytest)(?=\s|$|[`:;|&])/i.test(text);
  const hasRunIntent = /\b(?:run|execute|exec)\b/i.test(text) || /\b(?:stdout|stderr|exit\s+code)\b/i.test(text);
  const hasShellTarget = /\b(?:shell|terminal|command|cmd)\b/i.test(text);
  return /\b(?:run|execute|exec)\s*:/i.test(text) || hasKnownCommand || (hasRunIntent && hasShellTarget);
}

export function isGenericToolUseCountDemoPrompt(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;
  return [
    /\b(?:use|call|invoke|try|exercise)\s+(?:any\s+)?\d+\s+tools?\b/i,
    /\buse\s+any\s+tools?\b/i,
    /\bactually\s+(?:call|use|invoke)\s+(?:the\s+)?tools?\b/i,
    /\b\d+\s+tools?\b/i,
    /\btools?\s+\d+\b/i,
    /\btool\s+use\b/i,
    /아무\s*(?:tool|tools?|도구|툴)/i,
    /(?:tool|tools?|도구|툴)\s*\d+\s*(?:개|번)?/i,
    /\d+\s*(?:개|번)?\s*(?:tool|tools?|도구|툴)/i,
    /(?:도구|툴).{0,12}(?:써|사용|호출).{0,12}\d+\s*(?:개|번)?/i,
  ].some(pattern => pattern.test(trimmed));
}

export function requestedCursorToolUseCount(text: string): number | undefined {
  const patterns = [
    /\b(?:use|call|invoke|try|exercise)\s+(?:any\s+)?(\d+)\s+tools?\b/i,
    /\b(\d+)\s+tools?\b/i,
    /\btools?\s+(\d+)\b/i,
    /(?:tool|tools?|도구|툴)\s*(\d+)\s*(?:개|번)?/i,
    /(\d+)\s*(?:개|번)?\s*(?:tool|tools?|도구|툴)/i,
    /(?:도구|툴).{0,12}(?:써|사용|호출).{0,12}(\d+)\s*(?:개|번)?/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    const count = Number(match?.[1]);
    if (Number.isInteger(count) && count > 0 && count <= 50) return count;
  }
  return undefined;
}

function cursorGenericToolUseHint(text: string): string {
  const count = requestedCursorToolUseCount(text);
  if (!count) return CURSOR_GENERIC_TOOL_USE_USER_HINT;
  return [
    `This turn requests ${count} tool uses: emit exactly ${count} separate \`exec_command\` function calls/results.`,
    `One \`exec_command\` containing chained commands counts as 1 tool call, not ${count}.`,
    `Prefer one parallel tool-call batch containing all ${count} independent \`exec_command\` calls before waiting for results.`,
    CURSOR_GENERIC_TOOL_USE_USER_HINT,
  ].join(" ");
}

function activeTextMentionsGenericToolUseHint(text: string): boolean {
  return text.includes("Codex native exec tool")
    || text.includes("Codex Responses bridge exec tool")
    || text.includes("generic tool-use/count demos");
}

export function shouldAppendCursorGenericToolUseHint(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  text: string,
): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && cursorRequestHasShellAlias(tools)
    && isGenericToolUseCountDemoPrompt(trimmed)
    && !activeTextMentionsGenericToolUseHint(trimmed);
}

export function appendCursorGenericToolUseHint(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  text: string,
): string {
  if (!shouldAppendCursorGenericToolUseHint(tools, text)) return text;
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${cursorGenericToolUseHint(text)}`;
}

export function shouldUseNativeExecOnlyForGenericToolUse(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  text: string,
): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || !cursorRequestHasShellAlias(tools) || !isGenericToolUseCountDemoPrompt(trimmed)) return false;
  return !/\b(?:mcp|resource|resources|tool_search|plugin|plugins|app connector|github)\b/i.test(trimmed)
    && !/(?:리소스|플러그인|깃허브|github)/i.test(trimmed);
}

export function cursorToolsForActivePrompt<T extends Pick<OcxTool, "namespace" | "name">>(
  tools: readonly T[] | undefined,
  activeText: string,
  toolChoice?: OcxRequestOptions["toolChoice"],
): readonly T[] | undefined {
  if (!shouldUseNativeExecOnlyForGenericToolUse(tools, activeText)) return tools;
  const execTools = tools?.filter(isBareCodexExecCommandTool);
  if (execTools?.length && !execTools.some(tool => cursorToolAllowedByChoice(tool, toolChoice))) return tools;
  return execTools && execTools.length > 0 ? execTools : tools;
}

export function shouldAppendCursorShellAliasHint(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  text: string,
): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0
    && cursorRequestHasShellAlias(tools)
    && !activeTextMentionsExecCommand(trimmed)
    && looksLikeShellCommandRequest(trimmed);
}

export function appendCursorShellAliasHint(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
  text: string,
): string {
  if (!shouldAppendCursorShellAliasHint(tools, text)) return text;
  return `${text}${text.endsWith("\n") ? "\n" : "\n\n"}${CURSOR_SHELL_ALIAS_USER_HINT}`;
}

export function cursorToolAllowedByChoice(tool: Pick<OcxTool, "namespace" | "name">, toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if ("allowedTools" in toolChoice) {
    return toolChoice.allowedTools.includes(tool.name) || toolChoice.allowedTools.includes(cursorToolWireName(tool));
  }
  return tool.name === toolChoice.name || cursorToolWireName(tool) === toolChoice.name;
}

function quotedNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(", ");
}

function unavailableNeighborAgentToolNames(wireNames: readonly string[]): string[] {
  const advertised = new Set(wireNames);
  return NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertised.has(name));
}

function discoveryToolLabel(wireNames: readonly string[]): string | undefined {
  const labels: string[] = [];
  if (wireNames.includes("tool_search")) labels.push("`tool_search`");
  if (wireNames.some(name => name.startsWith("mcp__"))) labels.push("MCP");
  if (wireNames.some(name => /resource/i.test(name))) labels.push("resource discovery");
  return labels.length > 0 ? labels.join(", ") : undefined;
}

export function buildCursorToolGuidanceSystemNote(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): string | undefined {
  if (!tools?.length) return undefined;
  const wireNames = [...new Set(
    tools
      .filter(tool => cursorToolAllowedByChoice(tool, toolChoice))
      .map(tool => cursorToolWireName(tool)),
  )];
  if (wireNames.length === 0) return undefined;

  const listedNames = quotedNames(wireNames);
  const hasBareExec = wireNames.includes(CODEX_EXEC_COMMAND_TOOL);
  const hasApplyPatch = cursorRequestAdvertisesApplyPatch(tools, toolChoice);
  const discoveryTools = discoveryToolLabel(wireNames);
  const unavailableNeighborNames = unavailableNeighborAgentToolNames(wireNames);
  const notes = [
    `Cursor tool calls: available tool names are exactly ${listedNames}.`,
    "Use the current tool catalog as ground truth and call only those exact names with their listed argument keys.",
    unavailableNeighborNames.length > 0
      ? `This turn does not expose neighboring-agent tool names ${quotedNames(unavailableNeighborNames)}; do not call or suggest them unless the catalog lists them.`
      : undefined,
    hasBareExec
      ? "`exec_command` is the Codex Responses bridge exec tool for this turn, exposed through Cursor's tool protocol; it is not an external MCP server tool."
      : undefined,
    hasBareExec
      ? "Your tool list may display it under the longer name `mcp_opencodex-responses_exec_command`; both names are the SAME tool — call whichever your list shows, and do not comment on the naming difference to the user."
      : undefined,
    "Cursor product features (Chronicle, screen recording, Notes, Plans, background agents) are available only if this turn's catalog lists a matching tool; do not offer or promise them otherwise.",
    hasBareExec
      ? "For file read/search/listing, use `exec_command` when no more specific listed tool is available."
      : undefined,
    hasApplyPatch
      ? "For file edits, use the `apply_patch` tool, not built-in file write/delete tools."
      : undefined,
    hasBareExec
      ? "For tool-count demos, each counted tool must be a separate `exec_command` invocation/result; do not collapse several requested tools into one chained shell command."
      : undefined,
    "For independent read-only tool-count or batch requests, prefer one response containing multiple tool calls before waiting for results when the runtime supports parallel tool calls.",
    hasBareExec
      ? "For bridge tool-count batches, emit sibling `exec_command` calls together before any result is needed because the bridge may suspend after a returned tool call."
      : undefined,
    discoveryTools
      ? `Use ${discoveryTools} only for explicit discovery/resource tasks, not generic tool-count demos.`
      : undefined,
    "Do not count or report a tool call unless a tool result was actually returned.",
    hasBareExec
      ? "If a built-in file read, directory listing, grep, or shell operation is rejected by the runtime, use \`exec_command\` with the equivalent shell command instead (e.g. \`cat\`, \`ls\`, \`rg\`, \`grep\`). For file edits, use \`apply_patch\` when available."
      : undefined,
  ].filter((note): note is string => typeof note === "string");
  return notes.join(" ");
}

export function encodeCursorInputSchema(schema: unknown): Uint8Array {
  const value: JsonValue = schema && typeof schema === "object"
    ? schema as JsonValue
    : { type: "object", properties: {}, required: [] };
  return toBinary(ValueSchema, fromJson(ValueSchema, value));
}

export function buildCursorToolDefinitions(
  tools: readonly OcxTool[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): McpToolDefinition[] {
  if (!tools?.length) return [];
  return tools.filter(tool => cursorToolAllowedByChoice(tool, toolChoice)).map(tool => {
    const wireName = cursorToolWireName(tool);
    return create(McpToolDefinitionSchema, {
      name: wireName,
      toolName: wireName,
      providerIdentifier: OCX_RESPONSES_TOOL_PROVIDER,
      description: tool.description,
      inputSchema: encodeCursorInputSchema(cursorToolInputSchema(tool)),
    });
  });
}

/** Exact byte size of the protobuf field value Cursor receives for client tool registration. */
export function cursorMcpToolsEncodedSize(
  tools: readonly OcxTool[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): number {
  const definitions = buildCursorToolDefinitions(tools, toolChoice);
  return toBinary(McpToolsSchema, create(McpToolsSchema, { mcpTools: definitions })).byteLength;
}

/** Exact additive contribution of one repeated McpToolDefinition entry. */
export function cursorMcpToolEncodedSize(
  tool: OcxTool,
  toolChoice?: OcxRequestOptions["toolChoice"],
): number {
  return cursorMcpToolsEncodedSize([tool], toolChoice);
}
