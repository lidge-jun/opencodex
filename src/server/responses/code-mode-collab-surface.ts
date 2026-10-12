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

const TOOL_HEADING = /^### `([A-Za-z_$][\w$]*)`(?: \(`([^`]+)`\))?$/;
const DECLARATION_FENCE = "```ts";
const DECLARATION_CLOSE = "```";
// CommonMark fences: up to three spaces of indentation, three or more backticks or tildes. A fence
// closes only on the same character, at least as long, with nothing but whitespace after it.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

interface Fence { char: string; length: number }

function openedFence(line: string): Fence | undefined {
  const match = FENCE_OPEN.exec(line);
  if (!match) return undefined;
  const run = match[1]!;
  // A backtick fence's info string may not contain a backtick (that line is inline code).
  if (run[0] === "`" && match[2]!.includes("`")) return undefined;
  return { char: run[0]!, length: run.length };
}

function closesFence(line: string, fence: Fence): boolean {
  const match = FENCE_CLOSE.exec(line);
  return match !== null && match[1]![0] === fence.char && match[1]!.length >= fence.length;
}

function isCodeModeExec(tool: OcxTool): boolean {
  return tool.name === CODE_MODE_EXEC_TOOL_NAME && !tool.namespace && tool.freeform === true
    && typeof tool.description === "string"
    && tool.description.startsWith(CODE_MODE_EXEC_TEMPLATE_HEADER);
}

/** A nested tool rendered as a heading plus its own declaration; `raw` is the pre-normalization name. */
interface RenderedTool { name: string; raw: string }

/**
 * Nested tools whose top-level heading is followed by the declaration codex-rs renders for the same
 * name. A section ends at its declaration, not at the next heading: tool descriptions (V1 spawn's
 * own guidance, a configured usage hint) carry their own Markdown headings. Lines inside a quoted
 * fence are content and can neither open a section nor declare a tool.
 */
function renderedNestedTools(description: string): RenderedTool[] {
  const lines = description.split("\n");
  const rendered: RenderedTool[] = [];
  let pending: RenderedTool[] = [];
  let fence: Fence | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const heading = TOOL_HEADING.exec(line);
    if (heading) {
      pending.push({ name: heading[1]!, raw: heading[2] ?? heading[1]! });
      continue;
    }
    if (line === DECLARATION_LEAD && lines[i + 1] === DECLARATION_FENCE) {
      const declared = lines[i + 2] ?? "";
      let close = i + 2;
      while (close < lines.length && lines[close] !== DECLARATION_CLOSE) close += 1;
      // The innermost pending heading with this name owns the declaration; prose headings that
      // merely look like tool headings are dropped with the rest of the pending list.
      const owner = pending.findLast(tool => declared.startsWith("declare const tools: { " + tool.name + "("));
      if (owner && close < lines.length) rendered.push(owner);
      pending = [];
      i = close;
      continue;
    }
    fence = openedFence(line);
  }
  return rendered;
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
    for (const { raw } of renderedNestedTools(tool.description)) {
      // Classify by the name the host registered; the normalized identifier can collapse a foreign
      // namespace such as multi-agent-v1 onto multi_agent_v1.
      if (raw === MULTI_AGENT_V1_SPAWN) v1Spawn = true;
      else if (isForeignCollabName(raw)) foreign = true;
    }
  }
  if (!v1Spawn) return null;
  return foreign ? "ambiguous" : "v1";
}
