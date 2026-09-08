import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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

  // ocx connect status + ocx disconnect (issue #52): the local client-state
  // surface flipped to Go-owned. Each row seeds an identical home for the TS
  // and Go CLIs (CODEX_HOME is a sibling of the OPENCODEX_HOME config dir) and
  // diffs stdout/stderr/exit code; disconnect rows additionally diff the full
  // resulting file tree so the teardown transaction (token removal, catalog
  // restore, Codex journal unwind, config.json rewrite with rebase provenance)
  // is byte-identical. Catalog ages are wall-clock relative, so those rows
  // normalize the volatile digits before comparison, like normalizeHealthPid.
  const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");
  const sha256b64url = (value: string) => createHash("sha256").update(value)
    .digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const clientToken = "client-token-secret-value";
  const clientTokenHex = sha256hex(clientToken);
  const clientBaseConfig = {
    port: 10111,
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        apiKey: "secret-key",
      },
    },
    defaultProvider: "fixture",
  };
  const clientBlock = {
    serverUrl: "https://hub.example.test",
    managementUrl: "https://hub.example.test",
    managementTransport: "direct",
    selectedClients: ["claude"],
    tokenEnv: "OPENCODEX_API_AUTH_TOKEN",
    apiKeyId: "ck_1",
    tokenFingerprint: clientTokenHex,
    protocolVersion: 1,
    connectedAt: "2026-09-01T00:00:00.000Z",
    catalogSyncedAt: "2026-09-01T00:00:00.000Z",
  };
  const codexInjected = "# Auto-injected by opencodex\nopenai_base_url = \"http://127.0.0.1:10111/v1\"\n";
  const codexOriginal = "# user native config\nmodel = \"gpt-5.2\"\n";
  const codexProfileOriginal = "[default]\nenv = \"prod\"\n";
  const codexProfileInjected = "[default]\nenv = \"prod\"\nbase_url = \"http://127.0.0.1:10111\"\n";
  const remoteCatalog = "{\"catalog\": \"remote-bytes\"}\n";
  interface ClientSeed {
    config?: unknown;
    token?: string | null;
    tokenPrev?: string | null;
    catalog?: string | null;
    codexConfig?: string | null;
    profile?: string | null;
    journal?: unknown | null;
  }
  type ClientSeedProvider = ClientSeed | ((home: string) => ClientSeed);
  function seedClientHome(home: string, provider: ClientSeedProvider): void {
    const seed = typeof provider === "function" ? provider(home) : provider;
    const codex = join(home, "codex");
    mkdirSync(codex, { recursive: true });
    mkdirSync(join(codex, "profiles"), { recursive: true });
    if (seed.config !== undefined) writeFileSync(join(home, "config.json"), JSON.stringify(seed.config, null, 2) + "\n");
    if (seed.token !== undefined && seed.token !== null) writeFileSync(join(home, "service-api-token"), seed.token + "\n");
    if (seed.tokenPrev !== undefined && seed.tokenPrev !== null) {
      const path = join(home, "service-api-token.prev");
      writeFileSync(path, seed.tokenPrev + "\n");
      chmodSync(path, 0o600);
    }
    if (seed.catalog !== undefined && seed.catalog !== null) writeFileSync(join(codex, "opencodex-catalog.json"), seed.catalog);
    if (seed.codexConfig !== undefined && seed.codexConfig !== null) writeFileSync(join(codex, "config.toml"), seed.codexConfig);
    if (seed.profile !== undefined && seed.profile !== null) writeFileSync(join(codex, "profiles", "default.toml"), seed.profile);
    if (seed.journal !== undefined && seed.journal !== null) writeFileSync(join(codex, "opencodex-journal.json"), JSON.stringify(seed.journal));
  }
  function connectedConfig(overrides: Record<string, unknown> = {}, blockOverrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...clientBaseConfig, runtimeRole: "client", client: { ...clientBlock, ...blockOverrides }, ...overrides };
  }
  function codexJournal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      originalConfig: Buffer.from(codexOriginal).toString("base64"),
      originalProfile: null,
      pid: 12345,
      owner: { kind: "client", apiKeyId: "ck_1" },
      timestamp: "2026-09-01T00:00:00.000Z",
      injectedConfigHash: sha256hex(codexInjected),
      injectedProfileHash: null,
      ...overrides,
    };
  }
  function runClientCommand(args: string[], cli: "ts" | "go", home: string): Result {
    const binary = cli === "ts" ? process.execPath : goCLI!;
    const extra = cli === "ts" ? ["src/cli/index.ts"] : [];
    const result = Bun.spawnSync([binary, ...extra, ...args], {
      cwd: repoRoot,
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: join(home, "codex") },
      stdout: "pipe",
      stderr: "pipe",
    });
    return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
  }
  function normalizeClientAge(result: Result): Result {
    return {
      ...result,
      stdout: result.stdout.replace(/(\d+)s old/, "<age>s old").replace(/"catalogAgeSeconds":\s*\d+/, '"catalogAgeSeconds": <age>'),
    };
  }
  function snapshotTree(home: string): Record<string, string> {
    const out: Record<string, string> = {};
    const walk = (dir: string, prefix: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        if (rel === "config-mutation.sqlite") continue;
        const stat = lstatSync(full);
        if (stat.isSymbolicLink()) out[rel] = "<link>";
        else if (stat.isDirectory()) walk(full, rel);
        else out[rel] = readFileSync(full, "utf8");
      }
    };
    walk(home, "");
    return out;
  }
  const cleanedClientHomes: string[] = [];
  function clientParity(
    name: string,
    seed: ClientSeedProvider,
    args: string[],
    options: { compareFiles?: boolean; normalizeAge?: boolean } = {},
  ): void {
    test(`diffs ${name}`, () => {
      const tsHome = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
      const goHome = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
      cleanedClientHomes.push(tsHome, goHome);
      seedClientHome(tsHome, seed);
      seedClientHome(goHome, seed);
      let ts = runClientCommand(args, "ts", tsHome);
      let go = runClientCommand(args, "go", goHome);
      // Catalog ages are wall-clock relative whenever the connection records
      // catalogSyncedAt, so normalize the volatile digits unconditionally.
      ts = normalizeClientAge(ts);
      go = normalizeClientAge(go);
      expect(go).toEqual(ts);
      if (options.compareFiles) expect(snapshotTree(goHome)).toEqual(snapshotTree(tsHome));
    });
  }
  afterEach(() => {
    for (const home of cleanedClientHomes.splice(0)) {
      if (existsSync(home)) removeTreeWithRetry(home);
    }
  });

  describe("connect status + disconnect (issue #52)", () => {
    test.each([
      { name: "connect status argument rejection", args: ["connect", "status", "--wat"] },
      { name: "connect status duplicate --json", args: ["connect", "status", "--json", "--json"] },
      { name: "disconnect argument rejection", args: ["disconnect", "--wat"] },
      { name: "disconnect duplicate --keep-catalog", args: ["disconnect", "--keep-catalog", "--keep-catalog"] },
      { name: "disconnect help (Go-native text)", args: ["help", "disconnect"] },
      { name: "disconnect --help", args: ["disconnect", "--help"] },
      { name: "connect help (still TypeScript-owned)", args: ["help", "connect"] },
      { name: "connect --help", args: ["connect", "--help"] },
    ])("diffs usage/help output and exit code for $name", ({ args }) => {
      const home = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
      cleanedClientHomes.push(home);
      seedClientHome(home, {});
      const ts = runClientCommand(args, "ts", home);
      const go = runClientCommand(args, "go", home);
      expect(go).toEqual(ts);
    });

    // Read surface (connect status) on a freshly seeded home.
    const readRows: Array<{ name: string; seed: ClientSeedProvider; options?: { compareFiles?: boolean; normalizeAge?: boolean } }> = [
      { name: "connect status on an empty home", seed: {}, options: { compareFiles: true } },
      { name: "connect status on a disconnected config", seed: { config: clientBaseConfig }, options: { compareFiles: true } },
      { name: "connect status on a hub-role config", seed: { config: { ...clientBaseConfig, runtimeRole: "hub" } } },
      { name: "connect status on an invalid runtimeRole", seed: { config: { ...clientBaseConfig, runtimeRole: "bogus" } } },
      { name: "connect status on runtimeRole=client without a client block", seed: { config: { ...clientBaseConfig, runtimeRole: "client" } } },
      { name: "connect status on a client block without runtimeRole", seed: { config: { ...clientBaseConfig, client: { serverUrl: "https://hub.example.test" } } } },
      { name: "connect status on a malformed non-object client block", seed: { config: { ...clientBaseConfig, runtimeRole: "client", client: "just-a-string" } } },
      { name: "connect status on a malformed tokenFingerprint", seed: { config: connectedConfig({}, { tokenFingerprint: "not-hex-64" }) } },
      { name: "connect status on a malformed managementTransport", seed: { config: connectedConfig({}, { managementTransport: "webrtc" }) } },
      { name: "connect status on a malformed serverUrl", seed: { config: connectedConfig({}, { serverUrl: "https://hub.example.test/v1" }) } },
      { name: "connect status on a malformed connectedAt", seed: { config: connectedConfig({}, { connectedAt: "yesterday" }) } },
      { name: "connect status on a malformed pendingOperation.kind", seed: { config: connectedConfig({}, { pendingOperation: { kind: "bogus" } }) } },
      { name: "connect status on a malformed protocolVersion", seed: { config: connectedConfig({}, { protocolVersion: 2 }) } },
      { name: "connect status on an empty selectedClients", seed: { config: connectedConfig({}, { selectedClients: [] }) } },
      { name: "connect status connected without a token file", seed: { config: connectedConfig() }, options: { compareFiles: true } },
      { name: "connect status connected with an owned token", seed: { config: connectedConfig(), token: clientToken }, options: { compareFiles: true } },
      { name: "connect status connected with a foreign token", seed: { config: connectedConfig(), token: "some-other-secret" } },
      { name: "connect status connected with a remote catalog", seed: { config: connectedConfig(), token: clientToken, catalog: remoteCatalog }, options: { compareFiles: true, normalizeAge: true } },
      { name: "connect status orphan .prev cleanup", seed: { config: connectedConfig(), token: clientToken, tokenPrev: "old-rotation-secret" }, options: { compareFiles: true } },
      { name: "connect status with a pending key rotation", seed: (home: string) => ({
        config: connectedConfig({}, {
          pendingOperation: {
            kind: "rotate",
            rotationId: "rot_123",
            newKeyIssuedAt: "2026-09-01T00:00:00.000Z",
            oldKeyBackupPath: join(home, "service-api-token.prev"),
          },
        }),
        token: clientToken,
        tokenPrev: "old-rotation-secret",
      }), options: { normalizeAge: false } },
    ];
    for (const row of readRows) {
      clientParity(`${row.name} (human)`, row.seed, ["connect", "status"], row.options);
      clientParity(`${row.name} (--json)`, row.seed, ["connect", "status", "--json"], row.options);
    }
    test("diffs connect status against a dangling service-api-token symlink", () => {
      const tsHome = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
      const goHome = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
      cleanedClientHomes.push(tsHome, goHome);
      for (const home of [tsHome, goHome]) {
        seedClientHome(home, { config: connectedConfig(), token: null });
        symlinkSync("/nonexistent/client-token-target", join(home, "service-api-token"));
      }
      const ts = runClientCommand(["connect", "status", "--json"], "ts", tsHome);
      const go = runClientCommand(["connect", "status", "--json"], "go", goHome);
      expect(go).toEqual(ts);
    });

    // Disconnect teardown transaction: stdout parity plus byte-identical trees.
    const disconnectRows: Array<{ name: string; seed: ClientSeedProvider; args?: string[] }> = [
      { name: "disconnect on an empty home", seed: {} },
      { name: "disconnect on a disconnected config", seed: { config: clientBaseConfig } },
      { name: "disconnect connected with token missing", seed: { config: connectedConfig() } },
      { name: "disconnect connected with a changed token", seed: { config: connectedConfig(), token: "some-other-secret" } },
      { name: "disconnect a connected claude client", seed: { config: connectedConfig(), token: clientToken } },
      { name: "disconnect a connected claude client (--json)", seed: { config: connectedConfig(), token: clientToken }, args: ["disconnect", "--json"] },
      { name: "disconnect keeping the remote catalog", seed: { config: connectedConfig(), token: clientToken, catalog: remoteCatalog }, args: ["disconnect", "--keep-catalog", "--json"] },
      { name: "disconnect removing the remote catalog", seed: { config: connectedConfig(), token: clientToken, catalog: remoteCatalog }, args: ["disconnect", "--json"] },
      { name: "disconnect restoring the prior catalog snapshot", seed: {
        config: connectedConfig({}, {
          catalogFingerprint: sha256b64url(remoteCatalog),
          priorCatalog: Buffer.from("{\"my\": \"prior catalog\"}\n").toString("base64"),
        }),
        token: clientToken,
        catalog: remoteCatalog,
      }, args: ["disconnect", "--json"] },
      { name: "disconnect refusal when the catalog changed ownership", seed: { config: connectedConfig(), token: clientToken, catalog: "{\"someone\": \"else\"}\n" } },
      { name: "disconnect unwinding a client-owned Codex journal", seed: {
        config: connectedConfig({}, { selectedClients: ["codex", "claude"] }),
        token: clientToken,
        codexConfig: codexInjected,
        journal: codexJournal(),
      }, args: ["disconnect", "--json"] },
      { name: "disconnect unwinding a process-owned Codex journal", seed: {
        config: connectedConfig({}, { selectedClients: ["codex"] }),
        token: clientToken,
        codexConfig: codexInjected,
        journal: codexJournal({ owner: { kind: "process", pid: 4242 } }),
      } },
      { name: "disconnect restoring the Codex profile from the journal", seed: {
        config: connectedConfig({}, { selectedClients: ["codex"] }),
        token: clientToken,
        codexConfig: codexInjected,
        profile: codexProfileInjected,
        journal: codexJournal({
          originalProfile: Buffer.from(codexProfileOriginal).toString("base64"),
          injectedProfileHash: sha256hex(codexProfileInjected),
        }),
      }, args: ["disconnect", "--json"] },
      { name: "disconnect refusal when routing is injected without a journal", seed: {
        config: connectedConfig({}, { selectedClients: ["codex"] }),
        token: clientToken,
        codexConfig: codexInjected,
      } },
      { name: "disconnect refusal when the journal belongs to another key", seed: {
        config: connectedConfig({}, { selectedClients: ["codex"] }),
        token: clientToken,
        codexConfig: codexInjected,
        journal: codexJournal({ owner: { kind: "client", apiKeyId: "ck_OTHER" } }),
      } },
      { name: "disconnect refusal when the Codex config diverged from the journal", seed: {
        config: connectedConfig({}, { selectedClients: ["codex"] }),
        token: clientToken,
        codexConfig: codexInjected + "model = \"user-touched\"\n",
        journal: codexJournal(),
      } },
      { name: "disconnect leaves a stale Codex journal alone for a claude-only client", seed: {
        config: connectedConfig(),
        token: clientToken,
        codexConfig: codexInjected,
        journal: codexJournal(),
      }, args: ["disconnect", "--json"] },
      { name: "disconnect while an orphan .prev backup exists", seed: { config: connectedConfig(), token: clientToken, tokenPrev: "old-rotation-secret" }, args: ["disconnect", "--json"] },
    ];
    for (const row of disconnectRows) {
      clientParity(`${row.name}`, row.seed, row.args ?? ["disconnect"], { compareFiles: true });
    }
  });
  });
