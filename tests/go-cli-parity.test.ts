import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalAttestationProof } from "../src/lib/local-management-attestation";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { Database } from "bun:sqlite";

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
// attestedFixtureHeaders answers the findLiveProxy attestation challenge the
// way the management plane does (proof echoed back when a challenge is sent).
function attestedFixtureHeaders(challenge: string, port: number): HeadersInit {
  if (!challenge) return {};
  const proof = createLocalAttestationProof(secret, challenge, process.pid, port);
  return { "x-opencodex-attestation-proof": proof ?? "" };
}
function expectParity(args: Argv): Result { const ts = runTs(args); const go = runGo(args); expect(go).toEqual(ts); return ts; }

function normalizeHealthPid(result: Result): Result {
  if (!result.stdout.startsWith("Proxy healthy") && !result.stdout.startsWith("{\"ok\":true")) return result;
  return { ...result, stdout: result.stdout.replace(/PID (?:null|\d+)/, "PID <pid>").replace(/"pid":(?:null|\d+)/, '"pid":<pid>') };
}
afterEach(async () => { testServer?.stop(true); testServer = undefined; delete process.env.OPENCODEX_HOME; delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome); testHome = ""; });
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

  // management families). The fixture models the management plane: attested
  // /healthz, then stateless canned responses derived only from the request
  // (so the TS and Go runs never perturb each other). deny=true makes every
  // /api and /v1 request 401 like a missing admin token.
  function startMgmtFixture(deny: boolean): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-parity-"));
    testServer = Bun.serve({ port: 0, async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = attestedFixtureHeaders(challenge, testServer!.port ?? 0);
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      const management = path.startsWith("/api/") || path.startsWith("/v1/");
      if (management && (deny || request.headers.get("x-opencodex-api-key") !== process.env.OPENCODEX_ADMIN_AUTH_TOKEN)) {
        return Response.json({ error: "opencodex admin token required", reason: "no matching credential", hint: "Set OPENCODEX_ADMIN_AUTH_TOKEN to the token written to OPENCODEX_HOME/admin-api-token" }, { status: 401 });
      }
      const text = await request.text();
      let entry: any = null;
      if (text) { try { entry = JSON.parse(text); } catch { entry = null; } }
      const env = { debug: true, usage: false, injection: false, claude: false };
      const debugView = () => {
        const override: Record<string, boolean> = {};
        const out = { enabled: false, usage: false, injection: false, claude: false };
        if (entry && typeof entry === "object") {
          if (entry.reset === undefined) {
            for (const key of ["debug", "usage", "injection", "claude"] as const) {
              if (typeof entry[key] === "boolean") { override[key] = entry[key]; if (key === "debug") out.enabled = entry[key]; else (out as any)[key] = entry[key]; }
            }
          }
        }
        return { ...out, runtimeOverride: override, env };
      };
      if (path === "/api/debug" && request.method === "GET") return Response.json(debugView());
      if (path === "/api/debug" && request.method === "PUT") return Response.json(debugView());
      if (path === "/api/debug/logs") return Response.json([{ seq: 5, line: "provider debug line one" }, { seq: 6, line: "provider debug line two" }]);
      if (path === "/api/debug/usage-logs") return Response.json([]);
      if (path === "/api/keys" && request.method === "GET") return Response.json({
        keys: [
          { id: "key-1", name: "default", prefix: "ocx_data_ab12", createdAt: "2026-08-01T00:00:00.000Z", usage: { requests7d: 1447, totalRequests: 9033 } },
          { id: "key-2", name: "deploy", prefix: "ocx_data_cd34", createdAt: "2026-08-02T00:00:00.000Z", usage: { ambiguous: true } },
          { id: "key-3", name: "unused", prefix: "ocx_data_ef56", createdAt: "2026-08-03T00:00:00.000Z", usage: { requests7d: 0, totalRequests: 0, lastUsedAt: "2026-09-01T10:00:00.000Z" } },
        ],
        attributionSince: "2026-08-01T00:00:00.000Z",
        authMatrix: { admin: ["GET", "POST"] },
        baseUrl: `http://127.0.0.1:${testServer!.port}/v1`,
        responsesEndpoint: `http://127.0.0.1:${testServer!.port}/v1/responses`,
        chatCompletionsEndpoint: `http://127.0.0.1:${testServer!.port}/v1/chat/completions`,
        messagesEndpoint: `http://127.0.0.1:${testServer!.port}/v1/messages`,
        modelsEndpoint: `http://127.0.0.1:${testServer!.port}/v1/models`,
        endpoint: `http://127.0.0.1:${testServer!.port}/v1/responses`,
      });
      if (path === "/api/keys" && request.method === "POST") return Response.json({ id: "key-new", name: entry?.name ?? "default", key: "ocx_data_newsecret", createdAt: "2026-09-05T00:00:00.000Z" }, { status: 201 });
      if (path === "/api/keys" && request.method === "DELETE") return Response.json({ success: true });
      if (path === "/api/keys/rotate" && request.method === "POST") return Response.json({ id: entry?.id, rotationId: "rot-1", key: "ocx_data_rotsecret", createdAt: "2026-09-05T00:00:00.000Z" }, { status: 201 });
      if (path === "/api/keys/rotate/commit") return Response.json({ ok: true });
      if (path === "/api/keys/rotate" && request.method === "DELETE") return Response.json({ ok: true });
      if (path === "/v1/models") return Response.json({ object: "list", data: [{ id: "grok-4.6", owned_by: "xai" }, { id: "claude-haiku-4-5", owned_by: null }] });
      if (path === "/v1/chat/completions") return Response.json({ id: "chatcmpl-1", object: "chat.completion", model: entry?.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }] });
      if (path === "/v1/responses") return Response.json({ id: "resp-1", object: "response", model: entry?.model, output: [] });
      if (path === "/v1/messages") return Response.json({ id: "msg-1", type: "message", model: entry?.model, content: [{ type: "text", text: "OK" }] });
      if (path === "/api/settings" && request.method === "GET") return Response.json({ codexAutoStart: false, streamMode: "auto", codexDesktopAuthless: false, managementPort: 10100, desired: { enabled: true } });
      if (path === "/api/settings" && request.method === "PUT") return Response.json({ ok: true, saved: entry });
      if (path === "/api/startup-health") return Response.json({ status: "ok", autoStart: false, checks: [{ name: "port", ok: true }, { name: "config", ok: false }], service: { installed: true, name: "opencodex" } });
      if (path === "/api/system/memory") return Response.json({ rssBytes: 123456789, heapUsed: 2097152, heapTotal: 4194304, responseState: { activeTurns: 0, draining: false } });
      if (path === "/api/startup-action" && request.method === "POST") return Response.json({ message: `startup ${entry?.action} accepted` });
      if (path === "/api/diagnostics/project-config") return Response.json({ ok: true, file: "/tmp/none.json", issues: [] });
      if (path === "/api/sync" && request.method === "POST") return Response.json({ ok: true, catalogWritten: true, message: "Catalog refreshed." });
      if (path === "/api/system/codex-app-server") return Response.json({ reachable: true, pid: 4242 });
      if (path === "/api/system/codex-restart" && request.method === "POST") return Response.json({ requested: true });
      if (path === "/api/update/check") return Response.json({ available: false, current: "2.42.0", latest: "2.42.0", channel: url.searchParams.get("tag") ?? "latest" });
      if (path === "/api/update/status") return Response.json({ jobId: url.searchParams.get("jobId"), status: "done", ok: true });
      if (path === "/api/update/run" && request.method === "POST") return Response.json({ started: true, channel: entry?.tag, restart: entry?.restart });
      return Response.json({ error: "not found", path }, { status: 404 });
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  function withMgmtToken(value: string | undefined): void {
    if (value === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
    else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = value;
  }
  test.each([
    { args: ["help", "debug"] }, { args: ["debug", "--help"] },
    { args: ["help", "access"] }, { args: ["access", "--help"] },
    { args: ["help", "api-key"] }, { args: ["api-key", "--help"] },
    { args: ["help", "system"] }, { args: ["system", "--help"] },
  ])("diffs management family help contracts for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 0 });
  });
  test.each([
    { args: ["access", "bogus"], code: 2 },
    { args: ["access", "key", "bogus"], code: 2 },
    { args: ["access", "key", "remove", "key-1"], code: 2 },
    { args: ["access", "key", "rotate", "commit", "key-1"], code: 2 },
    { args: ["access", "test"], code: 2 },
    { args: ["access", "test", "m", "--protocol", "nope"], code: 2 },
    { args: ["api-key", "bogus"], code: 2 },
    { args: ["system", "bogus"], code: 2 },
    { args: ["system", "startup", "bogus"], code: 2 },
    { args: ["system", "update", "bogus"], code: 2 },
    { args: ["system", "codex-restart"], code: 2 },
    { args: ["debug", "bogus"], code: 1 },
    { args: ["debug", "provider", "bogus"], code: 1 },
  ])("diffs management family argument validation for $args", ({ args, code }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-parity-"));
    expect(expectParity(args)).toMatchObject({ code });
  });
  test.each([
    { args: ["debug", "provider", "status"] },
    { args: ["debug", "provider", "on"] },
    { args: ["debug", "provider", "reset"] },
    { args: ["debug", "usage", "status"] },
    { args: ["debug", "injection", "off"] },
    { args: ["debug", "provider", "logs"] },
    { args: ["debug", "usage", "logs"] },
    { args: ["access", "key"] },
    { args: ["access", "key", "list"] },
    { args: ["access", "key", "list", "--json"] },
    { args: ["access", "key", "create"] },
    { args: ["access", "key", "create", "deploy", "--json"] },
    { args: ["access", "key", "rotate", "key-1"] },
    { args: ["access", "key", "rotate", "key-1", "--json"] },
    { args: ["access", "key", "rotate", "commit", "key-1", "rot-1"] },
    { args: ["access", "key", "rotate", "abort", "key-1", "rot-1"] },
    { args: ["access", "key", "remove", "key-1", "--yes"] },
    { args: ["access", "endpoints"] },
    { args: ["access", "endpoints", "--json"] },
    { args: ["access", "models"] },
    { args: ["access", "models", "--json"] },
    { args: ["access", "test", "grok-4.6"] },
    { args: ["access", "test", "grok-4.6", "--json"] },
    { args: ["api-key"] },
    { args: ["api-key", "list"] },
    { args: ["api-key", "create", "deploy", "--json"] },
    { args: ["system", "settings"] },
    { args: ["system", "settings", "--json"] },
    { args: ["system", "settings", "--auto-start", "off", "--json"] },
    { args: ["system", "startup"] },
    { args: ["system", "diagnostics"] },
    { args: ["system", "diagnostics", "--json"] },
    { args: ["system", "sync"] },
    { args: ["system", "sync", "--json"] },
    { args: ["system", "codex-app-server"] },
    { args: ["system", "codex-app-server", "--json"] },
    { args: ["system", "codex-restart", "--yes"] },
    { args: ["system", "status"] },
    { args: ["system", "status", "--json"] },
    { args: ["system", "update", "check"] },
    { args: ["system", "update", "check", "--channel", "latest"] },
    { args: ["system", "update", "check", "--channel", "latest", "--json"] },
    { args: ["system", "update", "run", "--channel", "latest", "--restart", "off", "--yes"] },
    { args: ["system", "update", "status", "update-1"] },
  ])("diffs Go-owned management family output and exit code for $args", async ({ args }) => {
    startMgmtFixture(false);
    withMgmtToken("ocx_admin_testtokenforissue47abcdefghijklmnopqrstuvwxyz");
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  }, 20000);
  test.each([
    { args: ["access", "key"] },
    { args: ["access", "key", "create", "denied", "--json"] },
    { args: ["api-key", "create", "denied", "--json"] },
    { args: ["debug", "provider", "on"] },
    { args: ["system", "settings"] },
    { args: ["system", "sync", "--json"] },
  ])("diffs denied management writes across families for $args", async ({ args }) => {
    startMgmtFixture(true);
    withMgmtToken(undefined);
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 1 });
  }, 20000);
  test.each([
    { args: ["debug"], code: 0 },
    { args: ["debug", "provider", "status"], code: 1 },
    { args: ["debug", "provider", "on"], code: 1 },
    { args: ["debug", "usage", "logs"], code: 1 },
    { args: ["access"], code: 1 },
    { args: ["access", "key", "list"], code: 1 },
    { args: ["access", "test", "grok-1"], code: 1 },
    { args: ["api-key"], code: 1 },
    { args: ["api-key", "list"], code: 1 },
    { args: ["system"], code: 1 },
    { args: ["system", "status"], code: 1 },
    { args: ["system", "settings"], code: 1 },
    { args: ["system", "sync"], code: 1 },
    { args: ["system", "update", "check"], code: 1 },
    { args: ["system", "update", "status", "up-1"], code: 1 },
  ])("diffs management family output with no live proxy for $args", ({ args, code }) => {
    // A schema-valid config pinned to an unroutable port (9) makes the
    // no-proxy path deterministic instead of probing whatever occupies the
    // default port on this machine; both runtimes must print the same
    // "Proxy is not running" failure (and debug's env-default help at 0).
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-noproxy-"));
    writeFileSync(join(testHome, "config.json"), JSON.stringify({ port: 9, providers: { fixture: { adapter: "openai-chat", baseUrl: "https://example.test/v1", apiKey: "secret-key" } }, defaultProvider: "fixture" }));
    const result = expectParity(args);
    expect(result).toMatchObject({ code });
    if (args[0] === "debug" && args.length === 1) {
      expect(result.stdout).toContain("Proxy is not running — env defaults for the next start:");
      expect(result.stderr).toBe("");
    }
  });
  // system codex-cli-update stays TypeScript-owned behind an OwnershipFor
  // carve-out (read-only local Codex inspection, no management plane); these
  // rows exercise the delegated path end-to-end so a regression in the seam
  // (Go silently taking over the subcommand) fails loudly instead of only
  // tripping the ownership classification test.
  test.each([
    { args: ["system", "codex-cli-update", "check"] },
    { args: ["system", "codex-cli-update", "check", "--json"] },
  ])("diffs the delegated system codex-cli-update carve-out for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-noproxy-"));
    const result = expectParity(args);
    expect(result).toMatchObject({ code: 0 });
  });

  // the same live management payloads, so the fixture answers /healthz with the
  // attested identity and serves each family's routes from canned JSON.
  const jsonResponse = (payload: unknown, status = 200) => new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  function startFamilyFixture(api: (path: string, method: string) => Response): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-family-parity-"));
    testServer = Bun.serve({ port: 0, fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, process.pid, testServer!.port) } : {};
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      return api(path, request.method);
    }});
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  const storageReport = { sessionFiles: 12, bytes: 10485760, trash: { count: 3, labels: ["old", "gone"] } };
  const storagePreview = { count: 2, bytes: 3145728, digest: "pv-1", candidates: [{ relPath: "a.jsonl", bytes: 1048576 }, { relPath: "b.jsonl" }, { relPath: "c.jsonl", bytes: 2097152 }] };
  const storageTrash = { entries: [{ id: "e1", relPath: "x.jsonl", bytes: 123 }] };
  const storagePolicy = { enabled: true, target: { removeOldestPercent: 25 }, mode: "quarantine", schedule: "weekly" };
  function startStorageFixture(restoreConflict = false): void {
    startFamilyFixture((path, method) => {
      if (path === "/api/storage") return jsonResponse(storageReport);
      if (path === "/api/storage/cleanup/preview") return jsonResponse(storagePreview);
      if (path === "/api/storage/cleanup") return jsonResponse({ ok: true, removed: 3, freedBytes: 1048576 });
      if (path === "/api/storage/trash") return jsonResponse(storageTrash);
      if (path === "/api/storage/trash/restore") {
        return restoreConflict ? jsonResponse({ error: "drift", reason: "already restored" }, 409) : jsonResponse({ ok: true, restored: "e1" });
      }
      if (path === "/api/storage/cleanup-policy") return method === "PUT" ? jsonResponse({ ok: true }) : jsonResponse(storagePolicy);
      if (path === "/api/storage/cleanup-policy/run") return jsonResponse({ ok: true, removed: 8, freedBytes: 2097152 });
      return jsonResponse({ error: "not found" }, 404);
    });
  }
  const storageLiveRows = [
    { args: ["storage"] }, { args: ["storage", "report"] }, { args: ["storage", "report", "--json"] },
    { args: ["storage", "cleanup", "--percent", "50"] }, { args: ["storage", "cleanup", "--percent", "50", "--json"] },
    { args: ["storage", "cleanup", "--percent", "50", "--yes"] }, { args: ["storage", "cleanup", "--percent", "50", "--yes", "--json"] },
    { args: ["storage", "trash", "list"] }, { args: ["storage", "trash", "list", "--json"] },
    { args: ["storage", "policy"] }, { args: ["storage", "policy", "--json"] },
    { args: ["storage", "policy", "set", "--enabled", "true"] }, { args: ["storage", "policy", "set", "--enabled", "true", "--json"] },
    { args: ["storage", "policy", "set", "--percent", "10", "--mode", "permanent", "--schedule", "daily", "--json"] },
    { args: ["storage", "trash", "restore", "e1", "--yes"] },
    { args: ["storage", "policy", "run", "--yes", "--json"] },
  ];
  test.each(storageLiveRows)("diffs Go-owned storage output and exit code for $args", async ({ args }) => {
    startStorageFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["storage", "cleanup"] }, { args: ["storage", "cleanup", "--percent", "101"] },
    { args: ["storage", "cleanup", "--percent", "many"] }, { args: ["storage", "cleanup", "--percent", "5", "--mode", "weird"] },
    { args: ["storage", "trash", "nope"] }, { args: ["storage", "trash", "restore"] }, { args: ["storage", "trash", "restore", "e1"] },
    { args: ["storage", "policy", "set"] }, { args: ["storage", "policy", "set", "--enabled", "maybe"] },
    { args: ["storage", "policy", "run"] }, { args: ["storage", "bogus"] },
  ])("diffs storage argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-storage-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  test("diffs storage write refusal (409) and its exit code", async () => {
    startStorageFixture(true);
    const ts = await runTsAsync(["storage", "trash", "restore", "c1", "--yes"]);
    const go = await runGoAsync(["storage", "trash", "restore", "c1", "--yes"]);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 5 });
  });
  test("diffs storage help in both spellings", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-storage-parity-"));
    expect(expectParity(["help", "storage"]));
    expect(expectParity(["storage", "--help"]));
  });
  test("diffs storage when no proxy is running", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-storage-parity-"));
    expect(expectParity(["storage", "report"])).toMatchObject({ code: 1 });
    expect(expectParity(["storage", "cleanup", "--percent", "5", "--yes"])).toMatchObject({ code: 1 });
  });
  test("keeps storage codex-logs on the TypeScript observe owner", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-storage-parity-"));
    expect(expectParity(["storage", "codex-logs", "status"])).toMatchObject({ code: 1 });
  });

  // ── agent family (issue #48) ──────────────────────────────────────────────
  const agentPayloads = {
    v2: { enabled: true, mode: "v2", threads: 4 },
    injection: { model: "grok-4.6", effort: "high", prompt: null, multiAgentGuidanceEnabled: true },
    caps: { effortCap: "high", subagentEffortCap: "low" },
    subagents: { models: ["sub-a", "sub-b"] },
    fallback: { models: ["sub-a"], pollMs: 60000 },
    sidecars: {
      webSearchModels: [{ value: "chatgpt-web", model: "gpt-web", backend: "openai", authSlot: true }, { value: "claude-web", model: "claude-web", backend: "anthropic" }],
      visionModels: [{ value: "vis-1", backend: "openai", baseline: true }],
    },
  };
  function startAgentFixture(): void {
    startFamilyFixture((path, method) => {
      const routes: Record<string, unknown> = {
        "/api/v2": agentPayloads.v2, "/api/injection-model": agentPayloads.injection,
        "/api/effort-caps": agentPayloads.caps, "/api/subagent-models": agentPayloads.subagents,
        "/api/subagent-model-fallback": agentPayloads.fallback, "/api/sidecar-settings": agentPayloads.sidecars,
        "/api/codex-auth/features/default-mode-request-user-input": { enabled: true },
      };
      if (path in routes) {
        if (method === "PUT") return jsonResponse({ ok: true });
        return jsonResponse(routes[path]);
      }
      return jsonResponse({ error: "not found" }, 404);
    });
  }
  const agentLiveRows = [
    { args: ["agent"] },
    { args: ["agent", "status", "--json"] },
    { args: ["agent", "injection"] },
    { args: ["agent", "injection", "set", "--model", "m1", "--effort", "high", "--prompt", "keep going", "--guidance", "on"] },
    { args: ["agent", "injection", "set", "--model", "-", "--effort", "-", "--json"] },
    { args: ["agent", "effort"] }, { args: ["agent", "effort", "set", "--main", "high"] },
    { args: ["agent", "effort", "set", "--subagent", "-", "--json"] },
    { args: ["agent", "subagents"] }, { args: ["agent", "subagents", "set", "sub-a,sub-b,sub-a"] },
    { args: ["agent", "subagents", "set", "x,y", "--json"] }, { args: ["agent", "subagents", "clear"] },
    { args: ["agent", "subagents", "set", "--weird"] },
    { args: ["agent", "roster", "set", "a,b"] },
    { args: ["agent", "fallback"] }, { args: ["agent", "fallback", "set", "f1,f2", "--poll-ms", "120000"] },
    { args: ["agent", "fallback", "clear", "--json"] }, { args: ["agent", "fallback", "set", "--poll-ms", "60000", "--json"] },
    { args: ["agent", "sidecar"] }, { args: ["agent", "sidecar", "web", "--list"] }, { args: ["agent", "sidecar", "web", "--list", "--json"] },
    { args: ["agent", "sidecar", "vision", "--list"] }, { args: ["agent", "sidecar", "vision", "--list", "--json"] },
    { args: ["agent", "sidecar", "web", "--model", "chatgpt-web", "--backend", "openai", "--reasoning", "high", "--max-descriptions", "3"] },
    { args: ["agent", "sidecar", "web", "--model", "gpt-web", "--backend", "openai", "--json"] },
    { args: ["agent", "sidecar", "vision", "--model", "-", "--backend", "-", "--json"] },
    { args: ["agent", "request-user-input"] }, { args: ["agent", "request-user-input", "on", "--json"] },
  ];
  test.each(agentLiveRows)("diffs Go-owned agent output and exit code for $args", async ({ args }) => {
    startAgentFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["agent", "bogus"] }, { args: ["agent", "--json"] },
    { args: ["agent", "injection", "bogus"] }, { args: ["agent", "injection", "--json"] },
    { args: ["agent", "injection", "set", "--guidance", "maybe"] },
    { args: ["agent", "effort", "set"] }, { args: ["agent", "effort", "nope"] },
    { args: ["agent", "subagents", "set"] }, { args: ["agent", "subagents", "set", "a,b,c,d,e,f"] },
    { args: ["agent", "subagents", "nope"] },
    { args: ["agent", "fallback", "nope"] }, { args: ["agent", "fallback", "set", "--poll-ms", "100"] },
    { args: ["agent", "fallback", "set", "--poll-ms", "999999999"] },
    { args: ["agent", "sidecar", "bogus"] }, { args: ["agent", "sidecar", "web"] },
    { args: ["agent", "request-user-input", "maybe"] }, { args: ["agent", "request-user-input", "on", "extra"] },
    { args: ["agent", "subagents", "set", "--json"] },
  ])("diffs agent argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-agent-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });

  // ── grok + integration family (issue #48) ─────────────────────────────────
  const grokState = { excluded: ["old-model"], selection: { mode: "fenced" } };
  function startGrokFixture(applyMessage?: string): void {
    startFamilyFixture((path, method) => {
      if (path === "/api/grok") return jsonResponse(grokState);
      if (path === "/api/grok/apply") return jsonResponse(applyMessage ? { message: applyMessage } : { ok: true });
      if (path === "/api/grok/selection") return jsonResponse({ ok: true });
      return jsonResponse({ error: "not found" }, 404);
    });
  }
  const grokLiveRows = [
    { args: ["grok"] }, { args: ["grok", "show"] },
    { args: ["grok", "apply"] }, { args: ["grok", "apply", "--json"] },
    { args: ["grok", "exclude", "m1,m2"] }, { args: ["grok", "include", "old-model"] }, { args: ["grok", "exclude", "--weird"] },
    { args: ["grok", "set", "g1,g2", "--json"] }, { args: ["grok", "clear"] },
    { args: ["integration", "grok", "status"] }, { args: ["integration", "grok", "set", "z", "--json"] },
  ];
  test.each(grokLiveRows)("diffs Go-owned grok output and exit code for $args", async ({ args }) => {
    startGrokFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test("diffs grok apply with a server message", async () => {
    startGrokFixture("Fence written to ~/.grok/config.toml.");
    const ts = await runTsAsync(["grok", "apply"]);
    const go = await runGoAsync(["grok", "apply"]);
    expect(go).toEqual(ts);
  });
  test.each([
    { args: ["grok", "bogus"] }, { args: ["grok", "--json"] }, { args: ["grok", "exclude"] }, { args: ["grok", "set"] },
    { args: ["integration"] }, { args: ["integration", "bogus"] },
  ])("diffs grok/integration argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-grok-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });

  function startIntegrationFixture(): void {
    startFamilyFixture((path, method) => {
      if (path === "/api/claude-code") return jsonResponse({ enabled: true, authMode: "proxy" });
      if (path === "/api/client-integrations") return jsonResponse({ clients: [{ clientId: "mcode", state: "enabled", installed: true }, { clientId: "claude", state: "disabled", installed: false }] });
      if (path === "/api/client-integrations/mcode") return jsonResponse({ clientId: "mcode", state: "enabled", installed: true });
      if (path === "/api/client-integrations/journal") return jsonResponse({ operations: [{ at: "2026-08-22T10:00:00Z", clientId: "mcode", kind: "enable", opId: "op-1", snapshot: "current" }, { at: "2026-08-22T11:00:00Z", clientId: "claude", kind: "disable", opId: "op-2", snapshot: "expired" }] });
      if (path === "/api/client-integrations/journal?client=mcode") return jsonResponse({ operations: [] });
      if (path === "/api/client-integrations/restore") return jsonResponse({ message: "Restored op-1." });
      if (path.startsWith("/api/client-integrations/") && method === "PUT") return jsonResponse({ ok: true });
      if (path === "/api/native-integrations") return jsonResponse({
        clients: [
          { clientId: "claude", state: "enabled", installed: true, desiredEnabled: true, configPath: "~/.claude/settings.json" },
          { clientId: "codex", state: "enabled", installed: false, desiredEnabled: false, configPath: "~/.codex/config.toml", disableBlocked: "running app-server" },
          { clientId: "grok", state: "disabled", installed: true, desiredEnabled: null, configPath: "" },
        ],
      });
      if (path.startsWith("/api/native-integrations/") && method === "PUT") return jsonResponse({ ok: true });
      return jsonResponse({ error: "not found" }, 404);
    });
  }
  const integrationLiveRows = [
    { args: ["integration", "client"] },
    { args: ["integration", "client", "status", "--client", "mcode"] },
    { args: ["integration", "client", "history"] }, { args: ["integration", "client", "history", "--json"] },
    { args: ["integration", "client", "history", "--client", "mcode"] },
    { args: ["integration", "client", "restore", "--op", "op-1"] },
    { args: ["integration", "client", "restore", "--op", "op-1", "--confirm-drift", "--json"] },
    { args: ["integration", "client", "enable", "--client", "mcode"] },
    { args: ["integration", "client", "enable", "--client", "mcode", "--json"] },
    { args: ["integration", "client", "enable", "--client", "mcode", "--overwrite-conflict"] },
    { args: ["integration", "client", "disable", "--client", "mcode"] },
    { args: ["integration", "claude"] },
    { args: ["integration", "claude", "set", "--enabled", "on", "--auth-mode", "proxy", "--compact-window", "200000", "--small-fast-model", "-", "--model-map", "a=b,c=d", "--blocked-skills", "x,y", "--web-model", "w1", "--web-backend", "-"] },
    { args: ["integration", "claude", "set", "--enabled", "off", "--compact-window", "default", "--model-map", "-", "--json"] },
    { args: ["integration", "native"] }, { args: ["integration", "native", "list", "--json"] },
    { args: ["integration", "native", "claude", "on"] }, { args: ["integration", "native", "codex", "off", "--json"] },
  ];
  test.each(integrationLiveRows)("diffs Go-owned integration output and exit code for $args", async ({ args }) => {
    startIntegrationFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["integration", "client", "restore"] }, { args: ["integration", "client", "restore", "--op", "x", "extra"] },
    { args: ["integration", "client", "enable"] }, { args: ["integration", "client", "disable", "--client", "mcode", "--overwrite-conflict"] },
    { args: ["integration", "client", "nope"] }, { args: ["integration", "client", "--json"] },
    { args: ["integration", "claude", "set"] }, { args: ["integration", "claude", "--json"] }, { args: ["integration", "claude", "set", "--model-map", "bad"] },
    { args: ["integration", "claude", "set", "--compact-window", "abc"] }, { args: ["integration", "claude", "bogus"] },
    { args: ["integration", "native", "bogus"] }, { args: ["integration", "native", "claude", "maybe"] },
  ])("diffs integration argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-integration-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  // ── lab family (issue #48) ─────────────────────────────────────────────────
  // status reads the local SQLite projection under <home>/lab/compatibility.sqlite
  // (src/cli/lab.ts, src/lab/query/connection.ts). The other verbs keep their
  // TypeScript owner and are exercised as delegation smoke rows below.
  function writeLabProjection(home: string, schemaVersion = "3", specVersion = "cl-02.v1"): void {
    mkdirSync(join(home, "lab"), { recursive: true });
    const db = new Database(join(home, "lab", "compatibility.sqlite"));
    db.run("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
    db.run("INSERT INTO schema_meta VALUES (?, ?), (?, ?), (?, ?)",
      "schema_version", schemaVersion, "projection_spec_version", specVersion, "built_at_ms", "1700000000123");
    for (const t of ["events", "subjects", "observations", "claims", "verdicts", "artifacts", "corruption"]) {
      db.run(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
    }
    db.run("INSERT INTO events VALUES ('e1'), ('e2')");
    db.run("INSERT INTO subjects VALUES ('s1')");
    db.run("INSERT INTO verdicts VALUES ('v1'), ('v2'), ('v3')");
    db.run("INSERT INTO corruption VALUES ('c1')");
    db.close();
  }
  const labProjectionRows = [
    { args: ["lab"] }, { args: ["lab", "--json"] }, { args: ["lab", "status"] }, { args: ["lab", "status", "--json"] },
  ];
  test.each(labProjectionRows)("diffs Go-owned lab status output and exit code for $args", async ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
    writeLabProjection(testHome);
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["lab", "status"] }, { args: ["lab", "status", "--json"] },
  ])("diffs Go-owned lab incompatible projection output for $args", async ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
    writeLabProjection(testHome, "99", "cl-02.v1");
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["lab"] }, { args: ["lab", "status"] }, { args: ["lab", "status", "--json"] }, { args: ["lab", "--json"] },
    { args: ["lab", "bogus"] }, { args: ["lab", "status", "extra"] },
  ])("diffs lab output when no projection is present for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
    expect(expectParity(args)).toMatchObject({ code: args.includes("bogus") || args.includes("extra") ? 2 : 0 });
  });
  test.each([
    { args: ["lab", "catalog"], code: 0 }, { args: ["lab", "verdicts"], code: 1 },
    { args: ["lab", "public", "community"], code: 0 }, { args: ["lab", "automation", "status"], code: 0 },
  ])("diffs lab TypeScript-owned verb delegation for $args", async ({ args, code }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts.code).toBe(code);
  });
  test("diffs lab help in both spellings", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
    expect(expectParity(["help", "lab"]));
    expect(expectParity(["lab", "--help"]));
  });

  test("diffs management-family help in both spellings", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-family-parity-"));
    for (const name of ["agent", "grok", "integration"]) {
      expect(expectParity(["help", name]));
      expect(expectParity([name, "--help"]));
    }
  });
  test("diffs management-family output when no proxy is running", () => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-family-parity-"));
    for (const args of [["agent", "status"], ["grok"], ["integration", "client"], ["integration", "claude"], ["integration", "native"]]) {
      const result = expectParity(args);
      expect(result.code).toBe(1);
    }
  });
});
  // alias/combo/route are Go-owned (ADR-0008 config-routing slice, issue #49);
  // both CLIs read and write the routing subsections of the config file through
  // the same live-proxy management routes, so the fixture serves the attested
  // identity probe plus canned /api/aliases, /api/combos, /api/routing-profiles
  // and their write endpoints.
  function startRoutingFixture(): void {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-routing-parity-"));
    const aliasesPayload = {
      providers: { alpha: "a", beta: "b" },
      models: {
        alpha: {
          m1: { alias: "one", source: "user" },
          "gpt-5.4": { alias: "five", source: "builtin" },
          stale: { alias: "gone", source: "user", stale: true },
        },
      },
      defaults: { global: true, providers: { alpha: false } },
    };
    const combosPayload = {
      combos: [
        { id: "fast", model: "combo/fast", strategy: "failover", stickyLimit: 1, targets: [{ provider: "alpha", model: "m1", weight: 2 }, { provider: "beta", model: "b1" }] },
        { id: "smart", model: "combo/smart", strategy: "round-robin", stickyLimit: 3, targets: [{ provider: "alpha", model: "m2" }], alias: "smartie", defaultEffort: "high" },
      ],
    };
    const profilesPayload = {
      profiles: [
        { id: "p1", model: "policy/p1", revision: 3, strategy: "cost" },
        // A profile without a public model exercises the `policy/<id>` fallback.
        { id: "p2", revision: 1, strategy: "cost" },
      ],
    };
    const decisionPayload = {
      profile: "p1",
      matched: true,
      model: "policy/p1",
      reasons: ["compatibility matched"],
      evidence: {},
      candidates: [],
    };
    testServer = Bun.serve({ port: 0, fetch: async request => {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/healthz") {
        const challenge = request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, process.pid, testServer!.port) } : {};
        return Response.json({ status: "ok", service: "opencodex", version: "2.42.0", uptime: 1, pid: process.pid, port: testServer!.port }, { headers });
      }
      if (path === "/api/aliases" && request.method === "GET") return Response.json(aliasesPayload);
      if (path === "/api/combos" && request.method === "GET") return Response.json(combosPayload);
      if (path === "/api/combos" && request.method === "PUT") {
        const body = await request.json().catch(() => ({}));
        if ((body as { id?: string })?.id === "conflict") return Response.json({ error: "alias conflicts with 'combo/smart'" }, { status: 409 });
        return Response.json({ ok: true, id: (body as { id?: string })?.id ?? null });
      }
      if (path === "/api/combos" && request.method === "DELETE") {
        const id = url.searchParams.get("id");
        if (id === "gone") return Response.json({ error: "unknown combo: gone" }, { status: 404 });
        return Response.json({ ok: true, id });
      }
      if (path === "/api/routing-profiles" && request.method === "GET") return Response.json(profilesPayload);
      if (path === "/api/routing-profiles/dry-run" && request.method === "POST") return Response.json(decisionPayload);
      if (path === "/api/default-aliases" && request.method === "PUT") {
        return Response.json({ ok: true, catalogRefresh: { status: "noop", ok: true } });
      }
      const providerAlias = path.match(/^\/api\/providers\/([^/]+)\/alias$/);
      if (providerAlias && request.method === "PUT") {
        const name = decodeURIComponent(providerAlias[1]!);
        if (name === "beta") return Response.json({ error: "alias conflicts with 'beta'" }, { status: 409 });
        if (name === "ghost") return Response.json({ error: `provider '${name}' not found` }, { status: 404 });
        return Response.json({ ok: true, provider: name, alias: "x", catalogRefresh: { status: "noop", ok: true } });
      }
      const modelAlias = path.match(/^\/api\/providers\/([^/]+)\/model-aliases$/);
      if (modelAlias && request.method === "PUT") {
        const name = decodeURIComponent(modelAlias[1]!);
        if (name === "ghost") return Response.json({ error: `provider '${name}' not found` }, { status: 404 });
        return Response.json({ ok: true, aliases: { m1: "one" }, catalogRefresh: { status: "noop", ok: true } });
      }
      return new Response("not found", { status: 404 });
    } });
    writeFileSync(join(testHome, "runtime-port.json"), JSON.stringify({ pid: process.pid, port: testServer.port, hostname: "127.0.0.1", attestationSecret: secret }));
  }
  test.each([
    { args: ["alias", "list"] },
    { args: ["alias", "list", "--json"] },
    { args: ["alias", "defaults", "on"] },
    { args: ["alias", "defaults", "off", "--provider", "alpha"] },
    { args: ["alias", "defaults", "on", "--json"] },
    { args: ["alias", "set", "alpha", "fast-a"] },
    { args: ["alias", "set", "alpha", "fast-a", "--json"] },
    { args: ["alias", "set", "alpha/m1", "one-a", "--json"] },
    { args: ["alias", "rm", "alpha"] },
    { args: ["alias", "rm", "alpha/m1", "--json"] },
    { args: ["combo", "list"] },
    { args: ["combo", "list", "--json"] },
    { args: ["combo", "show", "fast"] },
    { args: ["combo", "show", "smart", "--json"] },
    { args: ["combo", "set", "fast", "--targets", "alpha/m1:2,beta/b1", "--json"] },
    { args: ["combo", "set", "smart", "--targets", "alpha/m2", "--strategy", "round-robin", "--sticky", "3", "--effort", "high", "--alias", "smartie", "--display-name", "Smart Combo", "--rename-from", "old-smart"] },
    { args: ["combo", "set", "dash", "--targets", "alpha/m1", "--effort", "-", "--alias", "-", "--display-name", "-"] },
    { args: ["combo", "remove", "fast", "--yes"] },
    { args: ["combo", "remove", "fast", "--yes", "--json"] },
    { args: ["route", "combo", "list"] },
    { args: ["route", "combo", "show", "fast", "--json"] },
    { args: ["route", "policy", "list"] },
    { args: ["route", "policy", "list", "--json"] },
    { args: ["route", "policy", "show", "p1"] },
    { args: ["route", "policy", "show", "p2", "--json"] },
    { args: ["route", "policy", "dry-run", "p1"] },
    { args: ["route", "policy", "dry-run", "p1", "--model-context", "9000", "--tools", "--image", "--structured-output", "--json"] },
    { args: ["route", "policy", "evaluate", "p1", "--model-context", "128000"] },
  ])("diffs Go-owned config-routing output and exit code for $args", async ({ args }) => {
    startRoutingFixture();
    // spawnSync blocks Bun's event loop, which starves the fixture server; live
    // management-plane rows drive both CLIs async like the usage oracle above.
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 0, stderr: "" });
  });
  test.each([
    { args: ["combo", "show", "missing"] },
    { args: ["route", "policy", "show", "missing"] },
  ])("diffs config-routing unknown-id usage output for $args", async ({ args }) => {
    startRoutingFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code: 2, stdout: "" });
  });
  test.each([
    // Write refusals: 409 (collision) and 404 (unknown target) selection the
    // fixture keys on the provider/combo id both CLIs send.
    { args: ["alias", "set", "beta", "b2"], code: 5 },
    { args: ["alias", "set", "ghost", "g"], code: 4 },
    { args: ["alias", "set", "ghost/m", "g", "--json"], code: 4 },
    { args: ["combo", "set", "conflict", "--targets", "alpha/m1"], code: 5 },
    { args: ["combo", "remove", "gone", "--yes"], code: 4 },
  ])("diffs config-routing write refusals for $args", async ({ args, code }) => {
    startRoutingFixture();
    const ts = await runTsAsync(args);
    const go = await runGoAsync(args);
    expect(go).toEqual(ts);
    expect(ts).toMatchObject({ code, stdout: "" });
  });
  test.each([
    { args: ["alias", "defaults", "maybe"] },
    { args: ["alias", "defaults", "on", "extra"] },
    { args: ["alias", "defaults", "--provider"] },
    { args: ["alias", "defaults", "--provider", "x", "on"] },
    { args: ["alias", "set"] },
    { args: ["alias", "set", "alpha"] },
    { args: ["alias", "set", "alpha/"] },
    { args: ["alias", "set", "/m"] },
    { args: ["alias", "set", "alpha", "m1", "extra"] },
    { args: ["alias", "rm"] },
    { args: ["alias", "rm", "alpha", "extra"] },
    { args: ["alias", "list", "extra"] },
    { args: ["alias", "frobnicate", "x"] },
    { args: ["combo", "frobnicate"] },
    { args: ["combo", "set"] },
    { args: ["combo", "set", "x"] },
    { args: ["combo", "set", "x", "--targets"] },
    { args: ["combo", "set", "x", "--targets", "plain"] },
    { args: ["combo", "set", "x", "--targets", "a/b:0"] },
    { args: ["combo", "set", "x", "--targets", "a/"] },
    { args: ["combo", "set", "x", "--targets", "a/b", "--strategy", "bad"] },
    { args: ["combo", "set", "x", "--targets", "a/b", "--sticky", "3"] },
    { args: ["combo", "set", "x", "--targets", "a/b", "--strategy", "random", "--sticky", "5"] },
    { args: ["combo", "set", "x", "--targets", "a/b", "--sticky", "200"] },
    { args: ["combo", "set", "x", "--targets", "a/b", "--sticky", "abc"] },
    { args: ["combo", "remove", "x"] },
    { args: ["combo", "remove", "x", "--yes", "extra"] },
    { args: ["route"] },
    { args: ["route", "frobnicate"] },
    { args: ["route", "policy"] },
    { args: ["route", "policy", "show", "--json"] },
    { args: ["route", "policy", "dry-run", "x", "--model-context", "abc"] },
    { args: ["route", "policy", "dry-run", "x", "extra"] },
    { args: ["route", "policy", "frobnicate"] },
  ])("diffs config-routing argument validation for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-routing-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 2 });
  });
  test.each([
    { args: ["alias", "list"] },
    { args: ["combo"] },
    { args: ["route", "combo"] },
    { args: ["route", "combo", "list"] },
    { args: ["route", "policy", "list"] },
    { args: ["alias", "set", "alpha", "x"] },
  ])("diffs config-routing when no proxy is running for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-routing-parity-"));
    expect(expectParity(args)).toMatchObject({ code: 1, stdout: "" });
  });
  test.each([
    { args: ["help", "alias"] }, { args: ["alias", "--help"] }, { args: ["alias", "help"] },
    { args: ["help", "combo"] }, { args: ["combo", "--help"] },
    { args: ["help", "route"] }, { args: ["route", "--help"] },
    { args: ["route", "combo", "--help"] }, { args: ["route", "policy", "--help"] },
  ])("diffs config-routing help contracts for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-routing-parity-"));
    expect(expectParity(args));
  });