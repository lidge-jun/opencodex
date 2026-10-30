import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// NTFS file IDs exceed 2^53; these modules compare file identity, which must come from
// stat calls made with { bigint: true }. Each scope names the declaration that observes it.
const scopes: Record<string, string[]> = {
  "src/config/initialize.ts": ["identifiesDescriptor"],
  "src/service/state-lock.ts": ["readLockSnapshot"],
  "src/oauth/store.ts": ["snapshot", "createOAuthFileLock"],
  "src/claude/intercept/proxy-auth.ts": ["assertSameNode", "readPinnedToken", "ensurePrivateDirectory", "ensureClaudeInterceptProxyToken"],
  "src/claude/desktop-remote-store-io.ts": ["read"],
  "src/server/persistent-gui-session.ts": ["readRecords"],
  "src/lib/spend-pool-alias-validation.ts": ["readExistingSpendSalt"],
  "src/integrations/droid-settings.ts": ["assertDroidSettingsUnambiguous"],
  "src/integrations/aside-profile-context.ts": ["storeGuard"],
  "src/integrations/hermes-profiles.ts": ["lstatOrNull"],
  "src/providers/cc-switch-import-source.ts": ["readSourceRows"],
  "src/adapters/command-code-project-context.ts": ["openedFileIsConfined"],
  "src/codex/catalog/write-audit.ts": ["appendCatalogWriteAudit"],
};

/** Blank string, template and comment contents (offsets kept) so only code is balanced or matched. */
function maskNonCode(source: string): string {
  const out = source.split("");
  let index = 0;
  const blank = (from: number, to: number) => { for (let at = from; at < to; at++) if (out[at] !== "\n") out[at] = " "; };
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") { const end = source.indexOf("\n", index); const stop = end < 0 ? source.length : end; blank(index, stop); index = stop; continue; }
    if (char === "/" && next === "*") { const end = source.indexOf("*/", index + 2); const stop = end < 0 ? source.length : end + 2; blank(index, stop); index = stop; continue; }
    if (char === "'" || char === '"' || char === "`") {
      let at = index + 1;
      while (at < source.length && source[at] !== char) at += source[at] === "\\" ? 2 : 1;
      blank(index + 1, at); index = at + 1; continue;
    }
    index++;
  }
  return out.join("");
}

function matching(code: string, open: number, left: string, right: string): number {
  let depth = 0;
  for (let at = open; at < code.length; at++) {
    if (code[at] === left) depth++;
    else if (code[at] === right && --depth === 0) return at;
  }
  return -1;
}

/** The body of NAME's declaration (function or method), never of a call to it. */
function declarationBody(code: string, name: string): [number, number] | null {
  for (const match of code.matchAll(new RegExp(`(?:\\bfunction\\s+|^[ \\t]*(?:export\\s+)?(?:async\\s+)?)${name}\\s*\\(`, "gm"))) {
    const close = matching(code, match.index! + match[0].length - 1, "(", ")");
    if (close < 0) continue;
    let at = close + 1;
    while (/\s/.test(code[at] ?? "")) at++;
    if (code[at] === ":") {
      at++;
      while (/\s/.test(code[at] ?? "")) at++;
      if (code[at] === "{") at = matching(code, at, "{", "}") + 1;
      while (at < code.length && code[at] !== "{" && code[at] !== ";") at++;
    }
    if (code[at] !== "{") continue;
    const end = matching(code, at, "{", "}");
    if (end > 0) return [at, end + 1];
  }
  return null;
}

/** Every stat call in a masked body with its full argument text, nested parentheses included. */
function statCalls(code: string, source: string, [from, to]: [number, number]): Array<{ call: string; args: string }> {
  const body = code.slice(from, to);
  const calls: Array<{ call: string; args: string }> = [];
  for (const match of body.matchAll(/\b(?:lstatSync|fstatSync|statSync|lstat|stat|handle\.stat)\s*\(/g)) {
    const start = from + match.index!;
    const close = matching(code, start + match[0].length - 1, "(", ")");
    if (close < 0) continue;
    calls.push({ call: source.slice(start, close + 1), args: code.slice(start + match[0].length, close) });
  }
  return calls;
}

function inspect(source: string, names: string[], droid = false): string[] {
  const code = maskNonCode(source);
  const problems: string[] = [];
  for (const name of names) {
    const range = declarationBody(code, name);
    if (!range) { problems.push(`missing declaration: ${name}`); continue; }
    const calls = statCalls(code, source, range);
    if (calls.length === 0) problems.push(`no stat call in: ${name}`);
    for (const { call, args } of calls) {
      if (droid && /^lstatSync\(root\)$/.test(call)) continue;
      if (!/\{\s*bigint\s*:\s*true\s*\}/.test(args)) problems.push(`numeric stat: ${call}`);
    }
  }
  if (/\bNumber\s*\([^)]*\.(?:ino|dev)\b/.test(code)) problems.push("numeric identity");
  return problems;
}

describe("file identity caller stats", () => {
  test("detects a numeric identity observation", () => {
    expect(inspect("function check() { const s = lstatSync(path); return s.ino === 1; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(path)"]);
    expect(inspect("function check() { const s = lstatSync(join(root, name)); return s.ino === 1; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(join(root, name))"]);
    expect(inspect("function check() { return lstatSync(join(root, name), { bigint: true }).ino; }", ["check"])).toEqual([]);
    expect(inspect("function check() { const s = lstatSync(path, { bigint: true }); return Number(s.ino); }", ["check"]))
      .toEqual(["numeric identity"]);
  });

  test("strings and comments cannot hide or invent a call", () => {
    expect(inspect('function check() { const a = lstatSync(join(root, "(")); const b = lstatSync(p, { bigint: true }); }', ["check"]))
      .toEqual(['numeric stat: lstatSync(join(root, "("))']);
    expect(inspect('function check() { const b = lstatSync(join(root, ")"), { bigint: true }); /* lstatSync(x) */ }', ["check"])).toEqual([]);
  });

  test("resolves the declaration, not an earlier call", () => {
    const source = "function caller() { return check(); }\nfunction check() { return lstatSync(path).ino; }";
    expect(inspect(source, ["check"])).toEqual(["numeric stat: lstatSync(path)"]);
    expect(inspect("function check() { return 1; }", ["check"])).toEqual(["no stat call in: check"]);
  });

  for (const [path, names] of Object.entries(scopes)) {
    test(path, () => expect(inspect(readFileSync(repoPath(path), "utf8"), names, path.endsWith("droid-settings.ts"))).toEqual([]));
  }
});
