import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { helperPath, repoPath } from "../helpers/repo-root";
import { createFixtureNamespaceOwner, FIXTURE_NAMESPACE_MARKER } from "../helpers/fixture-namespace-owner";

let root: string;
let ownedTemp: string;
let realHome: string;
let owner: ReturnType<typeof createFixtureNamespaceOwner>;
const extraRoots: string[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-preload-admission-"));
  ownedTemp = join(root, "temp");
  realHome = join(root, "real-user");
  mkdirSync(ownedTemp);
  owner = createFixtureNamespaceOwner(ownedTemp);
  mkdirSync(realHome, { recursive: true });
});

afterEach(() => {
  // Only these exclusively created fixture roots belong to this test.
  for (const path of [root, ...extraRoots.splice(0)]) {
    rmSync(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

function load(fixtureHome: string | undefined, guard = "1", overrides: NodeJS.ProcessEnv = {}) {
  const env = {
    ...process.env,
    TEMP: ownedTemp, TMP: ownedTemp, TMPDIR: ownedTemp,
    HOME: realHome, USERPROFILE: realHome,
    OCX_TEST_HOME_GUARD: guard, OCX_REAL_HOME: realHome,
    OCX_REAL_CLAUDE_CONFIG_DIR: join(realHome, ".claude"),
    CLAUDE_CONFIG_DIR: join(realHome, ".claude"),
    OPENCODEX_HOME: fixtureHome,
    ...owner,
    OCX_FIXTURE_KNOWN_FOLDER: repoPath("src", "codex", "windows-local-appdata.ts"),
    ...overrides,
  };
  return spawnSync(process.execPath, ["--preload", helperPath("fixture-windows-runtime-preload.ts"), "-e",
    'console.log("FIXTURE_ADMITTED=" + require(process.env.OCX_FIXTURE_KNOWN_FOLDER).resolveWindowsLocalAppData())',
  ], { cwd: root, env, encoding: "utf8", timeout: 10_000 });
}

// Each refusal names the gate that must stop the child, in the preload's check order, so a case
// cannot pass because an earlier, unrelated gate refused it.
const GUARD = /requires an absolute guarded OPENCODEX_HOME/;
const OWNER_ROOT = /requires an absolute owner root and nonce/;
const PROTECTED = /refusing Windows runtime fixture (in |overlapping a protected tree)/;
const OUTSIDE = /refusing Windows runtime fixture outside its owned root/;
const MARKER = /requires an owner marker/;
const NONCE = /requires a matching owner nonce/;

function refuses(fixtureHome: string, reason: RegExp, guard = "1", overrides: NodeJS.ProcessEnv = {}) {
  const target = join(dirname(fixtureHome), "local-appdata");
  const homeExisted = existsSync(fixtureHome);
  expect(existsSync(target)).toBe(false);
  const result = load(fixtureHome, guard, overrides);
  expect(result.error).toBeUndefined();
  expect({ status: result.status, stderr: result.stderr }).not.toMatchObject({ status: 0 });
  expect(result.stderr).toMatch(reason);
  expect(result.stdout).not.toContain("FIXTURE_ADMITTED=");
  expect(existsSync(target)).toBe(false);
  expect(existsSync(fixtureHome)).toBe(homeExisted);
}

test.each([
  ["protected home", [".opencodex"]],
  ["protected descendant", [".opencodex", "nested"]],
  ["protected ancestor", []],
  ["Codex descendant", [".codex", "nested"]],
  ["Claude descendant", [".claude", "nested"]],
  ["LaunchAgents descendant", ["Library", "LaunchAgents", "nested"]],
] as const)("refuses %s before mkdir or mock registration", (_label, parts) => {
refuses(join(realHome, ...parts), PROTECTED);
});

test("refuses an unowned custom home outside the child's tmpdir and checkout .tmp", () => {
refuses(join(root, "custom", "ocx"), OUTSIDE);
});

test("refuses the owned temp root itself rather than treating equality as containment", () => {
refuses(ownedTemp, OUTSIDE);
});

test("requires the armed home guard even for an owned fixture", () => {
refuses(join(ownedTemp, "fixture", "ocx"), GUARD, "0");
});

test.each([undefined, "", "   ", "relative-home"])("refuses missing, blank or relative home: %s", home => {
  const result = load(home);
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(GUARD);
  expect(result.stdout).not.toContain("FIXTURE_ADMITTED=");
  expect(existsSync(join(root, "local-appdata"))).toBe(false);
});

test("accepts a mkdtemp home strictly inside the canonical temp root", () => {
  const home = mkdtempSync(join(ownedTemp, "fixture-"));
  const result = load(home);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`FIXTURE_ADMITTED=${join(ownedTemp, "local-appdata")}`);
  expect(existsSync(join(ownedTemp, "local-appdata"))).toBe(true);
});

test("accepts a not-yet-created fixture below an existing temp ancestor", () => {
  const home = join(ownedTemp, "new-parent", "ocx");
  const result = load(home);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(existsSync(join(dirname(home), "local-appdata"))).toBe(true);
});

test("accepts the checkout .tmp fixture root used by Windows catalog tests", () => {
  mkdirSync(repoPath(".tmp"), { recursive: true });
  const fixture = mkdtempSync(repoPath(".tmp", "preload-admission-"));
  extraRoots.push(fixture);
  const result = load(join(fixture, "ocx"), "1", createFixtureNamespaceOwner(fixture));
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(existsSync(join(fixture, "local-appdata"))).toBe(true);
});

test("refuses an owned-root alias whose missing child resolves outside that root", () => {
  const outside = join(root, "outside");
  mkdirSync(outside);
  const alias = join(ownedTemp, "alias");
  symlinkSync(outside, alias, process.platform === "win32" ? "junction" : "dir");
refuses(join(alias, "missing", "ocx"), OUTSIDE);
  expect(readdirSync(outside)).toEqual([]);
});

test("refuses a protected local-appdata target even when the fixture home is owned", () => {
  const fixture = mkdtempSync(join(ownedTemp, "fixture-"));
  const protectedTarget = join(realHome, ".opencodex");
  mkdirSync(protectedTarget);
  symlinkSync(protectedTarget, join(fixture, "local-appdata"), process.platform === "win32" ? "junction" : "dir");
  const result = load(join(fixture, "ocx"));
  expect(result.error).toBeUndefined();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(PROTECTED);
  expect(result.stdout).not.toContain("FIXTURE_ADMITTED=");
  expect(readdirSync(protectedTarget)).toEqual([]);
});

test("refuses a missing owner marker before mkdir or mock registration", () => {
  unlinkSync(join(ownedTemp, FIXTURE_NAMESPACE_MARKER));
  refuses(join(ownedTemp, "fixture", "ocx"), MARKER);
});

test.each(["wrong-nonce", ""])("refuses a mismatched or empty owner nonce: %s", nonce => {
refuses(join(ownedTemp, "fixture", "ocx"), nonce ? NONCE : OWNER_ROOT, "1", { OCX_FIXTURE_NAMESPACE_NONCE: nonce });
});

test.each([undefined, "relative-root"])("requires an absolute owner root: %s", fixtureRoot => {
refuses(join(ownedTemp, "fixture", "ocx"), OWNER_ROOT, "1", { OCX_FIXTURE_NAMESPACE_ROOT: fixtureRoot });
});

test.each([false, true])("refuses a protected tmpdir's ..fixture child (home exists: %s)", exists => {
  const protectedTemp = join(realHome, ".opencodex");
  const fixture = join(protectedTemp, "..fixture");
  mkdirSync(fixture, { recursive: true });
  const home = join(fixture, "ocx");
  if (exists) mkdirSync(home);
  refuses(home, PROTECTED, "1", {
    ...createFixtureNamespaceOwner(fixture),
    TEMP: protectedTemp, TMP: protectedTemp, TMPDIR: protectedTemp,
  });
});

test.skipIf(process.platform !== "win32" && process.platform !== "darwin")
  .each([".OPENCODEX", ".CODEX", ".CLAUDE", "Library/LAUNCHAGENTS"])
  ("refuses a missing case-equivalent protected tree: %s", tree => {
    realHome = join(ownedTemp, "case-user");
    mkdirSync(realHome);
    const home = join(realHome, tree);
    expect(existsSync(home)).toBe(false);
refuses(home, PROTECTED, "1", createFixtureNamespaceOwner(realHome));
  });

test("refuses an owner root containing a protected tree even when home and target are outside it", () => {
  realHome = join(ownedTemp, "real-user");
  mkdirSync(realHome);
refuses(join(ownedTemp, "safe", "ocx"), PROTECTED);
});

test("accepts an ordinary ..fixture component within its owned root", () => {
  const home = join(ownedTemp, "..fixture", "ocx");
  const result = load(home);
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(result.stdout).toContain(`FIXTURE_ADMITTED=${join(ownedTemp, "..fixture", "local-appdata")}`);
  expect(existsSync(join(dirname(home), "local-appdata"))).toBe(true);
});
