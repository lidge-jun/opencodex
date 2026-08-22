import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commandInvocation } from "../src/lib/win-exec";

setDefaultTimeout(30_000);

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const releaseScriptPath = join(repoRoot, "scripts", "release.ts");

interface LoggedCall {
  args: string[];
  name: string;
}

interface ReleaseScenario {
  branch?: string;
  npmLatest?: string;
  npmPreview?: string;
  headSha?: string;
  remoteHeadSha?: string;
  privacyExitCode?: number;
  testExitCode?: number;
  typecheckExitCode?: number;
}

function writeExecutable(path: string, contents: string): void {
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function shimProgramSource(name: "bun" | "gh" | "git" | "npm"): string {
  if (name === "bun") {
    return `import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RELEASE_LOG, JSON.stringify({ name: "bun", args }) + "\\n");

const exitCode =
  args[0] === "x" && args[1] === "tsc" ? Number(process.env.FAKE_BUN_TSC_EXIT_CODE ?? "0")
  : args[0] === "test" && args[1] === "--isolate" && args[2] === "tests" ? Number(process.env.FAKE_BUN_TEST_EXIT_CODE ?? "0")
  : args[0] === "run" && args[1] === "privacy:scan" ? Number(process.env.FAKE_BUN_PRIVACY_EXIT_CODE ?? "0")
  : 0;

if (exitCode !== 0) {
  console.error(\`fake bun failure: \${args.join(" ")}\`);
}

process.exit(exitCode);
`;
  }

  if (name === "git") {
    return `import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RELEASE_LOG, JSON.stringify({ name: "git", args }) + "\\n");

const headSha = process.env.FAKE_GIT_HEAD_SHA ?? "abc123def456";
const branch = process.env.FAKE_GIT_BRANCH ?? "main";
const stdout = (text) => process.stdout.write(text);
const stderr = (text) => process.stderr.write(text);

if (args[0] === "rev-parse" && args[1] === "--abbrev-ref" && args[2] === "HEAD") {
  stdout(branch + "\\n");
  process.exit(0);
}

if (args[0] === "status" && args[1] === "--porcelain") {
  stdout((process.env.FAKE_GIT_STATUS ?? "") + "\\n");
  process.exit(0);
}

if (args[0] === "ls-remote") {
  if (args.some(a => typeof a === "string" && a.startsWith("refs/heads/"))) {
    const branchRef = args.find(a => typeof a === "string" && a.startsWith("refs/heads/"));
    stdout(\`\${process.env.FAKE_GIT_REMOTE_HEAD_SHA ?? headSha}\t\${branchRef}\n\`);
  }
  process.exit(0);
}

if (args[0] === "add" || args[0] === "commit" || args[0] === "push") {
  process.exit(0);
}

if (args[0] === "rev-parse" && args[1] === "HEAD") {
  stdout(headSha + "\\n");
  process.exit(0);
}

if (args[0] === "rev-parse" && args[1]?.startsWith("origin/")) {
  stdout(headSha + "\\n");
  process.exit(0);
}

stderr(\`unexpected git args: \${args.join(" ")}\\n\`);
process.exit(1);
`;
  }

  if (name === "npm") {
    return `import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RELEASE_LOG, JSON.stringify({ name: "npm", args }) + "\\n");

if (args[0] === "view" && args.includes("dist-tags")) {
  process.stdout.write(JSON.stringify({
    latest: process.env.FAKE_NPM_LATEST ?? "0.0.1",
    preview: process.env.FAKE_NPM_PREVIEW ?? "0.0.1-preview.0",
  }) + "\\n");
  process.exit(0);
}

if (args[0] === "view") {
  console.error("npm ERR! code E404");
  process.exit(1);
}

if (args[0] === "version") {
  process.exit(0);
}

console.error(\`unexpected npm args: \${args.join(" ")}\`);
process.exit(1);
`;
  }

  return `import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_RELEASE_LOG, JSON.stringify({ name: "gh", args }) + "\\n");

const headSha = process.env.FAKE_GIT_HEAD_SHA ?? "abc123def456";
const stdout = (text) => process.stdout.write(text);
const stderr = (text) => process.stderr.write(text);

if (args[0] === "release" && args[1] === "view") {
  stderr("release not found\\n");
  process.exit(1);
}

if (args[0] === "run" && args[1] === "list") {
  if (args.includes("ci.yml")) {
    stdout(JSON.stringify([{ conclusion: "success", databaseId: 7, headSha, status: "completed", url: "https://example.test/ci" }]));
    process.exit(0);
  }

  if (args.includes("service-lifecycle.yml")) {
    stdout(JSON.stringify([{ conclusion: "success", databaseId: 8, headSha, status: "completed", url: "https://example.test/service" }]));
    process.exit(0);
  }

  if (args.includes("release.yml")) {
    stdout(JSON.stringify([{ createdAt: new Date().toISOString(), databaseId: 9, headSha, status: "queued", url: "https://example.test/release" }]));
    process.exit(0);
  }
}

if (args[0] === "workflow" && args[1] === "run") {
  process.exit(0);
}

if (args[0] === "run" && args[1] === "watch") {
  process.exit(0);
}

stderr(\`unexpected gh args: \${args.join(" ")}\\n\`);
process.exit(1);
`;
}

function installCommandShim(binDir: string, name: "bun" | "gh" | "git" | "npm"): void {
  const jsPath = join(binDir, `${name}.js`);
  const launcherPath = join(binDir, name);
  const cmdPath = join(binDir, `${name}.cmd`);

  writeFileSync(jsPath, shimProgramSource(name), "utf8");
  writeExecutable(launcherPath, `#!${process.execPath}\nimport "./${name}.js";\n`);
  writeFileSync(cmdPath, `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`, "utf8");
}

function readLoggedCalls(logPath: string): LoggedCall[] {
  const raw = readFileSync(logPath, "utf8").trim();
  if (!raw) return [];
  return raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as LoggedCall);
}

function findCallIndex(calls: LoggedCall[], name: string, matcher: (call: LoggedCall) => boolean): number {
  return calls.findIndex(call => call.name === name && matcher(call));
}

function runRelease(version: string, scenario: ReleaseScenario = {}) {
  const shimDir = mkdtempSync(join(tmpdir(), "ocx-release-helper-"));
  const logPath = join(shimDir, "release-log.jsonl");
  writeFileSync(logPath, "", "utf8");

  for (const name of ["bun", "gh", "git", "npm"] as const) {
    installCommandShim(shimDir, name);
  }

  // Windows names the variable `Path`, and `...process.env` copies it in under
  // that spelling. Adding a separate `PATH` key leaves BOTH present, and which
  // one wins is not something this test should be gambling on — the child saw
  // the real git instead of the shim, so the branch guard read `dev` and the
  // script aborted before logging a single call. Strip every case variant, then
  // set exactly one.
  const inheritedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "path"),
  );
  const pathKey = process.platform === "win32" ? "Path" : "PATH";
  const pathValue = `${shimDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? process.env.Path ?? ""}`;

  const result = spawnSync(process.execPath, [releaseScriptPath, version], {
    cwd: repoRoot,
    env: {
      ...inheritedEnv,
      [pathKey]: pathValue,
      FAKE_RELEASE_LOG: logPath,
      FAKE_GIT_BRANCH: scenario.branch ?? "main",
      FAKE_GIT_HEAD_SHA: scenario.headSha ?? "abc123def456",
      ...(scenario.remoteHeadSha ? { FAKE_GIT_REMOTE_HEAD_SHA: scenario.remoteHeadSha } : {}),
      FAKE_BUN_TSC_EXIT_CODE: String(scenario.typecheckExitCode ?? 0),
      FAKE_BUN_TEST_EXIT_CODE: String(scenario.testExitCode ?? 0),
      FAKE_BUN_PRIVACY_EXIT_CODE: String(scenario.privacyExitCode ?? 0),
      ...(scenario.npmLatest ? { FAKE_NPM_LATEST: scenario.npmLatest } : {}),
      ...(scenario.npmPreview ? { FAKE_NPM_PREVIEW: scenario.npmPreview } : {}),
    },
    encoding: "utf8",
  });

  const calls = readLoggedCalls(logPath);
  rmSync(shimDir, { recursive: true, force: true });
  return { calls, result };
}

describe("release helper", () => {
  test("preflight runs the shared audit, typecheck, test suite, and privacy scan before version bump", () => {
    const { calls, result } = runRelease("9.9.9");

    // Report what the script actually said. A bare status assertion turned a
    // Windows-only spawn failure into "Expected: 0 Received: 1" with no cause,
    // which cost a full CI round to diagnose.
    expect(`${result.status}\n${result.stderr ?? ""}`.trim()).toBe("0");

    const auditIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "run audit:high");
    const typecheckIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "x tsc --noEmit");
    const testIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "test --isolate tests");
    const privacyIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "run privacy:scan");
    const versionIndex = findCallIndex(calls, "npm", call => call.args.join(" ") === "version 9.9.9 --no-git-tag-version");
    const dispatchIndex = findCallIndex(calls, "gh", call =>
      call.args[0] === "workflow"
      && call.args[1] === "run"
      && call.args.includes("release.yml")
      && call.args.includes("tag=latest")
      && call.args.includes("dry-run=true"),
    );

    expect(auditIndex).toBeGreaterThanOrEqual(0);
    expect(typecheckIndex).toBeGreaterThan(auditIndex);
    expect(testIndex).toBeGreaterThan(typecheckIndex);
    expect(privacyIndex).toBeGreaterThan(testIndex);
    expect(versionIndex).toBeGreaterThan(privacyIndex);
    expect(dispatchIndex).toBeGreaterThan(versionIndex);
  });

  test("an obsolete version that would move latest backwards aborts before the bump", () => {
    const { calls, result } = runRelease("9.9.8", { npmLatest: "9.9.9" });

    expect(result.status).not.toBe(0);
    expect(result.stderr ?? "").toContain("does not move the 'latest' channel forward");
    expect(findCallIndex(calls, "npm", call => call.args[0] === "version")).toBe(-1);
    expect(findCallIndex(calls, "git", call => call.args[0] === "commit")).toBe(-1);
  });

  test("a version newer than the channel tip passes the forward guard", () => {
    const { calls, result } = runRelease("9.9.10", { npmLatest: "9.9.9" });

    expect(`${result.status}\n${result.stderr ?? ""}`.trim()).toBe("0");
    expect(findCallIndex(calls, "npm", call => call.args.join(" ") === "version 9.9.10 --no-git-tag-version")).toBeGreaterThanOrEqual(0);
  });

  test("preview releases compare against the preview channel, not latest", () => {
    const { result } = runRelease("9.9.9-preview.2", { branch: "preview", npmLatest: "10.0.0", npmPreview: "9.9.9-preview.1" });

    expect(`${result.status}\n${result.stderr ?? ""}`.trim()).toBe("0");
  });

  test("failed privacy scan aborts before version bump, commit, and push", () => {
    const { calls, result } = runRelease("9.9.9", { privacyExitCode: 1 });

    expect(result.status).not.toBe(0);
    expect(findCallIndex(calls, "bun", call => call.args.join(" ") === "run privacy:scan")).toBeGreaterThanOrEqual(0);
    expect(findCallIndex(calls, "npm", call => call.args[0] === "version")).toBe(-1);
    expect(findCallIndex(calls, "git", call => call.args[0] === "commit")).toBe(-1);
    expect(findCallIndex(calls, "git", call => call.args[0] === "push")).toBe(-1);
  });

  test("preview branch still defaults to preview tag and dry-run dispatch", () => {
    const { calls, result } = runRelease("9.9.9-preview.1", { branch: "preview" });

    expect(result.status).toBe(0);
    expect(findCallIndex(calls, "gh", call =>
      call.args[0] === "workflow"
      && call.args[1] === "run"
      && call.args.includes("release.yml")
      && call.args.includes("tag=preview")
      && call.args.includes("dry-run=true"),
    )).toBeGreaterThanOrEqual(0);
  });

  test("dispatch pins the audited release SHA via expected-sha", () => {
    const { calls, result } = runRelease("9.9.9", { headSha: "deadbeefcafe1234" });

    expect(result.status).toBe(0);
    expect(findCallIndex(calls, "gh", call =>
      call.args[0] === "workflow"
      && call.args[1] === "run"
      && call.args.includes("release.yml")
      && call.args.includes("expected-sha=deadbeefcafe1234"),
    )).toBeGreaterThanOrEqual(0);
  });

  test("aborts before dispatch when the remote branch moved during the CI wait", () => {
    const { calls, result } = runRelease("9.9.9", {
      headSha: "abc123def456",
      remoteHeadSha: "9999999999999999999999999999999999999999",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toContain("moved while waiting for CI");
    expect(findCallIndex(calls, "gh", call => call.args[0] === "workflow" && call.args[1] === "run")).toBe(-1);
  });

  /**
   * The preflight's `runQuiet` callers (`npm view`, `git ls-remote`, `gh release
   * view`) are the first commands a release runs. On Windows they are `.cmd`
   * shims, and a shell-less spawn of a bare `npm` neither consults PATHEXT nor
   * accepts a `.cmd` target — so the script died before invoking anything and
   * the four tests above failed with an empty call log on windows-latest only.
   *
   * The rest of this suite runs on the host platform, so on macOS/Linux it can
   * never exercise that path. Pin the win32 resolution directly instead of
   * waiting for CI to tell us.
   */
  test("preflight commands resolve through the Windows .cmd launcher", () => {
    const env = { PATH: "C:\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" };
    const cmdShim = (name: string) => (path: string) => path.toLowerCase() === `c:\\shims\\${name}.cmd`;

    const npm = commandInvocation("npm", ["view", "pkg@9.9.9", "version"], "win32", { env, exists: cmdShim("npm") });
    expect(npm.file).toBe("cmd.exe");
    expect(npm.options.windowsVerbatimArguments).toBe(true);
    expect(npm.args.join(" ")).toContain("npm.cmd");
    // A bare name would have survived unresolved and ENOENT'd at spawn time.
    expect(npm.args.join(" ")).not.toBe("npm");

    const gh = commandInvocation("gh", ["release", "view", "v9.9.9"], "win32", { env, exists: cmdShim("gh") });
    expect(gh.file).toBe("cmd.exe");
    expect(gh.args.join(" ")).toContain("gh.cmd");

    // A real `.exe` (git) must NOT be wrapped: direct spawn keeps arg boundaries.
    const git = commandInvocation("git", ["ls-remote", "origin"], "win32", {
      env,
      exists: (path: string) => path.toLowerCase() === "c:\\shims\\git.exe",
    });
    expect(git.file.toLowerCase()).toBe("c:\\shims\\git.exe");
    expect(git.options.windowsVerbatimArguments).toBeUndefined();
  });

  /**
   * The test above proves the LAUNCHER is correct; this one proves the release
   * script actually uses it. That distinction is not academic: `runQuiet` was
   * already routed through `commandInvocation` while every `git`/`bun`/`npm`
   * call still went through `Bun.$`, and the suite stayed green on macOS while
   * windows-latest failed. The built-in shell resolved PATH itself, walked past
   * the extension-less shim it could not execute, and reached the real `git` —
   * so the branch guard saw `dev` rather than the faked `main` and aborted
   * before logging a single call.
   *
   * A source assertion is the honest check here: the failure is "which resolver
   * ran", and no host-platform execution can observe that.
   */
  test("every external command goes through the shared launcher, not the built-in shell", () => {
    const source = readFileSync(releaseScriptPath, "utf8");
    const withoutComments = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");

    // Bun.$ resolves PATH with its own shell; that is exactly the bypass.
    expect(withoutComments).not.toMatch(/\$`/);
    expect(withoutComments).not.toMatch(/from\s+"bun"/);

    // And the launcher must still be the thing it reaches for.
    expect(withoutComments).toContain("commandInvocation");
  });

  // #1753 review follow-up: build metadata on the channel tip is valid semver
  // and compares by precedence only; an unparseable tip must fail CLOSED
  // (Number() on a garbage core used to yield NaN and pass any candidate).
  test("channel tip with build metadata compares by precedence, not NaN", () => {
    const { result } = runRelease("2.19.4", { npmLatest: "2.19.3+build.1" });
    expect(`${result.status}\n${result.stderr ?? ""}`.trim()).toBe("0");
  });

  test("channel tip equal after stripping build metadata does not move forward", () => {
    const { result } = runRelease("2.19.3", { npmLatest: "2.19.3+build.1" });
    expect(result.status).toBe(1);
    expect(result.stderr ?? "").toContain("does not move");
  });

  test("unparseable channel tip fails closed", () => {
    const { result } = runRelease("2.19.4", { npmLatest: "not-a-version" });
    expect(result.status).toBe(1);
    expect(result.stderr ?? "").toContain("cannot compare release versions");
  });
});
