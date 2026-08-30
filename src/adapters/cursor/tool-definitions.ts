import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxRequestOptions, OcxTool } from "../../types";
import { namespacedToolName, toolChoiceAliases } from "../../types";
import { McpToolDefinitionSchema, McpToolsSchema, type McpToolDefinition } from "./gen/agent_pb";
import { CODE_MODE_RESULT_ECHO_SENTENCE } from "../exec-tool-result-normalize";

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
export const CURSOR_SHELL_ALIAS_SYSTEM_NOTE =
  'Shell commands use the Codex shell bridge tool shown in this turn\'s catalog (`shell_command` or `exec_command`) with JSON arguments like {"cmd":"..."}. The long `mcp_opencodex-responses_*` display name is the same tool. Prefer it over Cursor-native Shell.';
const NEIGHBOR_AGENT_TOOL_NAMES = ["Read", "Grep", "Glob", "Bash", "LS"] as const;
const NEIGHBOR_AGENT_TOOL_ALIASES: Record<(typeof NEIGHBOR_AGENT_TOOL_NAMES)[number], readonly string[]> = {
  Read: ["read", "read_file"],
  Grep: ["grep"],
  Glob: ["glob", "find"],
  Bash: ["bash", "shell"],
  LS: ["ls"],
};

export const CURSOR_GENERIC_TOOL_USE_USER_HINT = [
  "For generic tool-use/count demos, satisfy the request with repeated Codex shell bridge calls (`shell_command` or `exec_command`) for harmless commands.",
  "`shell_command` / `exec_command` are the Codex Responses shell bridge exposed through Cursor's tool protocol; do not describe them as an external MCP server tool.",
  "Do not use `run_shell` unless this turn's tool catalog lists it.",
  "A request for N tools means N separate shell-bridge invocations/results; never satisfy it with one chained shell command such as `cmd1 && cmd2`.",
  "For independent read-only or output-only commands, emit all requested shell-bridge calls in the same response before waiting when the runtime supports parallel tool calls.",
  "The Cursor bridge may suspend after the first returned bridge tool call, so emit sibling calls together before any result is needed.",
  "If parallel emission is unavailable, continue with separate shell-bridge calls until the requested count has returned.",
  "Do not use `tool_search`, external MCP, or resource discovery just to pad the count unless explicitly asked.",
  "Do not suggest or switch to neighboring-agent tools such as `Grep`, `Read`, `Glob`, `Bash`, or `LS` unless this turn's catalog lists those exact names or an equivalent listed client tool.",
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

/**
 * Structured single-replacement schema advertised to Cursor models in addition to the freeform
 * `apply_patch` tool. Cursor-trained models reliably emit exact-match replacements (the native
 * Edit shape) but cannot produce Codex's freeform patch grammar, so every file edit attempt on the
 * Cursor route produced malformed `apply_patch` payloads that the Codex client rejected locally
 * (#1017). Calls to this tool are converted server-side into a valid apply_patch payload.
 */
export const CURSOR_EDIT_FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path of the file to edit, relative to the workspace root." },
    old_string: { type: "string", description: "Exact text to replace. Must match the current file content, including line breaks." },
    new_string: { type: "string", description: "Replacement text. Empty removes the matched text." },
  },
  required: ["file_path", "old_string", "new_string"],
  additionalProperties: false,
} as const;

/** Structured multi-replacement schema; mirrors Cursor's native MultiEdit shape. */
export const CURSOR_MULTI_EDIT_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path of the file to edit, relative to the workspace root." },
    edits: {
      type: "array",
      items: {
        type: "object",
        properties: {
          old_string: { type: "string", description: "Exact text to replace. Must match the current file content, including line breaks." },
          new_string: { type: "string", description: "Replacement text. Empty removes the matched text." },
        },
        required: ["old_string", "new_string"],
        additionalProperties: false,
      },
      description: "Ordered replacement edits for this file. Each old_string must match the current file content.",
    },
  },
  required: ["file_path", "edits"],
  additionalProperties: false,
} as const;

/**
 * Responses/Codex-side schema used ONLY for arg-key normalization after Cursor returns a call.
 * Cursor models are trained to emit `cmd`; Codex `shell_command` / `exec_command` validate
 * `command`. Keeping `cmd` out of this schema lets `normalizeArgKeys` rewrite `cmd` → `command`.
 */
export const CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to execute." },
    workdir: { type: "string", description: "Working directory for the command. Defaults to the turn cwd." },
    shell: { type: "string", description: "Shell binary to launch. Defaults to the user's default shell." },
    tty: { type: "boolean", description: "True allocates a PTY for the command; false or omitted uses plain pipes." },
    yield_time_ms: { type: "number", description: "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms." },
    max_output_tokens: { type: "number", description: "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy." },
    max_output_chars: { type: "number", description: "Output character budget when the Responses tool uses chars instead of tokens." },
  },
  required: ["command"],
} as const;

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
function isBareCodexExecCommandTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return isBareCodexShellBridgeTool(tool);
}

export function cursorRequestHasShellAlias(tools: readonly Pick<OcxTool, "namespace" | "name">[] | undefined): boolean {
  return tools?.some(isBareCodexExecCommandTool) ?? false;
}

function cursorRequestHasExecutionPath(
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

/**
 * Synthetic structured edit tools for the Cursor route (#1017).
 *
 * Codex exposes `apply_patch` as a freeform custom tool whose body must be the exact Codex patch
 * grammar (`*** Begin Patch` envelope, `@@` hunks, `-`/`+` prefixes). Cursor-trained models are
 * trained on exact-match edit tools instead and emit malformed patch text on every attempt, which
 * the Codex client then rejects locally ("invalid hunk"). When the request advertises the freeform
 * `apply_patch` tool, also advertise Cursor-native-shaped `edit_file` / `multi_edit` tools; the
 * adapter converts their exact-match replacements into a valid apply_patch payload (see
 * protobuf-events.translateStructuredEditCall).
 *
 * Never widened when the caller pinned an explicit tool choice: a forced `apply_patch` selection
 * must not gain sibling tools the client did not ask for.
 */
export function cursorStructuredEditTools(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): OcxTool[] {
  if (!cursorRequestAdvertisesApplyPatch(tools, toolChoice)) return [];
  if (toolChoice && toolChoice !== "auto" && toolChoice !== "required") return [];
  // Never shadow an already-advertised bare tool with the same name (a client catalog could
  // legitimately expose its own `edit_file` / `multi_edit` MCP-style tools).
  const existingBareNames = new Set(
    (tools ?? []).filter(tool => !tool.namespace).map(tool => tool.name),
  );
  const candidates: OcxTool[] = [
    {
      name: CURSOR_EDIT_FILE_TOOL,
      cursorStructuredEdit: true,
      description:
        "Replace one block of text in a file. OpenCodex converts the replacement into a Codex apply_patch change. Copy old_string and new_string with their exact leading whitespace — Codex may locate a line after trimming indent, but it writes new_string verbatim, so stripped indent silently corrupts the file. An empty old_string with a non-empty new_string creates a new file (Add File). If the same text appears more than once, the first match is updated. Matching is line-based, so an edit cannot add or remove only the file's final newline, and old_string/new_string that are identical after line normalization are rejected as a no-op.",
      parameters: { ...CURSOR_EDIT_FILE_INPUT_SCHEMA },
    },
    {
      name: CURSOR_MULTI_EDIT_TOOL,
      cursorStructuredEdit: true,
      description:
        "Apply several text replacements to one file. OpenCodex converts them into one Codex apply_patch change. Copy each old_string/new_string with exact leading whitespace. If a later edit's old_string is the text after an earlier replacement, OpenCodex folds those edits into one original-file hunk. Independent edits stay separate hunks. An empty old_string with a non-empty new_string creates a new file (Add File); do not mix that with an independent Update on the same path. If the same text appears more than once, the first match is updated. Matching is line-based, so an edit cannot add or remove only the file's final newline, and identical old/new after line normalization are rejected as a no-op.",
      parameters: { ...CURSOR_MULTI_EDIT_INPUT_SCHEMA },
    },
  ];
  return candidates.filter(tool => !existingBareNames.has(tool.name));
}

/**
 * True when this request actually advertises the synthetic structured edit tools (`edit_file` /
 * `multi_edit`) — i.e. a freeform `apply_patch` is advertised, no tool-choice pin blocks widening,
 * and neither name is shadowed by an existing bare tool in the client catalog.
 */
export function cursorRequestAdvertisesStructuredEdits(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): boolean {
  return cursorStructuredEditTools(tools, toolChoice).length > 0;
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

function clientSemanticToolNameFromCursorWire(name: string): string {
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

/** Schema advertised to Cursor for this tool (may use Cursor-preferred field names like `cmd`). */
export function cursorToolInputSchema(tool: OcxTool): unknown {
  return isBareCodexExecCommandTool(tool) ? CURSOR_EXEC_COMMAND_INPUT_SCHEMA : (tool.parameters ?? {});
}

/**
 * Schema used to normalize completed Cursor tool args back to Responses/Codex field names.
 * Must NOT reuse `cursorToolInputSchema` for the shell bridge: advertising `cmd` while also
 * treating `cmd` as canonical prevents the `cmd` → `command` rewrite Codex requires (#399).
 */
export function cursorToolArgNormalizeSchema(tool: OcxTool): unknown {
  if (isBareCodexShellBridgeTool(tool)) {
    return shellBridgeArgNormalizeSchema(tool);
  }
  return tool.parameters ?? {};
}

function shellBridgeArgNormalizeSchema(tool: OcxTool): unknown {
  const parameters = tool.parameters;
  if (!parameters || typeof parameters !== "object") return CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA;
  const base = parameters as Record<string, unknown>;
  const rawProps = base.properties && typeof base.properties === "object"
    ? { ...(base.properties as Record<string, unknown>) }
    : {};
  const required = Array.isArray(base.required) ? [...base.required as unknown[]] : [];
  const requiresCommand = required.includes("command") || "command" in rawProps;
  const requiresCmd = required.includes("cmd") || "cmd" in rawProps;
  const shouldRewriteCmdToCommand = tool.name === CODEX_SHELL_COMMAND_TOOL || requiresCommand;

  if (!shouldRewriteCmdToCommand && requiresCmd) {
    return parameters;
  }

  // Drop Cursor-preferred aliases so normalizeArgKeys can rewrite them to Responses keys.
  delete rawProps.cmd;
  const properties = {
    ...CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA.properties,
    ...rawProps,
    command: rawProps.command ?? CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA.properties.command,
  };
  return {
    ...base,
    type: "object",
    properties,
    required: requiresCommand ? required : ["command"],
  };
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
    `This turn requests ${count} tool uses: emit exactly ${count} separate Codex shell bridge function calls/results (\`shell_command\` or \`exec_command\`).`,
    `One shell-bridge call containing chained commands counts as 1 tool call, not ${count}.`,
    `Prefer one parallel tool-call batch containing all ${count} independent shell-bridge calls before waiting for results.`,
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
  if (trimmed.length === 0 || !cursorRequestHasExecutionPath(tools) || !isGenericToolUseCountDemoPrompt(trimmed)) return false;
  return !/\b(?:mcp|resource|resources|tool_search|plugin|plugins|app connector|github)\b/i.test(trimmed)
    && !/(?:리소스|플러그인|깃허브|github)/i.test(trimmed);
}

export function cursorToolsForActivePrompt<T extends Pick<OcxTool, "namespace" | "name">>(
  tools: readonly T[] | undefined,
  activeText: string,
  toolChoice?: OcxRequestOptions["toolChoice"],
): readonly T[] | undefined {
  if (!shouldUseNativeExecOnlyForGenericToolUse(tools, activeText)) return tools;
  const execTools = tools?.filter(isCursorExecutionPathTool);
  const catalog = tools ?? [];
  if (execTools?.length && !execTools.some(tool => cursorToolAllowedByChoice(tool, toolChoice, catalog))) return tools;
  return execTools && execTools.length > 0 ? execTools : tools;
}

/**
 * Required command payload keys for a shell bridge tool, derived from the advertised schema when present.
 */
export function shellBridgeRequiredCommandKeys(
  toolName: string,
  schema?: unknown,
): readonly ("cmd" | "command")[] {
  if (schema && typeof schema === "object") {
    const required = (schema as Record<string, unknown>).required;
    if (Array.isArray(required)) {
      const keys = required.filter((key): key is "cmd" | "command" => key === "cmd" || key === "command");
      if (keys.length > 0) return keys;
    }
  }
  return toolName === CODEX_SHELL_COMMAND_TOOL ? ["command"] : ["cmd"];
}

/** Normalize-schema defaults used when validating stateless synthetic shell-bridge calls. */
export function defaultShellBridgeArgNormalizeSchema(toolName: string): unknown {
  return toolName === CODEX_SHELL_COMMAND_TOOL
    ? CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA
    : {
      type: "object",
      properties: CURSOR_EXEC_COMMAND_INPUT_SCHEMA.properties,
      required: ["cmd"],
    };
}

export function cursorShellBridgeDropError(toolName: string): string {
  return `Cursor emitted ${toolName} without a non-empty command; the tool call was dropped.`;
}

/**
 * Extract a non-empty shell command from completed Cursor bridge args using the schema's required
 * command key (`cmd` for bare exec_command, `command` for shell_command).
 */
export function nonEmptyShellBridgeCommandFromArgs(
  finalArgs: string,
  toolName: string,
  schema?: unknown,
): string | undefined {
  let parsed: unknown;
  try {
    parsed = finalArgs.length > 0 ? JSON.parse(finalArgs) : {};
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const requiredKeys = shellBridgeRequiredCommandKeys(toolName, schema);
  const candidateKeys = new Set<"cmd" | "command">([
    ...requiredKeys,
    requiredKeys.includes("cmd") ? "command" : "cmd",
  ]);
  for (const key of candidateKeys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

export function cursorShellBridgeArgsValid(
  finalArgs: string,
  toolName: string,
  schema?: unknown,
): boolean {
  return !isCodexShellBridgeToolName(toolName)
    || nonEmptyShellBridgeCommandFromArgs(finalArgs, toolName, schema) !== undefined;
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

function quotedNames(names: readonly string[]): string {
  return names.map(name => `\`${name}\``).join(", ");
}

function advertisedCoversNeighbor(wireNames: readonly string[], neighbor: (typeof NEIGHBOR_AGENT_TOOL_NAMES)[number]): boolean {
  const advertised = new Set(wireNames.map(name => clientSemanticToolNameFromCursorWire(name).toLowerCase()));
  if (advertised.has(neighbor.toLowerCase())) return true;
  return NEIGHBOR_AGENT_TOOL_ALIASES[neighbor].some(alias => advertised.has(alias.toLowerCase()));
}

function unavailableNeighborAgentToolNames(wireNames: readonly string[]): string[] {
  return NEIGHBOR_AGENT_TOOL_NAMES.filter(name => !advertisedCoversNeighbor(wireNames, name));
}

function discoveryToolLabel(wireNames: readonly string[]): string | undefined {
  const labels: string[] = [];
  if (wireNames.includes(CODEX_TOOL_SEARCH_TOOL)) labels.push(`\`${CODEX_TOOL_SEARCH_TOOL}\``);
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
      .filter(tool => cursorToolAllowedByChoice(tool, toolChoice, tools))
      .map(tool => cursorToolWireName(tool)),
  )];
  if (wireNames.length === 0) return undefined;

  const listedNames = quotedNames(wireNames);
  const shellBridgeNames = wireNames.filter(isCodexShellBridgeToolName);
  const hasBareExec = shellBridgeNames.length > 0;
  const codeMode = cursorRequestUsesCodeMode(tools, toolChoice);
  // Code mode describes how the freeform exec tool works; it does not suppress the rest of the
  // catalog. A turn can advertise freeform `exec` AND ordinary top-level tools at once, and
  // telling the model those are "not separate top-level tools" would make it refuse tools that
  // are right there in its catalog. Name the ones that stay callable instead.
  const codeModeOtherTopLevelNames = codeMode
    ? wireNames.filter(name => name !== CODEX_UNIFIED_EXEC_TOOL && !isCodexShellBridgeToolName(name))
    : [];
  const shellBridgeLabel = quotedNames(shellBridgeNames.length > 0 ? shellBridgeNames : [...CODEX_SHELL_BRIDGE_TOOL_NAMES]);
  const hasApplyPatch = cursorRequestAdvertisesApplyPatch(tools, toolChoice);
  const structuredEditNames = tools
    ?.filter(tool => !tool.namespace && isCursorStructuredEditToolName(tool.name))
    .map(tool => tool.name) ?? [];
  const discoveryTools = discoveryToolLabel(wireNames);
  const unavailableNeighborNames = unavailableNeighborAgentToolNames(wireNames);
  // Host-shell-neutral: the Codex client executes bridge commands, and may differ from
  // the OpenCodex proxy OS (LAN/SSH remote-proxy). Always cover PowerShell 5.1 pitfalls.
  const hostShellNote = hasBareExec
    ? "Match shell syntax to the Codex client host that runs the bridge (not only the proxy OS). Windows PowerShell 5.1: no CMD `cd /d`, no bash heredocs (`<<EOF`); `&&`/`||` are unsupported parser errors — prefer the bridge working-directory argument for directory changes, and use `if ($?) { ... }` for success-gated follow-up steps; do not treat `;` as a substitute for `&&`. POSIX: use portable commands (`cat`/`ls`/`rg`); never emit Get-Content or Get-ChildItem unless the host shell is PowerShell. After a shell failure, make at most one corrected bridge attempt, then report the error and stop — do not repeat equivalent failing commands."
    : undefined;
  const notes = [
    `Cursor tool calls: available tool names are exactly ${listedNames}.`,
    "Use the current tool catalog as ground truth and call only those exact names with their listed argument keys.",
    unavailableNeighborNames.length > 0
      ? `This turn does not expose neighboring-agent tool names ${quotedNames(unavailableNeighborNames)}; do not call or suggest them unless the catalog lists them.`
      : undefined,
    // Code mode: shell/edit/MCP live inside freeform `exec` as nested helpers. Without this the
    // model probes for a top-level shell tool that is not there.
    codeMode
      ? `\`${CODEX_UNIFIED_EXEC_TOOL}\` is Codex code mode: its body is JavaScript evaluated in a V8 isolate, not a shell command and not Node. Shell, file edits, and MCP are nested helpers called INSIDE that body as \`await tools.<name>(...)\`, for example \`await tools.exec_command({cmd: \"ls\"})\`. Read the tool description and the isolate global \`ALL_TOOLS\` (not \`tools.ALL_TOOLS\`) for helpers this turn provides; absence from the top-level catalog or from \`exec\`'s description is not absence. Those nested helpers are not themselves top-level tools, so do not call \`exec_command\` or \`shell_command\` at the top level here${codeModeOtherTopLevelNames.length > 0 ? `; every other tool this turn lists, including ${quotedNames(codeModeOtherTopLevelNames)}, remains callable at the top level as usual` : ""}. Nested \`tools.apply_patch(input)\` is host-executed: the string must begin exactly with \`*** Begin Patch\` and end with \`*** End Patch\` (no trailing \`***\` on those lines). OpenCodex does not rewrite JavaScript inside exec, so a decorated \`*** Begin Patch ***\` envelope is rejected by Codex before the file is touched.`
      : undefined,
    codeMode
      ? CODE_MODE_RESULT_ECHO_SENTENCE + " There is no `require`, no `module`, and no filesystem or network globals; reach the host only through the nested helpers."
      : undefined,
    codeMode
      ? "NEVER attempt Cursor-native Shell, Read, Grep, List, or any tool absent from the catalog — they are not executed in this environment and every probe wastes a turn. The exec code cell (with its nested helpers) is the ONLY execution surface; go to it directly on the FIRST attempt and do not narrate switching surfaces."
      : undefined,
    hasBareExec
      ? `${shellBridgeLabel} is the Codex Responses shell bridge for this turn, exposed through Cursor's tool protocol; it is not an external MCP server tool. \`shell_command\` and \`exec_command\` are aliases of the same bridge.`
      : undefined,
    hasBareExec
      ? "Your tool list may display it under a longer `mcp_opencodex-responses_shell_command` / `mcp_opencodex-responses_exec_command` name; those are the SAME tool — call whichever your list shows, and do not comment on the naming difference to the user."
      : undefined,
    hasBareExec
      ? `NEVER attempt Cursor-native Shell, Read, Grep, List, or any tool not in the catalog above — they are not executed locally in this environment and every attempt wastes a turn and can stall the session. ${shellBridgeLabel} is the ONLY shell surface; go to it directly on the FIRST attempt, never as a fallback after probing a native tool. Do not narrate switching surfaces ("native is blocked, using the bridge instead") — there is exactly one surface.`
      : undefined,
    hasBareExec
      ? "Tool-selection commentary is forbidden: for any shell, read, grep, list, or file operation, your FIRST visible action is the bridge call itself — never a sentence about which tool you will use, which tool was redirected, or switching surfaces. Words like 차단/전환/blocked/switching must not appear in your output for tool-routing reasons."
      : undefined,
    hostShellNote,
    "Cursor product features (Chronicle, screen recording, Notes, Plans, background agents) are available only if this turn's catalog lists a matching tool; do not offer or promise them otherwise.",
    hasBareExec
      ? `For file read/search/listing, use ${shellBridgeLabel} when no more specific listed tool is available.`
      : undefined,
    hasApplyPatch
      ? structuredEditNames.length > 0
        ? `For file edits, prefer the structured edit tools ${quotedNames(structuredEditNames)} — they take replacements that OpenCodex converts into Codex \`apply_patch\` changes. Include exact leading whitespace in old_string/new_string. Use \`apply_patch\` directly only with a \`*** Begin Patch\` envelope and bare \`@@\` hunks (never git-style \`@@ -n,m +n,m @@\`); never emit patch-like plain text as tool arguments.`
        : "For file edits, use the `apply_patch` tool, not built-in file write/delete tools."
      : undefined,
    hasApplyPatch
      ? "Creating or modifying file CONTENT via shell redirection (`>`, `>>`, `printf`/`echo` into a file, `cat <<EOF`, `sed -i`) is forbidden while apply_patch or the structured edit tools are advertised — use those edit tools so the change is reviewable. Shell output redirection is fine for logs/scratch pipes that are not the deliverable file."
      : undefined,
    hasBareExec
      ? "For tool-count demos, each counted tool must be a separate Codex shell-bridge invocation/result; do not collapse several requested tools into one chained shell command."
      : undefined,
    "For independent read-only tool-count or batch requests, prefer one response containing multiple tool calls before waiting for results when the runtime supports parallel tool calls.",
    hasBareExec
      ? "For bridge tool-count batches, emit sibling shell-bridge calls together before any result is needed because the bridge may suspend after a returned tool call."
      : undefined,
    discoveryTools
      ? `Use ${discoveryTools} only for explicit discovery/resource tasks, not generic tool-count demos.`
      : undefined,
    "Do not count or report a tool call unless a tool result was actually returned.",
    hasBareExec
      ? `For every file read, directory listing, grep, or shell operation use ${shellBridgeLabel} directly with host-shell-safe commands (POSIX: \`cat\`/\`ls\`/\`rg\`; Windows PowerShell: \`Get-Content\`/\`Get-ChildItem\`/\`Select-String\`). For file edits, use ${structuredEditNames.length > 0 ? `the structured edit tools (${quotedNames(structuredEditNames)}) or ` : ""}\`apply_patch\` when available.`
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
  return tools.filter(tool => cursorToolAllowedByChoice(tool, toolChoice, tools)).map(tool => {
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
