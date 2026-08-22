import type { AdapterEvent, OcxProviderConfig, OcxRequestOptions, OcxTool } from "../types";
import { isAllowedToolChoice, namespacedToolName, toolChoiceToolPredicate } from "../types";
import {
  declaredToolsBlock,
  effectiveInstructionText,
  shouldSuppressCodeModePatchGuidance,
} from "./tool-catalog-nudge";

/**
 * Grok Build catalog for xAI code-mode turns. Cursor advertises `edit_file`;
 * Grok is shown the Grok Build names (`read_file`, `grep`, `list_dir`,
 * `search_replace`, `write`, `run_terminal_command`) instead of Codex `exec` /
 * `ALL_TOOLS`. Completed calls are converted into `exec` or `apply_patch` for Codex.
 */
export const GROK_READ_FILE_TOOL = "read_file";
export const GROK_GREP_TOOL = "grep";
export const GROK_LIST_DIR_TOOL = "list_dir";
export const GROK_SEARCH_REPLACE_TOOL = "search_replace";
export const GROK_WRITE_TOOL = "write";
export const GROK_RUN_TERMINAL_COMMAND_TOOL = "run_terminal_command";
/** Older catalog name; still converted if Grok emits it. */
const GROK_WRITE_ALIAS = "write_file";
export const GROK_NATIVE_TOOLS = [
  GROK_READ_FILE_TOOL,
  GROK_GREP_TOOL,
  GROK_LIST_DIR_TOOL,
  GROK_SEARCH_REPLACE_TOOL,
  GROK_WRITE_TOOL,
  GROK_RUN_TERMINAL_COMMAND_TOOL,
] as const;
export const GROK_STRUCTURED_EDIT_TOOLS = [GROK_SEARCH_REPLACE_TOOL, GROK_WRITE_TOOL] as const;
const GROK_NATIVE_CALL_NAMES = new Set<string>([...GROK_NATIVE_TOOLS, GROK_WRITE_ALIAS]);

const PATCH_BEGIN = "*** Begin Patch";
const PATCH_END = "*** End Patch";
const PATH_ARG_KEYS = ["target_file", "targetFile", "target_directory", "targetDirectory", "file_path", "filePath", "path", "filepath", "filename", "file"] as const;
const OLD_STRING_KEYS = ["old_string", "oldString", "old_str", "oldtext", "old_text", "old_content", "before", "search"] as const;
const NEW_STRING_KEYS = ["new_string", "newString", "new_str", "newtext", "new_text", "contents", "content", "new_contents", "after", "replace"] as const;
const WRITE_CONTENT_KEYS = ["content", "contents", ...NEW_STRING_KEYS] as const;
const COMMAND_ARG_KEYS = ["command", "cmd", "cmd_line", "cmdLine"] as const;
const PATTERN_ARG_KEYS = ["pattern", "query", "regex"] as const;
const GLOB_ARG_KEYS = ["glob", "include", "glob_pattern"] as const;
const CODEX_SHELL_BRIDGE_TOOL_NAMES = ["exec_command", "shell_command"] as const;

export const GROK_SEARCH_REPLACE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path of the file to edit, relative to the workspace root." },
    old_string: { type: "string", description: "Exact text to replace. Must match the current file content, including line breaks. Empty creates a new file when new_string is non-empty." },
    new_string: { type: "string", description: "Replacement text. Empty removes the matched text." },
  },
  required: ["file_path", "old_string", "new_string"],
  additionalProperties: false,
} as const;

export const GROK_WRITE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    file_path: { type: "string", description: "Path of the file to create, relative to the workspace root." },
    content: { type: "string", description: "Full contents of the new file." },
  },
  required: ["file_path", "content"],
  additionalProperties: false,
} as const;

export const GROK_READ_FILE_INPUT_SCHEMA = {
  type: "object",
  properties: {
    target_file: { type: "string", description: "Path of the file to read, relative to the workspace root." },
    offset: { type: "integer", description: "Optional 1-based start line." },
    limit: { type: "integer", description: "Optional number of lines to read." },
  },
  required: ["target_file"],
  additionalProperties: false,
} as const;

export const GROK_GREP_INPUT_SCHEMA = {
  type: "object",
  properties: {
    pattern: { type: "string", description: "Regular expression to search for." },
    path: { type: "string", description: "File or directory to search. Defaults to the workspace root." },
    glob: { type: "string", description: "Optional glob to limit which files are searched." },
  },
  required: ["pattern"],
  additionalProperties: false,
} as const;

export const GROK_LIST_DIR_INPUT_SCHEMA = {
  type: "object",
  properties: {
    target_directory: { type: "string", description: "Directory to list. Defaults to the workspace root." },
  },
  additionalProperties: false,
} as const;

export const GROK_RUN_TERMINAL_COMMAND_INPUT_SCHEMA = {
  type: "object",
  properties: {
    command: { type: "string", description: "Shell command to run." },
    working_directory: { type: "string", description: "Working directory for the command." },
    with_escalated_permissions: {
      type: "boolean",
      description:
        "True asks Codex to prompt for a sandbox escalation. Required for Git operations that update the index or refs, for example add, commit, checkout, switch, reset, or restore.",
    },
    justification: {
      type: "string",
      description: "Short reason shown in the Codex permission prompt when escalating.",
    },
  },
  required: ["command"],
  additionalProperties: false,
} as const;

const GIT_INDEX_ESCALATION_JUSTIFICATION =
  "Update Git index or refs; the sandbox cannot create .git/index.lock or other repository lock files.";

const GIT_MUTATING_COMMANDS = new Set([
  "add", "commit", "checkout", "switch", "reset", "restore", "revert", "branch", "stash", "rm", "mv", "tag",
  "update-index", "update-ref", "cherry-pick", "rebase", "merge", "notes",
]);
const GIT_GLOBAL_OPTIONS_WITH_VALUE = new Set([
  "-C", "-c", "--config-env", "--exec-path", "--git-dir", "--work-tree", "--namespace", "--super-prefix",
]);

function shellCommandSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  let word = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  const flushWord = () => {
    if (word.length > 0) segments[segments.length - 1]!.push(word);
    word = "";
  };
  const flushSegment = () => {
    flushWord();
    if (segments[segments.length - 1]!.length > 0) segments.push([]);
  };
  for (const character of command) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (quote) {
      if (character === quote) quote = undefined;
      else if (character === "\\" && quote !== "'") escaped = true;
      else word += character;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "\n" || character === "\r") {
      flushSegment();
      continue;
    }
    if (/\s/.test(character)) {
      flushWord();
      continue;
    }
    if (character === ";" || character === "|" || character === "&") {
      flushSegment();
      continue;
    }
    word += character;
  }
  flushWord();
  return segments.filter(segment => segment.length > 0);
}

function gitSubcommand(words: readonly string[]): string | undefined {
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] ?? "")) index += 1;
  if (words[index] === "command") index += 1;
  if (words[index] !== "git") return undefined;
  index += 1;
  while (index < words.length) {
    const word = words[index]!;
    if (!word.startsWith("-")) return word.toLowerCase();
    if (word === "--") return undefined;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(word)) {
      index += 2;
      continue;
    }
    if (/^-C.+/.test(word) || /^-c.+/.test(word) || /^--(?:config-env|exec-path|git-dir|work-tree|namespace|super-prefix)=/.test(word)) {
      index += 1;
      continue;
    }
    index += 1;
  }
  return undefined;
}

/** Git mutations need a Codex sandbox escalation; status/log/diff do not. */
export function grokShellNeedsGitEscalation(cmd: string): boolean {
  return shellCommandSegments(cmd).some(segment => {
    const subcommand = gitSubcommand(segment);
    return subcommand !== undefined && GIT_MUTATING_COMMANDS.has(subcommand);
  });
}

export type GrokStructuredEditTranslation =
  | { patch: string; error?: undefined }
  | { error: string; patch?: undefined };

export type GrokEditCodexSink =
  | { kind: "exec"; name: string }
  | { kind: "apply_patch" };

export function isGrokStructuredEditToolName(name: string): boolean {
  return name === GROK_SEARCH_REPLACE_TOOL || name === GROK_WRITE_TOOL || name === GROK_WRITE_ALIAS;
}

export function isGrokNativeToolName(name: string): boolean {
  return GROK_NATIVE_CALL_NAMES.has(name);
}

function isGrokWriteToolName(name: string): boolean {
  return name === GROK_WRITE_TOOL || name === GROK_WRITE_ALIAS;
}

export function isXaiGrokChatProvider(provider: Pick<OcxProviderConfig, "baseUrl">): boolean {
  try {
    const host = new URL(provider.baseUrl).hostname.toLowerCase();
    return host === "api.x.ai" || host.endsWith(".x.ai") || host === "cli-chat-proxy.grok.com";
  } catch {
    return false;
  }
}

const CODEX_APPLY_PATCH_EDIT_CONSTRAINT =
  /Use `apply_patch` for local file edits\. Do not create or edit files with `cat` or other shell write tricks\. Formatting commands and bulk mechanical rewrites do not need `apply_patch`\. Do not use Python to read or write files when a simple shell command or `apply_patch` is enough\./g;

const GROK_FILE_EDIT_CONSTRAINT =
  "File edits on this turn use the listed tools `write` and `search_replace`. "
  + "OpenCodex converts those calls into Codex apply_patch. "
  + "Do not call `apply_patch` or `exec` unless this turn's catalog lists those exact names. "
  + "Do not create or edit files with `cat` or other shell write tricks.";

/**
 * Codex base instructions name `apply_patch` as the edit tool. Grok's advertised
 * catalog does not list it. Rewrite that constraint so the callable names match.
 */
export function rewriteCodexFileEditGuidanceForGrok(text: string): string {
  return text.replace(CODEX_APPLY_PATCH_EDIT_CONSTRAINT, GROK_FILE_EDIT_CONSTRAINT);
}

function isCodexCodeModeExecTool(tool: Pick<OcxTool, "namespace" | "name" | "freeform">): boolean {
  return !tool.namespace && tool.name === "exec" && tool.freeform === true;
}

function isBareShellBridgeTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return !tool.namespace && (CODEX_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).includes(tool.name);
}

function isExecToolChoiceName(name: string): boolean {
  return name === "exec" || name.endsWith("__exec");
}

/** Codex Desktop often sends `{allowedTools:["exec"], mode:"auto"}`, not the string `"auto"`. */
function grokToolChoiceAllowsNativeCatalog(toolChoice: OcxRequestOptions["toolChoice"] | undefined): boolean {
  if (!toolChoice || toolChoice === "auto" || toolChoice === "required") return true;
  if (toolChoice === "none") return false;
  if (isAllowedToolChoice(toolChoice)) {
    return toolChoice.allowedTools.some(isExecToolChoiceName);
  }
  return typeof toolChoice === "object" && "name" in toolChoice && isExecToolChoiceName(toolChoice.name);
}

function firstStringArg(args: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function firstBooleanArg(args: Record<string, unknown>, keys: readonly string[]): boolean | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function firstNumberArg(args: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function normalizePatchPath(path: string): string {
  let next = path.trim().replace(/\\/g, "/");
  while (next.startsWith("./")) next = next.slice(2);
  return next;
}

function patchLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function addFilePatch(path: string, contents: string): GrokStructuredEditTranslation {
  const lines = patchLines(contents);
  if (lines.length === 0 && contents.length === 0) {
    return { error: `${GROK_WRITE_TOOL} requires non-empty content; the call was dropped.` };
  }
  return { patch: [PATCH_BEGIN, `*** Add File: ${path}`, ...lines.map(line => `+${line}`), PATCH_END].join("\n") };
}

function replacementPatch(path: string, oldString: string, newString: string): GrokStructuredEditTranslation {
  if (oldString.length === 0) return addFilePatch(path, newString);
  const oldLines = patchLines(oldString);
  const newLines = patchLines(newString);
  if (oldLines.length === newLines.length && oldLines.every((line, i) => line === newLines[i])) {
    return { error: `${GROK_SEARCH_REPLACE_TOOL} old_string and new_string are identical; the replacement is a no-op and was dropped.` };
  }
  return {
    patch: [
      PATCH_BEGIN,
      `*** Update File: ${path}`,
      "@@",
      ...oldLines.map(line => `-${line}`),
      ...newLines.map(line => `+${line}`),
      PATCH_END,
    ].join("\n"),
  };
}

export function grokEditCodexSink(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform" | "description">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): GrokEditCodexSink | undefined {
  const visible = tools?.filter(toolChoiceToolPredicate(toolChoice, tools));
  if (!visible || visible.length === 0) return undefined;
  if (visible.some(tool => !tool.namespace && tool.name === "apply_patch")) return { kind: "apply_patch" };
  const exec = visible.find(isCodexCodeModeExecTool);
  if (!exec || visible.some(isBareShellBridgeTool)) return undefined;
  const helpers = declaredToolsBlock(exec.description ?? "");
  if (!helpers || !/\bapply_patch\s*\(\s*input\s*:\s*string\s*\)/i.test(helpers)) return undefined;
  return { kind: "exec", name: namespacedToolName(exec.namespace, exec.name) };
}

function grokCodeModeExecSink(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform" | "description">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
): Extract<GrokEditCodexSink, { kind: "exec" }> | undefined {
  const visible = tools?.filter(toolChoiceToolPredicate(toolChoice, tools));
  if (!visible || visible.length === 0) return undefined;
  const exec = visible.find(isCodexCodeModeExecTool);
  if (!exec || visible.some(isBareShellBridgeTool)) return undefined;
  const helpers = declaredToolsBlock(exec.description ?? "");
  if (!helpers || !/\bapply_patch\s*\(\s*input\s*:\s*string\s*\)/i.test(helpers)) return undefined;
  // Live Codex often declares only apply_patch in this block. exec_command still exists
  // on the isolate (ALL_TOOLS); requiring it here left exec in Grok's catalog.
  return { kind: "exec", name: namespacedToolName(exec.namespace, exec.name) };
}

export function grokNativeCatalogTools(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform" | "description">[] | undefined,
  toolChoice: OcxRequestOptions["toolChoice"] | undefined,
  provider: Pick<OcxProviderConfig, "baseUrl">,
  effectiveInstructions?: readonly string[],
): OcxTool[] {
  if (!isXaiGrokChatProvider(provider)) return [];
  if (!grokToolChoiceAllowsNativeCatalog(toolChoice)) return [];
  if (shouldSuppressCodeModePatchGuidance((effectiveInstructions ?? []).join("\n"))) return [];
  if (!grokCodeModeExecSink(tools, toolChoice)) return [];
  const existingBareNames = new Set((tools ?? []).filter(tool => !tool.namespace).map(tool => tool.name));
  const candidates: OcxTool[] = [
    {
      name: GROK_READ_FILE_TOOL,
      description: "Read a file from the workspace.",
      parameters: { ...GROK_READ_FILE_INPUT_SCHEMA },
    },
    {
      name: GROK_GREP_TOOL,
      description: "Search file contents with a regular expression.",
      parameters: { ...GROK_GREP_INPUT_SCHEMA },
    },
    {
      name: GROK_LIST_DIR_TOOL,
      description: "List a directory.",
      parameters: { ...GROK_LIST_DIR_INPUT_SCHEMA },
    },
    {
      name: GROK_SEARCH_REPLACE_TOOL,
      description:
        "Replace one block of text in a file. Call this tool to edit; describing the edit in assistant text does not change the file. OpenCodex converts the replacement into a Codex apply_patch change. Copy old_string and new_string with their exact leading whitespace — Codex may locate a line after trimming indent, but it writes new_string verbatim, so stripped indent silently corrupts the file. An empty old_string with a non-empty new_string creates a new file (Add File). If the same text appears more than once, the first match is updated.",
      parameters: { ...GROK_SEARCH_REPLACE_INPUT_SCHEMA },
    },
    {
      name: GROK_WRITE_TOOL,
      description:
        "Create a new file, including files produced by a refactor or split. Splitting a large file is one write per new module from slices already read, not a design outline in assistant text. Call this tool to create the file; describing the change does not write it. OpenCodex converts the content into a Codex apply_patch Add File. Use search_replace to change an existing file.",
      parameters: { ...GROK_WRITE_INPUT_SCHEMA },
    },
    {
      name: GROK_RUN_TERMINAL_COMMAND_TOOL,
      description:
        "Run a shell command. Use read_file, grep, list_dir, search_replace, and write for ordinary file work. Git operations that update the index or refs, for example add, commit, checkout, switch, reset, or restore, must set with_escalated_permissions=true (and a short justification) so Codex can prompt to write repository lock files; a commentary message cannot request that permission. If a command fails with Operation not permitted, retry once with with_escalated_permissions=true.",
      parameters: { ...GROK_RUN_TERMINAL_COMMAND_INPUT_SCHEMA },
    },
  ];
  const available = candidates.filter(tool => !existingBareNames.has(tool.name));
  // Hiding exec is safe only while the projected catalog still owns an edit sink. If the
  // caller already owns both edit names, the remaining read/terminal helpers cannot be
  // translated into file mutations, so keep the original code-mode catalog intact.
  return available.some(tool => isGrokStructuredEditToolName(tool.name)) ? available : [];
}

type GrokNativeCatalogRequest = {
  context?: {
    tools?: readonly Pick<OcxTool, "namespace" | "name" | "freeform" | "description">[];
    messages?: Parameters<typeof effectiveInstructionText>[0];
    systemPrompt?: readonly string[];
  };
  options?: { toolChoice?: OcxRequestOptions["toolChoice"] };
};

/** Exact upstream-only Grok names introduced for this request after collision filtering. */
export function grokNativeToolNamesForRequest(
  parsed: GrokNativeCatalogRequest,
  provider: Pick<OcxProviderConfig, "baseUrl">,
): ReadonlySet<string> {
  const context = parsed.context ?? {};
  const effectiveInstructions = effectiveInstructionText(context.messages, context.systemPrompt);
  return new Set(grokNativeCatalogTools(
    context.tools,
    parsed.options?.toolChoice,
    provider,
    effectiveInstructions,
  ).map(tool => tool.name));
}

/** @deprecated Use grokNativeCatalogTools. Write tools only, for older tests. */
export function grokStructuredEditTools(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform" | "description">[] | undefined,
  toolChoice: OcxRequestOptions["toolChoice"] | undefined,
  provider: Pick<OcxProviderConfig, "baseUrl">,
  effectiveInstructions?: readonly string[],
): OcxTool[] {
  return grokNativeCatalogTools(tools, toolChoice, provider, effectiveInstructions)
    .filter(tool => isGrokStructuredEditToolName(tool.name));
}

export function grokFacingTools(
  tools: readonly OcxTool[] | undefined,
  toolChoice: OcxRequestOptions["toolChoice"] | undefined,
  provider: Pick<OcxProviderConfig, "baseUrl">,
  effectiveInstructions?: readonly string[],
): OcxTool[] | undefined {
  if (!tools) return undefined;
  const native = grokNativeCatalogTools(tools, toolChoice, provider, effectiveInstructions);
  const visible = tools.filter(toolChoiceToolPredicate(toolChoice, tools));
  if (native.length === 0) return visible;
  return [...visible.filter(tool => tool.namespace || tool.name !== "exec"), ...native];
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function grokResponsesFunctionTool(tool: OcxTool): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    parameters: tool.parameters,
    ...(tool.strict !== undefined ? { strict: tool.strict } : {}),
  };
}

function isResponsesCodeModeExecDeclaration(tool: unknown): boolean {
  return isPlainRecord(tool) && tool.type === "custom" && tool.name === "exec";
}

function rewriteResponsesToolGroup(
  tools: unknown[],
  replacements: readonly Record<string, unknown>[],
  state: { injected: boolean; replaced: boolean },
): unknown[] {
  const rewritten: unknown[] = [];
  for (const tool of tools) {
    if (isResponsesCodeModeExecDeclaration(tool)) {
      state.replaced = true;
      if (!state.injected) {
        rewritten.push(...replacements);
        state.injected = true;
      }
      continue;
    }
    if (
      isPlainRecord(tool)
      && tool.type === "namespace"
      && tool.name === "functions"
      && Array.isArray(tool.tools)
    ) {
      const inner = tool.tools.filter(entry => !isResponsesCodeModeExecDeclaration(entry));
      if (inner.length !== tool.tools.length) {
        state.replaced = true;
        if (inner.length > 0) rewritten.push({ ...tool, tools: inner });
        if (!state.injected) {
          rewritten.push(...replacements);
          state.injected = true;
        }
        continue;
      }
    }
    rewritten.push(tool);
  }
  return rewritten;
}

function rewriteResponsesInstructionContent(content: unknown): unknown {
  if (typeof content === "string") return rewriteCodexFileEditGuidanceForGrok(content);
  if (!Array.isArray(content)) return content;
  let changed = false;
  const next = content.map(part => {
    if (!isPlainRecord(part) || typeof part.text !== "string") return part;
    const text = rewriteCodexFileEditGuidanceForGrok(part.text);
    if (text === part.text) return part;
    changed = true;
    return { ...part, text };
  });
  return changed ? next : content;
}

function rewriteResponsesInstructions(body: Record<string, unknown>): Record<string, unknown> {
  let next = body;
  if (typeof body.instructions === "string") {
    const instructions = rewriteCodexFileEditGuidanceForGrok(body.instructions);
    if (instructions !== body.instructions) next = { ...next, instructions };
  }
  if (!Array.isArray(next.input)) return next;
  let changed = false;
  const input = next.input.map(item => {
    if (
      !isPlainRecord(item)
      || (item.type !== undefined && item.type !== "message")
      || (item.role !== "developer" && item.role !== "system")
    ) return item;
    const content = rewriteResponsesInstructionContent(item.content);
    if (content === item.content) return item;
    changed = true;
    return { ...item, content };
  });
  return changed ? { ...next, input } : next;
}

function parsedExecArguments(item: Record<string, unknown>): Record<string, unknown> | undefined {
  if (item.type === "custom_tool_call") {
    return typeof item.input === "string" ? { input: item.input } : undefined;
  }
  if (item.type !== "function_call" || typeof item.arguments !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(item.arguments);
    return isPlainRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function responsesFunctionCallItemId(id: unknown): unknown {
  if (typeof id !== "string" || !id.startsWith("ctc_")) return id;
  return `fc_${id.slice(4)}`;
}

function rewriteResponsesExecHistory(
  body: Record<string, unknown>,
  sinkName: string,
  convertedNativeToolNames: ReadonlySet<string>,
): Record<string, unknown> {
  if (!Array.isArray(body.input)) return body;
  const reconstructed = new Map<string, ReconstructedGrokToolCall>();
  for (const item of body.input) {
    if (!isPlainRecord(item) || item.name !== sinkName || typeof item.call_id !== "string") continue;
    const args = parsedExecArguments(item);
    const call = args ? reconstructGrokToolCallFromExec(args) : undefined;
    if (call && convertedNativeToolNames.has(call.name)) reconstructed.set(item.call_id, call);
  }
  if (reconstructed.size === 0) return body;
  let changed = false;
  const input = body.input.map(item => {
    if (!isPlainRecord(item) || typeof item.call_id !== "string") return item;
    const call = reconstructed.get(item.call_id);
    if (!call) return item;
    if (
      (item.type === "custom_tool_call" || item.type === "function_call")
      && item.name === sinkName
    ) {
      const { input: _input, arguments: _arguments, ...rest } = item;
      changed = true;
      return {
        ...rest,
        type: "function_call",
        id: responsesFunctionCallItemId(item.id),
        name: call.name,
        arguments: JSON.stringify(call.arguments),
      };
    }
    if (item.type === "custom_tool_call_output") {
      changed = true;
      return { ...item, type: "function_call_output" };
    }
    return item;
  });
  return changed ? { ...body, input } : body;
}

function rewriteResponsesExecToolChoice(
  body: Record<string, unknown>,
  nativeNames: readonly string[],
): Record<string, unknown> {
  const choice = body.tool_choice;
  if (!isPlainRecord(choice)) return body;
  if ((choice.type === "custom" || choice.type === "function") && choice.name === "exec") {
    return { ...body, tool_choice: "required" };
  }
  if (choice.type !== "allowed_tools" || !Array.isArray(choice.tools)) return body;
  let replaced = false;
  const tools: unknown[] = [];
  const seen = new Set<string>();
  for (const entry of choice.tools) {
    if (isPlainRecord(entry) && entry.name === "exec") {
      replaced = true;
      for (const name of nativeNames) {
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push({ type: "function", name });
      }
      continue;
    }
    const key = isPlainRecord(entry) && typeof entry.name === "string" ? entry.name : undefined;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    tools.push(entry);
  }
  return replaced ? { ...body, tool_choice: { ...choice, tools } } : body;
}

export type GrokResponsesRequestRewrite = {
  body: unknown;
  convertedNativeToolNames: ReadonlySet<string>;
  execSinkName?: string;
};

/**
 * Apply the Grok Build catalog to raw Responses passthrough requests. Unlike the
 * Chat adapter, this path serializes `_rawBody`, so parsed-context changes alone
 * cannot affect the upstream catalog.
 */
export function rewriteGrokResponsesRequestBody(
  body: unknown,
  parsed: {
    context?: {
      tools?: readonly OcxTool[];
      messages?: Parameters<typeof effectiveInstructionText>[0];
      systemPrompt?: readonly string[];
    };
    options?: { toolChoice?: OcxRequestOptions["toolChoice"] };
  },
  provider: Pick<OcxProviderConfig, "baseUrl">,
): GrokResponsesRequestRewrite {
  if (!isPlainRecord(body)) return { body, convertedNativeToolNames: new Set() };
  const context = parsed.context ?? {};
  const toolChoice = parsed.options?.toolChoice;
  const effectiveInstructions = effectiveInstructionText(
    context.messages,
    context.systemPrompt,
  );
  const native = grokNativeCatalogTools(
    context.tools,
    toolChoice,
    provider,
    effectiveInstructions,
  );
  const sink = grokCodeModeExecSink(context.tools, toolChoice);
  if (native.length === 0 || !sink) return { body, convertedNativeToolNames: new Set() };

  const convertedNativeToolNames = new Set(native.map(tool => tool.name));
  const replacements = native.map(grokResponsesFunctionTool);
  const state = { injected: false, replaced: false };
  let next: Record<string, unknown> = body;
  if (Array.isArray(next.tools)) {
    const originalTools = next.tools;
    const tools = rewriteResponsesToolGroup(originalTools, replacements, state);
    if (tools.length !== originalTools.length || tools.some((entry, index) => entry !== originalTools[index])) {
      next = { ...next, tools };
    }
  }
  if (Array.isArray(next.input)) {
    let changed = false;
    const input = next.input.map(item => {
      if (!isPlainRecord(item) || item.type !== "additional_tools" || !Array.isArray(item.tools)) return item;
      const originalTools = item.tools;
      const tools = rewriteResponsesToolGroup(originalTools, replacements, state);
      if (tools.length === originalTools.length && tools.every((entry, index) => entry === originalTools[index])) return item;
      changed = true;
      return { ...item, tools };
    });
    if (changed) next = { ...next, input };
  }
  // A parsed tool can come from replay metadata rather than a writable catalog
  // container. Do not arm response rewriting unless an actual exec declaration
  // was replaced on the wire.
  if (!state.replaced) return { body, convertedNativeToolNames: new Set() };

  next = rewriteResponsesInstructions(next);
  next = rewriteResponsesExecHistory(next, sink.name, convertedNativeToolNames);
  next = rewriteResponsesExecToolChoice(next, [...convertedNativeToolNames]);
  return {
    body: next,
    convertedNativeToolNames,
    execSinkName: sink.name,
  };
}

export function translateGrokStructuredEditCall(
  toolName: string,
  argsText: string,
): GrokStructuredEditTranslation | undefined {
  if (!isGrokStructuredEditToolName(toolName)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsText);
    if (typeof parsed === "string") parsed = JSON.parse(parsed);
  } catch {
    return {
      error: `${toolName} arguments were not valid JSON; the call was dropped. `
        + (isGrokWriteToolName(toolName)
          ? "Use file_path and content."
          : "Use file_path, old_string, and new_string."),
    };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { error: `${toolName} arguments must be a JSON object; the call was dropped.` };
  }
  const args = parsed as Record<string, unknown>;
  const rawPath = firstStringArg(args, PATH_ARG_KEYS);
  const path = rawPath ? normalizePatchPath(rawPath) : undefined;
  if (!path) return { error: `${toolName} is missing a non-empty file_path; the call was dropped.` };
  if (/[\n\r\0]/.test(path)) {
    return { error: `${toolName} file_path must not contain a newline, CR, or NUL; the call was dropped.` };
  }
  if (args.replace_all === true || args.replaceAll === true) {
    return {
      error: `${toolName} replace_all is not supported; Codex apply_patch first-matches only. Split into unique old_string hunks.`,
    };
  }
  if (isGrokWriteToolName(toolName)) {
    const content = firstStringArg(args, WRITE_CONTENT_KEYS);
    if (content === undefined) return { error: `${GROK_WRITE_TOOL} requires content; the call was dropped.` };
    return addFilePatch(path, content);
  }
  const oldString = firstStringArg(args, OLD_STRING_KEYS);
  const newString = firstStringArg(args, NEW_STRING_KEYS);
  if (oldString === undefined || newString === undefined) {
    return { error: `${GROK_SEARCH_REPLACE_TOOL} requires old_string and new_string; the call was dropped.` };
  }
  return replacementPatch(path, oldString, newString);
}

function parseArgsObject(argsText: string): Record<string, unknown> | { error: string } {
  try {
    const parsed: unknown = JSON.parse(argsText);
    const value = typeof parsed === "string" ? JSON.parse(parsed) : parsed;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { error: "arguments must be a JSON object" };
    }
    return value as Record<string, unknown>;
  } catch {
    return { error: "arguments were not valid JSON" };
  }
}

type GrokExecCommandExtras = {
  workdir?: string;
  requireEscalatedSandbox?: boolean;
  justification?: string;
};

function encodeExecCommand(
  cmd: string,
  sinkName: string,
  extras: GrokExecCommandExtras = {},
): { name: string; arguments: string } {
  const fields = [`cmd: ${JSON.stringify(cmd)}`];
  if (extras.workdir) fields.push(`workdir: ${JSON.stringify(extras.workdir)}`);
  if (extras.requireEscalatedSandbox) fields.push('sandbox_permissions: "require_escalated"');
  if (extras.justification) fields.push(`justification: ${JSON.stringify(extras.justification)}`);
  const input = `const r = await tools.exec_command({ ${fields.join(", ")} });\ntext(r.output);`;
  return { name: sinkName, arguments: JSON.stringify({ input }) };
}

function execCommandExtras(toolName: string, argsText: string, cmd: string): GrokExecCommandExtras {
  if (toolName !== GROK_RUN_TERMINAL_COMMAND_TOOL) return {};
  const args = parseArgsObject(argsText);
  if ("error" in args) return {};
  const workdir = firstStringArg(args, ["working_directory", "workingDirectory", "workdir", "cwd"]);
  const justification = firstStringArg(args, ["justification", "reason"]);
  const explicit = firstBooleanArg(args, ["with_escalated_permissions", "withEscalatedPermissions", "escalate"]);
  const auto = grokShellNeedsGitEscalation(cmd);
  const escalate = auto || explicit === true;
  if (!escalate && !workdir) return {};
  return {
    ...(workdir ? { workdir } : {}),
    ...(escalate ? { requireEscalatedSandbox: true } : {}),
    ...(escalate ? { justification: justification ?? (auto ? GIT_INDEX_ESCALATION_JUSTIFICATION : undefined) } : {}),
  };
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function powershellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function powershellEncodedCommand(script: string): string {
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, "utf16le").toString("base64")}`;
}

function posixGrokShellCommand(
  toolName: string,
  path: string | undefined,
  offset: number | undefined,
  limit: number | undefined,
  pattern: string | undefined,
  glob: string | undefined,
  command: string | undefined,
): { cmd: string } | { error: string } {
  if (toolName === GROK_READ_FILE_TOOL) {
    if (!path) return { error: `${toolName} is missing a non-empty path` };
    if (offset !== undefined || limit !== undefined) {
      const start = Math.max(1, Math.floor(offset ?? 1));
      const end = limit !== undefined ? start + Math.max(0, Math.floor(limit)) - 1 : "$";
      return { cmd: `sed -n ${shellSingleQuote(`${start},${end}p`)} ${shellSingleQuote(path)}` };
    }
    return { cmd: `cat -- ${shellSingleQuote(path)}` };
  }
  if (toolName === GROK_GREP_TOOL) {
    if (!pattern) return { error: `${toolName} is missing a pattern` };
    const target = path ?? ".";
    const globFlag = glob ? ` --glob ${shellSingleQuote(glob)}` : "";
    return { cmd: `rg -n${globFlag} -- ${shellSingleQuote(pattern)} ${shellSingleQuote(target)}` };
  }
  if (toolName === GROK_LIST_DIR_TOOL) {
    return { cmd: `ls -la -- ${shellSingleQuote(path ?? ".")}` };
  }
  if (toolName === GROK_RUN_TERMINAL_COMMAND_TOOL) {
    if (!command) return { error: `${toolName} is missing a command` };
    return { cmd: command };
  }
  return { error: `${toolName} is not a shell-mapped Grok tool` };
}

function windowsGrokShellCommand(
  toolName: string,
  path: string | undefined,
  offset: number | undefined,
  limit: number | undefined,
  pattern: string | undefined,
  glob: string | undefined,
  command: string | undefined,
): { cmd: string } | { error: string } {
  if (toolName === GROK_READ_FILE_TOOL) {
    if (!path) return { error: `${toolName} is missing a non-empty path` };
    const literal = powershellSingleQuote(path);
    if (offset !== undefined || limit !== undefined) {
      const start = Math.max(1, Math.floor(offset ?? 1));
      const skip = start - 1;
      const first = limit !== undefined ? ` -First ${Math.max(0, Math.floor(limit))}` : "";
      return {
        cmd: powershellEncodedCommand(
          `Get-Content -LiteralPath ${literal} | Select-Object -Skip ${skip}${first} | Out-String`,
        ),
      };
    }
    return { cmd: powershellEncodedCommand(`Get-Content -LiteralPath ${literal} -Raw`) };
  }
  if (toolName === GROK_GREP_TOOL) {
    if (!pattern) return { error: `${toolName} is missing a pattern` };
    const target = powershellSingleQuote(path ?? ".");
    const pat = powershellSingleQuote(pattern);
    const globFilter = glob
      ? ` | Where-Object { $_.Name -like ${powershellSingleQuote(glob)} }`
      : "";
    return {
      cmd: powershellEncodedCommand(
        `$items = @(Get-ChildItem -LiteralPath ${target} -Recurse -File -ErrorAction SilentlyContinue${globFilter}); `
          + `if (-not $items -and (Test-Path -LiteralPath ${target} -PathType Leaf)) { $items = @(Get-Item -LiteralPath ${target}) }; `
          + `$items | Select-String -Pattern ${pat} | ForEach-Object { '{0}:{1}:{2}' -f $_.Path, $_.LineNumber, $_.Line }`,
      ),
    };
  }
  if (toolName === GROK_LIST_DIR_TOOL) {
    const target = powershellSingleQuote(path ?? ".");
    return {
      cmd: powershellEncodedCommand(
        `Get-ChildItem -Force -LiteralPath ${target} | Format-Table Mode, Length, LastWriteTime, Name -AutoSize | Out-String`,
      ),
    };
  }
  if (toolName === GROK_RUN_TERMINAL_COMMAND_TOOL) {
    if (!command) return { error: `${toolName} is missing a command` };
    return { cmd: command };
  }
  return { error: `${toolName} is not a shell-mapped Grok tool` };
}

export function translateGrokShellCall(
  toolName: string,
  argsText: string,
  platform: NodeJS.Platform = process.platform,
): { cmd: string } | { error: string } {
  const args = parseArgsObject(argsText);
  if ("error" in args) return { error: `${toolName} ${args.error}` };
  const rawPath = firstStringArg(args, PATH_ARG_KEYS);
  const path = rawPath ? normalizePatchPath(rawPath) : undefined;
  const offset = firstNumberArg(args, ["offset", "start_line", "startLine"]);
  const limit = firstNumberArg(args, ["limit", "count"]);
  const pattern = firstStringArg(args, PATTERN_ARG_KEYS);
  const glob = firstStringArg(args, GLOB_ARG_KEYS);
  const command = firstStringArg(args, COMMAND_ARG_KEYS);
  if (platform === "win32") {
    return windowsGrokShellCommand(toolName, path, offset, limit, pattern, glob, command);
  }
  return posixGrokShellCommand(toolName, path, offset, limit, pattern, glob, command);
}

export type ReconstructedGrokToolCall = {
  name: string;
  arguments: Record<string, unknown>;
};

function parseJsonStringLiteral(source: string): string | undefined {
  const trimmed = source.trim();
  if (!trimmed.startsWith("\"")) return undefined;
  try {
    const value: unknown = JSON.parse(trimmed);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function splitJsonStringAtStart(source: string): { value: string; rest: string } | undefined {
  if (!source.startsWith("\"")) return undefined;
  let index = 1;
  while (index < source.length) {
    if (source[index] === "\\") {
      index += 2;
      continue;
    }
    if (source[index] === "\"") {
      const value = parseJsonStringLiteral(source.slice(0, index + 1));
      if (value === undefined) return undefined;
      return { value, rest: source.slice(index + 1) };
    }
    index += 1;
  }
  return undefined;
}

function unquotePowershellLiteral(quoted: string): string | undefined {
  if (quoted.length < 2 || quoted[0] !== "'" || quoted[quoted.length - 1] !== "'") return undefined;
  return quoted.slice(1, -1).replace(/''/g, "'");
}

const POWERSHELL_LITERAL_CAPTURE = "('(?:[^']|'')*')";
const POWERSHELL_RAW_READ = new RegExp(`^Get-Content -LiteralPath ${POWERSHELL_LITERAL_CAPTURE} -Raw$`);
const POWERSHELL_RANGED_READ = new RegExp(`^Get-Content -LiteralPath ${POWERSHELL_LITERAL_CAPTURE} \\| Select-Object -Skip (\\d+)(?: -First (\\d+))? \\| Out-String$`);
const POWERSHELL_LIST_DIR = new RegExp(`^Get-ChildItem -Force -LiteralPath ${POWERSHELL_LITERAL_CAPTURE} \\| Format-Table Mode, Length, LastWriteTime, Name -AutoSize \\| Out-String$`);
const POWERSHELL_GREP_PATTERN = new RegExp(`Select-String -Pattern ${POWERSHELL_LITERAL_CAPTURE}`);
const POWERSHELL_GREP_DIRECTORY = new RegExp(`Get-ChildItem -LiteralPath ${POWERSHELL_LITERAL_CAPTURE} -Recurse -File`);
const POWERSHELL_GREP_FILE = new RegExp(`Get-Item -LiteralPath ${POWERSHELL_LITERAL_CAPTURE}`);
const POWERSHELL_GREP_GLOB = new RegExp(`Where-Object \\{ \\$_\\.Name -like ${POWERSHELL_LITERAL_CAPTURE} \\}`);

function reconstructFromApplyPatch(patch: string): ReconstructedGrokToolCall | undefined {
  const lines = patch.split("\n");
  if (lines[0] !== PATCH_BEGIN || lines[lines.length - 1] !== PATCH_END || lines.length < 3) return undefined;
  const add = /^\*\*\* Add File: (.+)$/.exec(lines[1]);
  if (add) {
    const contents = lines.slice(2, -1).map(line => (line.startsWith("+") ? line.slice(1) : line)).join("\n");
    return { name: GROK_WRITE_TOOL, arguments: { file_path: add[1], content: contents } };
  }
  const update = /^\*\*\* Update File: (.+)$/.exec(lines[1]);
  if (!update) return undefined;
  const bodyStart = lines[2] === "@@" ? 3 : 2;
  const oldLines: string[] = [];
  const newLines: string[] = [];
  for (const line of lines.slice(bodyStart, -1)) {
    if (line.startsWith("-")) oldLines.push(line.slice(1));
    else if (line.startsWith("+")) newLines.push(line.slice(1));
    else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1));
      newLines.push(line.slice(1));
    }
  }
  return {
    name: GROK_SEARCH_REPLACE_TOOL,
    arguments: { file_path: update[1], old_string: oldLines.join("\n"), new_string: newLines.join("\n") },
  };
}

function splitShellSingleQuotedAtStart(source: string): { value: string; rest: string } | undefined {
  if (!source.startsWith("'")) return undefined;
  let value = "";
  let index = 1;
  while (index < source.length) {
    if (source.startsWith("'\\''", index)) {
      value += "'";
      index += 4;
      continue;
    }
    if (source[index] === "'") return { value, rest: source.slice(index + 1) };
    value += source[index];
    index += 1;
  }
  return undefined;
}

function reconstructFromPosixCmd(cmd: string): ReconstructedGrokToolCall | undefined {
  if (cmd.startsWith("cat -- ")) {
    const path = splitShellSingleQuotedAtStart(cmd.slice("cat -- ".length));
    if (path && path.rest === "" && path.value) {
      return { name: GROK_READ_FILE_TOOL, arguments: { target_file: path.value } };
    }
  }
  const sed = /^sed -n '(\d+),(\$|\d+)p' /.exec(cmd);
  if (sed) {
    const path = splitShellSingleQuotedAtStart(cmd.slice(sed[0].length));
    if (!path || path.rest !== "" || !path.value) return undefined;
    const offset = Number(sed[1]);
    const arguments_: Record<string, unknown> = { target_file: path.value, offset };
    if (sed[2] !== "$") arguments_.limit = Number(sed[2]) - offset + 1;
    return { name: GROK_READ_FILE_TOOL, arguments: arguments_ };
  }
  if (cmd.startsWith("ls -la -- ")) {
    const path = splitShellSingleQuotedAtStart(cmd.slice("ls -la -- ".length));
    if (path && path.rest === "" && path.value) {
      return { name: GROK_LIST_DIR_TOOL, arguments: { target_directory: path.value } };
    }
  }
  if (!cmd.startsWith("rg -n")) return undefined;
  let rest = cmd.slice("rg -n".length);
  let glob: string | undefined;
  if (rest.startsWith(" --glob ")) {
    const split = splitShellSingleQuotedAtStart(rest.slice(" --glob ".length));
    if (!split || !split.value) return undefined;
    glob = split.value;
    rest = split.rest;
  }
  if (!rest.startsWith(" -- ")) return undefined;
  const pattern = splitShellSingleQuotedAtStart(rest.slice(" -- ".length));
  if (!pattern || !pattern.value || !pattern.rest.startsWith(" ")) return undefined;
  const path = splitShellSingleQuotedAtStart(pattern.rest.slice(1));
  if (!path || path.rest !== "") return undefined;
  return {
    name: GROK_GREP_TOOL,
    arguments: { pattern: pattern.value, path: path.value, ...(glob ? { glob } : {}) },
  };
}

function reconstructFromWindowsCmd(cmd: string): ReconstructedGrokToolCall | undefined {
  const encoded = /^powershell\.exe -NoProfile -NonInteractive -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(cmd.trim());
  if (!encoded) return undefined;
  let script: string;
  try {
    script = Buffer.from(encoded[1], "base64").toString("utf16le");
  } catch {
    return undefined;
  }
  const raw = POWERSHELL_RAW_READ.exec(script);
  if (raw) {
    const path = unquotePowershellLiteral(raw[1]);
    return path ? { name: GROK_READ_FILE_TOOL, arguments: { target_file: path } } : undefined;
  }
  const ranged = POWERSHELL_RANGED_READ.exec(script);
  if (ranged) {
    const path = unquotePowershellLiteral(ranged[1]);
    if (!path) return undefined;
    const arguments_: Record<string, unknown> = { target_file: path, offset: Number(ranged[2]) + 1 };
    if (ranged[3]) arguments_.limit = Number(ranged[3]);
    return { name: GROK_READ_FILE_TOOL, arguments: arguments_ };
  }
  const list = POWERSHELL_LIST_DIR.exec(script);
  if (list) {
    const path = unquotePowershellLiteral(list[1]);
    return path ? { name: GROK_LIST_DIR_TOOL, arguments: { target_directory: path } } : undefined;
  }
  const grep = POWERSHELL_GREP_PATTERN.exec(script);
  const grepPath = POWERSHELL_GREP_DIRECTORY.exec(script) ?? POWERSHELL_GREP_FILE.exec(script);
  if (grep && grepPath) {
    const pattern = unquotePowershellLiteral(grep[1]);
    const path = unquotePowershellLiteral(grepPath[1]);
    if (!pattern || path === undefined) return undefined;
    const arguments_: Record<string, unknown> = { pattern, path };
    const glob = POWERSHELL_GREP_GLOB.exec(script);
    if (glob) {
      const globValue = unquotePowershellLiteral(glob[1]);
      if (globValue) arguments_.glob = globValue;
    }
    return { name: GROK_GREP_TOOL, arguments: arguments_ };
  }
  return undefined;
}

function reconstructFromShellCmd(cmd: string, extras: Record<string, unknown> = {}): ReconstructedGrokToolCall {
  const mapped = reconstructFromPosixCmd(cmd) ?? reconstructFromWindowsCmd(cmd);
  if (mapped) return mapped;
  return { name: GROK_RUN_TERMINAL_COMMAND_TOOL, arguments: { command: cmd, ...extras } };
}

function reconstructExecExtras(rest: string): Record<string, unknown> {
  const extras: Record<string, unknown> = {};
  const workdir = /workdir:\s*("(?:\\.|[^"\\])*")/.exec(rest);
  if (workdir) {
    const value = parseJsonStringLiteral(workdir[1]);
    if (value) extras.working_directory = value;
  }
  if (/\bsandbox_permissions:\s*"require_escalated"/.test(rest)) extras.with_escalated_permissions = true;
  const justification = /justification:\s*("(?:\\.|[^"\\])*")/.exec(rest);
  if (justification) {
    const value = parseJsonStringLiteral(justification[1]);
    if (value) extras.justification = value;
  }
  return extras;
}

/** Map a Codex-side converted `exec` body back to the Grok tool Grok originally called. */
export function reconstructGrokToolCallFromExec(args: Record<string, unknown>): ReconstructedGrokToolCall | undefined {
  const input = typeof args.input === "string" ? args.input.trim() : undefined;
  if (!input) return undefined;
  const applyHead = /^await tools\.apply_patch\(/.exec(input);
  if (applyHead) {
    const split = splitJsonStringAtStart(input.slice(applyHead[0].length));
    if (split && /^\s*\)\s*;?\s*$/.test(split.rest)) return reconstructFromApplyPatch(split.value);
  }
  const shellHead = /^const r = await tools\.exec_command\(\{\s*cmd:\s*/.exec(input);
  if (shellHead) {
    const split = splitJsonStringAtStart(input.slice(shellHead[0].length));
    if (split && /^\s*(?:,[\s\S]*?)?\}\);\s*text\(r\.output\);\s*$/.test(split.rest)) {
      return reconstructFromShellCmd(split.value, reconstructExecExtras(split.rest));
    }
  }
  return undefined;
}

export function encodeGrokEditForCodexSink(
  translation: GrokStructuredEditTranslation,
  sink: GrokEditCodexSink,
): { name: string; arguments: string } {
  if (translation.error) {
    if (sink.kind === "exec") {
      return {
        name: sink.name,
        arguments: JSON.stringify({ input: `text(${JSON.stringify(translation.error)})` }),
      };
    }
    return { name: "apply_patch", arguments: JSON.stringify({ input: translation.error }) };
  }
  if (sink.kind === "exec") {
    return {
      name: sink.name,
      arguments: JSON.stringify({ input: `await tools.apply_patch(${JSON.stringify(translation.patch)})` }),
    };
  }
  return { name: "apply_patch", arguments: JSON.stringify({ input: translation.patch }) };
}

function encodeGrokNativeCall(
  toolName: string,
  argsText: string,
  sink: GrokEditCodexSink,
): { name: string; arguments: string } {
  if (isGrokStructuredEditToolName(toolName)) {
    const translation = translateGrokStructuredEditCall(toolName, argsText)
      ?? { error: `${toolName} could not be converted to apply_patch.` };
    return encodeGrokEditForCodexSink(translation, sink);
  }
  const shell = translateGrokShellCall(toolName, argsText);
  if ("error" in shell) {
    return {
      name: sink.kind === "exec" ? sink.name : "exec",
      arguments: JSON.stringify({ input: `text(${JSON.stringify(shell.error)})` }),
    };
  }
  return encodeExecCommand(shell.cmd, sink.kind === "exec" ? sink.name : "exec", execCommandExtras(toolName, argsText, shell.cmd));
}

/** Convert a complete native Grok function call to Codex's custom `exec` wire shape. */
export function grokNativeCallToCodexCustomTool(
  toolName: string,
  argsText: string,
  execSinkName: string,
  complete = true,
): { name: string; input: string } {
  if (!complete) return { name: execSinkName, input: "" };
  const encoded = encodeGrokNativeCall(toolName, argsText, { kind: "exec", name: execSinkName });
  try {
    const args: unknown = JSON.parse(encoded.arguments);
    return {
      name: encoded.name,
      input: isPlainRecord(args) && typeof args.input === "string" ? args.input : "",
    };
  } catch {
    return { name: encoded.name, input: "" };
  }
}

function encodedGrokCallEvents(
  pending: { id: string; name: string; args: string },
  sink: GrokEditCodexSink,
): AdapterEvent[] {
  const encoded = encodeGrokNativeCall(pending.name, pending.args, sink);
  return [
    { type: "tool_call_start", id: pending.id, name: encoded.name },
    ...(encoded.arguments.length > 0 ? [{ type: "tool_call_delta" as const, arguments: encoded.arguments }] : []),
    { type: "tool_call_end" },
  ];
}

function* yieldEncodedGrokCall(
  pending: { id: string; name: string; args: string },
  sink: GrokEditCodexSink,
): Generator<AdapterEvent> {
  yield* encodedGrokCallEvents(pending, sink);
}

export async function* rewriteGrokStructuredEditEvents(
  events: AsyncIterable<AdapterEvent>,
  advertisedNames: ReadonlySet<string>,
  sink: GrokEditCodexSink,
): AsyncGenerator<AdapterEvent> {
  let pending: { id: string; name: string; args: string } | undefined;
  for await (const event of events) {
    if (event.type === "tool_call_start") {
      if (pending) yield* yieldEncodedGrokCall(pending, sink);
      pending = advertisedNames.has(event.name)
        ? { id: event.id, name: event.name, args: "" }
        : undefined;
      if (pending) continue;
    }
    if (pending && event.type === "tool_call_delta") {
      pending.args += event.arguments;
      continue;
    }
    if (pending && event.type === "tool_call_end") {
      yield* yieldEncodedGrokCall(pending, sink);
      pending = undefined;
      continue;
    }
    if (pending && (event.type === "error" || event.type === "done" || event.type === "incomplete")) {
      yield* yieldEncodedGrokCall(pending, sink);
      pending = undefined;
    }
    yield event;
  }
  if (pending) yield* yieldEncodedGrokCall(pending, sink);
}

export function grokExecSinkFromCatalog(
  freeformToolNames?: ReadonlySet<string>,
  declaredToolNames?: ReadonlySet<string>,
): GrokEditCodexSink | undefined {
  for (const name of freeformToolNames ?? []) {
    if (name === "exec" || name.endsWith("__exec")) return { kind: "exec", name };
  }
  if (declaredToolNames?.has("exec")) return { kind: "exec", name: "exec" };
  return undefined;
}

/** Last-mile rewrite for every Responses bridge, including web-search/image loops. */
export function rewriteGrokNativeCallsForCodexExec(
  events: AsyncIterable<AdapterEvent>,
  freeformToolNames?: ReadonlySet<string>,
  declaredToolNames?: ReadonlySet<string>,
  convertedNativeToolNames?: ReadonlySet<string>,
): AsyncIterable<AdapterEvent> {
  const sink = grokExecSinkFromCatalog(freeformToolNames, declaredToolNames);
  if (!sink || !convertedNativeToolNames || convertedNativeToolNames.size === 0) return events;
  return rewriteGrokStructuredEditEvents(events, convertedNativeToolNames, sink);
}

export function rewriteGrokNativeCallEventList(
  events: AdapterEvent[],
  freeformToolNames?: ReadonlySet<string>,
  declaredToolNames?: ReadonlySet<string>,
  convertedNativeToolNames?: ReadonlySet<string>,
): { events: AdapterEvent[]; rewritten: boolean } {
  const sink = grokExecSinkFromCatalog(freeformToolNames, declaredToolNames);
  if (!sink || !convertedNativeToolNames || convertedNativeToolNames.size === 0) {
    return { events, rewritten: false };
  }
  const advertisedNames = convertedNativeToolNames;
  const out: AdapterEvent[] = [];
  let pending: { id: string; name: string; args: string } | undefined;
  let rewritten = false;
  for (const event of events) {
    if (event.type === "tool_call_start") {
      if (pending) out.push(...encodedGrokCallEvents(pending, sink));
      pending = advertisedNames.has(event.name)
        ? { id: event.id, name: event.name, args: "" }
        : undefined;
      if (pending) {
        rewritten = true;
        continue;
      }
    }
    if (pending && event.type === "tool_call_delta") {
      pending.args += event.arguments;
      continue;
    }
    if (pending && event.type === "tool_call_end") {
      out.push(...encodedGrokCallEvents(pending, sink));
      pending = undefined;
      continue;
    }
    if (pending && (event.type === "error" || event.type === "done" || event.type === "incomplete")) {
      out.push(...encodedGrokCallEvents(pending, sink));
      pending = undefined;
    }
    out.push(event);
  }
  if (pending) out.push(...encodedGrokCallEvents(pending, sink));
  return { events: rewritten ? out : events, rewritten };
}

export function rewriteAdapterEventsForGrokStructuredEdits(
  events: AsyncIterable<AdapterEvent>,
  parsed: {
    context: {
      tools?: readonly Pick<OcxTool, "namespace" | "name" | "freeform" | "description">[];
      messages?: Parameters<typeof effectiveInstructionText>[0];
      systemPrompt?: readonly string[];
    };
    options: { toolChoice?: OcxRequestOptions["toolChoice"] };
  },
  provider: Pick<OcxProviderConfig, "baseUrl">,
): AsyncIterable<AdapterEvent> {
  const convertedNativeToolNames = grokNativeToolNamesForRequest(parsed, provider);
  if (convertedNativeToolNames.size === 0) return events;
  const sink = grokCodeModeExecSink(parsed.context.tools, parsed.options.toolChoice);
  if (!sink) return events;
  return rewriteGrokStructuredEditEvents(events, convertedNativeToolNames, sink);
}
