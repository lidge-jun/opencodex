import { create, fromJson, toBinary, type JsonValue } from "@bufbuild/protobuf";
import { ValueSchema } from "@bufbuild/protobuf/wkt";
import type { OcxRequestOptions, OcxTool } from "../../types";
import { McpToolDefinitionSchema, McpToolsSchema, type McpToolDefinition } from "./gen/agent_pb";
import { CURSOR_EDIT_FILE_TOOL, CURSOR_MULTI_EDIT_TOOL, cursorRequestAdvertisesApplyPatch, cursorToolAllowedByChoice, cursorToolWireName, OCX_RESPONSES_TOOL_PROVIDER } from "./tool-naming";
import { CURSOR_EDIT_FILE_INPUT_SCHEMA, CURSOR_MULTI_EDIT_INPUT_SCHEMA, cursorToolInputSchema } from "./tool-schemas";
export { OCX_RESPONSES_TOOL_PROVIDER, CODEX_EXEC_COMMAND_TOOL, CODEX_SHELL_COMMAND_TOOL, CODEX_UNIFIED_EXEC_TOOL, CODEX_WAIT_TOOL, CODEX_APPLY_PATCH_TOOL, CODEX_TOOL_SEARCH_TOOL, CURSOR_EDIT_FILE_TOOL, CURSOR_MULTI_EDIT_TOOL, CURSOR_STRUCTURED_EDIT_TOOLS, CURSOR_EXEC_COMMAND_TOOL, CODEX_SHELL_BRIDGE_TOOL_NAMES, isCodexShellBridgeToolName, resolveShellBridgeAliasKey, cursorToolChoiceAliases, isBareCodexShellBridgeTool, isCursorExecutionPathTool, isCursorWaitTool, isCursorCodeModeExecTool, cursorRequestUsesCodeMode, cursorRequestHasShellAlias, cursorRequestAdvertisesApplyPatch, isCursorStructuredEditToolName, isCursorSyntheticStructuredEditTool, cursorToolWireName, normalizeCursorWireName, normalizeCursorTextToolMarkers, responsesToolNameFromCursorWire, cursorToolAllowedByChoice } from "./tool-naming";
export { CURSOR_EXEC_COMMAND_INPUT_SCHEMA, CURSOR_FREEFORM_INPUT_SCHEMA, CURSOR_EDIT_FILE_INPUT_SCHEMA, CURSOR_MULTI_EDIT_INPUT_SCHEMA, CODEX_SHELL_BRIDGE_ARG_NORMALIZE_SCHEMA, cursorToolInputSchema, cursorToolArgNormalizeSchema, shellBridgeRequiredCommandKeys, defaultShellBridgeArgNormalizeSchema, cursorShellBridgeDropError, nonEmptyShellBridgeCommandFromArgs, cursorShellBridgeArgsValid } from "./tool-schemas";
export { CURSOR_SHELL_ALIAS_SYSTEM_NOTE, CURSOR_GENERIC_TOOL_USE_USER_HINT, isGenericToolUseCountDemoPrompt, requestedCursorToolUseCount, shouldAppendCursorGenericToolUseHint, appendCursorGenericToolUseHint, shouldUseNativeExecOnlyForGenericToolUse, cursorToolsForActivePrompt, buildCursorToolGuidanceSystemNote } from "./tool-guidance";

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
