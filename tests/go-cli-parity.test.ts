import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
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
let testLookalike: ReturnType<typeof Bun.spawn> | undefined;
let testLookalikeDir = "";
// The healthz body pid must satisfy the TS runtime's cmdline-identity gate for
// gui pairing (verifyPidIdentity). zcode rows never verify, so they keep the
// test process pid; gui rows swap in an ocx-start lookalike process.
let fixturePid = process.pid;
type Result = { code: number; stdout: string; stderr: string };
// The main-repo bunfig preload can inject a transient CODEX_HOME (a sandboxed
// temp dir removed when a concurrent suite finishes); the TS CLI aborts at
// startup when that env var points at a missing dir while the Go CLI ignores
// it. Strip it so the differential is immune to that ambient race — neither
// side's commands under test read a codex config.
function parityEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { ...process.env, OPENCODEX_HOME: home };
  delete env.CODEX_HOME;
  return env;
}
function runTs(args: string[], home = testHome): Result {
  const result = Bun.spawnSync([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: parityEnv(home), stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function runGo(args: string[], home = testHome): Result {
  const result = Bun.spawnSync([goCLI!, ...args], { cwd: repoRoot, env: parityEnv(home), stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
async function runTsAsync(args: string[], home = testHome): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: parityEnv(home), stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runGoAsync(args: string[], home = testHome): Promise<Result> {
  const child = Bun.spawn([goCLI!, ...args], { cwd: repoRoot, env: parityEnv(home), stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runTsEnvAsync(args: string[], env: Record<string, string>): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runGoEnvAsync(args: string[], env: Record<string, string>): Promise<Result> {
  const child = Bun.spawn([goCLI!, ...args], { cwd: repoRoot, env, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
function expectParity(args: string[]): Result { const ts = runTs(args); const go = runGo(args); expect(go).toEqual(ts); return ts; }
function normalizeHealthPid(result: Result): Result {
  if (!result.stdout.startsWith("Proxy healthy") && !result.stdout.startsWith("{\"ok\":true")) return result;
  return { ...result, stdout: result.stdout.replace(/PID (?:null|\d+)/, "PID <pid>").replace(/"pid":(?:null|\d+)/, '"pid":<pid>') };
}
afterEach(async () => { testServer?.stop(true); testServer = undefined; testLookalike?.kill("SIGTERM"); testLookalike = undefined; fixturePid = process.pid; if (testLookalikeDir && existsSync(testLookalikeDir)) removeTreeWithRetry(testLookalikeDir); testLookalikeDir = ""; delete process.env.OPENCODEX_HOME; if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome); testHome = ""; });
function startAttestedFixture(status: "ready" | "pending" | "failed"): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
  testServer = Bun.serve({ port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/healthz") {
      const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
      const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, process.pid, testServer!.port) } : {};
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
        const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, process.pid, testServer!.port) } : {};
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
    expect(expectParity(["help", "usage"]));
    expect(expectParity(["usage", "--help"]));
  });
  test("diffs usage when no proxy is running", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-usage-parity-"));
    expect(expectParity(["usage"])).toMatchObject({ code: 1 });
    expect(expectParity(["observe", "usage"])).toMatchObject({ code: 1 });
  });

  // gui/zcode/mcode/mmx are Go-owned (issue #54 ops + launcher slice); each row
  // diffs the TS owner against the Go implementation for the same argv, home,
  // and fixture. Rows that would reach a live proxy drive an attested fixture
  // server; rows that would spawn an external CLI run with a PATH that resolves
  // the same (missing or shim) `mcode`/`mmx` binary for both sides.
  test.each([
    { args: ["help", "gui"] }, { args: ["gui", "--help"] },
    { args: ["help", "zcode"] }, { args: ["zcode", "--help"] },
    { args: ["help", "mcode"] }, { args: ["mcode", "--help"] },
    { args: ["help", "mmx"] }, { args: ["mmx", "--help"] },
  ])("diffs launcher/ops help contracts for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-ops-parity-"));
    expectParity(args);
  });
  test.each([
    { args: ["gui", "pair"] },
    { args: ["gui", "pair", "--origin"] },
    { args: ["gui", "pair", "--origin", "--json"] },
    { args: ["gui", "pair", "--origin", "https://x.example " ] },
    { args: ["gui", "dashboard"] },
  ])("diffs gui pairing usage rejections for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-gui-parity-"));
    const result = expectParity(args);
    expect(result.code).toBe(1);
  });
  test("diffs gui pairing gate rejection without hub config", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-gui-parity-"));
    expect(expectParity(["gui", "pair", "--origin", "https://dash.example.test"])).toMatchObject({ code: 1 });
  });
  test.each([
    { args: ["zcode", "bogus"] },
    { args: ["zcode", "--json", "bogus"] },
    { args: ["zcode", "status", "extra"] },
    { args: ["zcode", "restore"] },
    { args: ["zcode", "restore", "--op"] },
    { args: ["zcode", "disable", "--overwrite-conflict"] },
  ])("diffs zcode usage rejections for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-zcode-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  test.each([
    { args: ["mmx", "text", "chat", "--api-key", "hidden"] },
    { args: ["mmx", "text", "chat", "--base-url=https://x.test"] },
    { args: ["mmx", "image", "generate", "--prompt", "cat"] },
    { args: ["mmx", "repl"] },
  ])("diffs mmx credential and surface rejections for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mmx-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  function startLoopbackGateHome(): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-launch-parity-"));
    // A non-loopback hostname trips the launchers' loopback-only gate before any
    // proxy discovery, keeping the row hermetic on both runtimes. The config is
    // complete so the TS loader does not emit a repair notice.
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      hostname: "10.0.0.1",
      port: 10100,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k" } },
      defaultProvider: "fixture",
    }));
  }
  test.each([
    { args: ["mcode"] },
    { args: ["mcode", "--definitely-not-a-flag"] },
    { args: ["mmx", "text", "chat"] },
    { args: ["mmx", "text", "repl", "--verbose"] },
  ])("diffs launcher loopback-only gate output for $args", ({ args }) => {
    startLoopbackGateHome();
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  function startOpsFixture(): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-ops-parity-"));
    const clientRows = JSON.stringify({ clients: [
      { clientId: "zcode", state: "enabled", installed: true },
      { clientId: "mcode", state: "disabled", installed: false },
    ] });
    const journal = JSON.stringify({ operations: [
      { at: "2026-08-22T10:11:12Z", clientId: "zcode", kind: "enable", opId: "op-1" },
      { at: "2026-08-22T10:12:13Z", clientId: "zcode", kind: "disable", opId: "op-2", snapshot: "expired" },
    ] });
    testServer = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, fixturePid, testServer!.port) } : {};
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: fixturePid, port: testServer!.port, guiPairCapability: "v1" }, { headers });
      }
      if (url.pathname === "/api/gui/pairing-grants" && request.method === "POST") {
        const origin = request.headers.get("x-opencodex-gui-pair-origin");
        return Response.json({
          grant: "ocx_pair_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          browserOrigin: origin,
          serverOrigin: `http://127.0.0.1:${testServer!.port}`,
          expiresAt: 1756000000000,
        });
      }
      if (url.pathname === "/api/client-integrations/zcode" && request.method === "PUT") {
        const enabled = JSON.parse(await request.text()).enabled === true;
        return Response.json({ message: `zcode ${enabled ? "enabled" : "disabled"}.` });
      }
      if (url.pathname === "/api/client-integrations") return new Response(clientRows, { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/client-integrations/zcode") return new Response(JSON.stringify({ clientId: "zcode", state: "enabled", installed: true }), { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/client-integrations/journal") return new Response(journal, { headers: { "content-type": "application/json" } });
      if (url.pathname === "/api/client-integrations/restore" && request.method === "POST") {
        const opId = (JSON.parse(await request.text()) as { opId?: string }).opId ?? "";
        if (opId === "op-2") {
          // A real refusal body: the server states WHY under reason and WHAT TO
          // DO under hint; both CLIs compose it through responseMessage.
          return Response.json({
            error: "Backup for op-2 has expired and cannot be restored.",
            reason: "snapshot-expired",
            hint: "Re-enable the integration to create a fresh backup, then restore again.",
          }, { status: 409 });
        }
        return Response.json({ message: "Restored." });
      }
      return new Response("not found", { status: 404 });
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: fixturePid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  // Spawn a process whose cmdline passes the TS runtime's verifyPidIdentity
  // gate (word "ocx" and the token "start") so gui pairing trusts its pid.
  function spawnOcxLookalike(): void {
    const dir = mkdtempSync(join(tmpdir(), "ocx-go-lookalike-"));
    testLookalikeDir = dir;
    const shim = join(dir, "ocx");
    writeFileSync(shim, "#!/bin/sh\ntrap 'exit 0' TERM INT\nwhile :; do sleep 1; done\n", { mode: 0o755 });
    const child = Bun.spawn(["/bin/sh", shim, "start", "--port", "39999"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    testLookalike = child;
    fixturePid = child.pid;
  }
  function writeHubConfig(): void {
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      runtimeRole: "hub",
      hub: { managementPublicOrigin: "http://dash.example.test" },
      hostname: "127.0.0.1",
      port: 10100,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k" } },
      defaultProvider: "fixture",
    }));
  }
  test.each([
    { args: ["zcode"] },
    { args: ["zcode", "--json"] },
    { args: ["zcode", "status"] },
    { args: ["zcode", "enable"] },
    { args: ["zcode", "enable", "--json"] },
    { args: ["zcode", "--json", "enable"] },
    { args: ["zcode", "disable", "--json"] },
    { args: ["zcode", "history"] },
    { args: ["zcode", "journal", "--json"] },
    { args: ["zcode", "restore", "--op", "op-1", "--confirm-drift"] },
    { args: ["zcode", "restore", "--op", "op-1", "--confirm-drift", "--json"] },
    { args: ["zcode", "restore", "--op", "op-2", "--confirm-drift"] },
    { args: ["zcode", "restore", "--op", "op-2", "--confirm-drift", "--json"] },
  ])("diffs Go-owned zcode output against the fixture for $args", async ({ args }) => {
    startOpsFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    if (args.includes("op-2")) {
      expect(go).toMatchObject({
        code: 5,
        stderr: "Error: Backup for op-2 has expired and cannot be restored.\nreason: snapshot-expired\nhint: Re-enable the integration to create a fresh backup, then restore again.\n",
      });
    }
  });
  test("diffs gui pairing success output against the fixture", async () => {
    spawnOcxLookalike();
    startOpsFixture();
    writeHubConfig();
    const args = ["gui", "pair", "--origin", "http://dash.example.test"];
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "Pairing grants are secret, single-use, and expire quickly. Do not save them.\n" });
  });
  test("diffs gui pairing JSON success output against the fixture", async () => {
    spawnOcxLookalike();
    startOpsFixture();
    writeHubConfig();
    const args = ["gui", "pair", "--origin", "http://dash.example.test", "--json"];
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test("diffs gui pairing failure when no proxy is running", () => {
    startLoopbackGateHome();
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      runtimeRole: "hub",
      hub: { managementPublicOrigin: "http://dash.example.test" },
      hostname: "10.0.0.1",
      port: 10999,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k" } },
      defaultProvider: "fixture",
    }));
    expect(expectParity(["gui", "pair", "--origin", "http://dash.example.test"])).toMatchObject({ code: 1 });
  });
  test("diffs the mcode wiring lane and its ENOENT spawn against the fixture", async () => {
    startOpsFixture();
    // Loopback config so the launcher trusts the fixture (complete so the TS
    // loader emits no repair notice); mcode config.yaml lives under
    // $HOME/.minimax, so HOME is redirected to the scratch home. The file uses
    // the canonical BLOCK form that client-integration enable actually writes
    // (src/integrations/serialize.ts), so the oracle guards the real shape the
    // TS writer emits, not a flow-only artifact. The fixture server serves
    // both CLIs, so the rows run async (a blocking spawnSync would starve the
    // fixture event loop).
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      hostname: "127.0.0.1",
      port: 10100,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k" } },
      defaultProvider: "fixture",
    }));
    const mcodeHome = mkdtempSync(join(tmpdir(), "ocx-go-mcode-home-"));
    mkdirSync(join(mcodeHome, ".minimax"), { recursive: true });
    writeFileSync(join(mcodeHome, ".minimax", "config.yaml"), [
      "theme: dark",
      "custom_provider:",
      "  opencodex:",
      "    name: OpenCodex managed provider",
      "    models: {}",
      "    options:",
      `      baseURL: http://127.0.0.1:${testServer!.port}`,
      "",
    ].join("\n"));
    const emptyPath = mkdtempSync(join(tmpdir(), "ocx-go-empty-path-"));
    try {
      const env = parityEnv(testHome);
      env.HOME = mcodeHome;
      env.PATH = emptyPath;
      const tsResult = await runTsEnvAsync(["mcode"], env);
      const goResult = await runGoEnvAsync(["mcode"], env);
      expect(goResult).toEqual(tsResult);
      expect(tsResult).toMatchObject({ code: 1, stderr: `✅ MiniMax Code wired to http://127.0.0.1:${testServer!.port}; select custom_provider:opencodex/<model> in MCode.\n❌ \`mcode\` CLI not found. Install MiniMax Code first: https://github.com/MiniMax-AI/minimax-code\n` });
    } finally {
      removeTreeWithRetry(mcodeHome);
      removeTreeWithRetry(emptyPath);
    }
  });
  test("diffs the mmx wiring lane and its ENOENT spawn against the fixture", async () => {
    startOpsFixture();
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      hostname: "127.0.0.1",
      port: 10100,
      providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k" } },
      defaultProvider: "fixture",
    }));
    // An empty PATH forces the ENOENT lane on both sides (no mmx binary to
    // exec); the fixture serves both CLIs so the rows run async.
    const emptyPath = mkdtempSync(join(tmpdir(), "ocx-go-empty-path-"));
    try {
      const env = parityEnv(testHome);
      env.PATH = emptyPath;
      const tsResult = await runTsEnvAsync(["mmx", "text", "chat"], env);
      const goResult = await runGoEnvAsync(["mmx", "text", "chat"], env);
      expect(goResult).toEqual(tsResult);
      expect(tsResult).toMatchObject({ code: 1, stderr: `✅ MiniMax CLI text bridged to http://127.0.0.1:${testServer!.port}/v1/messages.\n❌ \`mmx\` CLI not found. Install it first: npm install -g mmx-cli\n` });
    } finally {
      removeTreeWithRetry(emptyPath);
    }
  });
  test("diffs mcode informational passthrough on a missing CLI", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mcode-parity-"));
    // --help is intercepted as registry help before the launcher; --version is
    // the passthrough lane. Both sides spawn the same resolved `mcode --version`
    // binary from the same inherited PATH.
    const tsResult = runTs(["mcode", "--version"], testHome);
    const goResult = runGo(["mcode", "--version"], testHome);
    expect(goResult).toEqual(tsResult);
  });
  test("diffs mmx informational passthrough on a missing CLI", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mmx-parity-"));
    const tsResult = runTs(["mmx", "-v"], testHome);
    const goResult = runGo(["mmx", "-v"], testHome);
    expect(goResult).toEqual(tsResult);
  });
});
