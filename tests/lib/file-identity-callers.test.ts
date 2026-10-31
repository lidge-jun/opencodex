import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { repoPath } from "../helpers/repo-root";

// NTFS file IDs exceed 2^53; these modules compare file identity, which must come from stat
// calls made with { bigint: true }. A lexical tripwire over the named declarations, not a
// full parser: it catches the regression forms below and fails closed on scopes it cannot find.
const scopes: Record<string, string[]> = {
  "src/codex/codex-home-owner.ts": ["readCodexHomeJournal"],
  "src/codex/cli-update-artifacts.ts": ["verifyCodexCliArchive"],
  "src/codex/cli-install-provenance.ts": ["readBoundedFile", "observeHeldFileSet"],
  "src/codex/orca-auth-source.ts": ["readBoundedLocalFile"],
  "src/codex/inject/bounded-config-reader.ts": ["readBoundedCodexConfig"],
  "src/codex/main-account.ts": ["statIdentity"],
  "src/codex/coordinator-doctor.ts": ["inspectTarget"],
  "src/codex/native-main-lock-file.ts": ["openStableLockFile", "assertStableLockFile"],
  "src/codex/native-residue.ts": ["readRegularFile", "classifyHistoryDatabase"],
  "src/codex/history-provider.ts": ["patchFirstLineProviderInPlace", "assertHistoryDescriptorIdentity", "historyFileIdentity"],
  // shim-fingerprint.ts and shim-state-file.ts keep numeric dev/ino fields for the persisted shim
  // state format; their runtime comparisons use bigint identity and have behavioral coverage.
  "src/codex/shim-restore-lock.ts": ["readShimRestoreLockSnapshot", "tryAcquireShimRestoreLock"],
  "src/codex/shim-wrapper-write.ts": ["writeShim"],
  "src/remote-control/workspace-executor.ts": ["assertOpenedRegularFile", "assertApprovedRootIdentity"],
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

const REGEX_PRECEDES = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = /(?:^|[^\w$])(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

/**
 * Blank literal text (strings, template text, regex literals, comments) keeping offsets, so only
 * code is balanced or matched. Template ${...} expressions stay code.
 */
function maskNonCode(source: string): string {
  const out = source.split("");
  const blank = (from: number, to: number) => { for (let at = from; at < to; at++) if (out[at] !== "\n") out[at] = " "; };
  const regexMayStart = (at: number): boolean => {
    let back = at - 1;
    while (back >= 0 && /\s/.test(out[back]!)) back--;
    if (back < 0 || REGEX_PRECEDES.has(out[back]!)) return true;
    return REGEX_KEYWORDS.test(out.slice(Math.max(0, back - 11), back + 1).join(""));
  };
  const templateDepths: number[] = [];
  let braces = 0;
  let index = 0;
  const scanTemplate = (from: number): number => {
    let at = from;
    while (at < source.length) {
      if (source[at] === "\\") { at += 2; continue; }
      if (source[at] === "`") { blank(from, at); return at + 1; }
      if (source[at] === "$" && source[at + 1] === "{") { blank(from, at); templateDepths.push(braces); braces++; return at + 2; }
      at++;
    }
    blank(from, at);
    return at;
  };
  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") { const end = source.indexOf("\n", index); const stop = end < 0 ? source.length : end; blank(index, stop); index = stop; continue; }
    if (char === "/" && next === "*") { const end = source.indexOf("*/", index + 2); const stop = end < 0 ? source.length : end + 2; blank(index, stop); index = stop; continue; }
    if (char === "'" || char === '"') {
      let at = index + 1;
      while (at < source.length && source[at] !== char && source[at] !== "\n") at += source[at] === "\\" ? 2 : 1;
      blank(index + 1, at); index = at + 1; continue;
    }
    if (char === "`") { index = scanTemplate(index + 1); continue; }
    if (char === "/" && regexMayStart(index)) {
      let at = index + 1;
      let inClass = false;
      while (at < source.length && source[at] !== "\n" && (inClass || source[at] !== "/")) {
        if (source[at] === "\\") { at += 2; continue; }
        if (source[at] === "[") inClass = true;
        else if (source[at] === "]") inClass = false;
        at++;
      }
      blank(index + 1, at); index = at + 1; continue;
    }
    if (char === "{") braces++;
    if (char === "}") {
      braces--;
      if (templateDepths.length > 0 && braces === templateDepths[templateDepths.length - 1]) {
        templateDepths.pop(); index = scanTemplate(index + 1); continue;
      }
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

/** The body of NAME's declaration: a function, or a method head whose body opens on the same line. */
function declarationBody(code: string, name: string): [number, number] | null {
  const head = new RegExp(`(?:\\bfunction\\s+|^[ \\t]*(?:(?:export|async|public|private|protected|static|override)\\s+)*)${name}\\s*\\(`, "gm");
  for (const match of code.matchAll(head)) {
    const close = matching(code, match.index! + match[0].length - 1, "(", ")");
    if (close < 0) continue;
    let at = close + 1;
    while (code[at] === " " || code[at] === "\t") at++;
    if (code[at] === ":") {
      at++;
      // A "{" after | & : < , ( opens an object type, not the body.
      for (;;) {
        while (at < code.length && code[at] !== "{" && code[at] !== ";" && code[at] !== "\n") at++;
        if (code[at] !== "{") break;
        let back = at - 1;
        while (back >= 0 && (code[back] === " " || code[back] === "\t")) back--;
        if (!"|&:<,(".includes(code[back] ?? "")) break;
        at = matching(code, at, "{", "}") + 1;
        if (at <= 0) break;
      }
    }
    if (code[at] !== "{") continue;
    const end = matching(code, at, "{", "}");
    if (end > 0) return [at, end + 1];
  }
  return null;
}

/** The last top-level argument of a call's masked argument text. */
function lastArgument(args: string): string {
  let depth = 0;
  let start = 0;
  for (let at = 0; at < args.length; at++) {
    const char = args[at]!;
    if ("([{".includes(char)) depth++;
    else if (")]}".includes(char)) depth--;
    else if (char === "," && depth === 0) start = at + 1;
  }
  return args.slice(start).trim();
}

function inspect(source: string, names: string[], droid = false): string[] {
  const code = maskNonCode(source);
  const problems: string[] = [];
  for (const name of names) {
    const range = declarationBody(code, name);
    if (!range) { problems.push(`missing declaration: ${name}`); continue; }
    let observed = 0;
    for (const match of code.slice(range[0], range[1]).matchAll(/\b(?:lstatSync|fstatSync|statSync|lstat|stat|handle\.stat)\s*\(/g)) {
      const start = range[0] + match.index!;
      const close = matching(code, start + match[0].length - 1, "(", ")");
      if (close < 0) { problems.push(`unbalanced stat call in: ${name}`); continue; }
      const call = source.slice(start, close + 1);
      if (droid && /^lstatSync\(root\)$/.test(call)) continue;
      observed++;
      if (!/^\{\s*bigint\s*:\s*true\s*\}$/.test(lastArgument(code.slice(start + match[0].length, close)))) problems.push(`numeric stat: ${call}`);
    }
    if (observed === 0) problems.push(`no stat call in: ${name}`);
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
    expect(inspect("function check() { return lstatSync(p, convert({ bigint: true })).ino; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(p, convert({ bigint: true }))"]);
    expect(inspect("function check() { const s = lstatSync(path, { bigint: true }); return Number(s.ino); }", ["check"]))
      .toEqual(["numeric identity"]);
  });

  test("strings, templates, regexes and comments cannot hide or invent a call", () => {
    expect(inspect('function check() { const a = lstatSync(join(root, "(")); const b = lstatSync(p, { bigint: true }); }', ["check"]))
      .toEqual(['numeric stat: lstatSync(join(root, "("))']);
    expect(inspect('function check() { const b = lstatSync(join(root, ")"), { bigint: true }); /* lstatSync(x) */ }', ["check"])).toEqual([]);
    expect(inspect("function check() { const b = lstatSync(p, { bigint: true }); return `${lstatSync(q).ino}`; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(q)"]);
    expect(inspect("function check() { const r = /'(/; const a = lstatSync(p); // '\n}", ["check"]))
      .toEqual(["numeric stat: lstatSync(p)"]);
    expect(inspect("function check() { lstatSync(p, { bigint: true }); if (x) return /'/.test(y); lstatSync(q); // '\n}", ["check"]))
      .toEqual(["numeric stat: lstatSync(q)"]);
    expect(inspect("function check() { const half = a / b; const s = lstatSync(p, { bigint: true }); return half / 2; }", ["check"])).toEqual([]);
  });

  test("resolves the declaration, not an earlier call, and needs a real observation", () => {
    expect(inspect("function caller() { return check(); }\nfunction check() { return lstatSync(path).ino; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(path)"]);
    expect(inspect("check()\n{ lstatSync(p, { bigint: true }); }\nfunction check() { return lstatSync(path).ino; }", ["check"]))
      .toEqual(["numeric stat: lstatSync(path)"]);
    expect(inspect("function check() { return 1; }", ["check"])).toEqual(["no stat call in: check"]);
    expect(inspect('function check(): { kind: "a" } | { kind: "b"; n: number } { return lstatSync(p).ino; }', ["check"]))
      .toEqual(["numeric stat: lstatSync(p)"]);
    expect(inspect("function check() { lstatSync(root); }", ["check"], true)).toEqual(["no stat call in: check"]);
  });

  for (const [path, names] of Object.entries(scopes)) {
    test(path, () => expect(inspect(readFileSync(repoPath(path), "utf8"), names, path.endsWith("droid-settings.ts"))).toEqual([]));
  }
});
