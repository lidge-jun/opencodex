import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { VERSION } from "../src/server/management-api";
import { GO_OWNED_MANAGEMENT_ROUTES } from "../src/server/management/route-registry";
import {
  GO_SIDECAR_BIN_ENV,
  activeGoSidecarBaseUrl,
  resetGoSidecarForTests,
} from "../src/server/go-sidecar";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Differential oracle for the ADR-0008 Go sidecar (devlog/_plan/260905_go_sidecar_takeover).
 *
 * The TS in-process handlers and the Go ocx-sidecar must agree on status,
 * headers, and the body for every declared Go-owned route. The per-route
 * volatile set from src/server/management/route-registry.ts (the
 * `go.volatileFields` marker) is exactly what may legitimately differ — and it
 * may be EMPTY, which declares a strict route whose raw bytes must be equal
 * with no normalisation at all (a pure config read, e.g.
 * /api/shadow-call-settings). Nothing outside the declared set is ever
 * forgiven, so a later route cannot silently widen what parity means.
 *
 * The divergence class this pins is the one that sank dev2-go: Go runtime
 * numbers rendered under JavaScript labels, or a shape that merely looks like
 * the TS response. The assertion is byte identity of the wire bodies after the
 * declared normalisation (or raw byte identity for strict routes with an empty
 * volatile set) — a JSON re-parse would forgive key-order drift and
 * float-formatting drift that a byte compare catches.
 *
 * The harness needs the Go toolchain to build the sidecar, and boots two real
 * servers. Where `go` is unavailable (a contributor machine without Go), the
 * whole file skips with a visible reason; CI installs Go (see the `go` job and
 * the setup-go steps in .github/workflows/ci.yml), so the oracle runs there.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previousBinEnv = process.env[GO_SIDECAR_BIN_ENV];

function goToolchainAvailable(): boolean {
  const probe = Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" });
  return probe.success;
}

function buildSidecarBinary(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-sidecar-"));
  const binPath = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const build = Bun.spawnSync(
    ["go", "build", "-o", binPath, "./cmd/ocx-sidecar"],
    {
      cwd: join(repoRoot, "go"),
      env: { ...process.env, CGO_ENABLED: "0" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (build.exitCode !== 0) {
    throw new Error(
      `go build ./cmd/ocx-sidecar failed (${build.exitCode}):\n${new TextDecoder().decode(build.stderr)}`,
    );
  }
  return binPath;
}

const goAvailable = goToolchainAvailable();
// Built once at load: the four shard lanes and the macOS lane share nothing, so
// each process that can run this file pays one small build.
const sidecarBinary: string | null = goAvailable ? buildSidecarBinary() : null;

/**
 * The declared Go-owned health route (ADR-0008, ticket #14): volatile pid and
 * uptime, normalised by the oracle. The strict shadow-call-settings config read
 * (ticket #16) is pure and declares no volatile field. The oracle must prove
 * both; if a marker is ever removed it would compare nothing and pass
 * vacuously.
 */
const goOwnedHealth = GO_OWNED_MANAGEMENT_ROUTES.find(
  route => route.method === "GET" && route.path === "/api/system/health",
);

/** The strict config read route (ticket #16): pure function of config.json. */
const goOwnedShadowCallSettings = GO_OWNED_MANAGEMENT_ROUTES.find(
  route => route.method === "GET" && route.path === "/api/shadow-call-settings",
);

/**
 * Normalise the declared volatile fields of a route body to a fixed token.
 * Any other difference between two bodies fails the byte comparison. The field
 * list comes from the route's `go.volatileFields` marker (route-registry.ts):
 * the oracle normalises exactly the declared set and nothing else.
 */
function normaliseBody(raw: string, volatileFields: readonly string[]): string {
  let out = raw;
  for (const field of volatileFields) {
    out = out.replace(
      new RegExp(`"${field}":-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`, "g"),
      `"${field}":0`,
    );
  }
  return out;
}

const healthVolatileFields = goOwnedHealth?.go.volatileFields ?? [];

interface HealthCapture {
  status: number;
  contentType: string | null;
  body: string;
  parsed: { status: string; service: string; version: string; uptime: number; pid: number };
}

async function captureJson(server: { url: URL }, token: string, pathname: string): Promise<{ status: number; contentType: string | null; body: string }> {
  const response = await fetch(new URL(pathname, server.url), {
    headers: { "x-opencodex-api-key": token },
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
  };
}

async function captureShadowCall(server: { url: URL }, token: string) {
  return captureJson(server, token, "/api/shadow-call-settings");
}

async function captureCustomModels(server: { url: URL }, token: string) {
  return captureJson(server, token, "/api/custom-models");
}

async function captureHealth(server: { url: URL }, token: string): Promise<HealthCapture> {
  const response = await fetch(new URL("/api/system/health", server.url), {
    headers: { "x-opencodex-api-key": token },
  });
  const body = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body,
    parsed: JSON.parse(body) as HealthCapture["parsed"],
  };
}

const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";

function configFixture() {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "test",
    providers: {
      test: {
        adapter: "openai-chat",
        baseUrl: "https://example.test/v1",
        disabled: true,
        models: ["gpt-test"],
      },
    },
  };
}

function setUpFixture(): void {
  testHome = mkdtempSync(join(tmpdir(), "ocx-go-sidecar-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  saveConfig(configFixture());
}

function tearDownFixture(): void {
  resetGoSidecarForTests();
  if (previousBinEnv === undefined) delete process.env[GO_SIDECAR_BIN_ENV];
  else process.env[GO_SIDECAR_BIN_ENV] = previousBinEnv;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) {
    removeTreeWithRetry(testHome);
    testHome = "";
  }
}

async function waitFor<T>(probe: () => T | null | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`condition not met within ${timeoutMs}ms`);
    await Bun.sleep(50);
  }
}

function runFixtureTest(name: string, fn: (token: string) => Promise<void>): void {
  test(
    name,
    async () => {
      setUpFixture();
      try {
        await fn("admin-secret");
      } finally {
        tearDownFixture();
      }
    },
    SERVER_BUDGET_MS,
  );
}

describe.skipIf(!goAvailable || sidecarBinary === null)("ocx-sidecar differential parity (ADR-0008)", () => {
  test("the Go sidecar binary is buildable and health is declared Go-owned before the oracle runs", () => {
    expect(sidecarBinary).toBeTruthy();
    expect(existsSync(sidecarBinary!)).toBe(true);
    // The harness must prove a declared surface: if the marker is ever removed
    // the oracle would compare nothing and pass vacuously.
    expect(goOwnedHealth).toBeDefined();
    expect(healthVolatileFields).toEqual(["pid", "uptime"]);
    // The strict config read route must stay declared too; its contract is the
    // empty volatile set (raw byte equality, no normalisation).
    expect(goOwnedShadowCallSettings).toBeDefined();
    expect(goOwnedShadowCallSettings!.go.volatileFields).toEqual([]);
    // The strict raw-echo config route (ticket #17) must stay declared too.
    const customModels = GO_OWNED_MANAGEMENT_ROUTES.find(
      route => route.method === "GET" && route.path === "/api/custom-models",
    );
    expect(customModels).toBeDefined();
    expect(customModels!.go.volatileFields).toEqual([]);
  });

  runFixtureTest("in-process handler and Go sidecar agree on status, headers, and normalised body", async (token) => {
    // Server A: no sidecar attached — the route must answer exactly as a build
    // that never heard of Go (zero behaviour change for the default install).
    const serverA = startServer(0);
    try {
      const tsBody = await captureHealth(serverA, token);
      expect(tsBody.status).toBe(200);
      expect(tsBody.contentType).toBe("application/json");
      expect(tsBody.parsed).toMatchObject({
        status: "ok",
        service: "opencodex",
        version: VERSION,
      });
      // The in-process handler reports the proxy's own pid and uptime.
      expect(tsBody.parsed.pid).toBe(process.pid);

      // Server B: same config, sidecar attached via env. The front door must
      // now forward GET /api/system/health to the Go child.
      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      const serverB = startServer(0);
      try {
        const sidecarUrl = await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        const goBody = await captureHealth(serverB, token);
        expect(goBody.status).toBe(200);
        expect(goBody.contentType).toBe("application/json");
        expect(goBody.parsed).toMatchObject({
          status: "ok",
          service: "opencodex",
          version: VERSION,
        });
        // The sidecar reports ITS OWN pid, not the proxy's: this is the seam.
        expect(goBody.parsed.pid).not.toBe(process.pid);
        expect(goBody.parsed.pid).toBeGreaterThan(0);

        // Byte parity after the declared normalisation: the oracle fails on
        // drift rather than logging it. Raw bodies still differ (pid/uptime),
        // so a vacuous equality is impossible.
        expect(normaliseBody(goBody.body, healthVolatileFields)).toBe(normaliseBody(tsBody.body, healthVolatileFields));

        // The front door must relay the Go bytes without alteration. The two
        // requests land at different instants, so uptime (a volatile field)
        // legitimately differs — normalise exactly the declared set, then
        // require byte equality of everything the relay is allowed to touch.
        const direct = await fetch(new URL("/api/system/health", sidecarUrl), {
          headers: { accept: "application/json" },
        });
        expect(direct.status).toBe(200);
        expect(normaliseBody(await direct.text(), healthVolatileFields)).toBe(normaliseBody(goBody.body, healthVolatileFields));
      } finally {
        await serverB.stop(true);
      }
      expect(activeGoSidecarBaseUrl()).toBeNull();
    } finally {
      await serverA.stop(true);
    }
  });

  runFixtureTest("a missing sidecar binary is a warned no-op, not a startup failure", async (token) => {
    process.env[GO_SIDECAR_BIN_ENV] = join(testHome, "does-not-exist-ocx-sidecar");
    const server = startServer(0);
    try {
      const health = await captureHealth(server, token);
      expect(health.status).toBe(200);
      expect(health.parsed.pid).toBe(process.pid);
      expect(health.parsed.version).toBe(VERSION);
      expect(activeGoSidecarBaseUrl()).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  runFixtureTest("an unexpected sidecar exit deregisters the forwarder and health falls back in-process", async (token) => {
    // #11: a crash must surface, not fall silent. The supervisor deregisters the
    // forwarder on an unexpected child exit, so the next health response flips
    // back to the PROXY's pid — observable through the exact route the sidecar
    // was serving, with no gap where health is unanswered.
    process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
    const server = startServer(0);
    try {
      const sidecarUrl = await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
      const served = await captureHealth(server, token);
      expect(served.parsed.pid).not.toBe(process.pid);
      expect(served.parsed.pid).toBeGreaterThan(0);

      // The sidecar reports its own pid; kill that process to simulate a crash.
      const childPid = served.parsed.pid;
      let killed = false;
      try {
        process.kill(childPid, "SIGTERM");
        killed = true;
      } catch {
        killed = false;
      }
      expect(killed).toBe(true);

      // The supervisor observes the exit and empties the slot (base URL gone).
      await waitFor(() => (activeGoSidecarBaseUrl() === null ? true : null), 10_000);

      // Health still answers — from the in-process handler, pid flipped back.
      const after = await captureHealth(server, token);
      expect(after.status).toBe(200);
      expect(after.parsed.pid).toBe(process.pid);
    } finally {
      await server.stop(true);
    }
  });

  runFixtureTest("shadow-call-settings default body is byte-identical with no normalisation", async (token) => {
    // Ticket #16 first vertical slice: GET /api/shadow-call-settings is a pure
    // function of config.json. The fixture has no shadowCallIntercept section,
    // so both implementations must report the defaults. The declared volatile
    // set is EMPTY, so this comparison normalises nothing: raw bytes must be
    // equal.
    const serverA = startServer(0);
    try {
      const tsBody = await captureShadowCall(serverA, token);
      expect(tsBody.status).toBe(200);
      expect(tsBody.contentType).toBe("application/json");
      // Pin the exact TS body so a Go handler that merely echoes something
      // plausible but different cannot pass.
      expect(tsBody.body).toBe(`{"enabled":false,"model":"","sourceModels":["gpt-5.6-luna"]}`);

      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      const serverB = startServer(0);
      try {
        await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        const goBody = await captureShadowCall(serverB, token);
        expect(goBody.status).toBe(200);
        expect(goBody.contentType).toBe("application/json");
        expect(goBody.body).toBe(tsBody.body);
        expect(goBody.body).toBe(`{"enabled":false,"model":"","sourceModels":["gpt-5.6-luna"]}`);
      } finally {
        await serverB.stop(true);
      }
      expect(activeGoSidecarBaseUrl()).toBeNull();
    } finally {
      await serverA.stop(true);
    }
  });

  runFixtureTest("shadow-call-settings configured body is byte-identical and the relay alters nothing", async (token) => {
    // A non-default section exercises the projection (enabled, model verbatim,
    // sourceModels normalised exactly as TS normalises them) rather than the
    // empty-config fallback.
    saveConfig({
      ...configFixture(),
      shadowCallIntercept: {
        enabled: true,
        model: "gpt-5.5",
        sourceModels: [" gpt-5.4-mini ", "", "gpt-x"],
      },
    });
    const want = `{"enabled":true,"model":"gpt-5.5","sourceModels":["gpt-5.4-mini","gpt-x"]}`;

    const serverA = startServer(0);
    try {
      const tsBody = await captureShadowCall(serverA, token);
      expect(tsBody.body).toBe(want);

      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      const serverB = startServer(0);
      try {
        const sidecarUrl = await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        const goBody = await captureShadowCall(serverB, token);
        expect(goBody.body).toBe(want);

        // The front door must relay the Go bytes without alteration, matching
        // the sidecar's own direct response exactly.
        const direct = await fetch(new URL("/api/shadow-call-settings", sidecarUrl), {
          headers: { accept: "application/json" },
        });
        expect(direct.status).toBe(200);
        expect(await direct.text()).toBe(goBody.body);
      } finally {
        await serverB.stop(true);
      }
      expect(activeGoSidecarBaseUrl()).toBeNull();
    } finally {
      await serverA.stop(true);
    }
  });

  runFixtureTest("custom-models default body is byte-identical with no normalisation", async (token) => {
    // Ticket #17: GET /api/custom-models is a raw echo of the config's
    // customModels subsection (JSON.stringify(config.customModels ?? [])). The
    // fixture carries no customModels key, so both implementations must report
    // the nullish fallback []. Empty volatile set: raw bytes must be equal.
    const serverA = startServer(0);
    try {
      const tsBody = await captureCustomModels(serverA, token);
      expect(tsBody.status).toBe(200);
      expect(tsBody.contentType).toBe("application/json");
      expect(tsBody.body).toBe(`[]`);

      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      const serverB = startServer(0);
      try {
        await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        const goBody = await captureCustomModels(serverB, token);
        expect(goBody.status).toBe(200);
        expect(goBody.contentType).toBe("application/json");
        expect(goBody.body).toBe(tsBody.body);
        expect(goBody.body).toBe(`[]`);
      } finally {
        await serverB.stop(true);
      }
      expect(activeGoSidecarBaseUrl()).toBeNull();
    } finally {
      await serverA.stop(true);
    }
  });

  runFixtureTest("custom-models configured body is byte-identical (unknown keys and file order kept)", async (token) => {
    // A non-default section exercises the echo, not the fallback: unknown
    // per-entry keys survive, and each entry's key order follows the file
    // (JSON.stringify of the parsed value, not a schema). saveConfig persists
    // customModels as a passthrough (probed), so the fixture keeps its order.
    saveConfig({
      ...configFixture(),
      customModels: [
        { zetaField: 1, provider: "test", modelId: "custom-a", displayName: "Custom A", contextWindow: 99999 },
        { provider: "anthropic", modelId: "custom-b" },
      ],
    });
    const want = `[{"zetaField":1,"provider":"test","modelId":"custom-a","displayName":"Custom A","contextWindow":99999},{"provider":"anthropic","modelId":"custom-b"}]`;

    const serverA = startServer(0);
    try {
      const tsBody = await captureCustomModels(serverA, token);
      expect(tsBody.body).toBe(want);

      process.env[GO_SIDECAR_BIN_ENV] = sidecarBinary!;
      const serverB = startServer(0);
      try {
        const sidecarUrl = await waitFor(() => activeGoSidecarBaseUrl(), 15_000);
        const goBody = await captureCustomModels(serverB, token);
        expect(goBody.body).toBe(want);

        // The front door must relay the Go bytes without alteration, matching
        // the sidecar's own direct response exactly.
        const direct = await fetch(new URL("/api/custom-models", sidecarUrl), {
          headers: { accept: "application/json" },
        });
        expect(direct.status).toBe(200);
        expect(await direct.text()).toBe(goBody.body);
      } finally {
        await serverB.stop(true);
      }
      expect(activeGoSidecarBaseUrl()).toBeNull();
    } finally {
      await serverA.stop(true);
    }
  });
});
