import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

setDefaultTimeout(30_000);

const repoRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const releaseScriptPath = join(repoRoot, "scripts", "release.ts");

interface LoggedCall {
  args: string[];
  name: string;
}

interface ReleaseScenario {
  branch?: string;
  headSha?: string;
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
  : args[0] === "test" && args[1] === "tests" ? Number(process.env.FAKE_BUN_TEST_EXIT_CODE ?? "0")
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

  const result = spawnSync(process.execPath, [releaseScriptPath, version], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PATH: `${shimDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH ?? ""}`,
      FAKE_RELEASE_LOG: logPath,
      FAKE_GIT_BRANCH: scenario.branch ?? "main",
      FAKE_GIT_HEAD_SHA: scenario.headSha ?? "abc123def456",
      FAKE_BUN_TSC_EXIT_CODE: String(scenario.typecheckExitCode ?? 0),
      FAKE_BUN_TEST_EXIT_CODE: String(scenario.testExitCode ?? 0),
      FAKE_BUN_PRIVACY_EXIT_CODE: String(scenario.privacyExitCode ?? 0),
    },
    encoding: "utf8",
  });

  const calls = readLoggedCalls(logPath);
  rmSync(shimDir, { recursive: true, force: true });
  return { calls, result };
}

describe("release helper", () => {
  test("preflight runs typecheck, test suite, and privacy scan before version bump on main dry-runs", () => {
    const { calls, result } = runRelease("9.9.9");

    expect(result.status).toBe(0);

    const typecheckIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "x tsc --noEmit");
    const testIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "test tests");
    const privacyIndex = findCallIndex(calls, "bun", call => call.args.join(" ") === "run privacy:scan");
    const versionIndex = findCallIndex(calls, "npm", call => call.args.join(" ") === "version 9.9.9 --no-git-tag-version");
    const dispatchIndex = findCallIndex(calls, "gh", call =>
      call.args[0] === "workflow"
      && call.args[1] === "run"
      && call.args.includes("release.yml")
      && call.args.includes("tag=latest")
      && call.args.includes("dry-run=true"),
    );

    expect(typecheckIndex).toBeGreaterThanOrEqual(0);
    expect(testIndex).toBeGreaterThan(typecheckIndex);
    expect(privacyIndex).toBeGreaterThan(testIndex);
    expect(versionIndex).toBeGreaterThan(privacyIndex);
    expect(dispatchIndex).toBeGreaterThan(versionIndex);
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
});
