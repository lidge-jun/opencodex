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
 * That rendering is the only proof of V1 inside exec itself. When the model supports tool search,
 * codex-rs registers V1 as DEFERRED and leaves it out of the description entirely, and every
 * OpenCodex catalog row advertises tool search. Such a turn carries no V1 evidence here; a bare
 * exec, the ALL_TOOLS mention, and the saved OpenCodex mode prove nothing about the conversation
 * (codex-rs pins the version per session). The deferred case has its own, separate evidence source
 * in deferred-collab-surface.ts, which uses this file's genuine-exec check as a host guard.
 *
 * A tool description is copied into exec verbatim, so one that reproduces a complete top-level V1
 * section is indistinguishable from the host's own rendering. This parser cannot authenticate the
 * host; it only refuses everything short of that exact shape.
 */
import { CODE_MODE_EXEC_TOOL_NAME, declaresCodeModeExec, type OcxTool } from "../../types";

export type CodeModeV1Evidence = "v1" | "ambiguous" | null;

/** What a request's code-mode exec proves about collaboration, before any combination policy. */
export interface CodeModeExecAnalysis {
  /** A codex-rs code-mode exec is declared: bare, freeform, template-led, no bare shell bridge. */
  genuineExec: boolean;
  /** That exec renders a complete multi_agent_v1__spawn_agent section. */
  renderedV1: boolean;
  /** That exec mentions a spawn_agent or V2 companion that is not V1's, quoted or not. */
  foreignCollabClaim: boolean;
}

/** First line of codex-rs EXEC_DESCRIPTION_TEMPLATE; an overridden or foreign exec fails closed. */
const CODE_MODE_EXEC_TEMPLATE_HEADER = "Run JavaScript code to orchestrate/compose tool calls";
const MULTI_AGENT_V1_SPAWN = "multi_agent_v1__spawn_agent";
const SPAWN = "spawn_agent";
const V2_COMPANIONS = ["send_message", "followup_task", "interrupt_agent", "list_agents"] as const;
const DECLARATION_LEAD = "exec tool declaration:";

const TOOL_HEADING = /^### `([A-Za-z_$][\w$]*)`(?: \(`([^`]+)`\))?$/;
const DECLARATION_FENCE = "```ts";
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

/** The declaration fence codex-rs opens: three backticks and "ts". */
const DECLARATION_FENCE_SHAPE: Fence = { char: "`", length: 3 };

/** A complete declaration as render_code_mode_sample emits it, single- or multi-line. */
function isCompleteDeclaration(body: readonly string[], name: string): boolean {
  const text = body.join("\n");
  const prefix = "declare const tools: { " + name + "(";
  if (!text.startsWith(prefix)) return false;
  // A named, typed parameter (`args` for functions, `input` for freeform) and a non-empty return type.
  return /^(?:args|input): \S[\s\S]*\): Promise<[^>\s][\s\S]*>; \};$/.test(text.slice(prefix.length));
}

/** codex-rs normalize_code_mode_identifier: invalid identifier characters become `_`. */
function normalizeCodeModeIdentifier(raw: string): string {
  let identifier = "";
  for (const [index, ch] of [...raw].entries()) {
    const valid = index === 0 ? /[A-Za-z_$]/.test(ch) : /[A-Za-z0-9_$]/.test(ch);
    identifier += valid ? ch : "_";
  }
  return identifier === "" ? "_" : identifier;
}

/** A heading as render_tool_heading emits it: a raw suffix only when normalization changed the name. */
function renderedHeading(match: RegExpExecArray): RenderedTool | undefined {
  const name = match[1]!;
  const raw = match[2];
  if (raw === undefined) return { name, raw: name };
  return raw !== name && normalizeCodeModeIdentifier(raw) === name ? { name, raw } : undefined;
}

/**
 * Nested tools whose top-level heading is followed by the complete declaration codex-rs renders for
 * the same name. A section ends at its own declaration, not at the next heading, because tool and
 * namespace descriptions (V1 spawn's guidance, a configured usage hint) carry their own Markdown,
 * including example headings and example declarations. Pending headings form a stack: a
 * declaration is owned by the outermost pending heading with its name, which is removed together
 * with anything opened after it; a declaration nobody owns is an example and leaves the stack
 * alone. Lines inside a quoted fence can neither open a section nor declare a tool.
 */
function renderedNestedTools(description: string): RenderedTool[] {
  const lines = description.split("\n");
  const rendered: RenderedTool[] = [];
  const pending: RenderedTool[] = [];
  let fence: Fence | undefined;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (fence) {
      if (closesFence(line, fence)) fence = undefined;
      continue;
    }
    const match = TOOL_HEADING.exec(line);
    if (match) {
      const heading = renderedHeading(match);
      if (heading) pending.push(heading);
      continue;
    }
    if (line === DECLARATION_LEAD && lines[i + 1] === DECLARATION_FENCE) {
      let close = i + 2;
      while (close < lines.length && !closesFence(lines[close]!, DECLARATION_FENCE_SHAPE)) close += 1;
      if (close >= lines.length) return rendered; // unterminated: nothing after it is structure
      const body = lines.slice(i + 2, close);
      // The outermost pending heading with the declared name owns it, so a same-name heading quoted
      // inside the tool's own description cannot take over the genuine section.
      const owner = pending.findIndex(tool => isCompleteDeclaration(body, tool.name));
      if (owner >= 0) {
        rendered.push(pending[owner]!);
        pending.length = owner;
      }
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

/** Every name a heading or declaration line mentions, quoted or not. */
function mentionedToolNames(description: string): string[] {
  const names: string[] = [];
  for (const line of description.split("\n")) {
    const heading = TOOL_HEADING.exec(line);
    if (heading) {
      names.push(heading[1]!);
      if (heading[2] !== undefined) names.push(heading[2]);
    }
    for (const match of line.matchAll(/declare const tools: \{ ([A-Za-z_$][\w$]*)\(/g)) names.push(match[1]!);
  }
  return names;
}

/**
 * Reads every genuine code-mode exec once. The two collaboration halves are deliberately
 * asymmetric. V1 evidence needs a rendered section (a heading followed by its complete
 * declaration). The contradiction check reads every heading and declaration line, inside fences or
 * not and whoever "owns" it, so text copied into the listing can only push a turn toward null; it
 * cannot hide another surface. The contradiction is reported even without rendered V1, because
 * deferred V1 evidence must also yield to a rendered foreign surface.
 */
export function analyzeCodeModeExec(tools: readonly OcxTool[] | undefined): CodeModeExecAnalysis {
  const analysis: CodeModeExecAnalysis = { genuineExec: false, renderedV1: false, foreignCollabClaim: false };
  if (!tools || tools.length === 0) return analysis;
  if (!declaresCodeModeExec(new Set(tools.filter(tool => !tool.namespace).map(tool => tool.name)))) return analysis;
  for (const tool of tools) {
    if (!isCodeModeExec(tool)) continue;
    analysis.genuineExec = true;
    // A rendered V1 spawn heading carries no raw-name suffix: the identifier needs no normalization.
    if (renderedNestedTools(tool.description).some(rendered => rendered.raw === MULTI_AGENT_V1_SPAWN)) analysis.renderedV1 = true;
    if (mentionedToolNames(tool.description).some(isForeignCollabName)) analysis.foreignCollabClaim = true;
  }
  return analysis;
}

/**
 * "v1" when a genuine code-mode exec renders the V1 spawn tool and nothing that claims another
 * collaboration surface; "ambiguous" when it renders both; null when it proves nothing.
 */
export function codeModeV1Evidence(tools: readonly OcxTool[] | undefined): CodeModeV1Evidence {
  const analysis = analyzeCodeModeExec(tools);
  if (!analysis.renderedV1) return null;
  return analysis.foreignCollabClaim ? "ambiguous" : "v1";
}
