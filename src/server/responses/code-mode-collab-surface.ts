/**
 * V1 collaboration evidence nested inside Codex's code-mode `exec` tool (#6844).
 *
 * In code-mode-only turns codex-rs does not put the collaboration tools on the wire. When they are
 * ENABLED it renders each one into the custom `exec` description instead
 * (code-mode-protocol/src/description.rs, build_exec_tool_description): a top-level heading line,
 * the tool's own description, then an "exec tool declaration:" ts fence holding
 * "declare const tools: { <name>(args: ...): Promise<...>; };". A namespaced tool is flattened to
 * <namespace>__<name> (tools/src/code_mode.rs, code_mode_name_for_tool_name), and V1 always
 * registers under the fixed namespace multi_agent_v1, so a rendered V1 surface reads
 * multi_agent_v1__spawn_agent.
 *
 * That rendering is the only request-visible proof of V1 behind exec. When the model supports
 * tool search, codex-rs registers V1 as DEFERRED and leaves it out of the description entirely,
 * and every OpenCodex catalog row advertises tool search. Such a turn carries no V1 evidence and
 * stays null here; a bare exec, the ALL_TOOLS mention, and the saved OpenCodex mode prove nothing
 * about the conversation (codex-rs pins the version per session).
 *
 * A tool description is copied into exec verbatim, so one that reproduces a complete top-level V1
 * section is indistinguishable from the host's own rendering. This parser cannot authenticate the
 * host; it only refuses everything short of that exact shape.
 */
import { CODE_MODE_EXEC_TOOL_NAME, declaresCodeModeExec, type OcxTool } from "../../types";

export type CodeModeV1Evidence = "v1" | "ambiguous" | null;

/** First line of codex-rs EXEC_DESCRIPTION_TEMPLATE; an overridden or foreign exec fails closed. */
const CODE_MODE_EXEC_TEMPLATE_HEADER = "Run JavaScript code to orchestrate/compose tool calls";
const MULTI_AGENT_V1_SPAWN = "multi_agent_v1__spawn_agent";
const SPAWN = "spawn_agent";
const V2_COMPANIONS = ["send_message", "followup_task", "interrupt_agent", "list_agents"] as const;
const DECLARATION_LEAD = "exec tool declaration:";

const TOOL_HEADING = /^### `([A-Za-z_$][\w$]*)`(?: \(`[^`]+`\))?$/;
// CommonMark: any backtick run opens a fence; only a bare run closes it, so "```ts" inside a fence
// is content rather than a close.
/** codex-rs "## <namespace>" line preceding a namespace's tools; prose "## Usage" also matches and fails closed. */
const NAMESPACE_HEADING = /^## [A-Za-z_$][\w$.-]*$/;
const FENCE_OPEN = /^```/;
const FENCE_CLOSE = /^```\s*$/;

function isCodeModeExec(tool: OcxTool): boolean {
  return tool.name === CODE_MODE_EXEC_TOOL_NAME && !tool.namespace && tool.freeform === true
    && typeof tool.description === "string"
    && tool.description.startsWith(CODE_MODE_EXEC_TEMPLATE_HEADER);
}

/** True when a section ends with the declaration fence codex-rs renders for `name`. */
function endsWithOwnDeclaration(section: readonly string[], name: string): boolean {
  let end = section.length - 1;
  while (end >= 0 && section[end]!.trim() === "") end -= 1;
  if (end < 3 || section[end] !== "```") return false;
  // exec tool declaration: / ```ts / declare const tools: { name(args: ... (one or more lines) / ```
  let open = end - 1;
  while (open >= 0 && !section[open]!.startsWith("```")) open -= 1;
  return open >= 1 && open + 1 < end
    && section[open] === "```ts"
    && section[open - 1] === DECLARATION_LEAD
    && section[open + 1]!.startsWith("declare const tools: { " + name + "(");
}

/** Names of nested tools rendered as complete top-level sections, outside any quoted fence. */
function renderedNestedToolNames(description: string): string[] {
  const lines = description.split("\n");
  const names: string[] = [];
  let inFence = false;
  let current: { name: string; lines: string[] } | undefined;
  const close = () => {
    if (current && endsWithOwnDeclaration(current.lines, current.name)) names.push(current.name);
    current = undefined;
  };
  for (const line of lines) {
    if (!inFence) {
      const heading = TOOL_HEADING.exec(line);
      if (heading) {
        close();
        current = { name: heading[1]!, lines: [] };
        continue;
      }
      if (NAMESPACE_HEADING.test(line)) {
        close();
        continue;
      }
    }
    if (inFence ? FENCE_CLOSE.test(line) : FENCE_OPEN.test(line)) inFence = !inFence;
    current?.lines.push(line);
  }
  if (!inFence) close();
  return names;
}

/** A nested name that claims a collaboration surface other than V1's. */
function isForeignCollabName(name: string): boolean {
  if (name.startsWith("mcp__")) return false; // MCP server tools are never native collaboration
  if (name === MULTI_AGENT_V1_SPAWN) return false;
  if (name === SPAWN || name.endsWith("__" + SPAWN)) return true;
  return V2_COMPANIONS.some(companion => name === companion || name.endsWith("__" + companion));
}

/**
 * "v1" when a genuine code-mode exec renders the V1 spawn tool and nothing that claims another
 * collaboration surface; "ambiguous" when it renders both; null when it proves nothing.
 */
export function codeModeV1Evidence(tools: readonly OcxTool[] | undefined): CodeModeV1Evidence {
  if (!tools || tools.length === 0) return null;
  if (!declaresCodeModeExec(new Set(tools.filter(tool => !tool.namespace).map(tool => tool.name)))) return null;
  let v1Spawn = false;
  let foreign = false;
  for (const tool of tools) {
    if (!isCodeModeExec(tool)) continue;
    for (const name of renderedNestedToolNames(tool.description)) {
      if (name === MULTI_AGENT_V1_SPAWN) v1Spawn = true;
      else if (isForeignCollabName(name)) foreign = true;
    }
  }
  if (!v1Spawn) return null;
  return foreign ? "ambiguous" : "v1";
}
