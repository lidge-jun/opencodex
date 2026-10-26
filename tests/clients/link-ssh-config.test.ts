import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadHostCandidates, parseHostCandidates, splitSshArgs } from "../../src/link/ssh-config";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) removeTreeWithRetry(root);
});

function tempHome(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `ocx-link-config-${label}-`));
  roots.push(root);
  return root;
}

test("splitSshArgs follows OpenSSH quoting, escaping, and comment rules", () => {
  expect(splitSshArgs(String.raw`alpha\ one`)).toEqual(["alpha one"]);
  expect(splitSshArgs("\"a b\" 'c\\'d' e\\")).toEqual(["a b", "c'd", "e\\"]);
  expect(splitSshArgs("x # c")).toEqual(["x"]);
  expect(splitSshArgs("\"a#b\" z")).toEqual(["a#b", "z"]);
  expect(splitSshArgs(String.raw`'x\y'`)).toEqual([String.raw`x\y`]);
  expect(splitSshArgs("a\\\tb")).toEqual(["a\\", "b"]);
  expect(splitSshArgs("\"unterminated")).toBeNull();
});

test("host parsing keeps only concrete aliases and resumes after Match blocks", () => {
  const candidates = parseHostCandidates([
    "Host alpha beta ALPHA * ? !excluded \"alpha beta\" -x",
    "Host=gamma",
    "Host \"a#b\" z",
    "Host delta # trailing comment",
    "Host \"unterminated",
    "Match all",
    "HostName ignored.example.test",
    "Include ignored.conf",
    "Host epsilon",
  ].join("\n"));
  expect(candidates).toEqual([
    { alias: "alpha", source: "ssh_config" },
    { alias: "beta", source: "ssh_config" },
    { alias: "gamma", source: "ssh_config" },
    { alias: "z", source: "ssh_config" },
    { alias: "delta", source: "ssh_config" },
    { alias: "epsilon", source: "ssh_config" },
  ]);
});

test("top-level Include follows relative globs but ignores conditional includes", () => {
  const home = tempHome("include");
  const sshDir = join(home, ".ssh");
  const includeDir = join(sshDir, "conf.d");
  mkdirSync(includeDir, { recursive: true });
  writeFileSync(join(sshDir, "config"), [
    "Include conf.d/*.conf",
    "Host root.example.test",
    "  Include conditional/inside.conf",
    "Match all",
    "  Include conditional/match.conf",
    "Host after-match.example.test",
  ].join("\n"));
  writeFileSync(join(includeDir, "a.conf"), "Host alpha.example.test\n");
  writeFileSync(join(includeDir, "b.conf"), "Host beta.example.test\n");
  const conditionalDir = join(sshDir, "conditional");
  mkdirSync(conditionalDir, { recursive: true });
  writeFileSync(join(conditionalDir, "inside.conf"), "Host inside.example.test\n");
  writeFileSync(join(conditionalDir, "match.conf"), "Host match.example.test\n");

  expect(loadHostCandidates({ home }).map(candidate => candidate.alias)).toEqual([
    "alpha.example.test",
    "beta.example.test",
    "root.example.test",
    "after-match.example.test",
  ]);
});

for (const fixture of [
  { name: "star before parentheses", pattern: "conf.d/*(1).conf", files: ["conf.d/backup(1).conf", "conf.d/1.conf"], selected: [0] },
  { name: "question mark before parentheses", pattern: "conf.d/?(work).conf", files: ["conf.d/x(work).conf", "conf.d/work.conf"], selected: [0] },
  { name: "plus before parentheses", pattern: "conf.d/*+(work).conf", files: ["conf.d/a+(work).conf", "conf.d/awork.conf"], selected: [0] },
  { name: "at sign before parentheses", pattern: "conf.d/*@(work).conf", files: ["conf.d/a@(work).conf", "conf.d/awork.conf"], selected: [0] },
  { name: "exclamation mark before parentheses", pattern: "conf.d/*!(work).conf", files: ["conf.d/a!(work).conf", "conf.d/aother.conf"], selected: [0] },
  { name: "numeric brace range", pattern: "conf.d/shard-{1..3}-*.conf", files: ["conf.d/shard-{1..3}-a.conf", "conf.d/shard-1-a.conf"], selected: [0] },
  { name: "brace alternatives", pattern: "conf.d/{work,home}-*.conf", files: ["conf.d/{work,home}-a.conf", "conf.d/work-a.conf", "conf.d/home-a.conf"], selected: [0] },
  { name: "literal directory after a wildcard", pattern: "conf.*/@(work)/*.conf", files: ["conf.a/@(work)/a.conf", "conf.a/work/a.conf"], selected: [0] },
  { name: "ordinary question marks and classes", pattern: "conf.d/[ab]?.conf", files: ["conf.d/a1.conf", "conf.d/b2.conf", "conf.d/c3.conf", "conf.d/a12.conf"], selected: [0, 1] },
  { name: "parentheses and braces inside a class", pattern: "conf.d/[({]*.conf", files: ["conf.d/(a.conf", "conf.d/{b.conf", "conf.d/c.conf"], selected: [0, 1] },
  { name: "a leading closing bracket inside a class", pattern: "conf.d/[]({]*.conf", files: ["conf.d/(a.conf", "conf.d/]b.conf", "conf.d/{c.conf", "conf.d/d.conf"], selected: [0, 1, 2] },
  { name: "a negated class", pattern: "conf.d/[!({]*.conf", files: ["conf.d/(a.conf", "conf.d/{b.conf", "conf.d/c.conf"], selected: [2] },
  { name: "already quoted parentheses", pattern: "conf.d/*[(]1[)].conf", files: ["conf.d/backup(1).conf", "conf.d/1.conf"], selected: [0] },
  { name: "already quoted braces", pattern: "conf.d/*[{]1..3[}].conf", files: ["conf.d/shard{1..3}.conf", "conf.d/shard1.conf"], selected: [0] },
  { name: "an unclosed class cannot consume generated quoting", pattern: "conf.d/[[[ab*(c).conf", files: ["conf.d/bc).conf", "conf.d/c.conf"], selected: [] },
]) {
  test(`Include glob compatibility: ${fixture.name}`, () => {
    const home = tempHome("glob");
    const sshDir = join(home, ".ssh");
    mkdirSync(sshDir, { recursive: true });
    writeFileSync(join(sshDir, "config"), `Include ${fixture.pattern}\n`);
    for (const [index, file] of fixture.files.entries()) {
      const path = join(sshDir, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `Host host${index}.example.test\n`);
    }
    expect(loadHostCandidates({ home }).map(candidate => candidate.alias)).toEqual(
      fixture.selected.map(index => `host${index}.example.test`),
    );
  });
}

test.skipIf(process.platform === "win32")("Include preserves an escaped parenthesis in a POSIX glob", () => {
  const home = tempHome("escaped-glob");
  const sshDir = join(home, ".ssh");
  const includeDir = join(sshDir, "conf.d");
  mkdirSync(includeDir, { recursive: true });
  writeFileSync(join(sshDir, "config"), String.raw`Include conf.d/*\(1).conf`);
  writeFileSync(join(includeDir, "backup(1).conf"), "Host literal.example.test\n");
  writeFileSync(join(includeDir, "1.conf"), "Host expanded.example.test\n");
  expect(loadHostCandidates({ home }).map(candidate => candidate.alias)).toEqual(["literal.example.test"]);
});

test("Include recursion stops at the OpenSSH nesting limit", () => {
  const home = tempHome("recursive");
  const sshDir = join(home, ".ssh");
  mkdirSync(sshDir, { recursive: true });
  writeFileSync(join(sshDir, "config"), "Include config\nHost loop.example.test\n");
  expect(loadHostCandidates({ home })).toEqual([{ alias: "loop.example.test", source: "ssh_config" }]);
});

test("a missing ssh config produces no candidates", () => {
  expect(loadHostCandidates({ home: tempHome("missing") })).toEqual([]);
});
