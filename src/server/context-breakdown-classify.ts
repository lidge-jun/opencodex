/**
 * Context-window classifier: sizes only, never content.
 *
 * The marker strings, regexes and file-read detection below are ported from Magpie's prompt
 * classifier (internal/gateway/prompt.go), reduced to per-category totals and per-turn totals.
 *
 * Magpie is MIT licensed:
 *
 *   MIT License
 *
 *   Copyright (c) 2026 yetone
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/** Estimated tokens per category for a request as received from the client. */
export interface ContextBreakdownV1 {
  v: 1;
  parts: { system: number; tools: number; skills: number; memory: number; files: number; results: number; chat: number };
  /** Estimated tokens per conversation turn, oldest first; at most 48 entries. */
  turns: number[];
  /** Older turns beyond the 48 kept, plus any compaction summary, summed. */
  turnsEarlier?: number;
  /** Number of tool definitions. */
  toolCount: number;
  /** `previous_response_id` was set: earlier turns live upstream and are not in the body. */
  held?: true;
}

export type Rec = Record<string, unknown>;

export function isRec(v: unknown): v is Rec {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const MAX_TURNS = 48;
/** What an image or document is taken to cost: about a 1092x1092 image on Anthropic. */
export const IMAGE_TOKENS = 1600;
/** A call's arguments are parsed for a file read only when short enough to be a path or command. */
const MAX_ARGS_PARSE = 8192;
const MAX_JSON_DEPTH = 24;

/** About four ASCII characters a token, one token per other character (CJK, mostly). */
export function tokensOfText(s: string): number {
  let ascii = 0;
  let other = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 128) {
      ascii++;
      continue;
    }
    other++;
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
  }
  return Math.ceil(ascii / 4) + other;
}

/** A string of serialized JSON or call arguments: length over four, no scan. */
export function tokensOfBlob(s: string): number {
  return Math.ceil(s.length / 4);
}

function jsonChars(v: unknown, depth: number): number {
  switch (typeof v) {
    case "string":
      return v.length + 2;
    case "number":
      return 5;
    case "boolean":
      return 5;
    case "object": {
      if (v === null) return 4;
      if (depth >= MAX_JSON_DEPTH) return 8;
      let n = 2;
      if (Array.isArray(v)) {
        for (let i = 0; i < v.length; i++) n += jsonChars(v[i], depth + 1) + 1;
        return n;
      }
      for (const k in v as Rec) n += k.length + 4 + jsonChars((v as Rec)[k], depth + 1);
      return n;
    }
    default:
      return 0;
  }
}

/** Serialized size of a parsed JSON value over four, without serializing it. */
export function tokensOfJson(v: unknown): number {
  return Math.ceil(jsonChars(v, 0) / 4);
}

// --- text: instruction files, skills, reminders, harness messages ---

/** Claude Code: "Contents of /path/CLAUDE.md (project instructions, ...):" */
const CONTENTS_OF = /^Contents of (\S.*?) \(([^()\n]*(?:\([^()\n]*\)[^()\n]*)*)\):[ \t]*$/gm;
/** OpenCode: "Instructions from: /path/AGENTS.md" */
const INSTRUCTIONS_FROM = /^Instructions from: (\S.*?)[ \t]*$/gm;
/** Codex: "# AGENTS.md instructions for /path" */
const AGENTS_FOR = /^# (\S+\.md) instructions for (\S.*?)[ \t]*\n/;
const SKILLS_LIST = "The following skills are available for use with the Skill tool:";
const REMINDER_OPEN = "<system-reminder>";
const REMINDER_CLOSE = "</system-reminder>";
const REMINDERS = /<system-reminder(?:\s[^>]*)?>[\s\S]*?<\/system-reminder>/g;
/** What the user typed in the Codex app, after the context it puts first. */
const MY_REQUEST = /^## My request(?: for Codex)?:[ \t]*\n?/gm;
const HARNESS_USER_LEADS = ["<environment_context>", "<user_instructions>", "<turn_aborted>", "<user_shell_command>"];
/** How a text the agent put in as the user begins; none of these is the user speaking. */
const INJECTED_LEADS = [
  "<system-reminder", "<environment_context>", "<user_instructions>", "<turn_aborted>",
  "<user_shell_command>", "<subagent_notification>", "<in-app-browser-context",
  "<external_codex_apps_open_page>", "<session-context",
  "<task-notification>", "<subagent-notification>", "<plugin_reference>",
  "Available agent types for the Agent tool:", "Available agent types and the tools they have access to:",
  "New agent types are now available for the Agent tool:",
  "The TodoWrite tool hasn't been used recently.", "The task tools haven't been used recently.",
  "Conversation rewind applied.", "Workspace rewind applied.",
];

function trimLeftNewlines(s: string): string {
  let i = 0;
  while (i < s.length && s.charCodeAt(i) === 10) i++;
  return i === 0 ? s : s.slice(i);
}

/** True when the text is the user speaking, not something the agent injected for the model. */
export function userSays(text: string): boolean {
  let t = text;
  if (t.includes("<system-reminder")) t = t.replace(REMINDERS, "");
  t = t.trim();
  if (t.includes("## My request")) {
    let end = -1;
    for (const m of t.matchAll(MY_REQUEST)) end = m.index + m[0].length;
    if (end >= 0) t = t.slice(end).trim();
  }
  if (t === "" || AGENTS_FOR.test(t)) return false;
  for (const lead of INJECTED_LEADS) if (t.startsWith(lead)) return false;
  return true;
}

// --- tool calls and what they read ---

const READ_TOOLS = new Set(["Read", "read", "read_file", "ReadFile", "view", "View", "NotebookRead", "readFile", "open_file", "cat"]);
const PATH_KEYS = ["file_path", "path", "filePath", "target_file", "notebook_path", "file", "filename", "uri"];
const READ_COMMANDS = new Set(["cat", "head", "tail", "nl", "bat", "less", "more"]);
const SHELL_WRAPPERS = ["bash -lc ", "bash -c ", "sh -c ", "zsh -lc "];
const SHELL_OPERATORS = /[|;&><`$]/;
/** Codex's exec takes JavaScript: text(await tools.exec_command({cmd:"cat x"})). */
const CMD_OF_EXEC = /\bcmd\s*:\s*"((?:[^"\\]|\\.)*)"/;

function trimQuotes(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === '"' || s[a] === "'")) a++;
  while (b > a && (s[b - 1] === '"' || s[b - 1] === "'")) b--;
  return s.slice(a, b);
}

/** The files a shell command reads, when all it does is read files: cat, head, tail, nl, bat, sed -n. */
function filesOfCommand(command: string): string[] {
  let cmd = command.trim();
  for (const pre of SHELL_WRAPPERS) {
    if (cmd.startsWith(pre)) cmd = trimQuotes(cmd.slice(pre.length).trim());
  }
  if (SHELL_OPERATORS.test(cmd)) {
    const i = cmd.indexOf("&&");
    if (i >= 0 && cmd.startsWith("cd ") && !SHELL_OPERATORS.test(cmd.slice(i + 2))) cmd = cmd.slice(i + 2).trim();
    else return [];
  }
  const f = cmd.split(/\s+/).filter(Boolean);
  if (f.length < 2) return [];
  const head = f[0] ?? "";
  const sed = head === "sed" && f.includes("-n");
  if (!READ_COMMANDS.has(head) && !sed) return [];
  const files: string[] = [];
  for (let i = 1; i < f.length; i++) {
    const a = trimQuotes(f[i] ?? "");
    if (a.startsWith("-")) {
      if ((a === "-n" || a === "-c") && !sed && i + 1 < f.length) i++;
      continue;
    }
    if (sed && a.endsWith("p") && /[0-9,]/.test(a) && !a.includes("/") && !a.includes(".")) continue;
    if (/^[+-]?\d+$/.test(a)) continue;
    files.push(a);
  }
  return files;
}

/** Whether a tool call reads files, from its name and input (a parsed object or a JSON/JS string). */
export function callReadsFiles(name: string, input: unknown): boolean {
  let args: Rec | undefined;
  let source = "";
  if (typeof input === "string") {
    source = input;
    if (input.length <= MAX_ARGS_PARSE && /^\s*\{/.test(input)) {
      try {
        const parsed: unknown = JSON.parse(input);
        if (isRec(parsed)) args = parsed;
      } catch {
        // custom tool input is plain text or JavaScript
      }
    }
  } else if (isRec(input)) {
    args = input;
  }
  if (args && READ_TOOLS.has(name)) {
    for (const k of PATH_KEYS) if (str(args[k]) !== "") return true;
  }
  let cmd = "";
  if (args) {
    cmd = str(args.command) || str(args.cmd);
    if (cmd === "" && Array.isArray(args.command) && args.command.every(x => typeof x === "string")) {
      cmd = (args.command as string[]).join(" ");
    }
  } else if (source !== "" && source.length <= MAX_ARGS_PARSE) {
    const m = CMD_OF_EXEC.exec(source);
    if (m?.[1] !== undefined) {
      try {
        cmd = str(JSON.parse(`"${m[1]}"`));
      } catch {
        cmd = m[1];
      }
    }
  }
  return cmd !== "" && filesOfCommand(cmd).length > 0;
}

// --- the accumulator ---

/**
 * Sums a request's token estimate by category and by turn. It holds numbers and the ids of
 * file-reading calls (to class their results); no text outlives a call into it.
 */
export class BreakdownAccumulator {
  system = 0;
  tools = 0;
  skills = 0;
  memory = 0;
  files = 0;
  results = 0;
  chatTotal = 0;
  toolCount = 0;
  held = false;
  private compaction = 0;
  private turn = 0;
  private readonly turns: number[] = [];
  private readonly readCalls = new Set<string>();

  newTurn(): void {
    this.turn++;
  }

  /** What the user and the model said, and the model's calls, on the current turn. */
  chat(tokens: number): void {
    if (tokens <= 0) return;
    if (this.turn === 0) this.turn = 1;
    while (this.turns.length < this.turn) this.turns.push(0);
    this.turns[this.turn - 1]! += tokens;
    this.chatTotal += tokens;
  }

  compacted(tokens: number): void {
    if (tokens <= 0) return;
    this.compaction += tokens;
    this.chatTotal += tokens;
  }

  tool(tokens: number, count = 1): void {
    this.tools += tokens;
    this.toolCount += count;
  }

  noteCall(id: string, name: string, input: unknown): void {
    if (id !== "" && callReadsFiles(name, input)) this.readCalls.add(id);
  }

  /** What a tool answered: a file it read, or its other output. */
  result(callId: string, tokens: number): void {
    if (tokens <= 0) return;
    if (this.readCalls.has(callId)) this.files += tokens;
    else this.results += tokens;
  }

  file(tokens: number): void {
    this.files += tokens;
  }

  /** The agent's own prompt, with instruction files and the skills list taken out. */
  systemText(text: string): void {
    const rest = this.splitSkills(this.splitMemory(text));
    if (rest.trim().startsWith("<skills_instructions>")) {
      this.skills += tokensOfText(rest);
      return;
    }
    if (rest.trim() === "") return;
    this.system += tokensOfText(rest);
  }

  /** A user's text: an instruction file or reminder the agent put in as the user, or what the user said. */
  userText(text: string): void {
    let t = text.trim();
    const leading = t.startsWith(REMINDER_OPEN);
    // each leading reminder is memory; whatever the user wrote after them is still the user's
    while (t.startsWith(REMINDER_OPEN)) {
      const close = t.indexOf(REMINDER_CLOSE);
      const end = close < 0 ? t.length : close + REMINDER_CLOSE.length;
      this.reminder(t.slice(0, end));
      t = t.slice(end).trim();
    }
    if (t === "") return;
    if (AGENTS_FOR.test(t)) {
      this.memory += tokensOfText(t);
      return;
    }
    for (const lead of HARNESS_USER_LEADS) {
      if (t.startsWith(lead)) {
        this.system += tokensOfText(t);
        return;
      }
    }
    this.chat(tokensOfText(leading ? t : text));
  }

  private reminder(span: string): void {
    let rest = this.splitSkills(this.splitMemory(span)).trim();
    if (rest.startsWith(REMINDER_OPEN)) rest = rest.slice(REMINDER_OPEN.length);
    if (rest.endsWith(REMINDER_CLOSE)) rest = rest.slice(0, rest.length - REMINDER_CLOSE.length);
    rest = rest.trim();
    if (rest !== "") this.memory += tokensOfText(rest);
  }

  private splitMemory(text: string): string {
    if (!text.includes("Contents of ") && !text.includes("Instructions from: ")) return text;
    const at: number[] = [];
    for (const m of text.matchAll(CONTENTS_OF)) at.push(m.index);
    for (const m of text.matchAll(INSTRUCTIONS_FROM)) at.push(m.index);
    if (at.length === 0) return text;
    at.sort((a, b) => a - b);
    let rest = text.slice(0, at[0]);
    for (let i = 0; i < at.length; i++) {
      const end = i + 1 < at.length ? at[i + 1]! : text.length;
      let chunk = text.slice(at[i], end);
      // a reminder's closing tag and what follows it aren't the file's
      const j = chunk.indexOf(REMINDER_CLOSE);
      if (j >= 0) {
        rest += chunk.slice(j);
        chunk = chunk.slice(0, j);
      }
      this.memory += tokensOfText(chunk);
    }
    return rest;
  }

  /** The skills list runs from its heading to the next blank line. */
  private splitSkills(text: string): string {
    const at = text.indexOf(SKILLS_LIST);
    if (at < 0) return text;
    const items = trimLeftNewlines(text.slice(at + SKILLS_LIST.length));
    let end = text.length;
    const j = items.indexOf("\n\n");
    if (j >= 0) end -= items.length - j;
    this.skills += tokensOfText(text.slice(at, end));
    return text.slice(0, at) + trimLeftNewlines(text.slice(end));
  }

  finish(): ContextBreakdownV1 | undefined {
    const total = this.system + this.tools + this.skills + this.memory + this.files + this.results + this.chatTotal;
    if (total === 0 && this.toolCount === 0 && !this.held) return undefined;
    let turns = this.turns;
    let earlier = this.compaction;
    if (turns.length > MAX_TURNS) {
      const cut = turns.length - MAX_TURNS;
      for (let i = 0; i < cut; i++) earlier += turns[i]!;
      turns = turns.slice(cut);
    }
    return {
      v: 1,
      parts: {
        system: this.system,
        tools: this.tools,
        skills: this.skills,
        memory: this.memory,
        files: this.files,
        results: this.results,
        chat: this.chatTotal,
      },
      turns,
      ...(earlier > 0 ? { turnsEarlier: earlier } : {}),
      toolCount: this.toolCount,
      ...(this.held ? { held: true as const } : {}),
    };
  }
}
