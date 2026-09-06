import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { GO_OWNED_MANAGEMENT_ROUTES } from "../src/server/management/route-registry";
import { GO_SIDECAR_BIN_ENV, activeGoSidecarBaseUrl, resetGoSidecarForTests } from "../src/server/go-sidecar";
import { removeTreeWithRetry } from "./helpers/remove-tree";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";

/**
 * Ticket #33 differential oracle.  Lab activation is deliberately enabled in
 * this fixture: its route handlers are dynamically loaded and the production
 * SQLite projection remains the TypeScript parent oracle.  Server B therefore
 * proves the real Go public hop plus private bridge, rather than comparing two
 * direct calls to the dynamic handler.  Bodies are compared as raw bytes; all
 * migrated Lab reads declare an empty volatile set.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const previous = {
  bin: process.env[GO_SIDECAR_BIN_ENV],
  home: process.env.OPENCODEX_HOME,
  data: process.env.OPENCODEX_API_AUTH_TOKEN,
  admin: process.env.OPENCODEX_ADMIN_AUTH_TOKEN,
};

function goAvailable(): boolean {
  return Bun.spawnSync(["go", "version"], { stdout: "ignore", stderr: "ignore" }).success;
}

function buildSidecar(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-go-lab-routes-"));
  const bin = join(dir, process.platform === "win32" ? "ocx-sidecar.exe" : "ocx-sidecar");
  const result = Bun.spawnSync(["go", "build", "-o", bin, "./cmd/ocx-sidecar"], {
    cwd: join(repoRoot, "go"), env: { ...process.env, CGO_ENABLED: "0" }, stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error(new TextDecoder().decode(result.stderr));
  return bin;
}

const binary = goAvailable() ? buildSidecar() : null;
const literalLabReads = GO_OWNED_MANAGEMENT_ROUTES.filter(route => !route.mutates && route.path.startsWith("/api/lab/"));
const vectors = [
  "/api/lab/automation",
  "/api/lab/automation/runs?limit=1",
  "/api/lab/artifacts?limit=1",
  "/api/lab/catalog?layer=protocol_conformance",
  "/api/lab/events?limit=1",
  "/api/lab/observations?limit=1",
  "/api/lab/production-signals",
  "/api/lab/public/community",
  "/api/lab/status",
  "/api/lab/subjects?limit=1",
  "/api/lab/verdicts?limit=1",
] as const;

async function waitForSidecar(): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!activeGoSidecarBaseUrl()) {
    if (Date.now() >= deadline) throw new Error("sidecar did not attach");
    await Bun.sleep(25);
  }
}

async function capture(server: { url: URL }, path: string): Promise<{ status: number; contentType: string | null; body: string }> {
  const response = await fetch(new URL(path, server.url), { headers: { "x-opencodex-api-key": "admin-secret" } });
  return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
}

afterEach(() => {
  resetGoSidecarForTests();
  for (const [key, value] of Object.entries({
    [GO_SIDECAR_BIN_ENV]: previous.bin,
    OPENCODEX_HOME: previous.home,
    OPENCODEX_API_AUTH_TOKEN: previous.data,
    OPENCODEX_ADMIN_AUTH_TOKEN: previous.admin,
  })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe.skipIf(binary === null)("Go Lab route differential oracle (ticket #33)", () => {
  test("every literal Lab read is Go-owned with a strict byte contract", () => {
    expect(existsSync(binary!)).toBe(true);
    expect(literalLabReads.map(route => route.path).sort()).toEqual([
      "/api/lab/artifacts", "/api/lab/automation", "/api/lab/automation/runs", "/api/lab/catalog",
      "/api/lab/events", "/api/lab/observations", "/api/lab/production-signals", "/api/lab/public/community",
      "/api/lab/status", "/api/lab/subjects", "/api/lab/verdicts",
    ]);
    expect(literalLabReads.every(route => route.go.volatileFields.length === 0)).toBe(true);
  });

  test("activated Lab read responses match TypeScript oracle byte-for-byte through Go", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-go-lab-routes-home-"));
    process.env.OPENCODEX_HOME = home;
    process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
    process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
    // A valid non-empty profile is the production activation gate. The route
    // tests intentionally use an unseeded projection too, covering its 503
    // contract without bypassing activation.
    saveConfig({
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "test",
      providers: { test: { adapter: "openai-chat", baseUrl: "https://example.test/v1", models: ["gpt-test"] } },
      routingProfiles: { lab: { candidates: [{ provider: "test", model: "gpt-test" }] } },
    });
    const oracle = startServer(0);
    try {
      process.env[GO_SIDECAR_BIN_ENV] = binary!;
      const go = startServer(0);
      try {
        await waitForSidecar();
        for (const path of vectors) {
          const [ts, actual] = await Promise.all([capture(oracle, path), capture(go, path)]);
          expect(actual.status, path + " status").toBe(ts.status);
          expect(actual.contentType, path + " content-type").toBe(ts.contentType);
          expect(actual.body, path + " raw body").toBe(ts.body);
        }
      } finally {
        await go.stop(true);
      }
    } finally {
      await oracle.stop(true);
      removeTreeWithRetry(home);
    }
  }, SERVER_BUDGET_MS);
});
