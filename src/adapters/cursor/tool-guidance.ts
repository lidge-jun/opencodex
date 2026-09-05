import type { OcxRequestOptions, OcxTool } from "../../types";
import { CODE_MODE_RESULT_ECHO_SENTENCE } from "../exec-tool-result-normalize";
import { CODEX_SHELL_BRIDGE_TOOL_NAMES, CODEX_TOOL_SEARCH_TOOL, CODEX_UNIFIED_EXEC_TOOL, clientSemanticToolNameFromCursorWire, cursorRequestAdvertisesApplyPatch, cursorRequestHasExecutionPath, cursorRequestHasShellAlias, cursorRequestUsesCodeMode, cursorToolAllowedByChoice, cursorToolWireName, isCodexShellBridgeToolName, isCursorExecutionPathTool, isCursorStructuredEditToolName } from "./tool-naming";

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
      ? `\`${CODEX_UNIFIED_EXEC_TOOL}\` is Codex code mode: its body is JavaScript evaluated in a V8 isolate, not a shell command and not Node. Shell, file edits, and MCP are nested helpers called INSIDE that body as \`await tools.<name>(...)\`, for example \`await tools.exec_command({cmd: \"ls\"})\`. Read the tool description and the isolate global \`ALL_TOOLS\` (not \`tools.ALL_TOOLS\`) for helpers this turn provides; absence from the top-level catalog or from \`exec\`'s description is not absence. Those nested helpers are not themselves top-level tools, so do not call \`exec_command\` or \`shell_command\` at the top level here${codeModeOtherTopLevelNames.length > 0 ? `; every other tool this turn lists, including ${quotedNames(codeModeOtherTopLevelNames)}, remains callable at the top level as usual` : ""}. Nested \`tools.apply_patch(input)\` is host-executed: the string must begin exactly with \`*** Begin Patch\` and end with \`*** End Patch\`, each marker line being three asterisks, one space, the two words, then end of line with no further asterisks. OpenCodex does not rewrite JavaScript inside exec, so extra asterisks on a marker line are rejected by Codex before the file is touched.`
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
