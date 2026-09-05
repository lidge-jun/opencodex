import type { OcxTool } from "../../types";
import { CODEX_SHELL_COMMAND_TOOL, isBareCodexExecCommandTool, isBareCodexShellBridgeTool, isCodexShellBridgeToolName } from "./tool-naming";

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
