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
afterEach(async () => { testServer?.stop(true); testServer = undefined; delete process.env.OPENCODEX_HOME; delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN; if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome); testHome = ""; });
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

  // debug/system/api-key/access are Go-owned (ADR-0008, issue #47 batch 1
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
        const headers = challenge ? { "x-opencodex-attestation-proof": createLocalAttestationProof(secret, challenge, process.pid, testServer!.port) } : {};
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
});
