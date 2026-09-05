import { namespacedToolName, toolChoiceAliases, type OcxRequestOptions, type OcxTool } from "../../types";

export const OCX_RESPONSES_TOOL_PROVIDER = "opencodex-responses";
export const CODEX_EXEC_COMMAND_TOOL = "exec_command";
export const CODEX_SHELL_COMMAND_TOOL = "shell_command";
/** Codex Desktop unified-exec client tool. Companion of `wait`; not an `exec_command` schema alias. */
export const CODEX_UNIFIED_EXEC_TOOL = "exec";
export const CODEX_WAIT_TOOL = "wait";
export const CODEX_APPLY_PATCH_TOOL = "apply_patch";
export const CODEX_TOOL_SEARCH_TOOL = "tool_search";
export const CURSOR_EDIT_FILE_TOOL = "edit_file";
export const CURSOR_MULTI_EDIT_TOOL = "multi_edit";
export const CURSOR_STRUCTURED_EDIT_TOOLS = [CURSOR_EDIT_FILE_TOOL, CURSOR_MULTI_EDIT_TOOL] as const;
export const CURSOR_EXEC_COMMAND_TOOL = CODEX_EXEC_COMMAND_TOOL;
export const CODEX_SHELL_BRIDGE_TOOL_NAMES = [CODEX_EXEC_COMMAND_TOOL, CODEX_SHELL_COMMAND_TOOL] as const;

export function isCodexShellBridgeToolName(name: string): boolean {
  return (CODEX_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Direct key lookup, then shell_command/exec_command sibling aliases when the key is a bridge name.
 * Used for catalog admission, schema normalize maps, and Responses name maps (#399).
 */
export function resolveShellBridgeAliasKey<T>(
  key: string,
  lookup: (name: string) => T | undefined,
): T | undefined {
  const direct = lookup(key);
  if (direct !== undefined) return direct;
  if (!isCodexShellBridgeToolName(key)) return undefined;
  for (const alias of CODEX_SHELL_BRIDGE_TOOL_NAMES) {
    if (alias === key) continue;
    const hit = lookup(alias);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

export function cursorToolChoiceAliases(tool: Pick<OcxTool, "namespace" | "name">): string[] {
  const aliases = new Set(toolChoiceAliases(tool));
  if (isBareCodexShellBridgeTool(tool)) {
    for (const alias of CODEX_SHELL_BRIDGE_TOOL_NAMES) aliases.add(alias);
  }
  return [...aliases];
}

function catalogHasBareCodexShellBridge(
  catalog: readonly Pick<OcxTool, "namespace" | "name">[],
): boolean {
  return catalog.some(isBareCodexShellBridgeTool);
}

/**
 * Catalog-aware tool_choice matching for Cursor.
 * When a bare Codex shell bridge is in the catalog, raw `shell_command` / `exec_command`
 * choices select only that bridge (never a namespaced remote with the same raw name).
 * When no bare bridge exists, raw bridge names may select a namespaced tool by raw name.
 * Explicit wire names (`mcp__remote__exec_command`) always match the namespaced tool.
 */
function cursorToolChoiceMatches(
  tool: Pick<OcxTool, "namespace" | "name">,
  choiceName: string,
  catalog: readonly Pick<OcxTool, "namespace" | "name">[],
): boolean {
  if (isCodexShellBridgeToolName(choiceName)) {
    if (catalogHasBareCodexShellBridge(catalog)) {
      return isBareCodexShellBridgeTool(tool);
    }
    return tool.name === choiceName || cursorToolWireName(tool) === choiceName;
  }
  if (tool.name === choiceName) return true;
  if (cursorToolChoiceAliases(tool).includes(choiceName)) return true;
  return cursorToolWireName(tool) === choiceName
    && !catalog.some(candidate => candidate.name === choiceName);
}

export function isBareCodexShellBridgeTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return !tool.namespace && isCodexShellBridgeToolName(tool.name);
}

function isCursorResponsesProvider(namespace: string | undefined): boolean {
  return !namespace || namespace === OCX_RESPONSES_TOOL_PROVIDER;
}

const CURSOR_EXECUTION_PATH_TOOL_NAMES = [
  CODEX_UNIFIED_EXEC_TOOL,
  CODEX_EXEC_COMMAND_TOOL,
  CODEX_SHELL_COMMAND_TOOL,
] as const;

/** True for the Codex execution path that must survive Cursor transport truncation. */
export function isCursorExecutionPathTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return isCursorResponsesProvider(tool.namespace)
    && (CURSOR_EXECUTION_PATH_TOOL_NAMES as readonly string[]).includes(tool.name);
}

/** `wait` only resumes a yielded exec cell; it is unusable without an execution-path tool. */
export function isCursorWaitTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return isCursorResponsesProvider(tool.namespace) && tool.name === CODEX_WAIT_TOOL;
}

/**
 * True for Codex's unified-exec "code mode" tool: a freeform `exec` whose body is JavaScript
 * evaluated in a V8 isolate, not a shell command string.
 */
export function isCursorCodeModeExecTool(
  tool: Pick<OcxTool, "namespace" | "name" | "freeform">,
): boolean {
  return isCursorResponsesProvider(tool.namespace)
    && tool.name === CODEX_UNIFIED_EXEC_TOOL
    && tool.freeform === true;
}

/**
 * Codex code mode advertises ONE freeform `exec` tool and no bare shell bridge. Shell, file
 * edits, and MCP calls are reachable only as nested `tools.<name>(...)` helpers described inside
 * that tool's own description, so a flat catalog scan cannot see them.
 *
 * This matters because the shell-bridge guidance below is written for a flat catalog. Emitting
 * "call \`exec_command\`" into a code-mode turn names a top-level tool that does not exist: the
 * model calls it, gets nothing back, and burns turns rediscovering the real contract from error
 * messages (empty output until \`text()\` is called, \`require is not defined\` because the isolate
 * is not Node, \`apply_patch\` rejected because it too is only a nested helper here).
 */
export function cursorRequestUsesCodeMode(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): boolean {
  const catalog = tools ?? [];
  const visible = catalog.filter(tool => cursorToolAllowedByChoice(tool, toolChoice, catalog));
  return visible.some(isCursorCodeModeExecTool) && !visible.some(isBareCodexShellBridgeTool);
}

/** @deprecated Prefer isBareCodexShellBridgeTool; kept for older call sites/tests. */
export function isBareCodexExecCommandTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return isBareCodexShellBridgeTool(tool);
}

export function cursorRequestHasShellAlias(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined): boolean {
  return tools?.some(isBareCodexExecCommandTool) ?? false;
}

export function cursorRequestHasExecutionPath(
  tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined,
): boolean {
  return tools?.some(isCursorExecutionPathTool) ?? false;
}

export function cursorRequestAdvertisesApplyPatch(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): boolean {
  const catalog = tools ?? [];
  return catalog.some(tool => !tool.namespace && tool.name === CODEX_APPLY_PATCH_TOOL && tool.freeform === true && cursorToolAllowedByChoice(tool, toolChoice, catalog));
}

export function isCursorStructuredEditToolName(name: string): boolean {
  return (CURSOR_STRUCTURED_EDIT_TOOLS as readonly string[]).includes(name);
}

/** Internal provenance gate for synthetic edits after prompt filtering and catalog budgeting. */
export function isCursorSyntheticStructuredEditTool(
  tool: Pick<OcxTool, "namespace" | "name" | "cursorStructuredEdit">,
): boolean {
  return !tool.namespace && tool.cursorStructuredEdit === true && isCursorStructuredEditToolName(tool.name);
}

const CURSOR_CLIENT_TOOL_WIRE_PREFIX = "ocx_client_";
const CURSOR_PROXY_OWNED_BARE_TOOL_NAMES = new Set([
  CODEX_UNIFIED_EXEC_TOOL,
  CODEX_WAIT_TOOL,
  CODEX_EXEC_COMMAND_TOOL,
  CODEX_SHELL_COMMAND_TOOL,
  CODEX_APPLY_PATCH_TOOL,
  CURSOR_EDIT_FILE_TOOL,
  CURSOR_MULTI_EDIT_TOOL,
  CODEX_TOOL_SEARCH_TOOL,
]);

/** Avoid collisions with Cursor's private bare-tool namespace. */
function isCursorBareClientToolWireAliased(
  tool: Pick<OcxTool, "namespace" | "name">,
): boolean {
  return !tool.namespace
    && !CURSOR_PROXY_OWNED_BARE_TOOL_NAMES.has(tool.name);
}

export function cursorToolWireName(tool: Pick<OcxTool, "namespace" | "name">): string {
  if (isCursorBareClientToolWireAliased(tool)) {
    return `${CURSOR_CLIENT_TOOL_WIRE_PREFIX}${tool.name}`;
  }
  return namespacedToolName(tool.namespace, tool.name);
}

export function clientSemanticToolNameFromCursorWire(name: string): string {
  return name.startsWith(CURSOR_CLIENT_TOOL_WIRE_PREFIX)
    ? name.slice(CURSOR_CLIENT_TOOL_WIRE_PREFIX.length)
    : name;
}

/**
 * Cursor's harness shows MCP tools to the model as `mcp_<providerIdentifier>_<toolName>`; models
 * sometimes call that display name verbatim instead of the advertised short name (live 20:41/21:00
 * sessions: `mcp_opencodex-responses_exec_command` / `mcp_opencodex-responses_shell_command`).
 * Fold the display prefix back to the advertised wire name, and treat `shell_command` /
 * `exec_command` as the same Codex shell bridge, so alias thrash does not become "tool not found".
 */
const CURSOR_MCP_DISPLAY_PREFIX = `mcp_${OCX_RESPONSES_TOOL_PROVIDER}_`;

export function normalizeCursorWireName(name: string): string {
  return name.startsWith(CURSOR_MCP_DISPLAY_PREFIX) ? name.slice(CURSOR_MCP_DISPLAY_PREFIX.length) : name;
}

/**
 * #2305: some models emit a TEXTUAL pseudo tool call ("[TOOL_CALL]name[ARGS]{...}")
 * instead of a real frame, using Cursor's display alias as the name. Text-mode clients
 * (Pi) parse that text and then cannot dispatch the undeclared display name. Rewrite the
 * display alias to the advertised wire name ONLY inside the marker pair — prose that
 * merely mentions the alias stays untouched, and the scope guard is the exact
 * `mcp_${OCX_RESPONSES_TOOL_PROVIDER}_` prefix, never generic `mcp_`.
 * Known limit (recorded in devlog 230): a marker split across two streaming deltas is
 * not rewritten; tail-buffering is deferred until a live trace shows split markers.
 */
const CURSOR_TEXT_TOOL_MARKER = new RegExp(
  String.raw`\[TOOL_CALL\](${CURSOR_MCP_DISPLAY_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\[\]]+)\[ARGS\]`,
  "g",
);

export function normalizeCursorTextToolMarkers(text: string): string {
  if (!text.includes(CURSOR_MCP_DISPLAY_PREFIX)) return text;
  return text.replace(CURSOR_TEXT_TOOL_MARKER, (_match, name: string) => `[TOOL_CALL]${normalizeCursorWireName(name)}[ARGS]`);
}

export function responsesToolNameFromCursorWire(name: string, cursorToolNameMap?: ReadonlyMap<string, string>): string {
  const normalized = normalizeCursorWireName(name);
  if (!cursorToolNameMap) return normalized;
  return resolveShellBridgeAliasKey(normalized, alias => cursorToolNameMap.get(alias)) ?? normalized;
}

export function cursorToolAllowedByChoice(
  tool: Pick<OcxTool, "namespace" | "name">,
  toolChoice: OcxRequestOptions["toolChoice"] | undefined,
  catalog: readonly Pick<OcxTool, "namespace" | "name">[] = [tool],
): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if ("allowedTools" in toolChoice) {
    return toolChoice.allowedTools.some(choiceName => cursorToolChoiceMatches(tool, choiceName, catalog));
  }
  return cursorToolChoiceMatches(tool, toolChoice.name, catalog);
}
