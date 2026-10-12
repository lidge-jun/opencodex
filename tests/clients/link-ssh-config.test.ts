import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
