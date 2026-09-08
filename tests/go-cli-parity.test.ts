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

  // storage/agent/grok/integration are Go-owned (issue #48); both CLIs render
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
