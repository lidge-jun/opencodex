/**
 * The source oracle behind "no test removes a path it did not create".
 *
 * The runtime refusal in `src/lib/test-home-guard` only sees removals that reach a helper of
 * ours. A bare `rmSync` in a test file reaches nothing, and by the time the damage is
 * observable the directory is gone — which is how a live home, every OAuth login and a 372MB
 * usage ledger were lost on 2026-09-15. So the second half of the guard is a scan of the test
 * SOURCES, and this module is that scan.
 *
 * It is a helper rather than a block inside the guard test for one reason: a detector with no
 * adversarial inputs is indistinguishable from a broken regex. Exporting a pure function over
 * source TEXT lets the guard feed it the shapes the previous line-matcher missed — multiline
 * calls, `let` aliases, helper wrappers, namespaced `fs.rmSync` — and prove each one is caught.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The resolvers that hand out the HOME ITSELF. Removing one of these is never a test's
 * business: the fixture that created a directory already holds its own handle to it, so a
 * removal routed through a resolver is by construction a removal of whatever home the
 * process happens to be pointed at.
 */
export const HOME_ROOT_RESOLVERS = ["getConfigDir", "getCodexHome"] as const;

/** Removals, renames and overwrites. A rename is a removal of whatever sat at the source. */
export const DESTRUCTIVE_CALLS = [
  "rmSync", "rmdirSync", "unlinkSync", "renameSync", "cpSync", "truncateSync",
  "rm", "rmdir", "unlink", "rename", "cp", "truncate",
  "removeTreeWithRetry", "removeTestTempTree",
] as const;

export type HomeRemovalTier = "home-root" | "inside-home";

export type HomeRemovalSite = Readonly<{
  line: number;
  call: string;
  argument: string;
  tier: HomeRemovalTier;
}>;

/**
 * Blank comments and string BODIES while preserving offsets, newlines and interpolated code.
 *
 * The predecessor scan approximated this by discarding any line containing a quote. That is
 * why `rmSync(join(home, "config.json"))` was invisible to it, and why a name mentioned in a
 * comment could still seed its alias set. Template interpolations stay visible on purpose: the
 * code inside `${...}` is code, and a removal spelled with one must not become a blind spot.
 */
export function blankCommentsAndStrings(source: string): string {
  const out: string[] = [];
  const modes: Array<"code" | "template"> = ["code"];
  const braces: number[] = [0];
  const blank = (ch: string): void => { out.push(ch === "\n" ? "\n" : " "); };
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (modes[modes.length - 1] === "template") {
      if (ch === "\\") { blank(ch); blank(next ?? " "); i += 2; continue; }
      if (ch === "`") { modes.pop(); braces.pop(); out.push(ch); i += 1; continue; }
      if (ch === "$" && next === "{") { modes.push("code"); braces.push(0); out.push(ch); out.push(next); i += 2; continue; }
      blank(ch); i += 1; continue;
    }
    if (ch === "/" && next === "/") { while (i < source.length && source[i] !== "\n") { blank(source[i]!); i += 1; } continue; }
    if (ch === "/" && next === "*") {
      blank(ch); blank(next); i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) { blank(source[i]!); i += 1; }
      if (i < source.length) { blank("*"); blank("/"); i += 2; }
      continue;
    }
    if (ch === "\"" || ch === "'") {
      out.push(ch); i += 1;
      while (i < source.length) {
        if (source[i] === "\\") { blank(source[i]!); blank(source[i + 1] ?? " "); i += 2; continue; }
        if (source[i] === ch) { out.push(source[i]!); i += 1; break; }
        blank(source[i]!); i += 1;
      }
      continue;
    }
    if (ch === "`") { modes.push("template"); braces.push(0); out.push(ch); i += 1; continue; }
    if (ch === "{") { braces[braces.length - 1]! += 1; out.push(ch); i += 1; continue; }
    if (ch === "}") {
      if (braces[braces.length - 1] === 0 && modes.length > 1) { modes.pop(); braces.pop(); out.push(ch); i += 1; continue; }
      braces[braces.length - 1]! -= 1; out.push(ch); i += 1; continue;
    }
    out.push(ch); i += 1;
  }
  return out.join("");
}

/**
 * Every exported resolver that hands out a path inside the process-global home.
 *
 * Derived from `src/` rather than listed here, because a hand-written list is exactly what
 * went stale: the predecessor knew about `getConfigDir()` and nothing else, so
 * `unlinkSync(getConfigPath())` and `rmSync(usageLogPath())` were outside the guard while the
 * suite reported it green. A resolver added tomorrow is covered the day it lands.
 *
 * Only ZERO-ARGUMENT invocations are treated as home-derived at the call sites below. A
 * resolver that takes a path — `historyBackupPathFor(dbPath)`, `pendingTeardownPathFor(nonce)`
 * — derives from its argument, and a test that passes it a temp path is removing a temp path.
 */
export function homePathResolvers(srcDir: string): string[] {
  const found = new Set<string>(HOME_ROOT_RESOLVERS);
  const declaration = /export function ([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*:\s*string\s*\{/g;
  for (const file of typescriptFiles(srcDir)) {
    const source = blankCommentsAndStrings(readFileSync(file, "utf8"));
    declaration.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = declaration.exec(source)) !== null) {
      const body = braceBody(source, source.indexOf("{", match.index + match[0].length - 1));
      if (derivesFromHome(body)) found.add(match[1]!);
    }
  }
  return [...found].sort();
}

function derivesFromHome(body: string): boolean {
  return /join\(\s*get(?:ConfigDir|CodexHome)\(\)/.test(body)
    || /return\s+get(?:ConfigDir|CodexHome)\(\)/.test(body)
    || /\?\?\s*get(?:ConfigDir|CodexHome)\(\)/.test(body);
}

function braceBody(source: string, open: number): string {
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") { depth -= 1; if (depth === 0) return source.slice(open, i); }
  }
  return source.slice(open);
}

function typescriptFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== "node_modules") typescriptFiles(full, out); }
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/**
 * Whether this source creates the home it pins.
 *
 * Not "does it mention OPENCODEX_HOME": restoring a saved value is not ownership. The pin has
 * to receive a directory the file itself made, which is the property that makes a later
 * removal safe under the unpinned, unarmed invocation that caused the incident.
 */
export function pinsItsOwnHome(source: string): boolean {
  const code = blankCommentsAndStrings(source);
  const created = new Set<string>();
  collect(code, /(?:const|let|var)?\s*([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*mkdtempSync\s*\(/g, created);
  collect(code, /mkdirSync\s*\(\s*([A-Za-z_$][\w$]*)\b/g, created);
  const assignment = /process\.env\s*(?:\.\s*|\[\s*["']\s*)(?:OPENCODEX_HOME|CODEX_HOME)\s*["']?\s*\]?\s*=\s*([^;\n]+)/g;
  let match: RegExpExecArray | null;
  while ((match = assignment.exec(code)) !== null) {
    const value = match[1]!;
    if (/mkdtempSync|createTempHome/.test(value)) return true;
    if ([...created].some(name => new RegExp("\\b" + name + "\\b").test(value))) return true;
  }
  return /createTempHome\s*\(/.test(code);
}

function collect(code: string, pattern: RegExp, into: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(code)) !== null) into.add(match[1]!);
}

/**
 * Destructive call sites whose target derives from a home resolver.
 *
 * Taint propagates to a fixpoint through `const`/`let`/`var` bindings, reassignments, and
 * named functions that return a tainted expression — so an alias, a `join(dir, "x")` and a
 * one-line `authPath()` helper are all reachable, which they were not before. The type
 * annotation in a binding is bounded to its own LINE on purpose: an unbounded `[^=;]+` walks
 * past the newline and binds the wrong identifier, which silently hid a real call site while
 * this scan was being written.
 */
export function findHomeRemovalSites(source: string, resolvers: readonly string[]): HomeRemovalSite[] {
  const code = blankCommentsAndStrings(source);
  const anyResolver = zeroArgCall(resolvers);
  const rootResolver = zeroArgCall(HOME_ROOT_RESOLVERS);
  const tainted = new Set<string>();
  const rootTainted = new Set<string>();
  for (let pass = 0; pass < 6; pass += 1) {
    const before = tainted.size + rootTainted.size;
    const binding = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;\n]+)?=\s*([^;\n]+)/g;
    let match: RegExpExecArray | null;
    while ((match = binding.exec(code)) !== null) {
      const name = match[1]!;
      const value = match[2]!;
      if (anyResolver.test(value) || namesAnyOf(value, tainted)) tainted.add(name);
      // Root taint needs the value to BE the root, not merely to contain it. A
      // `join(getConfigDir(), "auth.json")` binding is a path inside the home, and treating it
      // as the home itself would refuse a pinned fixture that legitimately removes one file.
      if (isBareHomeRoot(value) || isExactly(value, rootTainted)) rootTainted.add(name);
    }
    const declaration = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    while ((match = declaration.exec(code)) !== null) {
      const body = braceBody(code, code.indexOf("{", match.index));
      if (!body.includes("return")) continue;
      if (anyResolver.test(body) || namesAnyOf(body, tainted)) tainted.add(match[1]!);
      if (returnsBareHomeRoot(body)) rootTainted.add(match[1]!);
    }
    if (tainted.size + rootTainted.size === before) break;
  }
  const sites: HomeRemovalSite[] = [];
  const call = new RegExp("(?:\\b|\\.)(" + DESTRUCTIVE_CALLS.join("|") + ")\\s*\\(", "g");
  let match: RegExpExecArray | null;
  while ((match = call.exec(code)) !== null) {
    const argument = firstArgument(code, match.index + match[0].length - 1);
    if (!anyResolver.test(argument) && !namesAnyOf(argument, tainted)) continue;
    const tier: HomeRemovalTier = rootResolver.test(argument.trim()) && isBareCall(argument)
      ? "home-root"
      : isExactly(argument, rootTainted) || callsAnyOf(argument, rootTainted) ? "home-root" : "inside-home";
    sites.push({
      line: code.slice(0, match.index).split("\n").length,
      call: match[1]!,
      argument: argument.trim(),
      tier,
    });
  }
  return sites;
}

/**
 * The sites a test file may not contain.
 *
 * Two tiers, because they fail differently. Removing the home ROOT is refused outright: no
 * pin makes `rmSync(getConfigDir())` a reasonable thing for a test to contain, and the
 * fixture hands back its own root for exactly that case. Removing a path INSIDE the home is
 * ordinary fixture hygiene — 17 files do it today — but only in a file that created the home
 * it is pointed at, which is the difference between a temp file and the user's config.json.
 */
export function findHomeRemovalViolations(source: string, resolvers: readonly string[]): HomeRemovalSite[] {
  const owns = pinsItsOwnHome(source);
  return findHomeRemovalSites(source, resolvers).filter(site => site.tier === "home-root" || !owns);
}

function zeroArgCall(names: readonly string[]): RegExp {
  return new RegExp("\\b(?:" + names.join("|") + ")\\s*\\(\\s*\\)");
}

function isBareCall(argument: string): boolean {
  return new RegExp("^\\s*(?:" + HOME_ROOT_RESOLVERS.join("|") + ")\\s*\\(\\s*\\)\\s*$").test(argument);
}

/** A value that IS the home root: the bare resolver call, or a thunk returning nothing else. */
function isBareHomeRoot(value: string): boolean {
  const root = HOME_ROOT_RESOLVERS.join("|");
  return new RegExp("^\\s*(?:\\([^)]*\\)\\s*(?::[^=]+)?=>\\s*)?(?:" + root + ")\\s*\\(\\s*\\)\\s*;?\\s*$").test(value);
}

function returnsBareHomeRoot(body: string): boolean {
  return new RegExp("return\\s+(?:" + HOME_ROOT_RESOLVERS.join("|") + ")\\s*\\(\\s*\\)\\s*;").test(body);
}

function callsAnyOf(text: string, names: ReadonlySet<string>): boolean {
  return [...names].some(name => new RegExp("^\\s*" + name + "\\s*\\(\\s*\\)\\s*$").test(text));
}

function namesAnyOf(text: string, names: ReadonlySet<string>): boolean {
  return [...names].some(name => new RegExp("\\b" + name + "\\b").test(text));
}

function isExactly(text: string, names: ReadonlySet<string>): boolean {
  return [...names].some(name => new RegExp("^\\s*" + name + "\\s*$").test(text));
}

/** The first argument of a call, brace/paren balanced so a multiline expression stays whole. */
function firstArgument(code: string, openParen: number): string {
  let depth = 0;
  let start = -1;
  for (let i = openParen; i < code.length; i += 1) {
    const ch = code[i]!;
    if (ch === "(" || ch === "[" || ch === "{") { depth += 1; if (depth === 1 && ch === "(") start = i + 1; continue; }
    if (ch === ")" || ch === "]" || ch === "}") { depth -= 1; if (depth === 0) return code.slice(start, i); continue; }
    if (depth === 1 && ch === ",") return code.slice(start, i);
  }
  return "";
}
