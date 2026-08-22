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

/**
 * The two halves of the code-mode shape, kept provider-neutral here.
 *
 * `./cursor/tool-definitions.ts` owns the Cursor-scoped versions of these
 * (`isCursorCodeModeExecTool` / `isBareCodexShellBridgeTool`), but those additionally require
 * the Cursor Responses namespace. This nudge is shared by Anthropic, Google, Kiro,
 * OpenAI-chat and command-code, so it needs the same semantics without that provider gate.
 */
const CODEX_UNIFIED_EXEC_TOOL_NAME = "exec";
const CODEX_SHELL_BRIDGE_TOOL_NAMES = ["exec_command", "shell_command"] as const;

function isCodexCodeModeExecTool(tool: Pick<OcxTool, "namespace" | "name" | "freeform">): boolean {
  return !tool.namespace && tool.name === CODEX_UNIFIED_EXEC_TOOL_NAME && tool.freeform === true;
}

/**
 * BARE means un-namespaced, and the word is load-bearing.
 *
 * An MCP server can advertise its own `exec_command` or `shell_command` — a docker, k8s or ssh
 * server plausibly does — and those arrive namespaced (`mcp__docker__exec_command`). They are
 * not Codex's shell bridge, so they must not cancel code mode: a genuine code-mode turn that
 * merely happens to sit beside an MCP shell tool would lose its guidance and fall back to the
 * generic sentence.
 *
 * The Cursor original this was ported from (`isBareCodexShellBridgeTool`) carries the same
 * `!tool.namespace` requirement; dropping it here made the name assert a check the body did not
 * perform.
 */
function isBareShellBridgeTool(tool: Pick<OcxTool, "namespace" | "name">): boolean {
  return !tool.namespace && (CODEX_SHELL_BRIDGE_TOOL_NAMES as readonly string[]).includes(tool.name);
}

function quoteNames(names: readonly string[]): string {
  return names.map(name => "`" + name + "`").join(", ");
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

/**
 * Codex code mode is a SEMANTIC property, not a name.
 *
 * The tool that carries it is a `freeform` `exec` whose body is JavaScript evaluated in a V8
 * isolate, advertised alongside no bare shell bridge. A provider is free to advertise an
 * ordinary structured tool called `exec` that runs a shell string — and a catalog can list
 * `exec` next to `exec_command`/`shell_command`, which is the flat-bridge shape, not code mode.
 *
 * Classifying on the name alone would tell those turns that `exec` takes JavaScript and that
 * shell is only reachable as a nested `tools.*` helper. Both are false there, and a model that
 * believes them sends the wrong arguments or avoids a legitimate execution tool entirely.
 *
 * So callers that HAVE the tool objects decide with the semantic predicate and pass the verified
 * wire name in; the name-only entry point cannot decide it and does not try.
 */
function codeModeExecWireName(
  advertised: ReadonlySet<string>,
  verifiedName: string | undefined,
): string | undefined {
  if (!verifiedName) return undefined;
  return advertised.has(verifiedName) ? verifiedName : undefined;
}

export function buildNonOpenAIToolCatalogNudgeFromNames(
  wireNames: readonly string[] | undefined,
  toWireName: (name: string) => string = name => name,
  codeModeExecName?: string,
): string | undefined {
  const names = uniqueNames(wireNames ?? []);
  if (names.length === 0) return undefined;

  const advertised = new Set(names);
  // Compare in the catalog's own coordinate system. `advertised` holds WIRE names, so a
  // provider that rewrites them (Claude OAuth `custom_`, Anthropic compat `cx_`) would never
  // match a bare neighbor name and would forbid tools the turn actually advertises -- the
  // catalog would list `custom_apply_patch` while the same sentence banned `apply_patch`.
  const unavailableNeighborNames = NEIGHBOR_AGENT_TOOL_NAMES.filter(
    name => !advertised.has(name) && !advertised.has(toWireName(name)),
  );
  const verifiedCodeModeExecName = codeModeExecWireName(advertised, codeModeExecName);

  return [
    "Tool contract: use the current tool catalog as ground truth.",
    "Valid tool names for this turn are exactly " + quoteNames(names) + ".",
    "These listed names are the complete top-level tool-call surface for this turn.",
    "Call only listed names with their listed argument keys; do not invent, translate, or rename tools.",
    "Names mentioned only in instructions, tool descriptions, argument descriptions, or nested helper APIs are not additional top-level tools.",
    verifiedCodeModeExecName
      ? "`" + verifiedCodeModeExecName + "` is Codex code mode: its body is JavaScript evaluated in a V8 isolate. Nested helpers are called INSIDE that body as `await tools.<name>(...)`, for example `await tools.exec_command({cmd: \"ls\"})` or `await tools.codex_app__list_threads({})`. Absence from the top-level catalog or from `" + verifiedCodeModeExecName + "`'s description is not absence: deferred helpers stay callable on `tools.<name>`. Discover them from the isolate global `ALL_TOOLS`, not `tools.ALL_TOOLS`. Do not skip an available nested helper because it is omitted from the listed top-level names."
      : "If a listed tool exposes nested helpers such as a tools.* API, call the listed parent tool and use those helpers only inside that tool's input.",
    unavailableNeighborNames.length > 0
      ? "Do not use neighboring-agent tool names " + quoteNames(unavailableNeighborNames) + " unless this turn's catalog lists those exact names."
      : undefined,
    "If you need shell, file search, file read, edit, or discovery behavior, choose the listed tool that provides that capability.",
    "Count a tool call only after its tool result returns; batch independent read-only calls when the runtime supports it.",
  ].filter((line): line is string => typeof line === "string").join(" ");
}

export function buildNonOpenAIToolCatalogNudgeForTools(
  tools: readonly Pick<OcxTool, "namespace" | "name" | "freeform">[] | undefined,
  toolChoice?: OcxRequestOptions["toolChoice"],
  toWireName: (tool: Pick<OcxTool, "namespace" | "name">) => string = tool => namespacedToolName(tool.namespace, tool.name),
): string | undefined {
  const visible = tools?.filter(toolChoiceToolPredicate(toolChoice, tools));
  const visibleNames = visible?.map(toWireName);
  // Decide code mode from the tool OBJECTS, while the `freeform` flag still exists — reducing
  // to wire names first throws away the only thing that distinguishes Codex's JavaScript
  // `exec` from an ordinary structured tool that happens to share the name.
  const codeModeExecTool = visible?.find(isCodexCodeModeExecTool);
  const codeModeExecName = codeModeExecTool
    && !visible?.some(isBareShellBridgeTool)
    ? toWireName(codeModeExecTool)
    : undefined;
  // Neighbor names are bare and un-namespaced, so probe the same transform with a bare tool.
  return buildNonOpenAIToolCatalogNudgeFromNames(
    visibleNames,
    name => toWireName({ name }),
    codeModeExecName,
  );
}
