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
});
