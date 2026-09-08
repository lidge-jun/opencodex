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
// Sibling worktrees sweep /tmp/ocx-go-cli-* between a queued run's build and
// its first spawn, so the binary is rebuilt lazily whenever it is missing.
let goCLI = goAvailable ? buildGoCLI() : null;
function ensureGoBinary(): string {
  if (goCLI === null || !existsSync(goCLI)) {
    if (goCLI !== null) removeTreeWithRetry(dirname(goCLI));
    goCLI = buildGoCLI();
  }
  return goCLI;
}
let testHome = "";
let testServer: ReturnType<typeof Bun.serve> | undefined;
type Result = { code: number; stdout: string; stderr: string };
// bun:test's test.each supplies readonly tuple rows; accept them so an argv
// row can be handed straight to a runner without a cast.
type Argv = readonly string[];
function runTs(args: Argv, home = testHome): Result {
  const result = Bun.spawnSync([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function runGo(args: Argv, home = testHome): Result {
  const result = Bun.spawnSync([ensureGoBinary(), ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
async function runTsAsync(args: Argv, home = testHome): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
async function runGoAsync(args: Argv, home = testHome): Promise<Result> {
  const child = Bun.spawn([ensureGoBinary(), ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home }, stdout: "pipe", stderr: "pipe" });
  return { code: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() };
}
function attestedHeaders(challenge: string, port: number): Record<string, string> {
  const proof = createLocalAttestationProof(secret, challenge, process.pid, port);
  return proof === null ? {} : { "x-opencodex-attestation-proof": proof };
}
function expectParity(args: Argv): Result { const ts = runTs(args); const go = runGo(args); expect(go).toEqual(ts); return ts; }

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
      const headers = attestedHeaders(challenge, testServer!.port!);
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
        const headers = attestedHeaders(challenge, testServer!.port!);
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
    const helpTs = expectParity(["help", "usage"]);
    expect(helpTs).toMatchObject({ code: 0, stderr: "" });
    const flagTs = expectParity(["usage", "--help"]);
    expect(flagTs).toMatchObject({ code: 0, stderr: "" });
  });
  test("diffs usage when no proxy is running", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-usage-parity-"));
    expect(expectParity(["usage"])).toMatchObject({ code: 1 });
    expect(expectParity(["observe", "usage"])).toMatchObject({ code: 1 });
  });

  // logs/memory/inspect are Go-owned (issue #45 batch): the TS CLI still runs its own
  // implementations, so the differential compares both against the same mocked
  // management routes. The fixture server answers /healthz with the attested
  // identity both runtimes probe before trusting runtime-port.json, and each
  // /api/… path with the canned payload below (or the raw body/status given).
  type RouteFixture = { status?: number; body?: unknown; raw?: string };
  function startReadsFixture(routes: Record<string, RouteFixture>): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
    testServer = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const proof = challenge ? createLocalAttestationProof(secret, challenge, process.pid, testServer!.port as number) : null;
        const headers: Record<string, string> = proof ? { "x-opencodex-attestation-proof": proof } : {};
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      const route = routes[path];
      if (!route) return new Response("not found", { status: 404 });
      if (route.raw !== undefined) return new Response(route.raw, { status: route.status ?? 200 });
      return Response.json(route.body, { status: route.status ?? 200 });
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  const readRoutes = (): Record<string, { body: unknown }> => ({
    "/api/logs": { body: { timeZone: "Asia/Shanghai", total: 2, logs: [
      { requestId: "ocx-1111111111", timestamp: 1788818801331, provider: "fixture", model: "fixture-model", status: 502, durationMs: 344, conversationId: "conv-abc-123" },
      { createdAt: "2026-08-22T10:00:00Z", provider: "xai", model: "grok-4.6", statusCode: 200 },
    ] } },
    "/api/system/memory": { body: { pid: 4242, bunVersion: "1.3.14", platform: "linux", uptimeSeconds: 123.456, rss: 104857600, heapUsed: 33554432, observedMetric: "rss", jscHeap: { heapSize: 33554432, objectCount: 1024 }, responseState: { count: 0 }, appOwnedBytes: { budgetBytes: 268435456, stores: { a: { b: 1 } }, observedInFlight: [1, 2, 3] }, streamMode: "auto", eagerRelay: null, watchdog: { warnThresholdBytes: 4294967296, samples: [1, 2] }, isDraining: false, freeHeapRatioHistory: [0.5, null, 0.4] } },
    "/api/request-history/req-1/route-decision": { body: { requestId: "req-1", routeDecision: { version: 1, decisionId: "d1", candidates: [{ provider: "fixture", eligible: true }] }, attemptSequence: [] } },
    "/api/config": { body: { port: 10100, defaultProvider: "fixture", codexAutoStart: true, providers: { fixture: { adapter: "openai-chat", hasApiKey: true } }, tiers: null } },
    "/api/catalog": { body: { models: [{ slug: "fixture-model", display_name: "Fixture", visibility: "list", service_tiers: [{ id: "priority", name: "Fast" }] }], source: "catalog" } },
    "/api/routing-analytics": { body: { generatedAt: 1788818834015, totalRequests: 1, confidence: "low", successRate: 0, failureRate: 1, durationMs: { p50: 344, sampleCount: 1 }, breakdown: [{ provider: "fixture", count: 1 }], profileBreakdown: [], priceCoverage: null, estimatedCostUsdPerSuccessfulRequest: null } },
    "/api/provider-request-pacing": { body: { fixture: { provider: "fixture", enabled: false, queued: 0, nextSlotInMs: 0 } } },
    "/api/key-providers": { body: { providers: [
      { id: "anthropic-apikey", label: "Anthropic (API key)", models: ["claude-sonnet-5", "claude-opus-5"], liveModels: true },
      { id: "openai-apikey", label: "OpenAI API", models: [] },
    ] } },
    "/api/codex-prompt": { body: { configPath: "/home/u/.codex/config.toml", configExists: true, readable: true, drift: null, inventory: [{ id: "base-instructions", class: "base", order: 0 }], layers: { base: "text" } } },
    "/api/codex-prompt/text": { body: "You are Codex, the world's most advanced coding agent.\n" },
    "/api/client-config": { body: { clientId: "codex", baseUrl: "http://127.0.0.1:10100", env: { OPENAI_BASE_URL: "http://127.0.0.1:10100/v1" } } },
    "/api/github/star": { body: { state: "not-starred", repo: "waxiangzi/opencodex", url: "https://github.com/waxiangzi/opencodex" } },
    "/api/windows-tray": { body: { supported: false, installed: false, running: false, stale: false, summary: "unsupported on linux" } },
  });
  test.each([
    { args: ["help", "logs"] }, { args: ["logs", "--help"] },
    { args: ["help", "memory"] }, { args: ["memory", "--help"] },
    { args: ["help", "inspect"] }, { args: ["inspect", "--help"] },
  ])('diffs logs/memory/inspect help contracts for $args', ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["logs"] }, { args: ["logs", "--json"] }, { args: ["logs", "--jsonl"] },
    { args: ["logs", "--provider", "fixture"] }, { args: ["logs", "--status", "502"] }, { args: ["logs", "--limit", "1"] },
    { args: ["logs", "explain", "req-1"] }, { args: ["logs", "explain", "req-1", "--json"] },
    { args: ["memory"] }, { args: ["memory", "--json"] }, { args: ["memory", "--limit", "3"] },
    { args: ["inspect"] }, { args: ["inspect", "config"] }, { args: ["inspect", "config", "--json"] },
    { args: ["inspect", "catalog"] }, { args: ["inspect", "routing-analytics"] },
    { args: ["inspect", "pacing"] }, { args: ["inspect", "pacing", "--name", "fixture"] },
    { args: ["inspect", "key-providers"] }, { args: ["inspect", "codex-prompt"] }, { args: ["inspect", "codex-prompt", "--text"] },
    { args: ["inspect", "client-config", "--client", "codex"] }, { args: ["inspect", "client-config", "--client", "codex", "--json"] },
    { args: ["inspect", "star"] }, { args: ["inspect", "star", "--json"] }, { args: ["inspect", "windows-tray"] },
  ])("diffs Go-owned logs/memory/inspect reads against the management fixture for $args", async ({ args }) => {
    startReadsFixture(readRoutes());
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["logs", "extra"] }, { args: ["logs", "--json", "--jsonl"] }, { args: ["logs", "--follow", "--json"] },
    { args: ["logs", "--provider"] }, { args: ["logs", "--limit", "0"] }, { args: ["logs", "--limit", "abc"] },
    { args: ["logs", "explain"] }, { args: ["memory", "extra"] }, { args: ["memory", "--limit", "x"] },
    { args: ["inspect", "nope"] }, { args: ["inspect", "client-config"] }, { args: ["inspect", "client-config", "--client"] },
    { args: ["inspect", "codex-prompt", "--text", "--json"] }, { args: ["inspect", "codex-prompt", "extra"] },
    { args: ["inspect", "pacing", "--name"] }, { args: ["inspect", "--bogus"] },
    // rejectArgs must redact secret-option values before reporting leftovers
    // (runtime-api.ts SECRET_OPTIONS); a regression here would echo the
    // credential to stderr.
    { args: ["logs", "--token", "supersecret"] }, { args: ["memory", "--admin-token", "supersecret"] },
  ])("diffs logs/memory/inspect argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  test.each([
    { args: ["logs"] }, { args: ["memory"] }, { args: ["inspect"] }, { args: ["logs", "explain", "req-missing"] },
  ])("diffs logs/memory/inspect when no proxy is running for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 1 });
  });
  test.each([
    { args: ["logs"], routes: { "/api/logs": { status: 500, raw: "boom" } }, code: 1 },
    { args: ["memory"], routes: { "/api/system/memory": { status: 404, body: { error: "missing state" } } }, code: 4 },
    { args: ["inspect", "config"], routes: { "/api/config": { status: 401, body: { error: "bad key", hint: "run ocx auth login" } } }, code: 1 },
    { args: ["inspect", "codex-prompt", "--text"], routes: { "/api/codex-prompt/text": { status: 503, raw: "gateway down" } }, code: 1 },
    { args: ["inspect", "star"], routes: { "/api/github/star": { status: 418, body: { detail: "teapot", message: "I'm a teapot" } } }, code: 1 },
    { args: ["inspect", "catalog"], routes: { "/api/catalog": { status: 409, body: { error: "catalog busy", hint: "retry after sync" } } }, code: 5 },
    // A 2xx empty body parses to JS null (only non-empty text is parsed), so
    // --json re-emits JSON.stringify(null) = "null" in both CLIs.
    { args: ["memory", "--json"], routes: { "/api/system/memory": { status: 200, raw: "" } }, code: 0 },
  ] as Array<{ args: readonly string[]; routes: Record<string, RouteFixture>; code: number }>)("diffs logs/memory/inspect management error output and exit code for $args", async ({ args, routes, code }) => {
    startReadsFixture(routes);
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code });
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
        const headers = attestedHeaders(challenge, testServer!.port!);
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      if (u.pathname === "/api/models") {
        return Response.json([
          { namespaced: "openai/gpt-5.1-codex", provider: "openai", id: "gpt-5.1-codex", native: true, displayName: "GPT-5.1 Codex", displayNameSource: "provider", contextWindow: 400000, reasoningEfforts: ["minimal", "low", "medium", "high", "xhigh", "max", "ultra"], defaultReasoningEffort: "medium" },
          { namespaced: "anthropic/claude-sonnet-4-5", provider: "anthropic", id: "claude-sonnet-4-5", displayName: "Claude Sonnet 4.5", displayNameSource: "provider", contextWindow: 200000, inputModalities: ["text", "image"], reasoningEfforts: ["low", "medium", "high"] },
          { namespaced: "fixture/audio-model", provider: "fixture", id: "audio-model", displayName: "Audio Only", displayNameSource: "fallback", contextWindow: 0, inputModalities: ["audio"], reasoningEfforts: ["none"] },
          { namespaced: "fixture/plain", provider: "fixture", id: "plain", displayName: "Plain", displayNameSource: "provider" },
          { namespaced: "fixture/o-brien", provider: "fixture", id: "o-brien", displayName: "O'Brien \"Wired\" Model", displayNameSource: "provider", contextWindow: 64000 },
          { namespaced: "fixture/ctrl", provider: "fixture", id: "ctrl", displayName: "Ctrl\u0001\u0007\u001bModel", displayNameSource: "provider" },
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
        const model = u.searchParams.get("model");
        const status = u.searchParams.get("status");
        const conversationId = u.searchParams.get("conversationId");
        const filtered = all.filter(row => (!provider || row.provider === provider) && (!model || row.model === model) && (!status || String(row.status) === status || String(row.statusCode) === status) && (!conversationId || row.conversationId === conversationId));
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
    { args: ["observe"] }, { args: ["observe", "logs"] }, { args: ["observe", "logs", "--json"] }, { args: ["observe", "logs", "--jsonl"] },
    { args: ["observe", "logs", "--provider", "anthropic"] }, { args: ["observe", "logs", "--model", "claude-sonnet-4-5"] },
    { args: ["observe", "logs", "--status", "200"] }, { args: ["observe", "logs", "--conversation", "convA"] },
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
  test("diffs export --force overwriting an existing --out file", async () => {
    startExportFixture();
    const outPath = join(testHome, "forced.json");
    writeFileSync(outPath, "stale bytes that --force must replace\n");
    const ts = await runTsAsync(["export", "--client", "pi", "--json", "--out", outPath, "--force"]);
    expect(ts).toMatchObject({ code: 0 });
    writeFileSync(outPath, "stale bytes that --force must replace\n");
    const go = await runGoAsync(["export", "--client", "pi", "--json", "--out", outPath, "--force"]);
    expect(go).toEqual(ts);
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
      const tsHuman = await runTsAsync(["export", "--client", "aside"]);
      const goHuman = await runGoAsync(["export", "--client", "aside"]);
      expect(goHuman).toEqual(tsHuman);
      expect(tsHuman).toMatchObject({ code: 0, stderr: "" });
      // --out is exercised from the same writable HOME; Go gets the clean slate
      // the TypeScript run consumed, like the pi clobber test.
      const outPath = join(asideHome, "aside-export.json");
      const tsOut = await runTsAsync(["export", "--client", "aside", "--json", "--out", outPath]);
      expect(tsOut).toMatchObject({ code: 0 });
      if (existsSync(outPath)) removeTreeWithRetry(outPath);
      const goOut = await runGoAsync(["export", "--client", "aside", "--json", "--out", outPath]);
      expect(goOut).toEqual(tsOut);
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
