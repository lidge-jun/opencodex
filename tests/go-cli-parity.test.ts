import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
// sync/sync-cache decide from CODEX_HOME as well; these runners drive both CLIs
// against the same pair of fresh homes exactly like a real invocation would.
function runTsAt(args: string[], home: string, codexHome: string): Result {
  const result = Bun.spawnSync([process.execPath, "src/cli/index.ts", ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function runGoAt(args: string[], home: string, codexHome: string): Result {
  const result = Bun.spawnSync([goCLI!, ...args], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe" });
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}
function removeKLock(codexHome: string): void {
  // Best-effort: drop the K lock database this Codex home hashes to so the
  // suite does not accumulate per-run artifacts under the runtime root.
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const digest = createHash("sha256").update(codexHome).digest("hex");
    const db = join(tmpdir(), `opencodex-runtime-v1-${uid}`, "catalog-write-locks", `${digest}.sqlite`);
    rmSync(db, { force: true });
  } catch { /* cleanup is best-effort */ }
}
function syncFixtureConfig(codexIntegration: boolean): string {
  return JSON.stringify({
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
    ...(codexIntegration ? {} : { clientIntegrations: { codex: false } }),
  });
}
function syncRowHomes(): { home: string; codexHome: string } {
  const home = mkdtempSync(join(tmpdir(), "ocx-go-sync-parity-"));
  const codexHome = mkdtempSync(join(tmpdir(), "ocx-go-sync-codex-"));
  writeFileSync(join(home, "config.json"), syncFixtureConfig(true));
  return { home, codexHome };
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

  // ────────────────────────────────────────────────────────────────────────────
  // sync / sync-cache are Go-owned (issue #50). Both CLIs run in the same pair
  // of fresh homes so the deterministic catalog-refresh flows produce identical
  // bytes; the TS CLI runs first and the Go CLI second over whatever the TS run
  // left (each flow is idempotent over the planted catalog).
  test.each([
    { args: ["help", "sync"] },
    { args: ["sync", "--help"] },
    { args: ["help", "sync-cache"] },
    { args: ["sync-cache", "--help"] },
  ])("diffs sync help contracts for $args", ({ args }) => {
    testHome = mkdtempSync(join(tmpdir(), "ocx-go-sync-parity-"));
    expectParity(args);
  });
  test.each([
    { name: "integration ON with no config.toml", integration: true, toml: false, code: 1 },
    { name: "integration OFF with a missing custom catalog path", integration: false, toml: true, code: 0 },
  ])("diffs native terminal ocx sync flows: $name", ({ integration, toml, code }) => {
    const { home, codexHome } = syncRowHomes();
    writeFileSync(join(home, "config.json"), syncFixtureConfig(integration));
    if (toml) writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "/nonexistent/custom-catalog.json"\n');
    try {
      const ts = runTsAt(["sync"], home, codexHome);
      const go = runGoAt(["sync"], home, codexHome);
      expect(go).toEqual(ts);
      expect(ts.code).toBe(code);
    } finally {
      removeKLock(codexHome);
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test.each([
    { name: "mismatched client present without role", config: syncFixtureConfig(true).replace(/}$/, ',"client":{"apiKeyId":"k"}}'), code: 1 },
    { name: "invalid runtimeRole", config: syncFixtureConfig(true).replace(/}$/, ',"runtimeRole":"weird"}'), code: 1 },
  ])("diffs client-state refusal flows for $name", ({ config, code }) => {
    const { home, codexHome } = syncRowHomes();
    writeFileSync(join(home, "config.json"), config);
    try {
      const ts = runTsAt(["sync"], home, codexHome);
      const go = runGoAt(["sync"], home, codexHome);
      expect(go).toEqual(ts);
      expect(ts.code).toBe(code);
    } finally {
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test.each([
    { args: ["sync-cache"] },
    { args: ["sync-cache", "--json"] },
  ])("diffs ocx sync-cache with no catalog for $args", ({ args }) => {
    const { home, codexHome } = syncRowHomes();
    try {
      const ts = runTsAt(args, home, codexHome);
      const go = runGoAt(args, home, codexHome);
      expect(go).toEqual(ts);
      expect(ts).toMatchObject({ code: 0 });
    } finally {
      removeKLock(codexHome);
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test.each([
    { args: ["sync-cache"] },
    { args: ["sync-cache", "--json"] },
    { args: ["sync-cache", "--restart-codex"] },
  ])("diffs ocx sync-cache with a planted catalog for $args", async ({ args }) => {
    const { home, codexHome } = syncRowHomes();
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture-model", display_name: "Fixture", context_window: 128000 }] }));
    try {
      const ts = runTsAt(args, home, codexHome);
      const afterTS = existsSync(join(codexHome, "models_cache.json")) ? await fileText(join(codexHome, "models_cache.json")) : null;
      const go = runGoAt(args, home, codexHome);
      const afterGo = existsSync(join(codexHome, "models_cache.json")) ? await fileText(join(codexHome, "models_cache.json")) : null;
      expect(go).toEqual(ts);
      expect(ts).toMatchObject({ code: 0 });
      // The Go rewrite must leave the same bytes the TS CLI wrote (rollback contract).
      expect(afterGo).toBe(afterTS);
    } finally {
      removeKLock(codexHome);
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test("diffs ocx sync-cache --restart-desktop-app outside Windows", () => {
    const { home, codexHome } = syncRowHomes();
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture-model" }] }));
    try {
      const ts = runTsAt(["sync-cache", "--restart-desktop-app"], home, codexHome);
      const go = runGoAt(["sync-cache", "--restart-desktop-app"], home, codexHome);
      expect(go).toEqual(ts);
    } finally {
      removeKLock(codexHome);
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test.each([
    { args: ["sync-cache"] },
    { args: ["sync-cache", "--json"] },
  ])("diffs ocx sync-cache failure taxonomy for $args", ({ args }) => {
    const { home, codexHome } = syncRowHomes();
    writeFileSync(join(codexHome, "opencodex-catalog.json"), "not-json{");
    try {
      const ts = runTsAt(args, home, codexHome);
      const go = runGoAt(args, home, codexHome);
      expect(go).toEqual(ts);
      expect(ts.code).toBe(1);
    } finally {
      removeKLock(codexHome);
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test.skipIf(process.platform !== "linux")("diffs contended catalog-write-lock behavior", async () => {
    const { home, codexHome } = syncRowHomes();
    writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [{ slug: "fixture-model" }] }));
    let holder: ReturnType<typeof Bun.spawn> | undefined;
    try {
      holder = Bun.spawn([goCLI!, "__catalog-khold"], { cwd: repoRoot, env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome }, stdout: "pipe", stderr: "pipe" });
      const reader = holder.stdout.getReader();
      let heldOutput = "";
      for (let i = 0; i < 300; i++) {
        const chunk = await Promise.race([reader.read(), Bun.sleep(100).then(() => null)]);
        if (!chunk) continue;
        if (chunk.value) heldOutput += new TextDecoder().decode(chunk.value);
        if (chunk.done || heldOutput.includes("HOLDING")) break;
      }
      expect(heldOutput).toContain("HOLDING");
      const ts = runTsAt(["sync-cache"], home, codexHome);
      const tsJSON = runTsAt(["sync-cache", "--json"], home, codexHome);
      const go = runGoAt(["sync-cache"], home, codexHome);
      const goJSON = runGoAt(["sync-cache", "--json"], home, codexHome);
      expect(ts).toMatchObject({ code: 0, stdout: "Another process owns the catalog write; cache sync skipped.\n" });
      expect(go).toEqual(ts);
      expect(goJSON).toEqual(tsJSON);
      expect(tsJSON.stdout).toContain('"reason": "busy"');
    } finally {
      holder?.kill();
      await holder?.exited.catch(() => undefined);
      removeKLock(codexHome);
      if (existsSync(home)) removeTreeWithRetry(home);
      if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
    }
  });
  test("writes byte-identical models_cache from the same catalog in both runtimes", async () => {
    const catalog = JSON.stringify({ models: [{ slug: "gpt-5.5-codex", display_name: "Quo\"te", context_window: 128000, price: 1e21, tiny: 1e-7, nested: { a: [1, 2.5], b: null } }] });
    const tsHome = mkdtempSync(join(tmpdir(), "ocx-go-sync-cache-ts-"));
    const tsCodex = mkdtempSync(join(tmpdir(), "ocx-go-sync-codex-ts-"));
    const goHome = mkdtempSync(join(tmpdir(), "ocx-go-sync-cache-go-"));
    const goCodex = mkdtempSync(join(tmpdir(), "ocx-go-sync-codex-go-"));
    try {
      for (const home of [tsHome, goHome]) writeFileSync(join(home, "config.json"), syncFixtureConfig(true));
      writeFileSync(join(tsCodex, "opencodex-catalog.json"), catalog);
      writeFileSync(join(goCodex, "opencodex-catalog.json"), catalog);
      const ts = runTsAt(["sync-cache"], tsHome, tsCodex);
      const go = runGoAt(["sync-cache"], goHome, goCodex);
      expect(go).toEqual(ts);
      const tsCache = await fileText(join(tsCodex, "models_cache.json"));
      const goCache = await fileText(join(goCodex, "models_cache.json"));
      expect(goCache).toBe(tsCache);
    } finally {
      removeKLock(tsCodex);
      removeKLock(goCodex);
      for (const dir of [tsHome, tsCodex, goHome, goCodex]) if (existsSync(dir)) removeTreeWithRetry(dir);
    }
  });
  async function fileText(path: string): Promise<string> { return new TextDecoder().decode(await Bun.file(path).arrayBuffer()); }
});
