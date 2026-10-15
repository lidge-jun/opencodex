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

const DECLARATION_PREFIX = "declare const tools: { ";
const PROMISE_SEPARATOR = "): Promise<";
const DECLARATION_SUFFIX = ">; };";
// Bounds keep a caller-controlled description linear work: a rendered listing is a heading, a
// description, and a small declaration per tool, so anything this large cannot be the codex-rs
// shape this parser exists to recognize.
const MAX_DESCRIPTION_LENGTH = 1 << 20;
const MAX_DECLARATION_LENGTH = 64 * 1024;

const isSpace = (ch: string | undefined): boolean => ch === undefined || /\s/.test(ch);

/**
 * The declared tool name when body is a complete declaration as render_code_mode_sample emits it,
 * single- or multi-line, else undefined. Fixed boundaries plus one forward scan that balances the
 * parameter list's brackets and the return type's generics: no backtracking, so a fence body full
 * of candidate separators stays linear work.
 */
function completeDeclarationName(body: readonly string[]): string | undefined {
  const text = body.join("\n");
  if (text.length > MAX_DECLARATION_LENGTH) return undefined;
  if (!text.startsWith(DECLARATION_PREFIX) || !text.endsWith(DECLARATION_SUFFIX)) return undefined;
  const signature = text.slice(DECLARATION_PREFIX.length, -DECLARATION_SUFFIX.length);
  const openParen = signature.indexOf("(");
  const name = openParen > 0 ? signature.slice(0, openParen) : "";
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) return undefined;
  // A named, typed parameter (`args` for functions, `input` for freeform) and a non-empty return type.
  const rest = signature.slice(openParen + 1);
  const typed = rest.startsWith("args: ") ? 6 : rest.startsWith("input: ") ? 7 : -1;
  if (typed < 0 || isSpace(rest[typed])) return undefined;
  // Quoted text and comments are opaque to delimiter matching. Each skip advances
  // past its text once; an unterminated region cannot contain a closing declaration.
  const isOpaqueTypeText = (at: number): boolean => {
    const ch = rest[at];
    return ch === '"' || ch === "'" || ch === "`"
      || ch === "/" && (rest[at + 1] === "/" || rest[at + 1] === "*");
  };
  const skipTypeText = (at: number): number | undefined => {
    const quote = rest[at]!;
    if (quote === "/" && rest[at + 1] === "/") {
      let i = at + 2;
      while (i < rest.length && rest[i] !== "\n" && rest[i] !== "\r"
        && rest[i] !== "\u2028" && rest[i] !== "\u2029") i += 1;
      return i < rest.length ? i : undefined;
    }
    if (quote === "/" && rest[at + 1] === "*") {
      const end = rest.indexOf("*/", at + 2);
      return end < 0 ? undefined : end + 1;
    }
    let i = at + 1;
    while (i < rest.length) {
      const ch = rest[i]!;
      if (ch === "\\") i += 2;
      else if (ch === quote) return i;
      else i += 1;
    }
    return undefined;
  };
  // The parameter list ends at the ')' that balances the opening '(': a ')' nested inside the
  // parameter's own type (e.g. `args: (a: string) => Promise<void>`) cannot pose as the separator.
  // The type must also say something before that ')': `args: )` or `args: /* note */)` names no type.
  let depth = 1;
  let close = -1;
  let typeContent = false;
  for (let at = typed; at < rest.length; at += 1) {
    const ch = rest[at]!;
    if (isOpaqueTypeText(at)) {
      if (ch !== "/") typeContent = true; // a quoted literal is a type, a comment is not
      const end = skipTypeText(at);
      if (end === undefined) return undefined;
      at = end;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (depth === 0) { close = at; break; }
    if (!isSpace(ch)) typeContent = true;
  }
  if (close < 0 || !typeContent || !rest.startsWith(PROMISE_SEPARATOR, close)) return undefined;
  const head = rest[close + PROMISE_SEPARATOR.length];
  if (head === ">" || isSpace(head)) return undefined;
  // The return type runs to the stripped suffix, which already supplied exactly one '>' for the
  // Promise's '<': generic depth must stay positive to the end and land at exactly 1 — a '>' that
  // reaches zero ('Promise<unknown>; garbage') is surplus text, a depth left above 1
  // ('Promise<Map<string, unknown') never closed its own generic, and a '=>' arrow never counts.
  let generic = 1;
  for (let at = close + PROMISE_SEPARATOR.length; at < rest.length; at += 1) {
    const ch = rest[at]!;
    if (isOpaqueTypeText(at)) {
      const end = skipTypeText(at);
      if (end === undefined) return undefined;
      at = end;
      continue;
    }
    if (ch === "<") generic += 1;
    else if (ch === ">" && rest[at - 1] !== "=") generic -= 1;
    if (generic === 0) return undefined;
  }
  return generic === 1 ? name : undefined;
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
  if (description.length > MAX_DESCRIPTION_LENGTH) return [];
  const lines = description.split("\n");
  const rendered: RenderedTool[] = [];
  const pending: RenderedTool[] = [];
  // Ascending indexes into `pending` per name, so a declaration finds its owner in one lookup
  // instead of rescanning every pending heading.
  const pendingByName = new Map<string, number[]>();
  const dropPendingTo = (length: number): void => {
    while (pending.length > length) {
      const removed = pending.pop()!;
      const indexes = pendingByName.get(removed.name)!;
      indexes.pop();
      if (indexes.length === 0) pendingByName.delete(removed.name);
    }
  };
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
      if (heading) {
        const indexes = pendingByName.get(heading.name);
        if (indexes) indexes.push(pending.length); else pendingByName.set(heading.name, [pending.length]);
        pending.push(heading);
      }
      continue;
    }
    if (line === DECLARATION_LEAD && lines[i + 1] === DECLARATION_FENCE) {
      let close = i + 2;
      while (close < lines.length && !closesFence(lines[close]!, DECLARATION_FENCE_SHAPE)) close += 1;
      if (close >= lines.length) return rendered; // unterminated: nothing after it is structure
      const body = lines.slice(i + 2, close);
      // The outermost pending heading with the declared name owns it, so a same-name heading quoted
      // inside the tool's own description cannot take over the genuine section.
      const declared = completeDeclarationName(body);
      const owner = declared === undefined ? -1 : pendingByName.get(declared)?.[0] ?? -1;
      if (owner >= 0) {
        rendered.push(pending[owner]!);
        dropPendingTo(owner);
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
