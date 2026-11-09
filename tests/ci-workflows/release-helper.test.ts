import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { commandInvocation } from "../../src/lib/win-exec";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

setDefaultTimeout(30_000);

const source = "a".repeat(40);
const other = "b".repeat(40);
type Call = { name: string; args: string[]; tokenMatches?: boolean; tokenPresent?: boolean; repository?: string };
type Scenario = { token?: string | null; repository?: string | null; authExit?: number; authToken?: string; resolverStderr?: string; dispatchStderr?: string; dispatchExit?: number; dispatchOutput?: string; runMode?: string; watchExit?: number; watchStdout?: string };

async function invoke(args: string[], evidence = JSON.stringify({ sourceSha: source, ciRunId: 42 }), evidenceExit = 0, scenario: Scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), "ocx-release-helper-"));
  try {
    const log = join(dir, "log");
    writeFileSync(log, "");
    for (const name of ["node", "gh", "git", "npm"]) {
      const program = join(dir, `${name}.js`);
      writeFileSync(program, `import { appendFileSync } from "node:fs";
const name = ${JSON.stringify(name)};
const args = process.argv.slice(2);
const details = name === "node" ? { tokenMatches: process.env.GH_TOKEN === process.env.RELEASE_TEST_EXPECTED_TOKEN, repository: process.env.GITHUB_REPOSITORY ?? "" }
  : name === "gh" && args[0] === "workflow" ? { tokenPresent: Boolean(process.env.GH_TOKEN) } : {};
appendFileSync(process.env.RELEASE_TEST_LOG, JSON.stringify({ name, args, ...details }) + "\\n");
if (name === "node") { process.stdout.write(process.env.RELEASE_TEST_EVIDENCE); process.stderr.write(process.env.RELEASE_TEST_RESOLVER_STDERR); process.exit(Number(process.env.RELEASE_TEST_EXIT)); }
if (name === "gh" && args[0] === "auth") { process.stdout.write(process.env.RELEASE_TEST_AUTH_TOKEN); if (Number(process.env.RELEASE_TEST_AUTH_EXIT)) process.stderr.write(process.env.RELEASE_TEST_AUTH_TOKEN); process.exit(Number(process.env.RELEASE_TEST_AUTH_EXIT)); }
if (name === "gh" && args[0] === "workflow") { process.stdout.write(process.env.RELEASE_TEST_DISPATCH_OUTPUT); process.stderr.write(process.env.RELEASE_TEST_DISPATCH_STDERR); process.exit(Number(process.env.RELEASE_TEST_DISPATCH_EXIT)); }
if (name === "gh" && args[0] === "api") { process.stdout.write(args[1].includes("/actions/workflows/") ? "42\\n" : "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\\n"); process.exit(0); }
if (name === "gh" && args[0] === "run" && args[1] === "list") {
  const mode = process.env.RELEASE_TEST_RUN_MODE;
  const run = { databaseId: 123, headSha: mode === "wrong-sha" ? "short" : mode === "moved" ? "c".repeat(40) : "b".repeat(40),
    headBranch: mode === "wrong-branch" ? "preview" : "dev", event: mode === "wrong-event" ? "push" : "workflow_dispatch",
    workflowDatabaseId: mode === "wrong-workflow" ? 43 : 42,
    createdAt: mode === "old" ? "2020-01-01T00:00:00Z" : new Date().toISOString(), status: "queued",
    url: mode === "wrong-repo" ? "https://github.com/other/repository/actions/runs/123" : "https://github.com/lidge-jun/opencodex/actions/runs/123" };
  process.stdout.write(JSON.stringify(mode === "malformed" ? {} : mode === "duplicate" ? [run, run] : mode === "other-run" ? [{ ...run, databaseId: 124, url: "https://github.com/lidge-jun/opencodex/actions/runs/124", createdAt: "2020-01-01T00:00:00Z" }, run] : [run])); process.exit(0);
}
if (name === "gh" && args[0] === "run" && args[1] === "watch") { process.stdout.write(process.env.RELEASE_TEST_WATCH_STDOUT); process.stderr.write(process.env.RELEASE_TEST_DISPATCH_STDERR); process.exit(Number(process.env.RELEASE_TEST_WATCH_EXIT)); }
`);
      const launcher = join(dir, name);
      writeFileSync(launcher, `#!${process.execPath}\nimport "./${name}.js";\n`);
      chmodSync(launcher, 0o755);
      writeFileSync(join(dir, `${name}.cmd`), `@echo off\r\n"${process.execPath}" "%~dp0\\${name}.js" %*\r\n`);
    }
    const child = Bun.spawn([process.execPath, repoPath("scripts", "release.ts"), ...args], {
      cwd: repoPath(), stdout: "pipe", stderr: "pipe", stdin: "ignore",
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
        GH_TOKEN: scenario.token === null ? undefined : (scenario.token ?? "fixture-existing-token"),
        GITHUB_REPOSITORY: scenario.repository === null ? undefined : (scenario.repository ?? "lidge-jun/opencodex"),
        RELEASE_TEST_LOG: log, RELEASE_TEST_EVIDENCE: evidence, RELEASE_TEST_EXIT: String(evidenceExit),
        RELEASE_TEST_AUTH_TOKEN: scenario.authToken ?? "fixture-auth-token", RELEASE_TEST_AUTH_EXIT: String(scenario.authExit ?? 0),
        RELEASE_TEST_EXPECTED_TOKEN: scenario.token === null ? (scenario.authToken ?? "fixture-auth-token").trim() : (scenario.token ?? "fixture-existing-token"),
        RELEASE_TEST_RESOLVER_STDERR: scenario.resolverStderr ?? "", RELEASE_TEST_DISPATCH_STDERR: scenario.dispatchStderr ?? "", RELEASE_TEST_DISPATCH_EXIT: String(scenario.dispatchExit ?? 0),
        RELEASE_TEST_DISPATCH_OUTPUT: scenario.dispatchOutput ?? "https://github.com/lidge-jun/opencodex/actions/runs/123\n",
        RELEASE_TEST_RUN_MODE: scenario.runMode ?? "valid", RELEASE_TEST_WATCH_EXIT: String(scenario.watchExit ?? 0),
        RELEASE_TEST_WATCH_STDOUT: scenario.watchStdout ?? "", HOME: dir, USERPROFILE: dir },
    });
    const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    const calls = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as Call);
    return { status, output: stdout + stderr, calls };
  } finally { removeTreeWithRetry(dir); }
}

describe("dev release helper", () => {
  test("dispatches the selected green source from dev with dry-run by default", async () => {
    const result = await invoke(["latest"]);
    expect(result.status, result.output).toBe(0);
    const dispatch = result.calls.find(call => call.name === "gh" && call.args[0] === "workflow");
    expect(dispatch?.args).toEqual(["workflow", "run", "release.yml", "--repo", "github.com/lidge-jun/opencodex", "--ref", "dev", "-f", "tag=latest", "-f", `expected-sha=${source}`, "-f", "dry-run=true"]);
    const list = result.calls.find(call => call.args.slice(0, 2).join(" ") === "run list");
    expect(list?.args).not.toContain("--commit");
    expect(result.calls.at(-1)?.args).toEqual(["run", "watch", "123", "--repo", "github.com/lidge-jun/opencodex", "--exit-status", "--interval", "10"]);
  });

  test("passes an explicit source through the evidence resolver and permits explicit publication", async () => {
    const result = await invoke(["preview", other, "--publish"], JSON.stringify({ sourceSha: other, ciRunId: 9 }));
    expect(result.status, result.output).toBe(0);
    expect(result.calls[0]?.args.slice(-2)).toEqual(["resolve", other]);
    const dispatch = result.calls.find(call => call.args[0] === "workflow");
    expect(dispatch?.args).toContain(`expected-sha=${other}`);
    expect(dispatch?.args).toContain("dry-run=false");
  });

  test.each([["invalid"], ["latest", "abc"], ["latest", source, "--unexpected"], ["latest", source, other]])("rejects invalid inputs before executing external commands: %j", async (...args) => {
    const result = await invoke(args);
    expect(result.status).not.toBe(0);
    expect(result.calls).toEqual([]);
  });

  test.each([
    ["{}", 0], [JSON.stringify({ sourceSha: other, ciRunId: 1 }), 0], [JSON.stringify({ sourceSha: source, ciRunId: 0 }), 0], ["not json", 0], ["", 1],
  ])("refuses unverified or malformed evidence", async (evidence, exit) => {
    const result = await invoke(["latest", source], evidence, exit);
    expect(result.status).not.toBe(0);
    expect(result.calls.filter(call => call.name === "gh")).toEqual([]);
  });


  test("acquires gh authentication for the resolver without exporting it to dispatch", async () => {
    const result = await invoke(["latest"], undefined, 0, { token: null, repository: null, authToken: "fixture-auth-token\n" });
    expect(result.status, result.output).toBe(0);
    expect(result.calls[0]).toEqual({ name: "gh", args: ["auth", "token", "--hostname", "github.com"] });
    expect(result.calls[1]).toMatchObject({ name: "node", tokenMatches: true, repository: "lidge-jun/opencodex" });
    expect(result.calls.find(call => call.args[0] === "workflow")).toMatchObject({ name: "gh", tokenPresent: false });
    expect(result.output).not.toContain("fixture-auth-token");
    expect(JSON.stringify(result.calls)).not.toContain("fixture-auth-token");
  });

  test("preserves supplied GH_TOKEN without invoking gh auth", async () => {
    const result = await invoke(["latest"], undefined, 0, { token: "fixture-existing-token", repository: null });
    expect(result.status, result.output).toBe(0);
    expect(result.calls[0]).toMatchObject({ name: "node", tokenMatches: true, repository: "lidge-jun/opencodex" });
    expect(result.calls.some(call => call.name === "gh" && call.args[0] === "auth")).toBe(false);
    expect(result.output).not.toContain("fixture-existing-token");
  });

  test("rejects a mismatched repository and an empty supplied token before any command", async () => {
    for (const scenario of [{ repository: "other/repository" }, { token: "" }]) {
      const result = await invoke(["latest"], undefined, 0, scenario);
      expect(result.status).not.toBe(0);
      expect(result.calls).toEqual([]);
    }
  });

  test("refuses authentication failure and never prints token-shaped output", async () => {
    for (const scenario of [
      { token: null, authExit: 1, authToken: "fixture-secret-auth" },
      { token: null, authToken: "" },
      { token: null, authToken: "fixture-secret-line\nsecond" },
    ] satisfies Scenario[]) {
      const result = await invoke(["latest"], undefined, 0, scenario);
      expect(result.status).not.toBe(0);
      expect(result.output).not.toContain("fixture-secret");
      expect(result.calls.some(call => call.name === "node" || call.args[0] === "workflow")).toBe(false);
    }
  });

  test("does not expose tokens in resolver or dispatch errors", async () => {
    const secret = "fixture-secret-echo";
    const resolver = await invoke(["latest"], "", 1, { token: secret, resolverStderr: secret });
    expect(resolver.status).not.toBe(0);
    expect(resolver.output).not.toContain(secret);
    expect(resolver.calls.some(call => call.name === "gh")).toBe(false);
    const dispatch = await invoke(["latest"], undefined, 0, { token: secret, dispatchExit: 1, dispatchStderr: secret });
    expect(dispatch.status).not.toBe(0);
    expect(dispatch.output).not.toContain(secret);
  });

  test("watches the dispatched run when dev advances before dispatch", async () => {
    const result = await invoke(["latest"], undefined, 0, { runMode: "moved" });
    expect(result.status, result.output).toBe(0);
    expect(result.calls.at(-1)?.args.slice(0, 3)).toEqual(["run", "watch", "123"]);
    const listing = result.calls.find(call => call.args.slice(0, 2).join(" ") === "run list");
    expect(listing?.args).not.toContain("--commit");
    expect(result.calls.some(call => call.args.some(arg => arg.includes("/git/ref/heads/dev")))).toBe(false);
  });

  test("watches the returned ID when an unrelated earlier run is also listed", async () => {
    const result = await invoke(["latest"], undefined, 0, { runMode: "other-run" });
    expect(result.status, result.output).toBe(0);
    const listing = result.calls.find(call => call.args.slice(0, 2).join(" ") === "run list");
    expect(listing?.args).toContain("--branch");
    expect(listing?.args).toContain("dev");
    expect(listing?.args).toContain("--event");
    expect(listing?.args).toContain("workflow_dispatch");
    expect(result.calls.at(-1)?.args.slice(0, 3)).toEqual(["run", "watch", "123"]);
  });

  test("rejects missing, ambiguous, or foreign dispatch run URLs without watching", async () => {
    for (const dispatchOutput of ["", "https://github.com/other/repository/actions/runs/123", "https://github.com/lidge-jun/opencodex/actions/runs/123\nhttps://github.com/lidge-jun/opencodex/actions/runs/124"]) {
      const result = await invoke(["latest"], undefined, 0, { dispatchOutput });
      expect(result.status).not.toBe(0);
      expect(result.calls.some(call => call.args.slice(0, 2).join(" ") === "run watch")).toBe(false);
    }
  });

  test("refuses a returned run whose head, date, repository or identity is inconsistent", async () => {
    for (const runMode of ["wrong-sha", "wrong-branch", "wrong-event", "wrong-workflow", "old", "wrong-repo", "duplicate", "malformed"]) {
      const result = await invoke(["latest"], undefined, 0, { runMode });
      expect(result.status, runMode).not.toBe(0);
      expect(result.calls.some(call => call.args.slice(0, 2).join(" ") === "run watch"), runMode).toBe(false);
    }
  });

  test("propagates watch failure without printing child stderr", async () => {
    const result = await invoke(["latest"], undefined, 0, { watchExit: 1, dispatchStderr: "fixture-secret-watch" });
    expect(result.status).not.toBe(0);
    expect(result.output).not.toContain("fixture-secret-watch");
  });

  test("streams watch progress and final job states to the operator (#8330)", async () => {
    const watchStdout = "fixture-progress: build in_progress\nfixture-final: X publish failed\n";
    for (const args of [["latest"], ["watch"]]) {
      const result = await invoke(args, undefined, 0, { watchStdout });
      expect(result.status, result.output).toBe(0);
      expect(result.output).toContain("https://github.com/lidge-jun/opencodex/actions/runs/123");
      expect(result.output).toContain(watchStdout);
    }
    const failed = await invoke(["latest"], undefined, 0, { watchExit: 1, watchStdout, dispatchStderr: "fixture-secret-watch" });
    expect(failed.status).not.toBe(0);
    expect(failed.output).toContain("fixture-final: X publish failed");
    expect(failed.output).not.toContain("fixture-secret-watch");
  });

  test("watch command locates the latest dev release without dispatching", async () => {
    const result = await invoke(["watch"]);
    expect(result.status, result.output).toBe(0);
    expect(result.calls.some(call => call.args[0] === "workflow")).toBe(false);
    expect(result.calls.at(-1)?.args.slice(0, 3)).toEqual(["run", "watch", "123"]);
  });

  test("external command resolution supports Windows cmd shims", () => {
    const invocation = commandInvocation("gh", ["workflow", "run", "release.yml"], "win32", {
      env: { PATH: "C:\\shims", PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      exists: path => path.toLowerCase() === "c:\\shims\\gh.cmd",
    });
    expect(invocation.file).toBe("cmd.exe");
    expect(invocation.options.windowsVerbatimArguments).toBe(true);
  });
});

describe("release dispatch guard", () => {
  const { validateReleaseDispatch } = require("../../.github/scripts/release-dispatch-guard.cjs") as {
    validateReleaseDispatch: (input: Record<string, string>) => string | null;
  };
  const valid = { eventName: "workflow_dispatch", ref: "refs/heads/dev", sourceSha: source, workflowSha: other };
  test("accepts separate workflow and source revisions and an omitted source", () => {
    expect(validateReleaseDispatch(valid)).toBeNull();
    expect(validateReleaseDispatch({ ...valid, sourceSha: "" })).toBeNull();
  });
  test.each([
    { eventName: "push" }, { ref: "refs/heads/main" }, { ref: "refs/heads/preview" },
    { ref: "refs/tags/dev" }, { sourceSha: "abc" }, { workflowSha: "abc" },
  ])("rejects invalid dispatch inputs: %j", overrides => {
    expect(validateReleaseDispatch({ ...valid, ...overrides })).not.toBeNull();
  });
});
