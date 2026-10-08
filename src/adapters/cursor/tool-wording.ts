import type { OcxTool } from "../../types";
import type { McpToolDefinition } from "./gen/agent_pb";
import { CODE_MODE_RESULT_ECHO_SENTENCE } from "../exec-tool-result-normalize";
import { OCX_RESPONSES_TOOL_PROVIDER, cursorRequestHasExecutionPath, cursorRequestHasShellAlias, cursorRequestUsesCodeMode, cursorToolWireName } from "./tool-naming";

/** Cursor may expose Claude with version-first, family-first, or effort-suffixed ids. */
export function cursorUsesPlainToolWording(modelId?: string): boolean {
  return /^(?:cursor\/)?claude-/i.test(modelId?.trim() ?? "");
}

export const CURSOR_TOOL_CALL_CONTINUATION = "Continue the task with that tool call.";
const CURSOR_NO_CLIENT_TOOLS = "Cursor-native filesystem, shell, and fetch tools are not available through this execution channel. No client tools are available in this request. Answer without tools using the information already provided, or report that the requested operation cannot be completed without tools.";

/** Factual catalog wording; legacy model wording is owned by native-exec.ts unchanged. */
export function cursorPlainNativeExecRedirectHint(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  mcpToolDefs: readonly Pick<McpToolDefinition, "name" | "providerIdentifier">[],
): string | undefined {
  const clientTools = tools ?? [];
  const names = [...new Set([
    ...clientTools.map(tool => cursorToolWireName(tool, clientTools)),
    ...mcpToolDefs.map(def => `mcp_${def.providerIdentifier}_${def.name}`),
  ])];
  if (names.length === 0) return CURSOR_NO_CLIENT_TOOLS;
  const shown = names.slice(0, 16).map(name => `\`${name}\``).join(", ");
  const more = names.length > 16 ? ` (+${names.length - 16} more)` : "";
  const catalog = `Available tools in this request's catalog: ${shown}${more}. `
    + `The harness displays a \`${OCX_RESPONSES_TOOL_PROVIDER}\` entry as \`mcp_${OCX_RESPONSES_TOOL_PROVIDER}_<name>\`; that is the same tool. `
    + "Cursor-native Read/Glob/Grep/LS/Shell/Write/Fetch are not available in this request. ";
  if (!cursorRequestHasShellAlias(clientTools) && cursorRequestUsesCodeMode(clientTools)) {
    return catalog + "`exec` takes a JavaScript body evaluated in a V8 isolate, not a shell command. Shell, file, search, and fetch are nested helpers called inside it as `await tools.<name>(...)`, for example `text(await tools.exec_command({cmd: \"ls\"}))`. "
      + "`shell_command` and `exec_command` are nested helpers, not top-level tools here. Every other listed tool remains callable at the top level. "
      + CODE_MODE_RESULT_ECHO_SENTENCE + " " + CURSOR_TOOL_CALL_CONTINUATION;
  }
  const operation = cursorRequestHasExecutionPath(clientTools)
    ? "Use the listed execution tool with its advertised argument schema and the Codex client host's shell syntax; use a listed edit tool for file edits. "
    : "Use the listed tool that fits the operation: a file, search, or fetch tool when provided, or a listed worker-agent delegation tool. ";
  return catalog + operation + CURSOR_TOOL_CALL_CONTINUATION;
}

/** Fallback uses advertised dispatcher definitions, never assumed shell/edit tools. */
export function cursorPlainNativeExecFallback(
  toolDefs: readonly Pick<McpToolDefinition, "name" | "providerIdentifier">[] = [],
): string {
  return cursorPlainNativeExecRedirectHint([], toolDefs)!;
}
