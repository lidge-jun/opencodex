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
  if (result.exitCode !== 0) throw new Error("go build ./cmd/ocx failed: " + new TextDecoder().decode(result.stderr));
  return binary;
}
const goAvailable = goToolchainAvailable();
const goCLI = goAvailable ? buildGoCLI() : null;
let testHome = "";
let testServer: ReturnType<typeof Bun.serve> | undefined;
type Result = { code: number; stdout: string; stderr: string };
function runTs(args: string[], home = testHome): Result {
  const result = Bun.spawnSync([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function runGo(args: string[], home = testHome): Result {
  const result = Bun.spawnSync([goCLI!, ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
async function runTsAsync(args: string[], home = testHome): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runGoAsync(args: string[], home = testHome): Promise<Result> {
  const child = Bun.spawn([goCLI!, ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
function expectParity(args: string[]): Result { const ts = runTs(args); const go = runGo(args); expect(go).toEqual(ts); return ts; }
function normalizeHealthPid(result: Result): Result {
  if (!result.stdout.startsWith("Proxy healthy") && !result.stdout.startsWith("{\"ok\":true")) return result;
  return { ...result, stdout: result.stdout.replace(/PID (?:null|\d+)/, "PID <pid>").replace(/\"pid\":(?:null|\d+)/, '"pid":<pid>') };
}
afterEach(async () => { testServer?.stop(true); testServer = undefined; delete process.env.OPENCODEX_HOME; if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome); testHome = ""; });
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

  // capabilities is Go-owned static data (ADR-0008 issue #46): the whole
  // surface — human rows, --json envelope, --mutating-only, --route inverse
  // lookup and its empty/missing-value exit — needs no live proxy.
  test.each([
    { args: ["capabilities"] },
    { args: ["capabilities", "--json"] },
    { args: ["capabilities", "--mutating-only"] },
    { args: ["capabilities", "--mutating-only", "--json"] },
    { args: ["capabilities", "--route", "/api/status"] },
    { args: ["capabilities", "--route", "/api/nope"] },
    { args: ["capabilities", "--route", "/api/nope", "--json"] },
    { args: ["capabilities", "--route"] },
    { args: ["help", "capabilities"] },
    { args: ["capabilities", "--help"] },
  ])("diffs Go-owned capabilities output and exit code for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expectParity(args);
  });

  // observe dispatches natively per subcommand (ADR-0008 issue #46); the
  // rebuild-index / index-status actions read the Bun:sqlite index directly, so
  // they keep the TypeScript owner at the action level and delegate.
  test.each([
    { args: ["observe", "logs", "rebuild-index"] },
    { args: ["observe", "logs", "index-status"] },
  ])("diffs TypeScript-owned observe indexer delegation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expectParity(args);
  });
  test.each([
    { args: ["observe", "wat"] },
    { args: ["observe", "logs", "--limit", "0"] },
    { args: ["observe", "logs", "--json", "--jsonl"] },
    { args: ["observe", "logs", "--follow", "--json"] },
    { args: ["observe", "storage", "codex-logs", "protect", "--mode", "wat"] },
  ])("diffs observe usage validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  test("diffs observe and export help in both spellings", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    for (const args of [
      ["help", "observe"], ["observe", "--help"], ["observe", "logs", "--help"],
      ["help", "export"], ["export", "--help"], ["export", "--client", "pi", "--help"],
    ]) {
      expectParity(args);
    }
  });

  // observe + export against one management fixture: logs (all renderers and
  // filters), explain, memory/debug/claude-inbound/injection summaries, storage
  // codex-logs actions, and export's twelve client documents. Both CLIs run
  // async because spawnSync starves the fixture server (the #43 lesson).
  function startExportFixture(): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-export-parity-"));
    testServer = Bun.serve({ port: 0, fetch(request) {
      const u = new URL(request.url);
      if (u.pathname === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, process.pid, testServer!.port) } : {};
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      if (u.pathname === "/api/models") {
        return Response.json([
          { namespaced: "openai/gpt-5.1-codex", provider: "openai", id: "gpt-5.1-codex", native: true, displayName: "GPT-5.1 Codex", displayNameSource: "provider", contextWindow: 400000, reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" },
          { namespaced: "anthropic/claude-sonnet-4-5", provider: "anthropic", id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", displayNameSource: "provider", contextWindow: 200000, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"] },
          { namespaced: "fixture/audio-model", provider: "fixture", id: "audio-model", displayName: "Audio Only", displayNameSource: "fallback", contextWindow: 0, inputModalities: ["audio"], reasoningEfforts: ["none"] },
          { namespaced: "fixture/plain", provider: "fixture", id: "plain", displayName: "Plain", displayNameSource: "provider" },
        ]);
      }
      if (u.pathname === "/api/logs") {
        const all = [
          { id: "req-1", timestamp: "2026-09-07T10:00:00.000Z", provider: "anthropic", model: "claude-sonnet-4-5", status: 200, durationMs: 1234.5, conversationId: "convA" },
          { id: "req-2", timestamp: "2026-09-07T10:00:01.000Z", provider: "openai", model: null, status: 429, conversationId: "" },
          { id: 3, timestamp: null, createdAt: "2026-09-07T09:00:00.000Z", statusCode: 500, durationMs: 2 },
          { timestamp: "2026-09-07T08:00:00.000Z", status: 200 },
        ];
        const provider = u.searchParams.get("provider");
        const status = u.searchParams.get("status");
        const filtered = all.filter(row => (!provider || row.provider === provider) && (!status || String(row.status) === status || String(row.statusCode) === status));
        return Response.json({ timeZone: "UTC", total: filtered.length, logs: filtered });
      }
      if (u.pathname === "/api/request-history/req-1/route-decision") {
        return Response.json({ requestId: "req-1", route: { provider: "anthropic", model: "claude-sonnet-4-5", reason: "match" }, usedFallback: false });
      }
      if (u.pathname === "/api/system/memory") return Response.json({ heap: 123456789, heapPeak: 200000000, gc: { count: 42, durationMs: 3.5 }, items: 7 });
      if (u.pathname === "/api/debug") return Response.json({ debug: true, usage: false, injection: null, claude: { enabled: false }, reset: false });
      if (u.pathname === "/api/claude/inbound-debug") return Response.json({ enabled: true, entries: [{ ts: 1756000000000, method: "POST", path: "/api/claude/inbound" }] });
      if (u.pathname === "/api/debug/injection-logs") return Response.json({ after: 0, entries: [{ ts: 1756000000000, kind: "prompt", bytes: 128 }, { ts: 1756000000001, kind: "response", bytes: null }] });
      if (u.pathname === "/api/storage") return Response.json({ codexLogs: { present: true, files: 12, sizeBytes: 4096 }, sessions: { archived: 3 } });
      if (u.pathname === "/api/storage/codex-logs") return Response.json({ mode: "compat", protected: true, files: 12 });
      if (u.pathname === "/api/storage/codex-logs/protect") return Response.json({ mode: "quiet", protected: true });
      if (u.pathname === "/api/storage/codex-logs/repair" || u.pathname === "/api/storage/codex-logs/compact" || u.pathname === "/api/storage/codex-logs/unprotect") {
        return Response.json({ ok: true });
      }
      return new Response("not found", { status: 404 });
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
    writeFileSync(join(testHome, "config.json"), JSON.stringify({
      port: testServer.port,
      hostname: "127.0.0.1",
      defaultProvider: "fixture",
      providers: {
        openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex" },
        anthropic: { adapter: "anthropic", baseUrl: "https://api.anthropic.com" },
        fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "k", defaultModel: "plain" },
      },
    }));
  }
  test.each([
    { args: ["observe", "logs"] }, { args: ["observe", "logs", "--json"] }, { args: ["observe", "logs", "--jsonl"] },
    { args: ["observe", "logs", "--provider", "anthropic"] }, { args: ["observe", "logs", "--status", "200"] },
    { args: ["observe", "logs", "--status", "429", "--conversation", "x"] }, { args: ["observe", "logs", "--limit", "2"] },
    { args: ["observe", "logs", "explain", "req-1"] }, { args: ["observe", "logs", "explain", "req-1", "--json"] },
    { args: ["observe", "memory"] }, { args: ["observe", "memory", "--json"] }, { args: ["observe", "debug"] }, { args: ["observe", "debug", "--json"] },
    { args: ["observe", "claude-inbound"] }, { args: ["observe", "injection"] }, { args: ["observe", "injection", "--limit", "1"] },
    { args: ["observe", "storage"] }, { args: ["observe", "storage", "--json"] }, { args: ["observe", "storage", "codex-logs"] },
    { args: ["observe", "storage", "codex-logs", "status", "--json"] }, { args: ["observe", "storage", "codex-logs", "protect"] },
    { args: ["observe", "storage", "codex-logs", "protect", "--mode", "quiet", "--json"] }, { args: ["observe", "storage", "codex-logs", "repair"] },
    { args: ["observe", "storage", "codex-logs", "compact", "--json"] }, { args: ["observe", "storage", "codex-logs", "unprotect", "--json"] },
  ])("diffs Go-owned observe output and exit code for $args", async ({ args }) => {
    startExportFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  const exportClientIds = ["opencode", "pi", "omp", "hermes", "openclaw", "kimi", "gajae", "dsh", "mcode", "zcode", "prime"];
  test.each(exportClientIds.flatMap(id => [
    { args: ["export", "--client", id, "--json"] },
    { args: ["export", "--client", id] },
  ]))("diffs Go-owned export output and exit code for $args", async ({ args }) => {
    startExportFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test("diffs export --json --out and the refusal to clobber", async () => {
    startExportFixture();
    const outPath = join(testHome, "written.json");
    const ts = await runTsAsync(["export", "--client", "pi", "--json", "--out", outPath]);
    expect(ts).toMatchObject({ code: 0 });
    // Give Go the same clean slate the TypeScript run just had.
    if (existsSync(outPath)) removeTreeWithRetry(outPath);
    const go = await runGoAsync(["export", "--client", "pi", "--json", "--out", outPath]);
    expect(go).toEqual(ts);
    const tsRefusal = await runTsAsync(["export", "--client", "pi", "--out", outPath]);
    const goRefusal = await runGoAsync(["export", "--client", "pi", "--out", outPath]);
    expect(goRefusal).toEqual(tsRefusal);
    expect(tsRefusal).toMatchObject({ code: 2 });
  });
  test("diffs export when no proxy is running", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-export-parity-"));
    expect(expectParity(["export", "--client", "pi"])).toMatchObject({ code: 1 });
  });
  test("diffs aside export under a fixture home with an account manifest", async () => {
    startExportFixture();
    const asideHome = mkdtempSync(join(tmpdir(), "ocx-aside-home-"));
    mkdirSync(join(asideHome, ".aside", "u", "0"), { recursive: true });
    writeFileSync(join(asideHome, ".aside", "accounts.json"), JSON.stringify({ currentAccountId: 0 }));
    const previousHome = process.env.HOME;
    process.env.HOME = asideHome;
    try {
      const ts = await runTsAsync(["export", "--client", "aside", "--json"]);
      const go = await runGoAsync(["export", "--client", "aside", "--json"]);
      expect(go).toEqual(ts);
      expect(ts).toMatchObject({ code: 0, stderr: "" });
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      removeTreeWithRetry(asideHome);
    }
  });
  test.each([
    { args: ["export", "--client"] },
    { args: ["export", "--client", "nope"] },
    { args: ["export", "extra"] },
    { args: ["export", "--client", "pi", "--json", "--force", "extra"] },
  ])("diffs export argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });

});
