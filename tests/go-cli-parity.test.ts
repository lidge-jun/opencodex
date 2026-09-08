import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
function goToolchainAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], {
    stdout: "ignore",
    stderr: "ignore",
  }).success;
}
function buildGoCLI(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-cli-"));
  const binary = join(dir, process.platform === "win32" ? "ocx.exe" : "ocx");
  const result = Bun.spawnSync(["go", "build", "-o", binary, "./cmd/ocx"], {
    cwd: join(repoRoot, "go"),
    env: { ...process.env, CGO_ENABLED: "0" },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0)
    throw new Error(
      `go build ./cmd/ocx failed: ${new TextDecoder().decode(result.stderr)}`,
    );
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
  const result = Bun.spawnSync(
    [process.execPath, "src/cli/index.ts", ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, OPENCODEX_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
function runGo(args: Argv, home = testHome): Result {
  const result = Bun.spawnSync([ensureGoBinary(), ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
async function runTsAsync(args: Argv, home = testHome): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}
async function runGoAsync(args: Argv, home = testHome): Promise<Result> {
  const child = Bun.spawn([ensureGoBinary(), ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}
function attestedHeaders(
  challenge: string,
  port: number,
): Record<string, string> {
  const proof = createLocalAttestationProof(
    secret,
    challenge,
    process.pid,
    port,
  );
  return proof === null ? {} : { "x-opencodex-attestation-proof": proof };
}
// attestedFixtureHeaders answers the findLiveProxy attestation challenge the
// way the management plane does (proof echoed back when a challenge is sent).
function attestedFixtureHeaders(challenge: string, port: number): HeadersInit {
  if (!challenge) return {};
  const proof = createLocalAttestationProof(
    secret,
    challenge,
    process.pid,
    port,
  );
  return { "x-opencodex-attestation-proof": proof ?? "" };
}
function expectParity(args: Argv): Result {
  const ts = runTs(args);
  const go = runGo(args);
  expect(go).toEqual(ts);
  return ts;
}

function normalizeHealthPid(result: Result): Result {
  if (
    !result.stdout.startsWith("Proxy healthy") &&
    !result.stdout.startsWith('{"ok":true')
  )
    return result;
  return {
    ...result,
    stdout: result.stdout
      .replace(/PID (?:null|\d+)/, "PID <pid>")
      .replace(/"pid":(?:null|\d+)/, '"pid":<pid>'),
  };
}
afterEach(async () => {
  testServer?.stop(true);
  testServer = undefined;
  delete process.env.OPENCODEX_HOME;
  delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  if (testHome && existsSync(testHome)) removeTreeWithRetry(testHome);
  testHome = "";
});
function startAttestedFixture(status: "ready" | "pending" | "failed"): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
  testServer = Bun.serve({
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/healthz") {
        const challenge =
          request.headers.get("x-opencodex-attestation-challenge") ?? "";
        const headers = attestedHeaders(challenge, testServer!.port!);
        return Response.json(
          {
            status: "ok",
            service: "opencodex",
            version: "2.42.0",
            uptime: 1,
            pid: process.pid,
            port: testServer!.port,
          },
          { headers },
        );
      }
      if (path === "/readyz")
        return Response.json(
          {
            status,
            service: "opencodex",
            version: "2.42.0",
            uptime: 1,
            pid: process.pid,
            port: testServer!.port,
          },
          { status: status === "ready" ? 200 : 503 },
        );
      return new Response("not found", { status: 404 });
    },
  });
  writeFileSync(
    join(testHome, "runtime-port.json"),
    JSON.stringify({
      pid: process.pid,
      port: testServer.port,
      hostname: "127.0.0.1",
      attestationSecret: secret,
    }),
  );
}
// sync/sync-cache decide from CODEX_HOME as well; these runners drive both CLIs
// against the same pair of fresh homes exactly like a real invocation would.
function runTsAt(args: Argv, home: string, codexHome: string): Result {
  const result = Bun.spawnSync(
    [process.execPath, "src/cli/index.ts", ...args],
    {
      cwd: repoRoot,
      env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
function runGoAt(args: Argv, home: string, codexHome: string): Result {
  const result = Bun.spawnSync([ensureGoBinary(), ...args], {
    cwd: repoRoot,
    env: { ...process.env, OPENCODEX_HOME: home, CODEX_HOME: codexHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}
function removeKLock(codexHome: string): void {
  // Best-effort: drop the K lock database this Codex home hashes to so the
  // suite does not accumulate per-run artifacts under the runtime root.
  try {
    const uid = process.getuid?.();
    if (uid === undefined) return;
    const digest = createHash("sha256").update(codexHome).digest("hex");
    const db = join(
      tmpdir(),
      `opencodex-runtime-v1-${uid}`,
      "catalog-write-locks",
      `${digest}.sqlite`,
    );
    rmSync(db, { force: true });
  } catch {
    /* cleanup is best-effort */
  }
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
/** Async variant that pipes `input` (or empty, when null) to the child's stdin. */
async function runTsAsyncInput(
  args: readonly string[],
  input: string | null,
  home = testHome,
): Promise<Result> {
  const child = Bun.spawn([process.execPath, "src/cli/index.ts", ...args], {
    cwd: repoRoot,
    env: parityEnv(home),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== null) child.stdin.write(input);
  child.stdin.end();
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}
async function runGoAsyncInput(
  args: readonly string[],
  input: string | null,
  home = testHome,
): Promise<Result> {
  const child = Bun.spawn([ensureGoBinary(), ...args], {
    cwd: repoRoot,
    env: parityEnv(home),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (input !== null) child.stdin.write(input);
  child.stdin.end();
  return {
    code: await child.exited,
    stdout: await new Response(child.stdout).text(),
    stderr: await new Response(child.stderr).text(),
  };
}
/**
 * A hermetic child env. The account-auth device-flow handlers import
 * src/codex/paths.ts at module load, which resolves CODEX_HOME eagerly; the
 * harness sandbox that CODEX_HOME points to can be reaped mid-suite (and is
 * irrelevant to the stub-proxy flows under test), so drop it and let the
 * default ~/.codex fall through exactly as it does for every other row.
 */
function parityEnv(home: string): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    OPENCODEX_HOME: home,
  };
  delete env.CODEX_HOME;
  return env;
}

describe.skipIf(!goAvailable || goCLI === null)(
  "Go CLI parity (ADR-0008, ticket #35)",
  () => {
    test.each([
      { args: ["--version"] },
      { args: ["-v"] },
      { args: ["version"] },
    ])("diffs version output and exit code for $args", ({ args }) => {
      expect(expectParity(args)).toMatchObject({ code: 0, stderr: "" });
    });
    test.each([
      { args: [] },
      { args: ["--help"] },
      { args: ["-h"] },
      { args: ["help"] },
      { args: ["help", "health"] },
      { args: ["health", "--help"] },
      { args: ["help", "ready"] },
      { args: ["ready", "--help"] },
    ])("diffs help output and exit code for $args", ({ args }) => {
      expectParity(args);
    });
    test("diffs unknown-command output and exit code", () => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
      expect(expectParity(["not-a-command"])).toMatchObject({
        code: 1,
        stderr: "Unknown command: not-a-command\n",
      });
    });
    test.each([
      { args: ["health"] },
      { args: ["health", "--json"] },
      { args: ["ready"] },
      { args: ["ready", "--json"] },
    ])(
      "diffs unavailable command output and exit code for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
        expectParity(args);
      },
    );
    test.each([
      { args: ["health"] },
      { args: ["health", "--json"] },
      { args: ["ready"] },
      { args: ["ready", "--json"] },
    ])(
      "diffs live ready command output and exit code for $args",
      async ({ args }) => {
        startAttestedFixture("ready");
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(normalizeHealthPid(go)).toEqual(normalizeHealthPid(ts));
      },
    );
    test.each(["pending", "failed"] as const)(
      "diffs live %s readiness JSON",
      (status) => {
        startAttestedFixture(status);
        expectParity(["ready", "--json"]);
      },
    );
    test.each([
      { args: ["ready", "--timeout", "5"] },
      { args: ["ready", "--wait", "--timeout", "0"] },
      { args: ["ready", "--wait", "--timeout", "301"] },
      { args: ["ready", "--wat"] },
    ])("diffs ready usage output and exit code for $args", ({ args }) => {
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
    ])(
      "diffs config, models, and provider output and exit code for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
        writeFileSync(
          join(testHome, "config.json"),
          JSON.stringify({
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
          }),
        );
        expectParity(args);
      },
    );
    test("diffs native config writes from argument parsing through persistence", () => {
      const home = mkdtempSync(join(tmpdir(), "ocx-go-config-parity-"));
      const configPath = join(home, "config.json");
      const exportPath = join(home, "export.json");
      const importPath = join(home, "import.json");
      const invalidImportPath = join(home, "invalid-import.json");
      const initial = {
        port: 10100,
        providers: {
          fixture: {
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
            apiKey: "secret-key",
          },
        },
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
        providers: {
          fixture: {
            adapter: "openai-chat",
            baseUrl: "https://example.test/v1",
          },
        },
        defaultProvider: "fixture",
        appOwnedMemoryBudgetMb: 128,
      });
      try {
        writeFileSync(configPath, initial);
        const ts = runTs(
          ["config", "set", "appOwnedMemoryBudgetMb", "63", "--json"],
          home,
        );
        const afterTS = await Bun.file(configPath).text();
        writeFileSync(configPath, initial);
        const go = runGo(
          ["config", "set", "appOwnedMemoryBudgetMb", "63", "--json"],
          home,
        );
        const afterGo = await Bun.file(configPath).text();
        expect(go).toEqual(ts);
        expect(afterTS).toBe(initial);
        expect(afterGo).toBe(initial);
      } finally {
        removeTreeWithRetry(home);
      }
    });
    test.each([
      { args: ["service", "status"] },
      { args: ["service", "not-a-command"] },
      { args: ["codex-shim", "status"] },
      { args: ["codex-shim", "not-a-command"] },
      { args: ["tray", "status"] },
      { args: ["tray", "not-a-command"] },
    ])(
      "diffs TypeScript-owned lifecycle command output and exit code for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
        expectParity(args);
      },
    );
    test.each([
      { args: ["status"] },
      { args: ["status", "--json"] },
      { args: ["doctor", "--json"] },
    ])(
      "diffs Go-owned status and doctor output and exit code for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
        expectParity(args);
      },
    );
    test.each([
      { args: ["help", "tray"] },
      { args: ["tray", "--help"] },
      { args: ["help", "service"] },
      { args: ["service", "--help"] },
      { args: ["help", "codex-shim"] },
      { args: ["codex-shim", "--help"] },
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
      testServer = Bun.serve({
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = attestedHeaders(challenge, testServer!.port!);
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          return new Response(payload, {
            status,
            headers: { "content-type": "application/json" },
          });
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
    }
    const usagePayload = JSON.stringify({
      range: "today",
      surface: "all",
      since: 1756000000000,
      summary: {
        requests: 1447,
        totalTokens: 178521375,
        inputTokens: 4489102,
        outputTokens: 1283441,
        cachedInputTokens: 172748832,
        estimatedCostUsd: 12.3456,
        unpricedRequests: 0,
        unmeteredRequests: 0,
      },
      providers: [
        {
          provider: "xai",
          requests: 1447,
          totalTokens: 178521375,
          estimatedCostUsd: 12.3456,
        },
      ],
      models: [
        {
          provider: "xai",
          model: "grok-4.6",
          requests: 1447,
          totalTokens: 178521375,
          estimatedCostUsd: 12.3456,
        },
      ],
      days: [
        {
          date: "2026-08-22",
          requests: 1447,
          totalTokens: 178521375,
          estimatedCostUsd: 12.3456,
        },
      ],
      accounts: [],
    });
    test.each([
      { args: ["usage"] },
      { args: ["usage", "--json"] },
      { args: ["usage", "--range", "7d"] },
      { args: ["usage", "--provider", "xai", "--json"] },
      { args: ["observe", "usage", "--json"] },
    ])(
      "diffs Go-owned usage output and exit code for $args",
      async ({ args }) => {
        startUsageFixture(usagePayload);
        // spawnSync blocks Bun's event loop, which starves the fixture server the
        // same way the #43 drill hit; live-fixture rows drive both CLIs async.
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
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
      testServer = Bun.serve({
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const proof = challenge
              ? createLocalAttestationProof(
                  secret,
                  challenge,
                  process.pid,
                  testServer!.port as number,
                )
              : null;
            const headers: Record<string, string> = proof
              ? { "x-opencodex-attestation-proof": proof }
              : {};
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          const route = routes[path];
          if (!route) return new Response("not found", { status: 404 });
          if (route.raw !== undefined)
            return new Response(route.raw, { status: route.status ?? 200 });
          return Response.json(route.body, { status: route.status ?? 200 });
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
    }
    const readRoutes = (): Record<string, { body: unknown }> => ({
      "/api/logs": {
        body: {
          timeZone: "Asia/Shanghai",
          total: 2,
          logs: [
            {
              requestId: "ocx-1111111111",
              timestamp: 1788818801331,
              provider: "fixture",
              model: "fixture-model",
              status: 502,
              durationMs: 344,
              conversationId: "conv-abc-123",
            },
            {
              createdAt: "2026-08-22T10:00:00Z",
              provider: "xai",
              model: "grok-4.6",
              statusCode: 200,
            },
          ],
        },
      },
      "/api/system/memory": {
        body: {
          pid: 4242,
          bunVersion: "1.3.14",
          platform: "linux",
          uptimeSeconds: 123.456,
          rss: 104857600,
          heapUsed: 33554432,
          observedMetric: "rss",
          jscHeap: { heapSize: 33554432, objectCount: 1024 },
          responseState: { count: 0 },
          appOwnedBytes: {
            budgetBytes: 268435456,
            stores: { a: { b: 1 } },
            observedInFlight: [1, 2, 3],
          },
          streamMode: "auto",
          eagerRelay: null,
          watchdog: { warnThresholdBytes: 4294967296, samples: [1, 2] },
          isDraining: false,
          freeHeapRatioHistory: [0.5, null, 0.4],
        },
      },
      "/api/request-history/req-1/route-decision": {
        body: {
          requestId: "req-1",
          routeDecision: {
            version: 1,
            decisionId: "d1",
            candidates: [{ provider: "fixture", eligible: true }],
          },
          attemptSequence: [],
        },
      },
      "/api/config": {
        body: {
          port: 10100,
          defaultProvider: "fixture",
          codexAutoStart: true,
          providers: { fixture: { adapter: "openai-chat", hasApiKey: true } },
          tiers: null,
        },
      },
      "/api/catalog": {
        body: {
          models: [
            {
              slug: "fixture-model",
              display_name: "Fixture",
              visibility: "list",
              service_tiers: [{ id: "priority", name: "Fast" }],
            },
          ],
          source: "catalog",
        },
      },
      "/api/routing-analytics": {
        body: {
          generatedAt: 1788818834015,
          totalRequests: 1,
          confidence: "low",
          successRate: 0,
          failureRate: 1,
          durationMs: { p50: 344, sampleCount: 1 },
          breakdown: [{ provider: "fixture", count: 1 }],
          profileBreakdown: [],
          priceCoverage: null,
          estimatedCostUsdPerSuccessfulRequest: null,
        },
      },
      "/api/provider-request-pacing": {
        body: {
          fixture: {
            provider: "fixture",
            enabled: false,
            queued: 0,
            nextSlotInMs: 0,
          },
        },
      },
      "/api/key-providers": {
        body: {
          providers: [
            {
              id: "anthropic-apikey",
              label: "Anthropic (API key)",
              models: ["claude-sonnet-5", "claude-opus-5"],
              liveModels: true,
            },
            { id: "openai-apikey", label: "OpenAI API", models: [] },
          ],
        },
      },
      "/api/codex-prompt": {
        body: {
          configPath: "/home/u/.codex/config.toml",
          configExists: true,
          readable: true,
          drift: null,
          inventory: [{ id: "base-instructions", class: "base", order: 0 }],
          layers: { base: "text" },
        },
      },
      "/api/codex-prompt/text": {
        body: "You are Codex, the world's most advanced coding agent.\n",
      },
      "/api/client-config": {
        body: {
          clientId: "codex",
          baseUrl: "http://127.0.0.1:10100",
          env: { OPENAI_BASE_URL: "http://127.0.0.1:10100/v1" },
        },
      },
      "/api/github/star": {
        body: {
          state: "not-starred",
          repo: "waxiangzi/opencodex",
          url: "https://github.com/waxiangzi/opencodex",
        },
      },
      "/api/windows-tray": {
        body: {
          supported: false,
          installed: false,
          running: false,
          stale: false,
          summary: "unsupported on linux",
        },
      },
    });
    test.each([
      { args: ["help", "logs"] },
      { args: ["logs", "--help"] },
      { args: ["help", "memory"] },
      { args: ["memory", "--help"] },
      { args: ["help", "inspect"] },
      { args: ["inspect", "--help"] },
    ])("diffs logs/memory/inspect help contracts for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
      expect(expectParity(args)).toMatchObject({ code: 0, stderr: "" });
    });
    test.each([
      { args: ["logs"] },
      { args: ["logs", "--json"] },
      { args: ["logs", "--jsonl"] },
      { args: ["logs", "--provider", "fixture"] },
      { args: ["logs", "--status", "502"] },
      { args: ["logs", "--limit", "1"] },
      { args: ["logs", "explain", "req-1"] },
      { args: ["logs", "explain", "req-1", "--json"] },
      { args: ["memory"] },
      { args: ["memory", "--json"] },
      { args: ["memory", "--limit", "3"] },
      { args: ["inspect"] },
      { args: ["inspect", "config"] },
      { args: ["inspect", "config", "--json"] },
      { args: ["inspect", "catalog"] },
      { args: ["inspect", "routing-analytics"] },
      { args: ["inspect", "pacing"] },
      { args: ["inspect", "pacing", "--name", "fixture"] },
      { args: ["inspect", "key-providers"] },
      { args: ["inspect", "codex-prompt"] },
      { args: ["inspect", "codex-prompt", "--text"] },
      { args: ["inspect", "client-config", "--client", "codex"] },
      { args: ["inspect", "client-config", "--client", "codex", "--json"] },
      { args: ["inspect", "star"] },
      { args: ["inspect", "star", "--json"] },
      { args: ["inspect", "windows-tray"] },
    ])(
      "diffs Go-owned logs/memory/inspect reads against the management fixture for $args",
      async ({ args }) => {
        startReadsFixture(readRoutes());
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["logs", "extra"] },
      { args: ["logs", "--json", "--jsonl"] },
      { args: ["logs", "--follow", "--json"] },
      { args: ["logs", "--provider"] },
      { args: ["logs", "--limit", "0"] },
      { args: ["logs", "--limit", "abc"] },
      { args: ["logs", "explain"] },
      { args: ["memory", "extra"] },
      { args: ["memory", "--limit", "x"] },
      { args: ["inspect", "nope"] },
      { args: ["inspect", "client-config"] },
      { args: ["inspect", "client-config", "--client"] },
      { args: ["inspect", "codex-prompt", "--text", "--json"] },
      { args: ["inspect", "codex-prompt", "extra"] },
      { args: ["inspect", "pacing", "--name"] },
      { args: ["inspect", "--bogus"] },
      // rejectArgs must redact secret-option values before reporting leftovers
      // (runtime-api.ts SECRET_OPTIONS); a regression here would echo the
      // credential to stderr.
      { args: ["logs", "--token", "supersecret"] },
      { args: ["memory", "--admin-token", "supersecret"] },
    ])(
      "diffs logs/memory/inspect argument validation for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
        expect(expectParity(args)).toMatchObject({ code: 2 });
      },
    );
    test.each([
      { args: ["logs"] },
      { args: ["memory"] },
      { args: ["inspect"] },
      { args: ["logs", "explain", "req-missing"] },
    ])(
      "diffs logs/memory/inspect when no proxy is running for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-reads-parity-"));
        expect(expectParity(args)).toMatchObject({ code: 1 });
      },
    );
    test.each([
      {
        args: ["logs"],
        routes: { "/api/logs": { status: 500, raw: "boom" } },
        code: 1,
      },
      {
        args: ["memory"],
        routes: {
          "/api/system/memory": {
            status: 404,
            body: { error: "missing state" },
          },
        },
        code: 4,
      },
      {
        args: ["inspect", "config"],
        routes: {
          "/api/config": {
            status: 401,
            body: { error: "bad key", hint: "run ocx auth login" },
          },
        },
        code: 1,
      },
      {
        args: ["inspect", "codex-prompt", "--text"],
        routes: {
          "/api/codex-prompt/text": { status: 503, raw: "gateway down" },
        },
        code: 1,
      },
      {
        args: ["inspect", "star"],
        routes: {
          "/api/github/star": {
            status: 418,
            body: { detail: "teapot", message: "I'm a teapot" },
          },
        },
        code: 1,
      },
      {
        args: ["inspect", "catalog"],
        routes: {
          "/api/catalog": {
            status: 409,
            body: { error: "catalog busy", hint: "retry after sync" },
          },
        },
        code: 5,
      },
      // A 2xx empty body parses to JS null (only non-empty text is parsed), so
      // --json re-emits JSON.stringify(null) = "null" in both CLIs.
      {
        args: ["memory", "--json"],
        routes: { "/api/system/memory": { status: 200, raw: "" } },
        code: 0,
      },
    ] as Array<{
      args: readonly string[];
      routes: Record<string, RouteFixture>;
      code: number;
    }>)(
      "diffs logs/memory/inspect management error output and exit code for $args",
      async ({ args, routes, code }) => {
        startReadsFixture(routes);
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code });
      },
    );

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
    ])(
      "diffs Go-owned capabilities output and exit code for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
        expectParity(args);
      },
    );

    // observe dispatches natively per subcommand (ADR-0008 issue #46); the
    // rebuild-index / index-status actions read the Bun:sqlite index directly, so
    // they keep the TypeScript owner at the action level and delegate.
    test.each([
      { args: ["observe", "logs", "rebuild-index"] },
      { args: ["observe", "logs", "index-status"] },
    ])(
      "diffs TypeScript-owned observe indexer delegation for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
        expectParity(args);
      },
    );
    test.each([
      { args: ["observe", "wat"] },
      { args: ["observe", "logs", "--limit", "0"] },
      { args: ["observe", "logs", "--json", "--jsonl"] },
      { args: ["observe", "logs", "--follow", "--json"] },
      {
        args: ["observe", "storage", "codex-logs", "protect", "--mode", "wat"],
      },
    ])("diffs observe usage validation for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
      expect(expectParity(args)).toMatchObject({ code: 2 });
    });
    test("diffs observe and export help in both spellings", () => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-cli-parity-"));
      for (const args of [
        ["help", "observe"],
        ["observe", "--help"],
        ["observe", "logs", "--help"],
        ["help", "export"],
        ["export", "--help"],
        ["export", "--client", "pi", "--help"],
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
      testServer = Bun.serve({
        port: 0,
        fetch(request) {
          const u = new URL(request.url);
          if (u.pathname === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = attestedHeaders(challenge, testServer!.port!);
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          if (u.pathname === "/api/models") {
            return Response.json([
              {
                namespaced: "openai/gpt-5.1-codex",
                provider: "openai",
                id: "gpt-5.1-codex",
                native: true,
                displayName: "GPT-5.1 Codex",
                displayNameSource: "provider",
                contextWindow: 400000,
                reasoningEfforts: [
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                  "ultra",
                ],
                defaultReasoningEffort: "medium",
              },
              {
                namespaced: "anthropic/claude-sonnet-4-5",
                provider: "anthropic",
                id: "claude-sonnet-4-5",
                displayName: "Claude Sonnet 4.5",
                displayNameSource: "provider",
                contextWindow: 200000,
                inputModalities: ["text", "image"],
                reasoningEfforts: ["low", "medium", "high"],
              },
              {
                namespaced: "fixture/audio-model",
                provider: "fixture",
                id: "audio-model",
                displayName: "Audio Only",
                displayNameSource: "fallback",
                contextWindow: 0,
                inputModalities: ["audio"],
                reasoningEfforts: ["none"],
              },
              {
                namespaced: "fixture/plain",
                provider: "fixture",
                id: "plain",
                displayName: "Plain",
                displayNameSource: "provider",
              },
              {
                namespaced: "fixture/o-brien",
                provider: "fixture",
                id: "o-brien",
                displayName: 'O\'Brien "Wired" Model',
                displayNameSource: "provider",
                contextWindow: 64000,
              },
              {
                namespaced: "fixture/ctrl",
                provider: "fixture",
                id: "ctrl",
                displayName: "Ctrl\u0001\u0007\u001bModel",
                displayNameSource: "provider",
              },
            ]);
          }
          if (u.pathname === "/api/logs") {
            const all = [
              {
                id: "req-1",
                timestamp: "2026-09-07T10:00:00.000Z",
                provider: "anthropic",
                model: "claude-sonnet-4-5",
                status: 200,
                durationMs: 1234.5,
                conversationId: "convA",
              },
              {
                id: "req-2",
                timestamp: "2026-09-07T10:00:01.000Z",
                provider: "openai",
                model: null,
                status: 429,
                conversationId: "",
              },
              {
                id: 3,
                timestamp: null,
                createdAt: "2026-09-07T09:00:00.000Z",
                statusCode: 500,
                durationMs: 2,
              },
              { timestamp: "2026-09-07T08:00:00.000Z", status: 200 },
            ];
            const provider = u.searchParams.get("provider");
            const model = u.searchParams.get("model");
            const status = u.searchParams.get("status");
            const conversationId = u.searchParams.get("conversationId");
            const filtered = all.filter(
              (row) =>
                (!provider || row.provider === provider) &&
                (!model || row.model === model) &&
                (!status ||
                  String(row.status) === status ||
                  String(row.statusCode) === status) &&
                (!conversationId || row.conversationId === conversationId),
            );
            return Response.json({
              timeZone: "UTC",
              total: filtered.length,
              logs: filtered,
            });
          }
          if (u.pathname === "/api/request-history/req-1/route-decision") {
            return Response.json({
              requestId: "req-1",
              route: {
                provider: "anthropic",
                model: "claude-sonnet-4-5",
                reason: "match",
              },
              usedFallback: false,
            });
          }
          if (u.pathname === "/api/system/memory")
            return Response.json({
              heap: 123456789,
              heapPeak: 200000000,
              gc: { count: 42, durationMs: 3.5 },
              items: 7,
            });
          if (u.pathname === "/api/debug")
            return Response.json({
              debug: true,
              usage: false,
              injection: null,
              claude: { enabled: false },
              reset: false,
            });
          if (u.pathname === "/api/claude/inbound-debug")
            return Response.json({
              enabled: true,
              entries: [
                {
                  ts: 1756000000000,
                  method: "POST",
                  path: "/api/claude/inbound",
                },
              ],
            });
          if (u.pathname === "/api/debug/injection-logs")
            return Response.json({
              after: 0,
              entries: [
                { ts: 1756000000000, kind: "prompt", bytes: 128 },
                { ts: 1756000000001, kind: "response", bytes: null },
              ],
            });
          if (u.pathname === "/api/storage")
            return Response.json({
              codexLogs: { present: true, files: 12, sizeBytes: 4096 },
              sessions: { archived: 3 },
            });
          if (u.pathname === "/api/storage/codex-logs")
            return Response.json({
              mode: "compat",
              protected: true,
              files: 12,
            });
          if (u.pathname === "/api/storage/codex-logs/protect")
            return Response.json({ mode: "quiet", protected: true });
          if (
            u.pathname === "/api/storage/codex-logs/repair" ||
            u.pathname === "/api/storage/codex-logs/compact" ||
            u.pathname === "/api/storage/codex-logs/unprotect"
          ) {
            return Response.json({ ok: true });
          }
          return new Response("not found", { status: 404 });
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
      writeFileSync(
        join(testHome, "config.json"),
        JSON.stringify({
          port: testServer.port,
          hostname: "127.0.0.1",
          defaultProvider: "fixture",
          providers: {
            openai: {
              adapter: "openai-responses",
              baseUrl: "https://chatgpt.com/backend-api/codex",
            },
            anthropic: {
              adapter: "anthropic",
              baseUrl: "https://api.anthropic.com",
            },
            fixture: {
              adapter: "openai-chat",
              baseUrl: "https://example.test/v1",
              apiKey: "k",
              defaultModel: "plain",
            },
          },
        }),
      );
    }
    test.each([
      { args: ["observe"] },
      { args: ["observe", "logs"] },
      { args: ["observe", "logs", "--json"] },
      { args: ["observe", "logs", "--jsonl"] },
      { args: ["observe", "logs", "--provider", "anthropic"] },
      { args: ["observe", "logs", "--model", "claude-sonnet-4-5"] },
      { args: ["observe", "logs", "--status", "200"] },
      { args: ["observe", "logs", "--conversation", "convA"] },
      { args: ["observe", "logs", "--status", "429", "--conversation", "x"] },
      { args: ["observe", "logs", "--limit", "2"] },
      { args: ["observe", "logs", "explain", "req-1"] },
      { args: ["observe", "logs", "explain", "req-1", "--json"] },
      { args: ["observe", "memory"] },
      { args: ["observe", "memory", "--json"] },
      { args: ["observe", "debug"] },
      { args: ["observe", "debug", "--json"] },
      { args: ["observe", "claude-inbound"] },
      { args: ["observe", "injection"] },
      { args: ["observe", "injection", "--limit", "1"] },
      { args: ["observe", "storage"] },
      { args: ["observe", "storage", "--json"] },
      { args: ["observe", "storage", "codex-logs"] },
      { args: ["observe", "storage", "codex-logs", "status", "--json"] },
      { args: ["observe", "storage", "codex-logs", "protect"] },
      {
        args: [
          "observe",
          "storage",
          "codex-logs",
          "protect",
          "--mode",
          "quiet",
          "--json",
        ],
      },
      { args: ["observe", "storage", "codex-logs", "repair"] },
      { args: ["observe", "storage", "codex-logs", "compact", "--json"] },
      { args: ["observe", "storage", "codex-logs", "unprotect", "--json"] },
    ])(
      "diffs Go-owned observe output and exit code for $args",
      async ({ args }) => {
        startExportFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    const exportClientIds = [
      "opencode",
      "pi",
      "omp",
      "hermes",
      "openclaw",
      "kimi",
      "gajae",
      "dsh",
      "mcode",
      "zcode",
      "prime",
    ];
    test.each(
      exportClientIds.flatMap((id) => [
        { args: ["export", "--client", id, "--json"] },
        { args: ["export", "--client", id] },
      ]),
    )(
      "diffs Go-owned export output and exit code for $args",
      async ({ args }) => {
        startExportFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test("diffs export --json --out and the refusal to clobber", async () => {
      startExportFixture();
      const outPath = join(testHome, "written.json");
      const ts = await runTsAsync([
        "export",
        "--client",
        "pi",
        "--json",
        "--out",
        outPath,
      ]);
      expect(ts).toMatchObject({ code: 0 });
      // Give Go the same clean slate the TypeScript run just had.
      if (existsSync(outPath)) removeTreeWithRetry(outPath);
      const go = await runGoAsync([
        "export",
        "--client",
        "pi",
        "--json",
        "--out",
        outPath,
      ]);
      expect(go).toEqual(ts);
      const tsRefusal = await runTsAsync([
        "export",
        "--client",
        "pi",
        "--out",
        outPath,
      ]);
      const goRefusal = await runGoAsync([
        "export",
        "--client",
        "pi",
        "--out",
        outPath,
      ]);
      expect(goRefusal).toEqual(tsRefusal);
      expect(tsRefusal).toMatchObject({ code: 2 });
    });
    test("diffs export --force overwriting an existing --out file", async () => {
      startExportFixture();
      const outPath = join(testHome, "forced.json");
      writeFileSync(outPath, "stale bytes that --force must replace\n");
      const ts = await runTsAsync([
        "export",
        "--client",
        "pi",
        "--json",
        "--out",
        outPath,
        "--force",
      ]);
      expect(ts).toMatchObject({ code: 0 });
      writeFileSync(outPath, "stale bytes that --force must replace\n");
      const go = await runGoAsync([
        "export",
        "--client",
        "pi",
        "--json",
        "--out",
        outPath,
        "--force",
      ]);
      expect(go).toEqual(ts);
    });
    test("diffs export when no proxy is running", () => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-export-parity-"));
      expect(expectParity(["export", "--client", "pi"])).toMatchObject({
        code: 1,
      });
    });
    test("diffs aside export under a fixture home with an account manifest", async () => {
      startExportFixture();
      const asideHome = mkdtempSync(join(tmpdir(), "ocx-aside-home-"));
      mkdirSync(join(asideHome, ".aside", "u", "0"), { recursive: true });
      writeFileSync(
        join(asideHome, ".aside", "accounts.json"),
        JSON.stringify({ currentAccountId: 0 }),
      );
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
        const tsOut = await runTsAsync([
          "export",
          "--client",
          "aside",
          "--json",
          "--out",
          outPath,
        ]);
        expect(tsOut).toMatchObject({ code: 0 });
        if (existsSync(outPath)) removeTreeWithRetry(outPath);
        const goOut = await runGoAsync([
          "export",
          "--client",
          "aside",
          "--json",
          "--out",
          outPath,
        ]);
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
      testServer = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = attestedFixtureHeaders(
              challenge,
              testServer!.port ?? 0,
            );
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          const management =
            path.startsWith("/api/") || path.startsWith("/v1/");
          if (
            management &&
            (deny ||
              request.headers.get("x-opencodex-api-key") !==
                process.env.OPENCODEX_ADMIN_AUTH_TOKEN)
          ) {
            return Response.json(
              {
                error: "opencodex admin token required",
                reason: "no matching credential",
                hint: "Set OPENCODEX_ADMIN_AUTH_TOKEN to the token written to OPENCODEX_HOME/admin-api-token",
              },
              { status: 401 },
            );
          }
          const text = await request.text();
          let entry: any = null;
          if (text) {
            try {
              entry = JSON.parse(text);
            } catch {
              entry = null;
            }
          }
          const env = {
            debug: true,
            usage: false,
            injection: false,
            claude: false,
          };
          const debugView = () => {
            const override: Record<string, boolean> = {};
            const out = {
              enabled: false,
              usage: false,
              injection: false,
              claude: false,
            };
            if (entry && typeof entry === "object") {
              if (entry.reset === undefined) {
                for (const key of [
                  "debug",
                  "usage",
                  "injection",
                  "claude",
                ] as const) {
                  if (typeof entry[key] === "boolean") {
                    override[key] = entry[key];
                    if (key === "debug") out.enabled = entry[key];
                    else (out as any)[key] = entry[key];
                  }
                }
              }
            }
            return { ...out, runtimeOverride: override, env };
          };
          if (path === "/api/debug" && request.method === "GET")
            return Response.json(debugView());
          if (path === "/api/debug" && request.method === "PUT")
            return Response.json(debugView());
          if (path === "/api/debug/logs")
            return Response.json([
              { seq: 5, line: "provider debug line one" },
              { seq: 6, line: "provider debug line two" },
            ]);
          if (path === "/api/debug/usage-logs") return Response.json([]);
          if (path === "/api/keys" && request.method === "GET")
            return Response.json({
              keys: [
                {
                  id: "key-1",
                  name: "default",
                  prefix: "ocx_data_ab12",
                  createdAt: "2026-08-01T00:00:00.000Z",
                  usage: { requests7d: 1447, totalRequests: 9033 },
                },
                {
                  id: "key-2",
                  name: "deploy",
                  prefix: "ocx_data_cd34",
                  createdAt: "2026-08-02T00:00:00.000Z",
                  usage: { ambiguous: true },
                },
                {
                  id: "key-3",
                  name: "unused",
                  prefix: "ocx_data_ef56",
                  createdAt: "2026-08-03T00:00:00.000Z",
                  usage: {
                    requests7d: 0,
                    totalRequests: 0,
                    lastUsedAt: "2026-09-01T10:00:00.000Z",
                  },
                },
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
          if (path === "/api/keys" && request.method === "POST")
            return Response.json(
              {
                id: "key-new",
                name: entry?.name ?? "default",
                key: "ocx_data_newsecret",
                createdAt: "2026-09-05T00:00:00.000Z",
              },
              { status: 201 },
            );
          if (path === "/api/keys" && request.method === "DELETE")
            return Response.json({ success: true });
          if (path === "/api/keys/rotate" && request.method === "POST")
            return Response.json(
              {
                id: entry?.id,
                rotationId: "rot-1",
                key: "ocx_data_rotsecret",
                createdAt: "2026-09-05T00:00:00.000Z",
              },
              { status: 201 },
            );
          if (path === "/api/keys/rotate/commit")
            return Response.json({ ok: true });
          if (path === "/api/keys/rotate" && request.method === "DELETE")
            return Response.json({ ok: true });
          if (path === "/v1/models")
            return Response.json({
              object: "list",
              data: [
                { id: "grok-4.6", owned_by: "xai" },
                { id: "claude-haiku-4-5", owned_by: null },
              ],
            });
          if (path === "/v1/chat/completions")
            return Response.json({
              id: "chatcmpl-1",
              object: "chat.completion",
              model: entry?.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "OK" },
                  finish_reason: "stop",
                },
              ],
            });
          if (path === "/v1/responses")
            return Response.json({
              id: "resp-1",
              object: "response",
              model: entry?.model,
              output: [],
            });
          if (path === "/v1/messages")
            return Response.json({
              id: "msg-1",
              type: "message",
              model: entry?.model,
              content: [{ type: "text", text: "OK" }],
            });
          if (path === "/api/settings" && request.method === "GET")
            return Response.json({
              codexAutoStart: false,
              streamMode: "auto",
              codexDesktopAuthless: false,
              managementPort: 10100,
              desired: { enabled: true },
            });
          if (path === "/api/settings" && request.method === "PUT")
            return Response.json({ ok: true, saved: entry });
          if (path === "/api/startup-health")
            return Response.json({
              status: "ok",
              autoStart: false,
              checks: [
                { name: "port", ok: true },
                { name: "config", ok: false },
              ],
              service: { installed: true, name: "opencodex" },
            });
          if (path === "/api/system/memory")
            return Response.json({
              rssBytes: 123456789,
              heapUsed: 2097152,
              heapTotal: 4194304,
              responseState: { activeTurns: 0, draining: false },
            });
          if (path === "/api/startup-action" && request.method === "POST")
            return Response.json({
              message: `startup ${entry?.action} accepted`,
            });
          if (path === "/api/diagnostics/project-config")
            return Response.json({
              ok: true,
              file: "/tmp/none.json",
              issues: [],
            });
          if (path === "/api/sync" && request.method === "POST")
            return Response.json({
              ok: true,
              catalogWritten: true,
              message: "Catalog refreshed.",
            });
          if (path === "/api/system/codex-app-server")
            return Response.json({ reachable: true, pid: 4242 });
          if (path === "/api/system/codex-restart" && request.method === "POST")
            return Response.json({ requested: true });
          if (path === "/api/update/check")
            return Response.json({
              available: false,
              current: "2.42.0",
              latest: "2.42.0",
              channel: url.searchParams.get("tag") ?? "latest",
            });
          if (path === "/api/update/status")
            return Response.json({
              jobId: url.searchParams.get("jobId"),
              status: "done",
              ok: true,
            });
          if (path === "/api/update/run" && request.method === "POST")
            return Response.json({
              started: true,
              channel: entry?.tag,
              restart: entry?.restart,
            });
          return Response.json({ error: "not found", path }, { status: 404 });
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
    }
    function withMgmtToken(value: string | undefined): void {
      if (value === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
      else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = value;
    }
    test.each([
      { args: ["help", "debug"] },
      { args: ["debug", "--help"] },
      { args: ["help", "access"] },
      { args: ["access", "--help"] },
      { args: ["help", "api-key"] },
      { args: ["api-key", "--help"] },
      { args: ["help", "system"] },
      { args: ["system", "--help"] },
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
    ])(
      "diffs management family argument validation for $args",
      ({ args, code }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-parity-"));
        expect(expectParity(args)).toMatchObject({ code });
      },
    );
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
      {
        args: [
          "system",
          "update",
          "run",
          "--channel",
          "latest",
          "--restart",
          "off",
          "--yes",
        ],
      },
      { args: ["system", "update", "status", "update-1"] },
    ])(
      "diffs Go-owned management family output and exit code for $args",
      async ({ args }) => {
        startMgmtFixture(false);
        withMgmtToken(
          "ocx_admin_testtokenforissue47abcdefghijklmnopqrstuvwxyz",
        );
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
      20000,
    );
    test.each([
      { args: ["access", "key"] },
      { args: ["access", "key", "create", "denied", "--json"] },
      { args: ["api-key", "create", "denied", "--json"] },
      { args: ["debug", "provider", "on"] },
      { args: ["system", "settings"] },
      { args: ["system", "sync", "--json"] },
    ])(
      "diffs denied management writes across families for $args",
      async ({ args }) => {
        startMgmtFixture(true);
        withMgmtToken(undefined);
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 1 });
      },
      20000,
    );
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
    ])(
      "diffs management family output with no live proxy for $args",
      ({ args, code }) => {
        // A schema-valid config pinned to an unroutable port (9) makes the
        // no-proxy path deterministic instead of probing whatever occupies the
        // default port on this machine; both runtimes must print the same
        // "Proxy is not running" failure (and debug's env-default help at 0).
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-noproxy-"));
        writeFileSync(
          join(testHome, "config.json"),
          JSON.stringify({
            port: 9,
            providers: {
              fixture: {
                adapter: "openai-chat",
                baseUrl: "https://example.test/v1",
                apiKey: "secret-key",
              },
            },
            defaultProvider: "fixture",
          }),
        );
        const result = expectParity(args);
        expect(result).toMatchObject({ code });
        if (args[0] === "debug" && args.length === 1) {
          expect(result.stdout).toContain(
            "Proxy is not running — env defaults for the next start:",
          );
          expect(result.stderr).toBe("");
        }
      },
    );
    // system codex-cli-update stays TypeScript-owned behind an OwnershipFor
    // carve-out (read-only local Codex inspection, no management plane); these
    // rows exercise the delegated path end-to-end so a regression in the seam
    // (Go silently taking over the subcommand) fails loudly instead of only
    // tripping the ownership classification test.
    test.each([
      { args: ["system", "codex-cli-update", "check"] },
      { args: ["system", "codex-cli-update", "check", "--json"] },
    ])(
      "diffs the delegated system codex-cli-update carve-out for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-mgmt-noproxy-"));
        const result = expectParity(args);
        expect(result).toMatchObject({ code: 0 });
      },
    );

    // the same live management payloads, so the fixture answers /healthz with the
    // attested identity and serves each family's routes from canned JSON.
    const jsonResponse = (payload: unknown, status = 200) =>
      new Response(
        typeof payload === "string" ? payload : JSON.stringify(payload),
        { status, headers: { "content-type": "application/json" } },
      );
    function startFamilyFixture(
      api: (path: string, method: string) => Response,
    ): void {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-family-parity-"));
      testServer = Bun.serve({
        port: 0,
        fetch(request) {
          const path = new URL(request.url).pathname;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = challenge
              ? {
                  "x-opencodex-attestation-proof": createLocalAttestationProof(
                    secret,
                    challenge,
                    process.pid,
                    testServer!.port,
                  ),
                }
              : {};
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          return api(path, request.method);
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
    }
    const storageReport = {
      sessionFiles: 12,
      bytes: 10485760,
      trash: { count: 3, labels: ["old", "gone"] },
    };
    const storagePreview = {
      count: 2,
      bytes: 3145728,
      digest: "pv-1",
      candidates: [
        { relPath: "a.jsonl", bytes: 1048576 },
        { relPath: "b.jsonl" },
        { relPath: "c.jsonl", bytes: 2097152 },
      ],
    };
    const storageTrash = {
      entries: [{ id: "e1", relPath: "x.jsonl", bytes: 123 }],
    };
    const storagePolicy = {
      enabled: true,
      target: { removeOldestPercent: 25 },
      mode: "quarantine",
      schedule: "weekly",
    };
    function startStorageFixture(restoreConflict = false): void {
      startFamilyFixture((path, method) => {
        if (path === "/api/storage") return jsonResponse(storageReport);
        if (path === "/api/storage/cleanup/preview")
          return jsonResponse(storagePreview);
        if (path === "/api/storage/cleanup")
          return jsonResponse({ ok: true, removed: 3, freedBytes: 1048576 });
        if (path === "/api/storage/trash") return jsonResponse(storageTrash);
        if (path === "/api/storage/trash/restore") {
          return restoreConflict
            ? jsonResponse({ error: "drift", reason: "already restored" }, 409)
            : jsonResponse({ ok: true, restored: "e1" });
        }
        if (path === "/api/storage/cleanup-policy")
          return method === "PUT"
            ? jsonResponse({ ok: true })
            : jsonResponse(storagePolicy);
        if (path === "/api/storage/cleanup-policy/run")
          return jsonResponse({ ok: true, removed: 8, freedBytes: 2097152 });
        return jsonResponse({ error: "not found" }, 404);
      });
    }
    const storageLiveRows = [
      { args: ["storage"] },
      { args: ["storage", "report"] },
      { args: ["storage", "report", "--json"] },
      { args: ["storage", "cleanup", "--percent", "50"] },
      { args: ["storage", "cleanup", "--percent", "50", "--json"] },
      { args: ["storage", "cleanup", "--percent", "50", "--yes"] },
      { args: ["storage", "cleanup", "--percent", "50", "--yes", "--json"] },
      { args: ["storage", "trash", "list"] },
      { args: ["storage", "trash", "list", "--json"] },
      { args: ["storage", "policy"] },
      { args: ["storage", "policy", "--json"] },
      { args: ["storage", "policy", "set", "--enabled", "true"] },
      { args: ["storage", "policy", "set", "--enabled", "true", "--json"] },
      {
        args: [
          "storage",
          "policy",
          "set",
          "--percent",
          "10",
          "--mode",
          "permanent",
          "--schedule",
          "daily",
          "--json",
        ],
      },
      { args: ["storage", "trash", "restore", "e1", "--yes"] },
      { args: ["storage", "policy", "run", "--yes", "--json"] },
    ];
    test.each(storageLiveRows)(
      "diffs Go-owned storage output and exit code for $args",
      async ({ args }) => {
        startStorageFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["storage", "cleanup"] },
      { args: ["storage", "cleanup", "--percent", "101"] },
      { args: ["storage", "cleanup", "--percent", "many"] },
      { args: ["storage", "cleanup", "--percent", "5", "--mode", "weird"] },
      { args: ["storage", "trash", "nope"] },
      { args: ["storage", "trash", "restore"] },
      { args: ["storage", "trash", "restore", "e1"] },
      { args: ["storage", "policy", "set"] },
      { args: ["storage", "policy", "set", "--enabled", "maybe"] },
      { args: ["storage", "policy", "run"] },
      { args: ["storage", "bogus"] },
    ])("diffs storage argument validation for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-storage-parity-"));
      expect(expectParity(args)).toMatchObject({ code: 2 });
    });
    test("diffs storage write refusal (409) and its exit code", async () => {
      startStorageFixture(true);
      const ts = await runTsAsync([
        "storage",
        "trash",
        "restore",
        "c1",
        "--yes",
      ]);
      const go = await runGoAsync([
        "storage",
        "trash",
        "restore",
        "c1",
        "--yes",
      ]);
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
      expect(
        expectParity(["storage", "cleanup", "--percent", "5", "--yes"]),
      ).toMatchObject({ code: 1 });
    });
    test("keeps storage codex-logs on the TypeScript observe owner", () => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-storage-parity-"));
      expect(expectParity(["storage", "codex-logs", "status"])).toMatchObject({
        code: 1,
      });
    });

    // ── agent family (issue #48) ──────────────────────────────────────────────
    const agentPayloads = {
      v2: { enabled: true, mode: "v2", threads: 4 },
      injection: {
        model: "grok-4.6",
        effort: "high",
        prompt: null,
        multiAgentGuidanceEnabled: true,
      },
      caps: { effortCap: "high", subagentEffortCap: "low" },
      subagents: { models: ["sub-a", "sub-b"] },
      fallback: { models: ["sub-a"], pollMs: 60000 },
      sidecars: {
        webSearchModels: [
          {
            value: "chatgpt-web",
            model: "gpt-web",
            backend: "openai",
            authSlot: true,
          },
          { value: "claude-web", model: "claude-web", backend: "anthropic" },
        ],
        visionModels: [{ value: "vis-1", backend: "openai", baseline: true }],
      },
    };
    function startAgentFixture(): void {
      startFamilyFixture((path, method) => {
        const routes: Record<string, unknown> = {
          "/api/v2": agentPayloads.v2,
          "/api/injection-model": agentPayloads.injection,
          "/api/effort-caps": agentPayloads.caps,
          "/api/subagent-models": agentPayloads.subagents,
          "/api/subagent-model-fallback": agentPayloads.fallback,
          "/api/sidecar-settings": agentPayloads.sidecars,
          "/api/codex-auth/features/default-mode-request-user-input": {
            enabled: true,
          },
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
      {
        args: [
          "agent",
          "injection",
          "set",
          "--model",
          "m1",
          "--effort",
          "high",
          "--prompt",
          "keep going",
          "--guidance",
          "on",
        ],
      },
      {
        args: [
          "agent",
          "injection",
          "set",
          "--model",
          "-",
          "--effort",
          "-",
          "--json",
        ],
      },
      { args: ["agent", "effort"] },
      { args: ["agent", "effort", "set", "--main", "high"] },
      { args: ["agent", "effort", "set", "--subagent", "-", "--json"] },
      { args: ["agent", "subagents"] },
      { args: ["agent", "subagents", "set", "sub-a,sub-b,sub-a"] },
      { args: ["agent", "subagents", "set", "x,y", "--json"] },
      { args: ["agent", "subagents", "clear"] },
      { args: ["agent", "subagents", "set", "--weird"] },
      { args: ["agent", "roster", "set", "a,b"] },
      { args: ["agent", "fallback"] },
      { args: ["agent", "fallback", "set", "f1,f2", "--poll-ms", "120000"] },
      { args: ["agent", "fallback", "clear", "--json"] },
      { args: ["agent", "fallback", "set", "--poll-ms", "60000", "--json"] },
      { args: ["agent", "sidecar"] },
      { args: ["agent", "sidecar", "web", "--list"] },
      { args: ["agent", "sidecar", "web", "--list", "--json"] },
      { args: ["agent", "sidecar", "vision", "--list"] },
      { args: ["agent", "sidecar", "vision", "--list", "--json"] },
      {
        args: [
          "agent",
          "sidecar",
          "web",
          "--model",
          "chatgpt-web",
          "--backend",
          "openai",
          "--reasoning",
          "high",
          "--max-descriptions",
          "3",
        ],
      },
      {
        args: [
          "agent",
          "sidecar",
          "web",
          "--model",
          "gpt-web",
          "--backend",
          "openai",
          "--json",
        ],
      },
      {
        args: [
          "agent",
          "sidecar",
          "vision",
          "--model",
          "-",
          "--backend",
          "-",
          "--json",
        ],
      },
      { args: ["agent", "request-user-input"] },
      { args: ["agent", "request-user-input", "on", "--json"] },
    ];
    test.each(agentLiveRows)(
      "diffs Go-owned agent output and exit code for $args",
      async ({ args }) => {
        startAgentFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["agent", "bogus"] },
      { args: ["agent", "--json"] },
      { args: ["agent", "injection", "bogus"] },
      { args: ["agent", "injection", "--json"] },
      { args: ["agent", "injection", "set", "--guidance", "maybe"] },
      { args: ["agent", "effort", "set"] },
      { args: ["agent", "effort", "nope"] },
      { args: ["agent", "subagents", "set"] },
      { args: ["agent", "subagents", "set", "a,b,c,d,e,f"] },
      { args: ["agent", "subagents", "nope"] },
      { args: ["agent", "fallback", "nope"] },
      { args: ["agent", "fallback", "set", "--poll-ms", "100"] },
      { args: ["agent", "fallback", "set", "--poll-ms", "999999999"] },
      { args: ["agent", "sidecar", "bogus"] },
      { args: ["agent", "sidecar", "web"] },
      { args: ["agent", "request-user-input", "maybe"] },
      { args: ["agent", "request-user-input", "on", "extra"] },
      { args: ["agent", "subagents", "set", "--json"] },
    ])("diffs agent argument validation for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-agent-parity-"));
      expect(expectParity(args)).toMatchObject({ code: 2 });
    });

    // ── grok + integration family (issue #48) ─────────────────────────────────
    const grokState = {
      excluded: ["old-model"],
      selection: { mode: "fenced" },
    };
    function startGrokFixture(applyMessage?: string): void {
      startFamilyFixture((path, method) => {
        if (path === "/api/grok") return jsonResponse(grokState);
        if (path === "/api/grok/apply")
          return jsonResponse(
            applyMessage ? { message: applyMessage } : { ok: true },
          );
        if (path === "/api/grok/selection") return jsonResponse({ ok: true });
        return jsonResponse({ error: "not found" }, 404);
      });
    }
    const grokLiveRows = [
      { args: ["grok"] },
      { args: ["grok", "show"] },
      { args: ["grok", "apply"] },
      { args: ["grok", "apply", "--json"] },
      { args: ["grok", "exclude", "m1,m2"] },
      { args: ["grok", "include", "old-model"] },
      { args: ["grok", "exclude", "--weird"] },
      { args: ["grok", "set", "g1,g2", "--json"] },
      { args: ["grok", "clear"] },
      { args: ["integration", "grok", "status"] },
      { args: ["integration", "grok", "set", "z", "--json"] },
    ];
    test.each(grokLiveRows)(
      "diffs Go-owned grok output and exit code for $args",
      async ({ args }) => {
        startGrokFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test("diffs grok apply with a server message", async () => {
      startGrokFixture("Fence written to ~/.grok/config.toml.");
      const ts = await runTsAsync(["grok", "apply"]);
      const go = await runGoAsync(["grok", "apply"]);
      expect(go).toEqual(ts);
    });
    test.each([
      { args: ["grok", "bogus"] },
      { args: ["grok", "--json"] },
      { args: ["grok", "exclude"] },
      { args: ["grok", "set"] },
      { args: ["integration"] },
      { args: ["integration", "bogus"] },
    ])("diffs grok/integration argument validation for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-grok-parity-"));
      expect(expectParity(args)).toMatchObject({ code: 2 });
    });

    function startIntegrationFixture(): void {
      startFamilyFixture((path, method) => {
        if (path === "/api/claude-code")
          return jsonResponse({ enabled: true, authMode: "proxy" });
        if (path === "/api/client-integrations")
          return jsonResponse({
            clients: [
              { clientId: "mcode", state: "enabled", installed: true },
              { clientId: "claude", state: "disabled", installed: false },
            ],
          });
        if (path === "/api/client-integrations/mcode")
          return jsonResponse({
            clientId: "mcode",
            state: "enabled",
            installed: true,
          });
        if (path === "/api/client-integrations/journal")
          return jsonResponse({
            operations: [
              {
                at: "2026-08-22T10:00:00Z",
                clientId: "mcode",
                kind: "enable",
                opId: "op-1",
                snapshot: "current",
              },
              {
                at: "2026-08-22T11:00:00Z",
                clientId: "claude",
                kind: "disable",
                opId: "op-2",
                snapshot: "expired",
              },
            ],
          });
        if (path === "/api/client-integrations/journal?client=mcode")
          return jsonResponse({ operations: [] });
        if (path === "/api/client-integrations/restore")
          return jsonResponse({ message: "Restored op-1." });
        if (path.startsWith("/api/client-integrations/") && method === "PUT")
          return jsonResponse({ ok: true });
        if (path === "/api/native-integrations")
          return jsonResponse({
            clients: [
              {
                clientId: "claude",
                state: "enabled",
                installed: true,
                desiredEnabled: true,
                configPath: "~/.claude/settings.json",
              },
              {
                clientId: "codex",
                state: "enabled",
                installed: false,
                desiredEnabled: false,
                configPath: "~/.codex/config.toml",
                disableBlocked: "running app-server",
              },
              {
                clientId: "grok",
                state: "disabled",
                installed: true,
                desiredEnabled: null,
                configPath: "",
              },
            ],
          });
        if (path.startsWith("/api/native-integrations/") && method === "PUT")
          return jsonResponse({ ok: true });
        return jsonResponse({ error: "not found" }, 404);
      });
    }
    const integrationLiveRows = [
      { args: ["integration", "client"] },
      { args: ["integration", "client", "status", "--client", "mcode"] },
      { args: ["integration", "client", "history"] },
      { args: ["integration", "client", "history", "--json"] },
      { args: ["integration", "client", "history", "--client", "mcode"] },
      { args: ["integration", "client", "restore", "--op", "op-1"] },
      {
        args: [
          "integration",
          "client",
          "restore",
          "--op",
          "op-1",
          "--confirm-drift",
          "--json",
        ],
      },
      { args: ["integration", "client", "enable", "--client", "mcode"] },
      {
        args: [
          "integration",
          "client",
          "enable",
          "--client",
          "mcode",
          "--json",
        ],
      },
      {
        args: [
          "integration",
          "client",
          "enable",
          "--client",
          "mcode",
          "--overwrite-conflict",
        ],
      },
      { args: ["integration", "client", "disable", "--client", "mcode"] },
      { args: ["integration", "claude"] },
      {
        args: [
          "integration",
          "claude",
          "set",
          "--enabled",
          "on",
          "--auth-mode",
          "proxy",
          "--compact-window",
          "200000",
          "--small-fast-model",
          "-",
          "--model-map",
          "a=b,c=d",
          "--blocked-skills",
          "x,y",
          "--web-model",
          "w1",
          "--web-backend",
          "-",
        ],
      },
      {
        args: [
          "integration",
          "claude",
          "set",
          "--enabled",
          "off",
          "--compact-window",
          "default",
          "--model-map",
          "-",
          "--json",
        ],
      },
      { args: ["integration", "native"] },
      { args: ["integration", "native", "list", "--json"] },
      { args: ["integration", "native", "claude", "on"] },
      { args: ["integration", "native", "codex", "off", "--json"] },
    ];
    test.each(integrationLiveRows)(
      "diffs Go-owned integration output and exit code for $args",
      async ({ args }) => {
        startIntegrationFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["integration", "client", "restore"] },
      { args: ["integration", "client", "restore", "--op", "x", "extra"] },
      { args: ["integration", "client", "enable"] },
      {
        args: [
          "integration",
          "client",
          "disable",
          "--client",
          "mcode",
          "--overwrite-conflict",
        ],
      },
      { args: ["integration", "client", "nope"] },
      { args: ["integration", "client", "--json"] },
      { args: ["integration", "claude", "set"] },
      { args: ["integration", "claude", "--json"] },
      { args: ["integration", "claude", "set", "--model-map", "bad"] },
      { args: ["integration", "claude", "set", "--compact-window", "abc"] },
      { args: ["integration", "claude", "bogus"] },
      { args: ["integration", "native", "bogus"] },
      { args: ["integration", "native", "claude", "maybe"] },
    ])("diffs integration argument validation for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-integration-parity-"));
      expect(expectParity(args)).toMatchObject({ code: 2 });
    });
    // ── lab family (issue #48) ─────────────────────────────────────────────────
    // status reads the local SQLite projection under <home>/lab/compatibility.sqlite
    // (src/cli/lab.ts, src/lab/query/connection.ts). The other verbs keep their
    // TypeScript owner and are exercised as delegation smoke rows below.
    function writeLabProjection(
      home: string,
      schemaVersion = "3",
      specVersion = "cl-02.v1",
    ): void {
      mkdirSync(join(home, "lab"), { recursive: true });
      const db = new Database(join(home, "lab", "compatibility.sqlite"));
      db.run("CREATE TABLE schema_meta (key TEXT PRIMARY KEY, value TEXT)");
      db.run(
        "INSERT INTO schema_meta VALUES (?, ?), (?, ?), (?, ?)",
        "schema_version",
        schemaVersion,
        "projection_spec_version",
        specVersion,
        "built_at_ms",
        "1700000000123",
      );
      for (const t of [
        "events",
        "subjects",
        "observations",
        "claims",
        "verdicts",
        "artifacts",
        "corruption",
      ]) {
        db.run(`CREATE TABLE ${t} (id TEXT PRIMARY KEY)`);
      }
      db.run("INSERT INTO events VALUES ('e1'), ('e2')");
      db.run("INSERT INTO subjects VALUES ('s1')");
      db.run("INSERT INTO verdicts VALUES ('v1'), ('v2'), ('v3')");
      db.run("INSERT INTO corruption VALUES ('c1')");
      db.close();
    }
    const labProjectionRows = [
      { args: ["lab"] },
      { args: ["lab", "--json"] },
      { args: ["lab", "status"] },
      { args: ["lab", "status", "--json"] },
    ];
    test.each(labProjectionRows)(
      "diffs Go-owned lab status output and exit code for $args",
      async ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
        writeLabProjection(testHome);
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["lab", "status"] },
      { args: ["lab", "status", "--json"] },
    ])(
      "diffs Go-owned lab incompatible projection output for $args",
      async ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
        writeLabProjection(testHome, "99", "cl-02.v1");
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["lab"] },
      { args: ["lab", "status"] },
      { args: ["lab", "status", "--json"] },
      { args: ["lab", "--json"] },
      { args: ["lab", "bogus"] },
      { args: ["lab", "status", "extra"] },
    ])(
      "diffs lab output when no projection is present for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
        expect(expectParity(args)).toMatchObject({
          code: args.includes("bogus") || args.includes("extra") ? 2 : 0,
        });
      },
    );
    test.each([
      { args: ["lab", "catalog"], code: 0 },
      { args: ["lab", "verdicts"], code: 1 },
      { args: ["lab", "public", "community"], code: 0 },
      { args: ["lab", "automation", "status"], code: 0 },
    ])(
      "diffs lab TypeScript-owned verb delegation for $args",
      async ({ args, code }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-lab-parity-"));
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts.code).toBe(code);
      },
    );
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
      for (const args of [
        ["agent", "status"],
        ["grok"],
        ["integration", "client"],
        ["integration", "claude"],
        ["integration", "native"],
      ]) {
        const result = expectParity(args);
        expect(result.code).toBe(1);
      }
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
          {
            id: "fast",
            model: "combo/fast",
            strategy: "failover",
            stickyLimit: 1,
            targets: [
              { provider: "alpha", model: "m1", weight: 2 },
              { provider: "beta", model: "b1" },
            ],
          },
          {
            id: "smart",
            model: "combo/smart",
            strategy: "round-robin",
            stickyLimit: 3,
            targets: [{ provider: "alpha", model: "m2" }],
            alias: "smartie",
            defaultEffort: "high",
          },
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
      testServer = Bun.serve({
        port: 0,
        fetch: async (request) => {
          const url = new URL(request.url);
          const path = url.pathname;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = challenge
              ? {
                  "x-opencodex-attestation-proof": createLocalAttestationProof(
                    secret,
                    challenge,
                    process.pid,
                    testServer!.port,
                  ),
                }
              : {};
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          if (path === "/api/aliases" && request.method === "GET")
            return Response.json(aliasesPayload);
          if (path === "/api/combos" && request.method === "GET")
            return Response.json(combosPayload);
          if (path === "/api/combos" && request.method === "PUT") {
            const body = await request.json().catch(() => ({}));
            if ((body as { id?: string })?.id === "conflict")
              return Response.json(
                { error: "alias conflicts with 'combo/smart'" },
                { status: 409 },
              );
            return Response.json({
              ok: true,
              id: (body as { id?: string })?.id ?? null,
            });
          }
          if (path === "/api/combos" && request.method === "DELETE") {
            const id = url.searchParams.get("id");
            if (id === "gone")
              return Response.json(
                { error: "unknown combo: gone" },
                { status: 404 },
              );
            return Response.json({ ok: true, id });
          }
          if (path === "/api/routing-profiles" && request.method === "GET")
            return Response.json(profilesPayload);
          if (
            path === "/api/routing-profiles/dry-run" &&
            request.method === "POST"
          )
            return Response.json(decisionPayload);
          if (path === "/api/default-aliases" && request.method === "PUT") {
            return Response.json({
              ok: true,
              catalogRefresh: { status: "noop", ok: true },
            });
          }
          const providerAlias = path.match(
            /^\/api\/providers\/([^/]+)\/alias$/,
          );
          if (providerAlias && request.method === "PUT") {
            const name = decodeURIComponent(providerAlias[1]!);
            if (name === "beta")
              return Response.json(
                { error: "alias conflicts with 'beta'" },
                { status: 409 },
              );
            if (name === "ghost")
              return Response.json(
                { error: `provider '${name}' not found` },
                { status: 404 },
              );
            return Response.json({
              ok: true,
              provider: name,
              alias: "x",
              catalogRefresh: { status: "noop", ok: true },
            });
          }
          const modelAlias = path.match(
            /^\/api\/providers\/([^/]+)\/model-aliases$/,
          );
          if (modelAlias && request.method === "PUT") {
            const name = decodeURIComponent(modelAlias[1]!);
            if (name === "ghost")
              return Response.json(
                { error: `provider '${name}' not found` },
                { status: 404 },
              );
            return Response.json({
              ok: true,
              aliases: { m1: "one" },
              catalogRefresh: { status: "noop", ok: true },
            });
          }
          return new Response("not found", { status: 404 });
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
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
      {
        args: [
          "combo",
          "set",
          "fast",
          "--targets",
          "alpha/m1:2,beta/b1",
          "--json",
        ],
      },
      {
        args: [
          "combo",
          "set",
          "smart",
          "--targets",
          "alpha/m2",
          "--strategy",
          "round-robin",
          "--sticky",
          "3",
          "--effort",
          "high",
          "--alias",
          "smartie",
          "--display-name",
          "Smart Combo",
          "--rename-from",
          "old-smart",
        ],
      },
      {
        args: [
          "combo",
          "set",
          "dash",
          "--targets",
          "alpha/m1",
          "--effort",
          "-",
          "--alias",
          "-",
          "--display-name",
          "-",
        ],
      },
      { args: ["combo", "remove", "fast", "--yes"] },
      { args: ["combo", "remove", "fast", "--yes", "--json"] },
      { args: ["route", "combo", "list"] },
      { args: ["route", "combo", "show", "fast", "--json"] },
      { args: ["route", "policy", "list"] },
      { args: ["route", "policy", "list", "--json"] },
      { args: ["route", "policy", "show", "p1"] },
      { args: ["route", "policy", "show", "p2", "--json"] },
      { args: ["route", "policy", "dry-run", "p1"] },
      {
        args: [
          "route",
          "policy",
          "dry-run",
          "p1",
          "--model-context",
          "9000",
          "--tools",
          "--image",
          "--structured-output",
          "--json",
        ],
      },
      {
        args: [
          "route",
          "policy",
          "evaluate",
          "p1",
          "--model-context",
          "128000",
        ],
      },
    ])(
      "diffs Go-owned config-routing output and exit code for $args",
      async ({ args }) => {
        startRoutingFixture();
        // spawnSync blocks Bun's event loop, which starves the fixture server; live
        // management-plane rows drive both CLIs async like the usage oracle above.
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["combo", "show", "missing"] },
      { args: ["route", "policy", "show", "missing"] },
    ])(
      "diffs config-routing unknown-id usage output for $args",
      async ({ args }) => {
        startRoutingFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code: 2, stdout: "" });
      },
    );
    test.each([
      // Write refusals: 409 (collision) and 404 (unknown target) selection the
      // fixture keys on the provider/combo id both CLIs send.
      { args: ["alias", "set", "beta", "b2"], code: 5 },
      { args: ["alias", "set", "ghost", "g"], code: 4 },
      { args: ["alias", "set", "ghost/m", "g", "--json"], code: 4 },
      { args: ["combo", "set", "conflict", "--targets", "alpha/m1"], code: 5 },
      { args: ["combo", "remove", "gone", "--yes"], code: 4 },
    ])(
      "diffs config-routing write refusals for $args",
      async ({ args, code }) => {
        startRoutingFixture();
        const ts = await runTsAsync(args);
        const go = await runGoAsync(args);
        expect(go).toEqual(ts);
        expect(ts).toMatchObject({ code, stdout: "" });
      },
    );
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
      {
        args: [
          "combo",
          "set",
          "x",
          "--targets",
          "a/b",
          "--strategy",
          "random",
          "--sticky",
          "5",
        ],
      },
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
    ])(
      "diffs config-routing when no proxy is running for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-routing-parity-"));
        expect(expectParity(args)).toMatchObject({ code: 1, stdout: "" });
      },
    );
    test.each([
      { args: ["help", "alias"] },
      { args: ["alias", "--help"] },
      { args: ["alias", "help"] },
      { args: ["help", "combo"] },
      { args: ["combo", "--help"] },
      { args: ["help", "route"] },
      { args: ["route", "--help"] },
      { args: ["route", "combo", "--help"] },
      { args: ["route", "policy", "--help"] },
    ])("diffs config-routing help contracts for $args", ({ args }) => {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-routing-parity-"));
      expect(expectParity(args));
    });
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
      {
        name: "integration ON with no config.toml",
        integration: true,
        toml: false,
        code: 1,
      },
      {
        name: "integration OFF with a missing custom catalog path",
        integration: false,
        toml: true,
        code: 0,
      },
    ])(
      "diffs native terminal ocx sync flows: $name",
      ({ integration, toml, code }) => {
        const { home, codexHome } = syncRowHomes();
        writeFileSync(
          join(home, "config.json"),
          syncFixtureConfig(integration),
        );
        if (toml)
          writeFileSync(
            join(codexHome, "config.toml"),
            'model_catalog_json = "/nonexistent/custom-catalog.json"\n',
          );
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
      },
    );
    test.each([
      {
        name: "mismatched client present without role",
        config: syncFixtureConfig(true).replace(
          /}$/,
          ',"client":{"apiKeyId":"k"}}',
        ),
        code: 1,
      },
      {
        name: "invalid runtimeRole",
        config: syncFixtureConfig(true).replace(
          /}$/,
          ',"runtimeRole":"weird"}',
        ),
        code: 1,
      },
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
    test.each([{ args: ["sync-cache"] }, { args: ["sync-cache", "--json"] }])(
      "diffs ocx sync-cache with no catalog for $args",
      ({ args }) => {
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
      },
    );
    test.each([
      { args: ["sync-cache"] },
      { args: ["sync-cache", "--json"] },
      { args: ["sync-cache", "--restart-codex"] },
    ])(
      "diffs ocx sync-cache with a planted catalog for $args",
      async ({ args }) => {
        const { home, codexHome } = syncRowHomes();
        writeFileSync(
          join(codexHome, "opencodex-catalog.json"),
          JSON.stringify({
            models: [
              {
                slug: "fixture-model",
                display_name: "Fixture",
                context_window: 128000,
              },
            ],
          }),
        );
        try {
          const ts = runTsAt(args, home, codexHome);
          const afterTS = existsSync(join(codexHome, "models_cache.json"))
            ? await fileText(join(codexHome, "models_cache.json"))
            : null;
          const go = runGoAt(args, home, codexHome);
          const afterGo = existsSync(join(codexHome, "models_cache.json"))
            ? await fileText(join(codexHome, "models_cache.json"))
            : null;
          expect(go).toEqual(ts);
          expect(ts).toMatchObject({ code: 0 });
          // The Go rewrite must leave the same bytes the TS CLI wrote (rollback contract).
          expect(afterGo).toBe(afterTS);
        } finally {
          removeKLock(codexHome);
          if (existsSync(home)) removeTreeWithRetry(home);
          if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
        }
      },
    );
    test("diffs ocx sync-cache --restart-desktop-app outside Windows", () => {
      const { home, codexHome } = syncRowHomes();
      writeFileSync(
        join(codexHome, "opencodex-catalog.json"),
        JSON.stringify({ models: [{ slug: "fixture-model" }] }),
      );
      try {
        const ts = runTsAt(
          ["sync-cache", "--restart-desktop-app"],
          home,
          codexHome,
        );
        const go = runGoAt(
          ["sync-cache", "--restart-desktop-app"],
          home,
          codexHome,
        );
        expect(go).toEqual(ts);
      } finally {
        removeKLock(codexHome);
        if (existsSync(home)) removeTreeWithRetry(home);
        if (existsSync(codexHome)) removeTreeWithRetry(codexHome);
      }
    });
    test.each([{ args: ["sync-cache"] }, { args: ["sync-cache", "--json"] }])(
      "diffs ocx sync-cache failure taxonomy for $args",
      ({ args }) => {
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
      },
    );
    test.skipIf(process.platform !== "linux")(
      "diffs contended catalog-write-lock behavior",
      async () => {
        const { home, codexHome } = syncRowHomes();
        writeFileSync(
          join(codexHome, "opencodex-catalog.json"),
          JSON.stringify({ models: [{ slug: "fixture-model" }] }),
        );
        let holder: ReturnType<typeof Bun.spawn> | undefined;
        try {
          holder = Bun.spawn([goCLI!, "__catalog-khold"], {
            cwd: repoRoot,
            env: {
              ...process.env,
              OPENCODEX_HOME: home,
              CODEX_HOME: codexHome,
            },
            stdout: "pipe",
            stderr: "pipe",
          });
          const reader = holder.stdout.getReader();
          let heldOutput = "";
          for (let i = 0; i < 300; i++) {
            const chunk = await Promise.race([
              reader.read(),
              Bun.sleep(100).then(() => null),
            ]);
            if (!chunk) continue;
            if (chunk.value)
              heldOutput += new TextDecoder().decode(chunk.value);
            if (chunk.done || heldOutput.includes("HOLDING")) break;
          }
          expect(heldOutput).toContain("HOLDING");
          const ts = runTsAt(["sync-cache"], home, codexHome);
          const tsJSON = runTsAt(["sync-cache", "--json"], home, codexHome);
          const go = runGoAt(["sync-cache"], home, codexHome);
          const goJSON = runGoAt(["sync-cache", "--json"], home, codexHome);
          expect(ts).toMatchObject({
            code: 0,
            stdout:
              "Another process owns the catalog write; cache sync skipped.\n",
          });
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
      },
    );
    test("writes byte-identical models_cache from the same catalog in both runtimes", async () => {
      const catalog = JSON.stringify({
        models: [
          {
            slug: "gpt-5.5-codex",
            display_name: 'Quo"te',
            context_window: 128000,
            price: 1e21,
            tiny: 1e-7,
            nested: { a: [1, 2.5], b: null },
          },
        ],
      });
      const tsHome = mkdtempSync(join(tmpdir(), "ocx-go-sync-cache-ts-"));
      const tsCodex = mkdtempSync(join(tmpdir(), "ocx-go-sync-codex-ts-"));
      const goHome = mkdtempSync(join(tmpdir(), "ocx-go-sync-cache-go-"));
      const goCodex = mkdtempSync(join(tmpdir(), "ocx-go-sync-codex-go-"));
      try {
        for (const home of [tsHome, goHome])
          writeFileSync(join(home, "config.json"), syncFixtureConfig(true));
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
        for (const dir of [tsHome, tsCodex, goHome, goCodex])
          if (existsSync(dir)) removeTreeWithRetry(dir);
      }
    });
    async function fileText(path: string): Promise<string> {
      return new TextDecoder().decode(await Bun.file(path).arrayBuffer());
    }
    // logout is Go-owned (issue #51 slice). The TS CLI still runs its own
    // handler, so the differential runs the same argv through both CLIs on the
    // same fresh home and compares stdout/stderr/exit code plus the resulting
    // auth.json bytes (the on-disk credential store both owners rewrite).
    const authFixtureJSON = (extra: Record<string, unknown> = {}) =>
      JSON.stringify({
        openai: {
          activeAccountId: "acct-1",
          accounts: [
            {
              id: "acct-1",
              credential: {
                access: "tok-1",
                refresh: "ref-1",
                expires: 1756000000000,
              },
            },
            {
              id: "acct-2",
              credential: {
                access: "tok-2",
                refresh: "ref-2",
                expires: 1756000000000,
              },
            },
          ],
        },
        xai: {
          activeAccountId: "one",
          accounts: [
            {
              id: "one",
              credential: {
                access: "xa",
                refresh: "xr",
                expires: 1756000000000,
              },
            },
          ],
        },
        ...extra,
      });
    function writeAuthFixture(
      home: string,
      extra: Record<string, unknown> = {},
    ): void {
      writeFileSync(join(home, "auth.json"), `${authFixtureJSON(extra)}\n`);
    }
    // Both CLIs rewrite auth.json on a logout, so compare the byte state each
    // owner leaves behind from the identical fixture.
    async function logoutParity(
      args: readonly string[],
      extra: Record<string, unknown> = {},
    ): Promise<Result> {
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
    test.each([{ args: ["help", "logout"] }, { args: ["logout", "--help"] }])(
      "diffs logout help contracts for $args",
      ({ args }) => {
        testHome = mkdtempSync(join(tmpdir(), "ocx-go-logout-parity-"));
        expect(expectParity(args)).toMatchObject({ code: 0, stderr: "" });
      },
    );
    test.each([
      { args: ["logout"], reason: "missing provider" },
      { args: ["logout", "--bogus"], reason: "unknown option --bogus" },
      { args: ["logout", "openai", "xai"], reason: "too many arguments" },
      { args: ["logout", "-j"], reason: "unknown option -j" },
      {
        args: ["logout", "bad provider"],
        reason: "not a valid provider name: bad provider",
      },
      {
        args: ["logout", "constructor"],
        reason: "not a valid provider name: constructor",
      },
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
        anthropic: {
          access: "legacy-access",
          refresh: "legacy-refresh",
          expires: 1756000000000,
          email: "Legacy@Example.com",
        },
      };
      const result = await logoutParity(["logout", "anthropic"], extra);
      expect(result).toMatchObject({
        code: 0,
        stdout: "Logged out of anthropic.\n",
      });
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
      oauth: Record<
        string,
        {
          accounts: Array<Record<string, unknown>>;
          activeId: string | null;
          autoSwitch: number | null;
          strategyMode: number | null;
          stickyLimit: number | null;
        }
      >;
      keys: Record<
        string,
        { keys: Array<Record<string, unknown>>; activeId: string | null }
      >;
      reports: Array<Record<string, unknown>>;
    };
    function freshAccountStore(): AccountStore {
      return {
        codexAccounts: [
          {
            id: "acct-a",
            email: "a@example.com",
            plan: "chatgpt-plus",
            priority: 2,
          },
          { id: "acct-b", email: "b@example.com", plan: "chatgpt-plus" },
          {
            id: "acct-c",
            alias: "main-work",
            email: "c@example.com",
            priority: -1,
            paused: true,
          },
          {
            id: "acct-d",
            email: "d@example.com",
            quota: {
              shortPercent: 90,
              shortResetAt: 1756000000,
              weeklyPercent: 40,
              monthlyPercent: 30,
            },
            exhausted: true,
          },
        ],
        codexActiveId: "acct-a",
        autoSwitch: 80,
        strategyMode: null,
        stickyLimit: null,
        cooldownIds: ["acct-c"],
        oauth: {
          anthropic: {
            accounts: [
              { id: "claude-1", alias: "work", email: "w@example.com" },
              { id: "claude-2", email: "c2@example.com" },
              { id: "claude-3" },
            ],
            activeId: "claude-1",
            autoSwitch: null,
            strategyMode: null,
            stickyLimit: null,
          },
          xai: {
            accounts: [{ id: "grok-1", email: "g@example.com" }],
            activeId: "grok-1",
            autoSwitch: null,
            strategyMode: null,
            stickyLimit: null,
          },
        },
        keys: {
          deepseek: {
            keys: [
              { id: "key-1", masked: "sk-ds-\u2026abcd" },
              { id: "key-2", label: "prod", masked: "sk-ds-\u2026wxyz" },
            ],
            activeId: "key-1",
          },
        },
        reports: [
          {
            provider: "anthropic",
            quota: {
              weeklyPercent: 12.5,
              weeklyResetAt: 1756000000,
              customWindows: [
                { label: "5h", percent: 33.3, resetAt: 1756000000000 },
              ],
            },
          },
        ],
      };
    }
    function startAccountFixture(store: AccountStore): void {
      testHome = mkdtempSync(join(tmpdir(), "ocx-go-account-parity-"));
      writeFileSync(
        join(testHome, "config.json"),
        JSON.stringify({
          defaultProvider: "deepseek",
          providers: {
            deepseek: {
              adapter: "openai-chat",
              baseUrl: "https://example.test/v1",
              authMode: "key",
              apiKey: "sk-abc",
              defaultModel: "deepseek-chat",
              models: ["deepseek-chat"],
            },
          },
        }),
      );
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      testServer = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname;
          const query = url.searchParams;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = new Headers();

            if (challenge)
              headers.set(
                "x-opencodex-attestation-proof",
                createLocalAttestationProof(
                  secret,
                  challenge,
                  process.pid as number,
                  testServer!.port,
                ),
              );
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          let body: Record<string, unknown> = {};
          if (request.method !== "GET" && request.method !== "DELETE") {
            try {
              body = await request.json();
            } catch {
              body = {};
            }
          }
          if (path === "/api/codex-auth/accounts") {
            if (request.method === "DELETE") {
              const id = query.get("id") ?? "";
              store.codexAccounts = store.codexAccounts.filter(
                (a) => a.id !== id,
              );
              if (store.codexActiveId === id)
                store.codexActiveId =
                  (store.codexAccounts[0]?.id as string | undefined) ?? null;
              return json({});
            }
            return json({ accounts: store.codexAccounts });
          }
          if (path === "/api/codex-auth/active") {
            if (request.method === "PUT") {
              if (typeof body.accountId === "string")
                store.codexActiveId = body.accountId;
              return json({});
            }
            return json({
              activeCodexAccountId: store.codexActiveId,
              ...(store.autoSwitch === null
                ? {}
                : { autoSwitchThreshold: store.autoSwitch }),
              ...(store.strategyMode === null
                ? {}
                : { accountPoolStrategy: store.strategyMode }),
              ...(store.stickyLimit === null
                ? {}
                : { accountPoolStickyLimit: store.stickyLimit }),
            });
          }
          if (path === "/api/codex-auth/auto-switch") {
            store.autoSwitch =
              typeof body.threshold === "number" ? body.threshold : null;
            return json({});
          }
          if (path === "/api/codex-auth/accounts/priority") {
            const account = store.codexAccounts.find((a) => a.id === body.id);
            if (!account)
              return json({ error: `unknown account ${String(body.id)}` }, 404);
            account.priority = body.priority;
            return json({ priority: body.priority });
          }
          if (path === "/api/codex-auth/accounts/pause") {
            const account = store.codexAccounts.find((a) => a.id === body.id);
            if (!account)
              return json({ error: `unknown account ${String(body.id)}` }, 404);
            account.paused = body.paused === true;
            return json({});
          }
          if (path === "/api/codex-auth/accounts/pause-exhausted") {
            const paused = store.codexAccounts
              .filter((a) => a.exhausted === true)
              .map((a) => a.id);
            return json({
              pausedAccountIds: paused,
              checkedAccountCount: store.codexAccounts.length,
              failedAccountCount: 0,
            });
          }
          if (path === "/api/codex-auth/accounts/clear-cooldown") {
            const id = String(body.id);
            const cleared = store.cooldownIds.includes(id);
            store.cooldownIds = store.cooldownIds.filter((c) => c !== id);
            return json({ cleared });
          }
          if (path === "/api/codex-auth/pool-strategy") {
            if ("strategyMode" in body)
              store.strategyMode = body.strategyMode as number;
            if ("stickyLimit" in body)
              store.stickyLimit = body.stickyLimit as number;
            return json({
              accountPoolStrategy: store.strategyMode,
              accountPoolStickyLimit: store.stickyLimit,
            });
          }
          if (path === "/api/codex-auth/accounts/alias") {
            const account = store.codexAccounts.find((a) => a.id === body.id);
            if (!account)
              return json({ error: `unknown account ${String(body.id)}` }, 404);
            if (typeof body.alias === "string" && body.alias)
              account.alias = body.alias;
            else delete account.alias;
            return json({});
          }
          if (path === "/api/oauth/providers")
            return json({ providers: Object.keys(store.oauth) });
          if (path === "/api/oauth/accounts") {
            const name = query.get("provider") ?? "";
            const pool = store.oauth[name];
            if (!pool)
              return json({ error: `unknown oauth provider "${name}"` }, 400);
            if (request.method === "DELETE") {
              const id = query.get("id") ?? "";
              pool.accounts = pool.accounts.filter((a) => a.id !== id);
              if (pool.activeId === id)
                pool.activeId =
                  (pool.accounts[0]?.id as string | undefined) ?? null;
              return json({});
            }
            if (request.method === "PUT") {
              if (typeof body.accountId === "string")
                pool.activeId = body.accountId;
              return json({});
            }
            return json({
              accounts: pool.accounts,
              activeAccountId: pool.activeId,
            });
          }
          if (path === "/api/oauth/accounts/active") {
            const pool = store.oauth[String(body.provider)];
            if (!pool)
              return json(
                { error: `unknown oauth provider "${String(body.provider)}"` },
                400,
              );
            pool.activeId = String(body.accountId);
            return json({});
          }
          if (path === "/api/oauth/accounts/pool") {
            const pool =
              store.oauth[String(body.provider)] ??
              store.oauth[query.get("provider") ?? ""];
            if (!pool) return json({ error: "unknown oauth provider" }, 400);
            if (typeof body.autoSwitchThreshold === "number")
              pool.autoSwitch = body.autoSwitchThreshold;
            if ("strategy" in body) pool.strategyMode = body.strategy as number;
            if ("stickyLimit" in body)
              pool.stickyLimit = body.stickyLimit as number;
            return json({
              autoSwitchThreshold: pool.autoSwitch,
              strategy: pool.strategyMode ?? null,
              stickyLimit: pool.stickyLimit ?? null,
            });
          }
          if (path === "/api/oauth/accounts/alias") {
            const pool = store.oauth[String(body.provider)];
            const account = pool?.accounts.find((a) => a.id === body.accountId);
            if (!account)
              return json(
                { error: `unknown account ${String(body.accountId)}` },
                404,
              );
            if (typeof body.alias === "string" && body.alias)
              account.alias = body.alias;
            else delete account.alias;
            return json({});
          }
          if (path === "/api/providers/keys") {
            const name = query.get("name") ?? "";
            const pool = store.keys[name];
            if (!pool)
              return json({ error: `unknown provider "${name}"` }, 404);
            if (request.method === "DELETE") {
              const id = query.get("id") ?? "";
              pool.keys = pool.keys.filter((k) => k.id !== id);
              if (pool.activeId === id)
                pool.activeId =
                  (pool.keys[0]?.id as string | undefined) ?? null;
              return json({});
            }
            return json({ keys: pool.keys, activeId: pool.activeId });
          }
          if (path === "/api/providers/keys/active") {
            const pool = store.keys[String(body.name)];
            if (!pool)
              return json(
                { error: `unknown provider "${String(body.name)}"` },
                404,
              );
            pool.activeId = String(body.id);
            return json({});
          }
          if (path === "/api/providers/keys/alias") {
            const pool = store.keys[String(body.name)];
            const key = pool?.keys.find((k) => k.id === body.id);
            if (!key)
              return json({ error: `unknown key ${String(body.id)}` }, 404);
            if (typeof body.alias === "string" && body.alias)
              key.label = body.alias;
            else delete key.label;
            return json({});
          }
          if (path === "/api/provider-quotas")
            return json({ reports: store.reports });
          return json(
            { error: `no fixture route ${request.method} ${path}` },
            404,
          );
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
    }
    async function accountParity(
      args: readonly string[],
      mutate?: (store: AccountStore) => void,
    ): Promise<Result> {
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
    ])(
      "diffs account list output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
    test.each([
      { args: ["account", "current", "openai"] },
      { args: ["account", "current", "openai", "--json"] },
      { args: ["account", "current", "anthropic", "--json"] },
      { args: ["account", "current"] },
    ])(
      "diffs account current output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
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
    ])(
      "diffs account refresh output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
    test.each([
      { args: ["account", "auto-switch", "openai", "on"] },
      { args: ["account", "auto-switch", "openai", "on", "--json"] },
      { args: ["account", "auto-switch", "openai", "off"] },
      {
        args: ["account", "auto-switch", "openai", "threshold", "65", "--json"],
      },
      { args: ["account", "auto-switch", "openai", "status"] },
      { args: ["account", "auto-switch", "openai", "status", "--json"] },
      { args: ["account", "auto-switch", "anthropic", "status"] },
      { args: ["account", "auto-switch", "deepseek", "status"] },
      { args: ["account", "auto-switch", "openai", "threshold", "300"] },
      { args: ["account", "auto-switch", "openai", "on", "extra"] },
    ])(
      "diffs account auto-switch output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
    test.each([
      { args: ["account", "priority", "openai", "acct-a"] },
      { args: ["account", "priority", "openai", "acct-a", "--json"] },
      { args: ["account", "priority", "openai", "acct-c", "+3"] },
      { args: ["account", "priority", "openai", "acct-c", "reset", "--json"] },
      { args: ["account", "priority", "openai", "acct-a", "last"] },
      { args: ["account", "priority", "openai", "acct-a", "bogus"] },
      { args: ["account", "priority", "anthropic", "acct-a", "1"] },
    ])(
      "diffs account priority output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
    test.each([
      { args: ["account", "pause", "openai", "acct-b"] },
      { args: ["account", "pause", "openai", "acct-b", "--json"] },
      { args: ["account", "resume", "openai", "acct-b"] },
      { args: ["account", "pause-exhausted", "openai"] },
      { args: ["account", "pause-exhausted", "openai", "--json"] },
    ])(
      "diffs account pause/resume output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
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
    ])(
      "diffs account strategy/sticky output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
    test.each([
      { args: ["account", "alias", "openai", "acct-c", "work-hub"] },
      { args: ["account", "alias", "openai", "acct-c", "--json"] },
      { args: ["account", "alias", "openai", "acct-c", "-"] },
      { args: ["account", "alias", "anthropic", "claude-1", "daily"] },
      { args: ["account", "alias", "anthropic", "claude-1", "-"] },
      { args: ["account", "alias", "deepseek", "key-2", "prod2"] },
    ])(
      "diffs account alias output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
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
    ])(
      "diffs account remove output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );
    test.each([
      { args: ["account", "clear-cooldown", "openai", "acct-c"] },
      { args: ["account", "clear-cooldown", "openai", "acct-c", "--json"] },
      { args: ["account", "clear-cooldown", "openai", "acct-a", "--json"] },
      { args: ["account", "clear-cooldown", "anthropic", "claude-1"] },
    ])(
      "diffs account clear-cooldown output and exit code for $args",
      async ({ args }) => {
        const result = await accountParity(args);
        expect(result.code).toBeLessThanOrEqual(1);
      },
    );

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
      writeFileSync(
        join(testHome, "config.json"),
        JSON.stringify({
          defaultProvider: "openai",
          providers: {
            openai: {
              adapter: "openai",
              baseUrl: "https://api.openai.com/v1",
              authMode: "codex",
            },
          },
        }),
      );
      const json = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "content-type": "application/json" },
        });
      testServer = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          const path = url.pathname;
          if (path === "/healthz") {
            const challenge =
              request.headers.get("x-opencodex-attestation-challenge") ?? "";
            const headers = new Headers();

            if (challenge)
              headers.set(
                "x-opencodex-attestation-proof",
                createLocalAttestationProof(
                  secret,
                  challenge,
                  process.pid as number,
                  testServer!.port,
                ),
              );
            return Response.json(
              {
                status: "ok",
                service: "opencodex",
                version: "2.42.0",
                uptime: 1,
                pid: process.pid,
                port: testServer!.port,
              },
              { headers },
            );
          }
          if (path === "/api/codex-auth/login") {
            if (login404)
              return json(
                {
                  error: "no such codex account pool",
                  reason: "openai is not configured",
                },
                404,
              );
            return json({
              url: "https://auth.openai.com/device?code=ABCD",
              deviceCode: "ABCD-EFGH",
              instructions: "Enter the code on the device page.",
              flowId: "flow-1",
            });
          }
          if (path === "/api/codex-auth/login/code") {
            if (login404)
              return json({ error: "no such codex login flow" }, 404);
            return json({ ok: true });
          }
          if (path === "/api/codex-auth/login/cancel")
            return json({ ok: true });
          if (path === "/api/codex-auth/login-status")
            return json({ status: "pending" });
          if (path === "/api/oauth/login") {
            if (login404)
              return json({ error: 'unknown oauth provider "xai"' }, 404);
            return json({
              url: "https://console.x.ai/login/callback",
              instructions: "Sign in at the console.",
              deviceCode: "XY-99",
              flowId: "xai-flow",
            });
          }
          if (path === "/api/oauth/login/code") {
            if (login404)
              return json({ error: "no such oauth login flow" }, 404);
            return json({ ok: true });
          }
          if (path === "/api/oauth/login/cancel") return json({ ok: true });
          if (path === "/api/oauth/status") return json({ loggedIn: false });
          if (path === "/api/codex-auth/reset-credits")
            return json({
              ok: true,
              accountId: url.searchParams.get("accountId"),
              available: 2,
            });
          if (path === "/api/codex-auth/reset-credits/consume")
            return json({ ok: true, consumed: 1, remaining: 1 });
          return json(
            { error: `no fixture route ${request.method} ${path}` },
            404,
          );
        },
      });
      writeFileSync(
        join(testHome, "runtime-port.json"),
        JSON.stringify({
          pid: process.pid,
          port: testServer.port,
          hostname: "127.0.0.1",
          attestationSecret: secret,
        }),
      );
    }
    async function authFlowParity(
      args: readonly string[],
      input: string | null,
      login404 = false,
    ): Promise<Result> {
      startAuthFixture(login404);
      const ts = await runTsAsyncInput(args, input);
      startAuthFixture(login404);
      const go = await runGoAsyncInput(args, input);
      expect(go).toEqual(ts);
      return ts;
    }
    test.each([
      {
        args: ["account", "login", "openai", "--code", "-", "--no-wait"],
        input: "SECRET-CODE",
      },
      {
        args: [
          "account",
          "login",
          "openai",
          "--code",
          "-",
          "--no-wait",
          "--json",
        ],
        input: "SECRET-CODE",
      },
      {
        args: ["account", "reauth", "openai", "--code", "-", "--no-wait"],
        input: "SECRET-CODE",
      },
      {
        args: ["account", "login", "xai", "--code", "-", "--no-wait"],
        input: "SECRET-CODE",
      },
      {
        args: ["account", "login", "xai", "--code", "-", "--no-wait", "--json"],
        input: "SECRET-CODE",
      },
      {
        args: [
          "account",
          "login",
          "openai",
          "--device",
          "--code",
          "-",
          "--no-wait",
          "--json",
        ],
        input: "SECRET-CODE",
      },
      { args: ["account", "code", "xai", "--code", "-"], input: "SECRET" },
      {
        args: [
          "account",
          "code",
          "openai",
          "--flow",
          "f1",
          "--code",
          "-",
          "--json",
        ],
        input: "SECRET",
      },
      { args: ["account", "cancel", "xai"], input: null },
      { args: ["account", "cancel", "openai", "--flow", "f1"], input: null },
      { args: ["account", "reset-credits", "acct-x"], input: null },
      { args: ["account", "reset-credits", "acct-x", "--json"], input: null },
      {
        args: [
          "account",
          "reset-credits",
          "main",
          "--consume",
          "--yes",
          "--json",
        ],
        input: null,
      },
    ])(
      "diffs account device-flow success output and exit code for $args",
      async ({ args, input }) => {
        const result = await authFlowParity(args, input as string | null);
        expect(result.code).toBe(0);
      },
    );
    test.each([
      {
        args: ["account", "login", "xai", "--device"],
        reason: "--device unsupported",
      },
      { args: ["account", "login"], reason: "missing provider" },
      {
        args: ["account", "login", "xai", "--id", "acct1"],
        reason: "--id without --reauth",
      },
      { args: ["account", "code"], reason: "missing provider" },
      { args: ["account", "code", "xai"], reason: "empty code" },
      {
        args: ["account", "code", "openai", "--flow", "f1"],
        reason: "empty code on codex flow",
      },
      {
        args: ["account", "cancel", "xai", "extra"],
        reason: "unexpected argument",
      },
      {
        args: ["account", "reset-credits", "main", "--consume"],
        reason: "consume without --yes",
      },
    ])("diffs account device-flow usage errors for $args", async ({ args }) => {
      const result = await authFlowParity(args, null);
      expect(result).toMatchObject({ code: 2, stdout: "" });
    });
    test.each([
      {
        args: [
          "account",
          "login",
          "openai",
          "--code",
          "-",
          "--no-wait",
          "--json",
        ],
      },
      { args: ["account", "code", "openai", "--flow", "f1", "--code", "-"] },
    ])(
      "diffs account device-flow runtime-api error handling for $args",
      async ({ args }) => {
        const result = await authFlowParity(args, "SECRET-CODE", true);
        expect(result).toMatchObject({ code: 4 });
      },
    );

    // ocx connect status + ocx disconnect (issue #52): the local client-state
    // surface flipped to Go-owned. Each row seeds an identical home for the TS
    // and Go CLIs (CODEX_HOME is a sibling of the OPENCODEX_HOME config dir) and
    // diffs stdout/stderr/exit code; disconnect rows additionally diff the full
    // resulting file tree so the teardown transaction (token removal, catalog
    // restore, Codex journal unwind, config.json rewrite with rebase provenance)
    // is byte-identical. Catalog ages are wall-clock relative, so those rows
    // normalize the volatile digits before comparison, like normalizeHealthPid.
    const sha256hex = (value: string) =>
      createHash("sha256").update(value).digest("hex");
    const sha256b64url = (value: string) =>
      createHash("sha256")
        .update(value)
        .digest("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
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
    const codexInjected =
      '# Auto-injected by opencodex\nopenai_base_url = "http://127.0.0.1:10111/v1"\n';
    const codexOriginal = '# user native config\nmodel = "gpt-5.2"\n';
    const codexProfileOriginal = '[default]\nenv = "prod"\n';
    const codexProfileInjected =
      '[default]\nenv = "prod"\nbase_url = "http://127.0.0.1:10111"\n';
    const remoteCatalog = '{"catalog": "remote-bytes"}\n';
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
      if (seed.config !== undefined)
        writeFileSync(
          join(home, "config.json"),
          JSON.stringify(seed.config, null, 2) + "\n",
        );
      if (seed.token !== undefined && seed.token !== null)
        writeFileSync(join(home, "service-api-token"), seed.token + "\n");
      if (seed.tokenPrev !== undefined && seed.tokenPrev !== null) {
        const path = join(home, "service-api-token.prev");
        writeFileSync(path, seed.tokenPrev + "\n");
        chmodSync(path, 0o600);
      }
      if (seed.catalog !== undefined && seed.catalog !== null)
        writeFileSync(join(codex, "opencodex-catalog.json"), seed.catalog);
      if (seed.codexConfig !== undefined && seed.codexConfig !== null)
        writeFileSync(join(codex, "config.toml"), seed.codexConfig);
      if (seed.profile !== undefined && seed.profile !== null)
        writeFileSync(join(codex, "profiles", "default.toml"), seed.profile);
      if (seed.journal !== undefined && seed.journal !== null)
        writeFileSync(
          join(codex, "opencodex-journal.json"),
          JSON.stringify(seed.journal),
        );
    }
    function connectedConfig(
      overrides: Record<string, unknown> = {},
      blockOverrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
      return {
        ...clientBaseConfig,
        runtimeRole: "client",
        client: { ...clientBlock, ...blockOverrides },
        ...overrides,
      };
    }
    function codexJournal(
      overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
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
    function runClientCommand(
      args: string[],
      cli: "ts" | "go",
      home: string,
    ): Result {
      const binary = cli === "ts" ? process.execPath : ensureGoBinary();
      const extra = cli === "ts" ? ["src/cli/index.ts"] : [];
      const result = Bun.spawnSync([binary, ...extra, ...args], {
        cwd: repoRoot,
        env: {
          ...process.env,
          OPENCODEX_HOME: home,
          CODEX_HOME: join(home, "codex"),
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      return {
        code: result.exitCode,
        stdout: new TextDecoder().decode(result.stdout),
        stderr: new TextDecoder().decode(result.stderr),
      };
    }
    function normalizeClientAge(result: Result): Result {
      return {
        ...result,
        stdout: result.stdout
          .replace(/(\d+)s old/, "<age>s old")
          .replace(/"catalogAgeSeconds":\s*\d+/, '"catalogAgeSeconds": <age>'),
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
        if (options.compareFiles)
          expect(snapshotTree(goHome)).toEqual(snapshotTree(tsHome));
      });
    }
    afterEach(() => {
      for (const home of cleanedClientHomes.splice(0)) {
        if (existsSync(home)) removeTreeWithRetry(home);
      }
    });

    describe("connect status + disconnect (issue #52)", () => {
      test.each([
        {
          name: "connect status argument rejection",
          args: ["connect", "status", "--wat"],
        },
        {
          name: "connect status duplicate --json",
          args: ["connect", "status", "--json", "--json"],
        },
        {
          name: "disconnect argument rejection",
          args: ["disconnect", "--wat"],
        },
        {
          name: "disconnect duplicate --keep-catalog",
          args: ["disconnect", "--keep-catalog", "--keep-catalog"],
        },
        {
          name: "disconnect help (Go-native text)",
          args: ["help", "disconnect"],
        },
        { name: "disconnect --help", args: ["disconnect", "--help"] },
        {
          name: "connect help (still TypeScript-owned)",
          args: ["help", "connect"],
        },
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
      const readRows: Array<{
        name: string;
        seed: ClientSeedProvider;
        options?: { compareFiles?: boolean; normalizeAge?: boolean };
      }> = [
        {
          name: "connect status on an empty home",
          seed: {},
          options: { compareFiles: true },
        },
        {
          name: "connect status on a disconnected config",
          seed: { config: clientBaseConfig },
          options: { compareFiles: true },
        },
        {
          name: "connect status on a hub-role config",
          seed: { config: { ...clientBaseConfig, runtimeRole: "hub" } },
        },
        {
          name: "connect status on an invalid runtimeRole",
          seed: { config: { ...clientBaseConfig, runtimeRole: "bogus" } },
        },
        {
          name: "connect status on runtimeRole=client without a client block",
          seed: { config: { ...clientBaseConfig, runtimeRole: "client" } },
        },
        {
          name: "connect status on a client block without runtimeRole",
          seed: {
            config: {
              ...clientBaseConfig,
              client: { serverUrl: "https://hub.example.test" },
            },
          },
        },
        {
          name: "connect status on a malformed non-object client block",
          seed: {
            config: {
              ...clientBaseConfig,
              runtimeRole: "client",
              client: "just-a-string",
            },
          },
        },
        {
          name: "connect status on a malformed tokenFingerprint",
          seed: {
            config: connectedConfig({}, { tokenFingerprint: "not-hex-64" }),
          },
        },
        {
          name: "connect status on a malformed managementTransport",
          seed: {
            config: connectedConfig({}, { managementTransport: "webrtc" }),
          },
        },
        {
          name: "connect status on a malformed serverUrl",
          seed: {
            config: connectedConfig(
              {},
              { serverUrl: "https://hub.example.test/v1" },
            ),
          },
        },
        {
          name: "connect status on a malformed connectedAt",
          seed: { config: connectedConfig({}, { connectedAt: "yesterday" }) },
        },
        {
          name: "connect status on a malformed pendingOperation.kind",
          seed: {
            config: connectedConfig(
              {},
              { pendingOperation: { kind: "bogus" } },
            ),
          },
        },
        {
          name: "connect status on a malformed protocolVersion",
          seed: { config: connectedConfig({}, { protocolVersion: 2 }) },
        },
        {
          name: "connect status on an empty selectedClients",
          seed: { config: connectedConfig({}, { selectedClients: [] }) },
        },
        {
          name: "connect status connected without a token file",
          seed: { config: connectedConfig() },
          options: { compareFiles: true },
        },
        {
          name: "connect status connected with an owned token",
          seed: { config: connectedConfig(), token: clientToken },
          options: { compareFiles: true },
        },
        {
          name: "connect status connected with a foreign token",
          seed: { config: connectedConfig(), token: "some-other-secret" },
        },
        {
          name: "connect status connected with a remote catalog",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            catalog: remoteCatalog,
          },
          options: { compareFiles: true, normalizeAge: true },
        },
        {
          name: "connect status orphan .prev cleanup",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            tokenPrev: "old-rotation-secret",
          },
          options: { compareFiles: true },
        },
        {
          name: "connect status with a pending key rotation",
          seed: (home: string) => ({
            config: connectedConfig(
              {},
              {
                pendingOperation: {
                  kind: "rotate",
                  rotationId: "rot_123",
                  newKeyIssuedAt: "2026-09-01T00:00:00.000Z",
                  oldKeyBackupPath: join(home, "service-api-token.prev"),
                },
              },
            ),
            token: clientToken,
            tokenPrev: "old-rotation-secret",
          }),
          options: { normalizeAge: false },
        },
      ];
      for (const row of readRows) {
        clientParity(
          `${row.name} (human)`,
          row.seed,
          ["connect", "status"],
          row.options,
        );
        clientParity(
          `${row.name} (--json)`,
          row.seed,
          ["connect", "status", "--json"],
          row.options,
        );
      }
      test("diffs connect status against a dangling service-api-token symlink", () => {
        const tsHome = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
        const goHome = mkdtempSync(join(tmpdir(), "ocx-client-parity-"));
        cleanedClientHomes.push(tsHome, goHome);
        for (const home of [tsHome, goHome]) {
          seedClientHome(home, { config: connectedConfig(), token: null });
          symlinkSync(
            "/nonexistent/client-token-target",
            join(home, "service-api-token"),
          );
        }
        const ts = runClientCommand(
          ["connect", "status", "--json"],
          "ts",
          tsHome,
        );
        const go = runClientCommand(
          ["connect", "status", "--json"],
          "go",
          goHome,
        );
        expect(go).toEqual(ts);
      });

      // Disconnect teardown transaction: stdout parity plus byte-identical trees.
      const disconnectRows: Array<{
        name: string;
        seed: ClientSeedProvider;
        args?: string[];
      }> = [
        { name: "disconnect on an empty home", seed: {} },
        {
          name: "disconnect on a disconnected config",
          seed: { config: clientBaseConfig },
        },
        {
          name: "disconnect connected with token missing",
          seed: { config: connectedConfig() },
        },
        {
          name: "disconnect connected with a changed token",
          seed: { config: connectedConfig(), token: "some-other-secret" },
        },
        {
          name: "disconnect a connected claude client",
          seed: { config: connectedConfig(), token: clientToken },
        },
        {
          name: "disconnect a connected claude client (--json)",
          seed: { config: connectedConfig(), token: clientToken },
          args: ["disconnect", "--json"],
        },
        {
          name: "disconnect keeping the remote catalog",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            catalog: remoteCatalog,
          },
          args: ["disconnect", "--keep-catalog", "--json"],
        },
        {
          name: "disconnect removing the remote catalog",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            catalog: remoteCatalog,
          },
          args: ["disconnect", "--json"],
        },
        {
          name: "disconnect restoring the prior catalog snapshot",
          seed: {
            config: connectedConfig(
              {},
              {
                catalogFingerprint: sha256b64url(remoteCatalog),
                priorCatalog: Buffer.from('{"my": "prior catalog"}\n').toString(
                  "base64",
                ),
              },
            ),
            token: clientToken,
            catalog: remoteCatalog,
          },
          args: ["disconnect", "--json"],
        },
        {
          name: "disconnect refusal when the catalog changed ownership",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            catalog: '{"someone": "else"}\n',
          },
        },
        {
          name: "disconnect unwinding a client-owned Codex journal",
          seed: {
            config: connectedConfig(
              {},
              { selectedClients: ["codex", "claude"] },
            ),
            token: clientToken,
            codexConfig: codexInjected,
            journal: codexJournal(),
          },
          args: ["disconnect", "--json"],
        },
        {
          name: "disconnect unwinding a process-owned Codex journal",
          seed: {
            config: connectedConfig({}, { selectedClients: ["codex"] }),
            token: clientToken,
            codexConfig: codexInjected,
            journal: codexJournal({ owner: { kind: "process", pid: 4242 } }),
          },
        },
        {
          name: "disconnect restoring the Codex profile from the journal",
          seed: {
            config: connectedConfig({}, { selectedClients: ["codex"] }),
            token: clientToken,
            codexConfig: codexInjected,
            profile: codexProfileInjected,
            journal: codexJournal({
              originalProfile:
                Buffer.from(codexProfileOriginal).toString("base64"),
              injectedProfileHash: sha256hex(codexProfileInjected),
            }),
          },
          args: ["disconnect", "--json"],
        },
        {
          name: "disconnect refusal when routing is injected without a journal",
          seed: {
            config: connectedConfig({}, { selectedClients: ["codex"] }),
            token: clientToken,
            codexConfig: codexInjected,
          },
        },
        {
          name: "disconnect refusal when the journal belongs to another key",
          seed: {
            config: connectedConfig({}, { selectedClients: ["codex"] }),
            token: clientToken,
            codexConfig: codexInjected,
            journal: codexJournal({
              owner: { kind: "client", apiKeyId: "ck_OTHER" },
            }),
          },
        },
        {
          name: "disconnect refusal when the Codex config diverged from the journal",
          seed: {
            config: connectedConfig({}, { selectedClients: ["codex"] }),
            token: clientToken,
            codexConfig: codexInjected + 'model = "user-touched"\n',
            journal: codexJournal(),
          },
        },
        {
          name: "disconnect leaves a stale Codex journal alone for a claude-only client",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            codexConfig: codexInjected,
            journal: codexJournal(),
          },
          args: ["disconnect", "--json"],
        },
        {
          name: "disconnect while an orphan .prev backup exists",
          seed: {
            config: connectedConfig(),
            token: clientToken,
            tokenPrev: "old-rotation-secret",
          },
          args: ["disconnect", "--json"],
        },
      ];
      for (const row of disconnectRows) {
        clientParity(`${row.name}`, row.seed, row.args ?? ["disconnect"], {
          compareFiles: true,
        });
      }
    });
  },
);
