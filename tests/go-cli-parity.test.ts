import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalAttestationProof } from "../src/lib/local-management-attestation";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Reusable ADR-0008 CLI differential. Add a row when Go takes ownership of a
 * TypeScript command; TS-only rows make the remaining migration surface explicit.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const secret = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";
function goToolchainAvailable(): boolean { return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success; }
function buildGoCLI(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-cli-"));
  const binary = join(dir, process.platform === "win32" ? "ocx.exe" : "ocx");
  const result = Bun.spawnSync(["go", "build", "-o", binary, "./cmd/ocx"], { cwd: join(repoRoot, "go"), env: { ...process.env, CGO_ENABLED: "0" }, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`go build ./cmd/ocx failed: ${new TextDecoder().decode(result.stderr)}`);
  return binary;
}
const goAvailable = goToolchainAvailable();
const goCLI = goAvailable ? buildGoCLI() : null;
let testHome = "";
let testServer: ReturnType<typeof Bun.serve> | undefined;
type Result = { code: number; stdout: string; stderr: string };
function runTs(args: readonly string[], home = testHome): Result {
  const result = Bun.spawnSync([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function runGo(args: readonly string[], home = testHome): Result {
  const result = Bun.spawnSync([goCLI!, ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
async function runTsAsync(args: readonly string[], home = testHome): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runGoAsync(args: readonly string[], home = testHome): Promise<Result> {
  const child = Bun.spawn([goCLI!, ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
/** Async variant that pipes `input` (or empty, when null) to the child's stdin. */
async function runTsAsyncInput(args: readonly string[], input: string | null, home = testHome): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: parityEnv(home), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== null) child.stdin.write(input);
  child.stdin.end();
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runGoAsyncInput(args: readonly string[], input: string | null, home = testHome): Promise<Result> {
  const child = Bun.spawn([goCLI!, ...args], { cwd: repoRoot, env: parityEnv(home), stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  if (input !== null) child.stdin.write(input);
  child.stdin.end();
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
/**
 * A hermetic child env. The account-auth device-flow handlers import
 * src/codex/paths.ts at module load, which resolves CODEX_HOME eagerly; the
 * harness sandbox that CODEX_HOME points to can be reaped mid-suite (and is
 * irrelevant to the stub-proxy flows under test), so drop it and let the
 * default ~/.codex fall through exactly as it does for every other row.
 */
function parityEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env, OPENCODEX_HOME: home };
  delete env.CODEX_HOME;
  return env;
}
function expectParity(args: readonly string[]): Result { const ts = runTs(args); const go = runGo(args); expect(go).toEqual(ts); return ts; }
function normalizeHealthPid(result: Result): Result {
  if (!result.stdout.startsWith("Proxy healthy") && !result.stdout.startsWith("{\"ok\":true")) return result;
  return { ...result, stdout: result.stdout.replace(/PID (?:null|\d+)/, "PID <pid>").replace(/"pid":(?:null|\d+)/, '"pid":<pid>') };
}
afterEach(async () => { testServer?.stop(true); testServer = undefined; delete process.env.OPENCODEX_HOME; if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome); testHome = ""; });
function startAttestedFixture(status: "ready" | "pending" | "failed"): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
  testServer = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") {
      const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
      const headers = new Headers();

      if (challenge) headers.set("x-opencodex-attestation-proof", createLocalAttestationProof(secret, challenge, process.pid as number, testServer!.port));
      return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
    }
    if (path === "/readyz") return Response.json({ status, service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { status: status === "ready" ? 200 : 503 });
    return new Response("not found", { status: 404 });
  }});
  writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
}
describe.skipIf(!goAvailable || goCLI === null)("Go CLI parity (ADR-0008, ticket #35)", () => {
  test.each([{ args: ["--version"] }, { args: ["-v"] }, { args: ["version"] }])("diffs version output and exit code for $args", ({ args }) => { expect(expectParity(args)).toMatchObject({ code: 0, stderr: "" }); });
  test.each([{ args: [] }, { args: ["--help"] }, { args: ["-h"] }, { args: ["help"] }, { args: ["help", "health"] }, { args: ["health", "--help"] }, { args: ["help", "ready"] }, { args: ["ready", "--help"] }])("diffs help output and exit code for $args", ({ args }) => { expectParity(args); });
  test("diffs unknown-command output and exit code", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expect(expectParity(["not-a-command"])).toMatchObject({ code: 1, stderr: "Unknown command: not-a-command\n" });
  });
  test.each([{ args: ["health"] }, { args: ["health", "--json"] }, { args: ["ready"] }, { args: ["ready", "--json"] }])("diffs unavailable command output and exit code for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expectParity(args);
  });
  test.each([{ args: ["health"] }, { args: ["health", "--json"] }, { args: ["ready"] }, { args: ["ready", "--json"] }])("diffs live ready command output and exit code for $args", async ({ args }) => {
    startAttestedFixture("ready");
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(normalizeHealthPid(go)).toEqual(normalizeHealthPid(ts));
  });
  test.each(["pending", "failed"] as const)("diffs live %s readiness JSON", status => {
    startAttestedFixture(status);
    expectParity(["ready", "--json"]);
  });
  test.each([{ args: ["ready", "--timeout", "5"] }, { args: ["ready", "--wait", "--timeout", "0"] }, { args: ["ready", "--wait", "--timeout", "301"] }, { args: ["ready", "--wat"] }])("diffs ready usage output and exit code for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    const result = expectParity(args);
    expect(result.code).toBe(64);
  });
  test.each([
    { args: ["config", "get", "defaultProvider"] },
    { args: ["config", "get", "providers.fixture.apiKey"] },
    { args: ["models", "--json"] },
    { args: ["models", "--provider", "fixture", "--json"] },
    { args: ["provider", "list", "--json"] },
    { args: ["provider", "show", "fixture", "--json"] },
  ])("diffs config, models, and provider output and exit code for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      providers: {
        fixture: {
          adapter: "openai-chat",
          baseUrl: "https://example.test/v1",
          apiKey: "secret-key",
          defaultModel: "fixture-model",
          models: ["fixture-model", "second"],
          contextWindow: 128000,
        },
      },
      defaultProvider: "fixture",
    }));
    expectParity(args);
  });
  test("diffs native config writes from argument parsing through persistence", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-go-config-parity-"));
    const configPath = join(home, "config.json");
    const exportPath = join(home, "export.json");
    const importPath = join(home, "import.json");
    const invalidImportPath = join(home, "invalid-import.json");
    const initial = {
      port: 10100,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "secret-key" } },
      defaultProvider: "fixture",
      autoSwitchThreshold: 50,
    };
    const reset = () => writeFileSync(configPath, JSON.stringify(initial));
    const parity = (args: string[]) => {
      reset();
      const ts = runTs(args, home);
      reset();
      const go = runGo(args, home);
      expect(go).toEqual(ts);
    };
    try {
      writeFileSync(importPath, JSON.stringify({ ...initial, port: 10102 }));
      writeFileSync(invalidImportPath, "{not-json");
      parity(["config", "show", "--source"]);
      parity(["config", "set", "autoSwitchThreshold", "70", "--json"]);
      parity(["config", "set", "port", "-1", "--json"]);
      parity(["config", "unset", "autoSwitchThreshold", "--json"]);
      parity(["config", "validate", "--json"]);
      parity(["config", "validate", importPath, "--json"]);
      parity(["config", "export", "-"]);
      parity(["config", "export", exportPath]);
      parity(["config", "import", importPath, "--yes", "--json"]);
      parity(["config", "import", importPath, "--json"]);
      parity(["config", "set"]);
      parity(["config", "set", "constructor", "true", "--json"]);
      parity(["config", "set", "missing.child", "true", "--json"]);
      parity(["config", "unset", "missing", "--json"]);
      parity(["config", "import"]);
      parity(["config", "import", invalidImportPath, "--yes", "--json"]);
    } finally {
      removeTreeWithRetry(home);
    }
  });
  test("keeps a rejected config mutation atomic in both CLI entry points", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-go-config-atomic-"));
    const configPath = join(home, "config.json");
    const initial = JSON.stringify({
      port: 10100,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1" } },
      defaultProvider: "fixture",
      appOwnedMemoryBudgetMb: 128,
    });
    try {
      writeFileSync(configPath, initial);
      const ts = runTs(["config", "set", "appOwnedMemoryBudgetMb", "63", "--json"], home);
      const afterTS = await Bun.file(configPath).text();
      writeFileSync(configPath, initial);
      const go = runGo(["config", "set", "appOwnedMemoryBudgetMb", "63", "--json"], home);
      const afterGo = await Bun.file(configPath).text();
      expect(go).toEqual(ts);
      expect(afterTS).toBe(initial);
      expect(afterGo).toBe(initial);
    } finally {
      removeTreeWithRetry(home);
    }
  });
  test.each([
    { args: ["service", "status"] }, { args: ["service", "not-a-command"] },
    { args: ["codex-shim", "status"] }, { args: ["codex-shim", "not-a-command"] },
    { args: ["tray", "status"] }, { args: ["tray", "not-a-command"] },
  ])("diffs TypeScript-owned lifecycle command output and exit code for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expectParity(args);
  });
  test.each([{ args: ["status"] }, { args: ["status", "--json"] }, { args: ["doctor", "--json"] }])("diffs Go-owned status and doctor output and exit code for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expectParity(args);
  });
  test.each([
    { args: ["help", "tray"] },
    { args: ["tray", "--help"] },
    { args: ["help", "service"] }, { args: ["service", "--help"] },
    { args: ["help", "codex-shim"] }, { args: ["codex-shim", "--help"] },
  ])("diffs lifecycle help contracts for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expectParity(args);
  });

  // usage is Go-owned (ADR-0008 post-flip seam batch 1); the TS CLI still runs
  // its own implementation, so the differential compares both against the same
  // mocked /api/usage payload. The fixture server answers /healthz with the
  // attested identity both runtimes' live-proxy discovery probes before they
  // trust runtime-port.json, and /api/usage with a canned payload.
  function startUsageFixture(payload: string, status = 200): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-usage-parity-"));
    testServer = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = new Headers();

        if (challenge) headers.set("x-opencodex-attestation-proof", createLocalAttestationProof(secret, challenge, process.pid as number, testServer!.port));
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      return new Response(payload, { status, headers: { "content-type": "application/json" } });
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  const usagePayload = JSON.stringify({
    range: "today",
    surface: "all",
    since: 1756000000000,
    summary: { requests: 1447, totalTokens: 178521375, inputTokens: 4489102, outputTokens: 1283441, cachedInputTokens: 172748832, estimatedCostUsd: 12.3456, unpricedRequests: 0, unmeteredRequests: 0 },
    providers: [{ provider: "xai", requests: 1447, totalTokens: 178521375, estimatedCostUsd: 12.3456 }],
    models: [{ provider: "xai", model: "grok-4.6", requests: 1447, totalTokens: 178521375, estimatedCostUsd: 12.3456 }],
    days: [{ date: "2026-08-22", requests: 1447, totalTokens: 178521375, estimatedCostUsd: 12.3456 }],
    accounts: [],
  });
  test.each([
    { args: ["usage"] },
    { args: ["usage", "--json"] },
    { args: ["usage", "--range", "7d"] },
    { args: ["usage", "--provider", "xai", "--json"] },
    { args: ["observe", "usage", "--json"] },
  ])("diffs Go-owned usage output and exit code for $args", async ({ args }) => {
    startUsageFixture(usagePayload);
    // spawnSync blocks Bun's event loop, which starves the fixture server the
    // same way the #43 drill hit; live-fixture rows drive both CLIs async.
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["usage", "--range", "nope"] },
    { args: ["usage", "--surface", "beard"] },
    { args: ["usage", "--range"] },
    { args: ["usage", "extra"] },
  ])("diffs usage argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-usage-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  test("diffs usage against a non-JSON error body and its exit code", async () => {
    startUsageFixture("nope", 500);
    const ts = await runTsAsync(["usage"]);
    const go = await runGoAsync(["usage"]);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 1 });
  });
  test("diffs usage help in both spellings", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-usage-parity-"));
    expect(expectParity(["help", "usage"])).toMatchObject({ code: 0, stderr: "" });
    expect(expectParity(["usage", "--help"])).toMatchObject({ code: 0, stderr: "" });
  });
  test("diffs usage when no proxy is running", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-usage-parity-"));
    expect(expectParity(["usage"])).toMatchObject({ code: 1 });
    expect(expectParity(["observe", "usage"])).toMatchObject({ code: 1 });
  });

  // logout is Go-owned (issue #51 slice). The TS CLI still runs its own
  // handler, so the differential runs the same argv through both CLIs on the
  // same fresh home and compares stdout/stderr/exit code plus the resulting
  // auth.json bytes (the on-disk credential store both owners rewrite).
  const authFixtureJSON = (extra: Record<string, unknown> = {}) => JSON.stringify({
    openai: {
      activeAccountId: "acct-1",
      accounts: [
        { id: "acct-1", credential: { access: "tok-1", refresh: "ref-1", expires: 1756000000000 } },
        { id: "acct-2", credential: { access: "tok-2", refresh: "ref-2", expires: 1756000000000 } },
      ],
    },
    xai: {
      activeAccountId: "one",
      accounts: [{ id: "one", credential: { access: "xa", refresh: "xr", expires: 1756000000000 } }],
    },
    ...extra,
  });
  function writeAuthFixture(home: string, extra: Record<string, unknown> = {}): void {
    writeFileSync(join(home, "auth.json"), `${authFixtureJSON(extra)}\n`);
  }
  // Both CLIs rewrite auth.json on a logout, so compare the byte state each
  // owner leaves behind from the identical fixture.
  async function logoutParity(args: readonly string[], extra: Record<string, unknown> = {}): Promise<Result> {
    const tsHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-ts-"));
    const goHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-go-"));
    try {
      writeAuthFixture(tsHome, extra);
      writeAuthFixture(goHome, extra);
      const ts = await runTsAsync(args, tsHome);
      const go = await runGoAsync(args, goHome);
      expect(go).toEqual(ts);
      const tsStore = await Bun.file(join(tsHome, "auth.json")).text();
      const goStore = await Bun.file(join(goHome, "auth.json")).text();
      expect(goStore).toBe(tsStore);
      return ts;
    } finally {
      if (existsSync(tsHome)) removeTreeWithRetry(tsHome);
      if (existsSync(goHome)) removeTreeWithRetry(goHome);
    }
  }
  test.each([
    { args: ["help", "logout"] },
    { args: ["logout", "--help"] },
  ])("diffs logout help contracts for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["logout"], reason: "missing provider" },
    { args: ["logout", "--bogus"], reason: "unknown option --bogus" },
    { args: ["logout", "openai", "xai"], reason: "too many arguments" },
    { args: ["logout", "-j"], reason: "unknown option -j" },
    { args: ["logout", "bad provider"], reason: "not a valid provider name: bad provider" },
    { args: ["logout", "constructor"], reason: "not a valid provider name: constructor" },
  ])("diffs logout argument validation for $args", async ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-parity-"));
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 2, stdout: "" });
  });
  test.each([
    { args: ["logout", "nonexistent"] },
    { args: ["logout", "nonexistent", "--json"] },
  ])("diffs logout not-found for $args", async ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-parity-"));
    const result = await logoutParity(args);
    expect(result).toMatchObject({ code: 4 });
  });
  test("diffs logout not-found on a store-less home", async () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-parity-"));
    const ts = await runTsAsync(["logout", "nonexistent"]);
    const go = await runGoAsync(["logout", "nonexistent"]);
    expect(go).toEqual(ts);
  });
  test("diffs logout of a non-active account promoting the next one", async () => {
    const result = await logoutParity(["logout", "openai"]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("Logged out of openai.\n");
  });
  test.each([
    { args: ["logout", "xai"] },
    { args: ["logout", "xai", "--json"] },
  ])("diffs logout of the last account for $args", async ({ args }) => {
    const result = await logoutParity(args);
    expect(result).toMatchObject({ code: 0 });
  });
  test("diffs logout normalizing a legacy single-credential row", async () => {
    const extra = {
      anthropic: { access: "legacy-access", refresh: "legacy-refresh", expires: 1756000000000, email: "Legacy@Example.com" },
    };
    const result = await logoutParity(["logout", "anthropic"], extra);
    expect(result).toMatchObject({ code: 0, stdout: "Logged out of anthropic.\n" });
    // The whole file is normalised on the rewrite: untouched openai/xai rows
    // survive in the same normalised shape from both owners.
  });
  // ---- ocx account (issue #51 slice) -------------------------------------
  // The account API-routing subcommands (list/current/use/refresh/auto-switch/
  // alias/priority/pause/resume/pause-exhausted/strategy/sticky/remove/
  // clear-cooldown) are Go-owned with the TS CLI still running its own handler.
  // The differential runs the same argv through both CLIs against an identical
  // fresh attested fixture proxy (reset per side so mutations start equal) and
  // compares stdout/stderr and the exit code.
  type AccountStore = {
    codexAccounts: Array<Record<string, unknown>>;
    codexActiveId: string | null;
    autoSwitch: number | null;
    strategyMode: number | null;
    stickyLimit: number | null;
    cooldownIds: string[];
    oauth: Record<string, { accounts: Array<Record<string, unknown>>; activeId: string | null; autoSwitch: number | null; strategyMode: number | null; stickyLimit: number | null }>;
    keys: Record<string, { keys: Array<Record<string, unknown>>; activeId: string | null }>;
    reports: Array<Record<string, unknown>>;
  };
  function freshAccountStore(): AccountStore {
    return {
      codexAccounts: [
        { id: "acct-a", email: "a@example.com", plan: "chatgpt-plus", priority: 2 },
        { id: "acct-b", email: "b@example.com", plan: "chatgpt-plus" },
        { id: "acct-c", alias: "main-work", email: "c@example.com", priority: -1, paused: true },
        { id: "acct-d", email: "d@example.com", quota: { shortPercent: 90, shortResetAt: 1756000000, weeklyPercent: 40, monthlyPercent: 30 }, exhausted: true },
      ],
      codexActiveId: "acct-a",
      autoSwitch: 80,
      strategyMode: null,
      stickyLimit: null,
      cooldownIds: ["acct-c"],
      oauth: {
        anthropic: {
          accounts: [{ id: "claude-1", alias: "work", email: "w@example.com" }, { id: "claude-2", email: "c2@example.com" }, { id: "claude-3" }],
          activeId: "claude-1",
          autoSwitch: null,
          strategyMode: null,
          stickyLimit: null,
        },
        xai: { accounts: [{ id: "grok-1", email: "g@example.com" }], activeId: "grok-1", autoSwitch: null, strategyMode: null, stickyLimit: null },
      },
      keys: {
        deepseek: { keys: [{ id: "key-1", masked: "sk-ds-\u2026abcd" }, { id: "key-2", label: "prod", masked: "sk-ds-\u2026wxyz" }], activeId: "key-1" },
      },
      reports: [{ provider: "anthropic", quota: { weeklyPercent: 12.5, weeklyResetAt: 1756000000, customWindows: [{ label: "5h", percent: 33.3, resetAt: 1756000000000 }] } }],
    };
  }
  function startAccountFixture(store: AccountStore): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-account-parity-"));
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      defaultProvider: "deepseek",
      providers: { deepseek: { adapter: "openai-chat", baseUrl: "https://example.test/v1", authMode: "key", apiKey: "sk-abc", defaultModel: "deepseek-chat", models: ["deepseek-chat"] } },
    }));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    testServer = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      const query = url.searchParams;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = new Headers();

        if (challenge) headers.set("x-opencodex-attestation-proof", createLocalAttestationProof(secret, challenge, process.pid as number, testServer!.port));
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      let body: Record<string, unknown> = {};
      if (request.method !== "GET" && request.method !== "DELETE") {
        try { body = await request.json(); } catch { body = {}; }
      }
      if (path === "/api/codex-auth/accounts") {
        if (request.method === "DELETE") {
          const id = query.get("id") ?? "";
          store.codexAccounts = store.codexAccounts.filter(a => a.id !== id);
          if (store.codexActiveId === id) store.codexActiveId = (store.codexAccounts[0]?.id as string | undefined) ?? null;
          return json({});
        }
        return json({ accounts: store.codexAccounts });
      }
      if (path === "/api/codex-auth/active") {
        if (request.method === "PUT") {
          if (typeof body.accountId === "string") store.codexActiveId = body.accountId;
          return json({});
        }
        return json({
          activeCodexAccountId: store.codexActiveId,
          ...(store.autoSwitch === null ? {} : { autoSwitchThreshold: store.autoSwitch }),
          ...(store.strategyMode === null ? {} : { accountPoolStrategy: store.strategyMode }),
          ...(store.stickyLimit === null ? {} : { accountPoolStickyLimit: store.stickyLimit }),
        });
      }
      if (path === "/api/codex-auth/auto-switch") {
        store.autoSwitch = typeof body.threshold === "number" ? body.threshold : null;
        return json({});
      }
      if (path === "/api/codex-auth/accounts/priority") {
        const account = store.codexAccounts.find(a => a.id === body.id);
        if (!account) return json({ error: `unknown account ${String(body.id)}` }, 404);
        account.priority = body.priority;
        return json({ priority: body.priority });
      }
      if (path === "/api/codex-auth/accounts/pause") {
        const account = store.codexAccounts.find(a => a.id === body.id);
        if (!account) return json({ error: `unknown account ${String(body.id)}` }, 404);
        account.paused = body.paused === true;
        return json({});
      }
      if (path === "/api/codex-auth/accounts/pause-exhausted") {
        const paused = store.codexAccounts.filter(a => a.exhausted === true).map(a => a.id);
        return json({ pausedAccountIds: paused, checkedAccountCount: store.codexAccounts.length, failedAccountCount: 0 });
      }
      if (path === "/api/codex-auth/accounts/clear-cooldown") {
        const id = String(body.id);
        const cleared = store.cooldownIds.includes(id);
        store.cooldownIds = store.cooldownIds.filter(c => c !== id);
        return json({ cleared });
      }
      if (path === "/api/codex-auth/pool-strategy") {
        if ("strategyMode" in body) store.strategyMode = body.strategyMode as number;
        if ("stickyLimit" in body) store.stickyLimit = body.stickyLimit as number;
        return json({ accountPoolStrategy: store.strategyMode, accountPoolStickyLimit: store.stickyLimit });
      }
      if (path === "/api/codex-auth/accounts/alias") {
        const account = store.codexAccounts.find(a => a.id === body.id);
        if (!account) return json({ error: `unknown account ${String(body.id)}` }, 404);
        if (typeof body.alias === "string" && body.alias) account.alias = body.alias; else delete account.alias;
        return json({});
      }
      if (path === "/api/oauth/providers") return json({ providers: Object.keys(store.oauth) });
      if (path === "/api/oauth/accounts") {
        const name = query.get("provider") ?? "";
        const pool = store.oauth[name];
        if (!pool) return json({ error: `unknown oauth provider "${name}"` }, 400);
        if (request.method === "DELETE") {
          const id = query.get("id") ?? "";
          pool.accounts = pool.accounts.filter(a => a.id !== id);
          if (pool.activeId === id) pool.activeId = (pool.accounts[0]?.id as string | undefined) ?? null;
          return json({});
        }
        if (request.method === "PUT") {
          if (typeof body.accountId === "string") pool.activeId = body.accountId;
          return json({});
        }
        return json({ accounts: pool.accounts, activeAccountId: pool.activeId });
      }
      if (path === "/api/oauth/accounts/active") {
        const pool = store.oauth[String(body.provider)];
        if (!pool) return json({ error: `unknown oauth provider "${String(body.provider)}"` }, 400);
        pool.activeId = String(body.accountId);
        return json({});
      }
      if (path === "/api/oauth/accounts/pool") {
        const pool = store.oauth[String(body.provider)] ?? store.oauth[query.get("provider") ?? ""];
        if (!pool) return json({ error: "unknown oauth provider" }, 400);
        if (typeof body.autoSwitchThreshold === "number") pool.autoSwitch = body.autoSwitchThreshold;
        if ("strategy" in body) pool.strategyMode = body.strategy as number;
        if ("stickyLimit" in body) pool.stickyLimit = body.stickyLimit as number;
        return json({ autoSwitchThreshold: pool.autoSwitch, strategy: pool.strategyMode ?? null, stickyLimit: pool.stickyLimit ?? null });
      }
      if (path === "/api/oauth/accounts/alias") {
        const pool = store.oauth[String(body.provider)];
        const account = pool?.accounts.find(a => a.id === body.accountId);
        if (!account) return json({ error: `unknown account ${String(body.accountId)}` }, 404);
        if (typeof body.alias === "string" && body.alias) account.alias = body.alias; else delete account.alias;
        return json({});
      }
      if (path === "/api/providers/keys") {
        const name = query.get("name") ?? "";
        const pool = store.keys[name];
        if (!pool) return json({ error: `unknown provider "${name}"` }, 404);
        if (request.method === "DELETE") {
          const id = query.get("id") ?? "";
          pool.keys = pool.keys.filter(k => k.id !== id);
          if (pool.activeId === id) pool.activeId = (pool.keys[0]?.id as string | undefined) ?? null;
          return json({});
        }
        return json({ keys: pool.keys, activeId: pool.activeId });
      }
      if (path === "/api/providers/keys/active") {
        const pool = store.keys[String(body.name)];
        if (!pool) return json({ error: `unknown provider "${String(body.name)}"` }, 404);
        pool.activeId = String(body.id);
        return json({});
      }
      if (path === "/api/providers/keys/alias") {
        const pool = store.keys[String(body.name)];
        const key = pool?.keys.find(k => k.id === body.id);
        if (!key) return json({ error: `unknown key ${String(body.id)}` }, 404);
        if (typeof body.alias === "string" && body.alias) key.label = body.alias; else delete key.label;
        return json({});
      }
      if (path === "/api/provider-quotas") return json({ reports: store.reports });
      return json({ error: `no fixture route ${request.method} ${path}` }, 404);
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  async function accountParity(args: readonly string[], mutate?: (store: AccountStore) => void): Promise<Result> {
    const boot = () => {
      const store = freshAccountStore();
      if (mutate) mutate(store);
      startAccountFixture(store);
    };
    boot();
    const ts = await runTsAsync(args);
    boot();
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    return ts;
  }
  test.each([
    { args: ["account", "list", "--json"] },
    { args: ["account", "list"] },
    { args: ["account", "list", "openai", "--json"] },
    { args: ["account", "list", "anthropic", "--json"] },
    { args: ["account", "list", "deepseek"] },
    { args: ["account", "list", "--all"] },
    { args: ["account", "list", "openai", "--quota", "--json"] },
    { args: ["account", "list", "openai", "--quota"] },
    { args: ["account", "list", "--quota", "--refresh", "--json"] },
    { args: ["account", "list", "unknown-provider"] },
  ])("diffs account list output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "current", "openai"] },
    { args: ["account", "current", "openai", "--json"] },
    { args: ["account", "current", "anthropic", "--json"] },
    { args: ["account", "current"] },
  ])("diffs account current output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "use", "openai", "acct-b"] },
    { args: ["account", "use", "openai", "main"] },
    { args: ["account", "use", "openai", "acct-b", "--json"] },
    { args: ["account", "use", "anthropic", "claude-2"] },
    { args: ["account", "use", "deepseek", "key-2", "--json"] },
    { args: ["account", "use", "openai"] },
  ])("diffs account use output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "refresh", "openai", "--json"] },
    { args: ["account", "refresh", "openai"] },
    { args: ["account", "refresh", "anthropic"] },
    { args: ["account", "refresh", "anthropic", "--json"] },
    { args: ["account", "refresh", "meta-muse"] },
  ])("diffs account refresh output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "auto-switch", "openai", "on"] },
    { args: ["account", "auto-switch", "openai", "on", "--json"] },
    { args: ["account", "auto-switch", "openai", "off"] },
    { args: ["account", "auto-switch", "openai", "threshold", "65", "--json"] },
    { args: ["account", "auto-switch", "openai", "status"] },
    { args: ["account", "auto-switch", "openai", "status", "--json"] },
    { args: ["account", "auto-switch", "anthropic", "status"] },
    { args: ["account", "auto-switch", "deepseek", "status"] },
    { args: ["account", "auto-switch", "openai", "threshold", "300"] },
    { args: ["account", "auto-switch", "openai", "on", "extra"] },
  ])("diffs account auto-switch output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "priority", "openai", "acct-a"] },
    { args: ["account", "priority", "openai", "acct-a", "--json"] },
    { args: ["account", "priority", "openai", "acct-c", "+3"] },
    { args: ["account", "priority", "openai", "acct-c", "reset", "--json"] },
    { args: ["account", "priority", "openai", "acct-a", "last"] },
    { args: ["account", "priority", "openai", "acct-a", "bogus"] },
    { args: ["account", "priority", "anthropic", "acct-a", "1"] },
  ])("diffs account priority output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "pause", "openai", "acct-b"] },
    { args: ["account", "pause", "openai", "acct-b", "--json"] },
    { args: ["account", "resume", "openai", "acct-b"] },
    { args: ["account", "pause-exhausted", "openai"] },
    { args: ["account", "pause-exhausted", "openai", "--json"] },
  ])("diffs account pause/resume output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "strategy", "openai"] },
    { args: ["account", "strategy", "openai", "--json"] },
    { args: ["account", "strategy", "openai", "balance"] },
    { args: ["account", "strategy", "openai", "fill", "--json"] },
    { args: ["account", "strategy", "anthropic"] },
    { args: ["account", "sticky", "openai"] },
    { args: ["account", "sticky", "openai", "12"] },
    { args: ["account", "sticky", "openai", "0"] },
    { args: ["account", "sticky", "anthropic", "--json"] },
  ])("diffs account strategy/sticky output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "alias", "openai", "acct-c", "work-hub"] },
    { args: ["account", "alias", "openai", "acct-c", "--json"] },
    { args: ["account", "alias", "openai", "acct-c", "-"] },
    { args: ["account", "alias", "anthropic", "claude-1", "daily"] },
    { args: ["account", "alias", "anthropic", "claude-1", "-"] },
    { args: ["account", "alias", "deepseek", "key-2", "prod2"] },
  ])("diffs account alias output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "remove", "openai", "acct-b", "--yes"] },
    { args: ["account", "remove", "openai", "acct-b", "--yes", "--json"] },
    { args: ["account", "remove", "openai", "acct-c", "--yes"] },
    { args: ["account", "remove", "openai", "acct-c", "--yes", "--json"] },
    { args: ["account", "remove", "anthropic", "claude-2", "--yes"] },
    { args: ["account", "remove", "deepseek", "key-2", "--yes"] },
    { args: ["account", "remove", "openai", "acct-b"] },
    { args: ["account", "remove", "openai", "main", "--yes"] },
    { args: ["account", "remove", "openai", "missing", "--yes"] },
  ])("diffs account remove output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });
  test.each([
    { args: ["account", "clear-cooldown", "openai", "acct-c"] },
    { args: ["account", "clear-cooldown", "openai", "acct-c", "--json"] },
    { args: ["account", "clear-cooldown", "openai", "acct-a", "--json"] },
    { args: ["account", "clear-cooldown", "anthropic", "claude-1"] },
  ])("diffs account clear-cooldown output and exit code for $args", async ({ args }) => {
    const result = await accountParity(args);
    expect(result.code).toBeLessThanOrEqual(1);
  });

  // ---- ocx account OAuth device flows (issue #51 slice) ------------------
  // account login/reauth/code/cancel/reset-credits are the headless device
  // flows against the management proxy (src/cli/account-auth.ts) and are
  // Go-owned. The success rows use `--code -` (a code piped on stdin, the
  // documented secret-safe spelling) and `--no-wait` so no 2s poll loop runs;
  // the fixture answers the login-start, code-submit, cancel and reset-credits
  // routes and an attested /healthz. Each side boots its own fixture so the
  // stdin byte stream and the response payloads are identical.
  function startAuthFixture(login404 = false): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-auth-parity-"));
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai", baseUrl: "https://api.openai.com/v1", authMode: "codex" } },
    }));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    testServer = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = new Headers();

        if (challenge) headers.set("x-opencodex-attestation-proof", createLocalAttestationProof(secret, challenge, process.pid as number, testServer!.port));
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      if (path === "/api/codex-auth/login") {
        if (login404) return json({ error: "no such codex account pool", reason: "openai is not configured" }, 404);
        return json({ url: "https://auth.openai.com/device?code=ABCD", deviceCode: "ABCD-EFGH", instructions: "Enter the code on the device page.", flowId: "flow-1" });
      }
      if (path === "/api/codex-auth/login/code") {
        if (login404) return json({ error: "no such codex login flow" }, 404);
        return json({ ok: true });
      }
      if (path === "/api/codex-auth/login/cancel") return json({ ok: true });
      if (path === "/api/codex-auth/login-status") return json({ status: "pending" });
      if (path === "/api/oauth/login") {
        if (login404) return json({ error: "unknown oauth provider \"xai\"" }, 404);
        return json({ url: "https://console.x.ai/login/callback", instructions: "Sign in at the console.", deviceCode: "XY-99", flowId: "xai-flow" });
      }
      if (path === "/api/oauth/login/code") {
        if (login404) return json({ error: "no such oauth login flow" }, 404);
        return json({ ok: true });
      }
      if (path === "/api/oauth/login/cancel") return json({ ok: true });
      if (path === "/api/oauth/status") return json({ loggedIn: false });
      if (path === "/api/codex-auth/reset-credits") return json({ ok: true, accountId: url.searchParams.get("accountId"), available: 2 });
      if (path === "/api/codex-auth/reset-credits/consume") return json({ ok: true, consumed: 1, remaining: 1 });
      return json({ error: `no fixture route ${request.method} ${path}` }, 404);
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  async function authFlowParity(args: readonly string[], input: string | null, login404 = false): Promise<Result> {
    startAuthFixture(login404);
    const ts = await runTsAsyncInput(args, input);
    startAuthFixture(login404);
    const go = await runGoAsyncInput(args, input);
    expect(go).toEqual(ts);
    return ts;
  }
  test.each([
    { args: ["account", "login", "openai", "--code", "-", "--no-wait"], input: "SECRET-CODE" },
    { args: ["account", "login", "openai", "--code", "-", "--no-wait", "--json"], input: "SECRET-CODE" },
    { args: ["account", "reauth", "openai", "--code", "-", "--no-wait"], input: "SECRET-CODE" },
    { args: ["account", "login", "xai", "--code", "-", "--no-wait"], input: "SECRET-CODE" },
    { args: ["account", "login", "xai", "--code", "-", "--no-wait", "--json"], input: "SECRET-CODE" },
    { args: ["account", "login", "openai", "--device", "--code", "-", "--no-wait", "--json"], input: "SECRET-CODE" },
    { args: ["account", "code", "xai", "--code", "-"], input: "SECRET" },
    { args: ["account", "code", "openai", "--flow", "f1", "--code", "-", "--json"], input: "SECRET" },
    { args: ["account", "cancel", "xai"], input: null },
    { args: ["account", "cancel", "openai", "--flow", "f1"], input: null },
    { args: ["account", "reset-credits", "acct-x"], input: null },
    { args: ["account", "reset-credits", "acct-x", "--json"], input: null },
    { args: ["account", "reset-credits", "main", "--consume", "--yes", "--json"], input: null },
  ])("diffs account device-flow success output and exit code for $args", async ({ args, input }) => {
    const result = await authFlowParity(args, input as string | null);
    expect(result.code).toBe(0);
  });
  test.each([
    { args: ["account", "login", "xai", "--device"], reason: "--device unsupported" },
    { args: ["account", "login"], reason: "missing provider" },
    { args: ["account", "login", "xai", "--id", "acct1"], reason: "--id without --reauth" },
    { args: ["account", "code"], reason: "missing provider" },
    { args: ["account", "code", "xai"], reason: "empty code" },
    { args: ["account", "code", "openai", "--flow", "f1"], reason: "empty code on codex flow" },
    { args: ["account", "cancel", "xai", "extra"], reason: "unexpected argument" },
    { args: ["account", "reset-credits", "main", "--consume"], reason: "consume without --yes" },
  ])("diffs account device-flow usage errors for $args", async ({ args }) => {
    const result = await authFlowParity(args, null);
    expect(result).toMatchObject({ code: 2, stdout: "" });
  });
  test.each([
    { args: ["account", "login", "openai", "--code", "-", "--no-wait", "--json"] },
    { args: ["account", "code", "openai", "--flow", "f1", "--code", "-"] },
  ])("diffs account device-flow runtime-api error handling for $args", async ({ args }) => {
    const result = await authFlowParity(args, "SECRET-CODE", true);
    expect(result).toMatchObject({ code: 4 });
  });
});
