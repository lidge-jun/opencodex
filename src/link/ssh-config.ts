import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSshAlias } from "./ssh-argv";

/**
 * Host candidates from OpenSSH client configuration.
 *
 * Candidates are offers, not trust: a host is usable only after a probe proves key login and the
 * user confirms its host key. Patterns (`*`, `?`, `!`) and `Match` blocks name no single host,
 * so they are skipped. An `Include` inside a `Host` or `Match` block applies only under that
 * block's condition, so only top-level includes are followed.
 */
export interface HostCandidate {
  alias: string;
  source: "ssh_config";
}

export interface ParseHostCandidatesOptions {
  /** Contents of every file an `Include` pattern names, in order. */
  resolveInclude?: (pattern: string) => string[];
  /** Include nesting limit; OpenSSH uses 16. */
  maxDepth?: number;
}

/**
 * Split arguments exactly the way OpenSSH's argv_split (misc.c) does when readconf calls it with
 * terminate_on_comment set:
 * - blanks and tabs separate arguments; an unquoted `#` at the start of an argument ends the line;
 * - a backslash before `'`, `"` or `\\` — or, outside quotes, before a space — yields that
 *   character; any other backslash (including a trailing one) is kept literally;
 * - single or double quotes group, and the backslash rule above applies inside them too.
 * Returns null for an unterminated quote, which OpenSSH rejects as an invalid line.
 */
export function splitSshArgs(text: string): string[] | null {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    const lead = text[i];
    if (lead === " " || lead === "\t") { i += 1; continue; }
    if (lead === "#") break;
    let arg = "";
    let quote: "'" | '"' | null = null;
    for (; i < text.length; i += 1) {
      const ch = text[i]!;
      const next = text[i + 1];
      if (ch === "\\") {
        if (next === "'" || next === '"' || next === "\\" || (quote === null && next === " ")) {
          i += 1;
          arg += next;
        } else {
          arg += ch;
        }
      } else if (quote === null && (ch === " " || ch === "\t")) {
        break;
      } else if (quote === null && (ch === '"' || ch === "'")) {
        quote = ch;
      } else if (quote !== null && ch === quote) {
        quote = null;
      } else {
        arg += ch;
      }
    }
    if (quote !== null) return null;
    out.push(arg);
  }
  return out;
}

function splitDirective(raw: string): { keyword: string; args: string[] } | null {
  const line = raw.trim();
  if (!line || line.startsWith("#")) return null;
  const match = /^([A-Za-z]+)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!match) return null;
  const args = splitSshArgs(match[2]!);
  if (!args) return null;
  return { keyword: match[1]!.toLowerCase(), args };
}

export function parseHostCandidates(text: string, options: ParseHostCandidatesOptions = {}): HostCandidate[] {
  const seen = new Set<string>();
  const out: HostCandidate[] = [];
  const maxDepth = options.maxDepth ?? 16;
  const visit = (body: string, depth: number): void => {
    let block: "top" | "host" | "match" = "top";
    for (const raw of body.split(/\r?\n/)) {
      const directive = splitDirective(raw);
      if (!directive) continue;
      if (directive.keyword === "match") { block = "match"; continue; }
      if (directive.keyword === "include") {
        if (block !== "top" || depth >= maxDepth || !options.resolveInclude) continue;
        for (const pattern of directive.args) {
          for (const included of options.resolveInclude(pattern)) visit(included, depth + 1);
        }
        continue;
      }
      if (directive.keyword !== "host") continue;
      block = "host";
      for (const alias of directive.args) {
        if (/[*?!]/.test(alias) || !isSshAlias(alias)) continue;
        const key = alias.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ alias, source: "ssh_config" });
      }
    }
  };
  visit(text, 0);
  return out;
}

export interface LoadHostCandidatesOptions {
  /** Home directory whose `.ssh/config` is read. Defaults to the user's home. */
  home?: string;
  readFile?: (path: string) => string;
  /** Expand one absolute glob pattern to file paths. */
  glob?: (pattern: string) => string[];
}

function defaultGlob(pattern: string): string[] {
  if (!/[*?[]/.test(pattern)) return [pattern];
  const base = dirname(pattern.slice(0, pattern.search(/[*?[]/) + 1));
  const relative = pattern.slice(base.length + 1);
  return [...new Bun.Glob(relative).scanSync({ cwd: base, absolute: true, onlyFiles: true })].sort();
}

/**
 * Read `~/.ssh/config` and its includes. A missing or unreadable file yields no candidates.
 * Include patterns support a leading `~/`, absolute and `~/.ssh`-relative paths and globs;
 * `~user`, environment variables and `%` tokens are not expanded, so such an include adds no
 * candidates (the host can still be entered by hand).
 */
export function loadHostCandidates(options: LoadHostCandidatesOptions = {}): HostCandidate[] {
  const home = options.home ?? homedir();
  const sshDir = join(home, ".ssh");
  const read = options.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const glob = options.glob ?? defaultGlob;
  const safeRead = (path: string): string | null => {
    try { return read(path); } catch { return null; }
  };
  const root = safeRead(join(sshDir, "config"));
  if (root === null) return [];
  return parseHostCandidates(root, {
    resolveInclude: pattern => {
      const expanded = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
      const absolute = isAbsolute(expanded) ? expanded : resolve(sshDir, expanded);
      let paths: string[];
      try { paths = glob(absolute); } catch { return []; }
      return paths.map(safeRead).filter((body): body is string => body !== null);
    },
  });
}
