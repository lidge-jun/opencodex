import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SERVER_BUDGET_MS } from "./helpers/test-budget";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import {
  GO_OWNED_MANAGEMENT_ROUTES,
  MANAGEMENT_ROUTES,
  findGoOwnedManagementRoute,
} from "../src/server/management/route-registry";
import {
  hasGoOwnedRouteForwarder,
  resetGoOwnedRouteForwarderForTests,
  setGoOwnedRouteForwarder,
} from "../src/server/go-sidecar-slot";
import { resetGoSidecarForTests } from "../src/server/go-sidecar";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * ADR-0008 read/write ownership split and batch-migration plumbing (ticket #14).
 *
 * Two things are pinned here, and they are deliberately different in kind:
 *
 * 1. REGISTRY INVARIANTS — the typed `go` ownership marker lives only on read
 *    routes (the discriminated union in route-registry.ts refuses it on a write
 *    route at compile time; these tests re-check at runtime), every Go-owned
 *    route declares a duplicate-free volatile set for the differential oracle
 *    (EMPTY when the route is strict: its body is a pure function of shared
 *    state and must be byte-identical with no normalisation), and the derived
 *    GO_OWNED_MANAGEMENT_ROUTES view stays in lockstep with the markers in
 *    MANAGEMENT_ROUTES.
 *
 * 2. DISPATCH BEHAVIOUR — one forwarding branch, driven by the registry data
 *    (not by per-route code), serves declared Go-owned routes from the sidecar
 *    and falls through to the in-process handlers for everything else and for
 *    every supervision state. These tests install a FAKE forwarder directly
 *    into the core-owned slot, so they exercise the full management dispatch
 *    without needing a Go toolchain or a spawned child: "declared marker"
 *    decides what is forwarded, never the forwarder itself.
 *
 * The batch-migration consequence: adding the next read route is a marker flip
 * in route-registry.ts plus a Go handler plus oracle coverage — the dispatch
 * edit is already written, once, and test 7 pins that it names no route.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Fixture: a real server on a throwaway OPENCODEX_HOME, like the parity oracle.
// ---------------------------------------------------------------------------

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
  testHome = mkdtempSync(join(tmpdir(), "ocx-go-ownership-"));
  process.env.OPENCODEX_HOME = testHome;
  process.env.OPENCODEX_API_AUTH_TOKEN = "data-secret";
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = "admin-secret";
  saveConfig(configFixture());
}

function tearDownFixture(): void {
  resetGoSidecarForTests();
  resetGoOwnedRouteForwarderForTests();
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

async function getJson(token: string, server: { url: URL }, pathname: string): Promise<{ status: number; pid?: number; body: string }> {
  const response = await fetch(new URL(pathname, server.url), {
    headers: { "x-opencodex-api-key": token },
  });
  const body = await response.text();
  const parsed = JSON.parse(body) as Record<string, unknown>;
  return { status: response.status, pid: typeof parsed.pid === "number" ? parsed.pid : undefined, body };
}

// ---------------------------------------------------------------------------
// 1. Registry invariants: the marker is typed read-only and volatile is declared.
// ---------------------------------------------------------------------------

describe("ADR-0008 ownership markers are typed read/write (ticket #14)", () => {
  test("the declared Go-owned surface is health (volatile), shadow-call-settings (strict) and custom-models (strict) today", () => {
    // Pin the migrated set so an accidental marker flip on another read route
    // fails here instead of silently changing what the proxy serves. Adding a
    // real migration updates this list deliberately. Health reports the serving
    // process's own pid/uptime and declares them volatile; shadow-call-settings
    // and custom-models are pure functions of config.json (the latter a raw
    // JSON.stringify echo) and declare NO volatile field, which means the
    // oracle compares their bytes with no normalisation at all.
    const byPath = new Map(GO_OWNED_MANAGEMENT_ROUTES.map(r => [r.path, r]));
    expect([...byPath.keys()].sort()).toEqual([
      "/api/custom-models",
      "/api/shadow-call-settings",
      "/api/system/health",
    ]);
    const health = byPath.get("/api/system/health")!;
    expect(health.method).toBe("GET");
    expect(health.mutates).toBe(false);
    expect(health.module).toBe("server/management/system-routes");
    expect(health.go.volatileFields).toEqual(["pid", "uptime"]);
    const shadowCall = byPath.get("/api/shadow-call-settings")!;
    expect(shadowCall.method).toBe("GET");
    expect(shadowCall.mutates).toBe(false);
    expect(shadowCall.module).toBe("server/management/config-routes");
    expect(shadowCall.go.volatileFields).toEqual([]);
    const customModels = byPath.get("/api/custom-models")!;
    expect(customModels.method).toBe("GET");
    expect(customModels.mutates).toBe(false);
    expect(customModels.module).toBe("server/management/model-routes");
    expect(customModels.go.volatileFields).toEqual([]);
  });

  test("no write route can be Go-owned: runtime re-check of the union's read-only arm", () => {
    // The discriminated union in route-registry.ts already refuses `go` on a
    // write route at compile time. This is the runtime belt-and-braces check:
    // it re-derives the marker set from MANAGEMENT_ROUTES and compares it with
    // the exported view, so a cast or an array-level workaround cannot drift.
    const marked = MANAGEMENT_ROUTES.filter(
      (r): r is (typeof GO_OWNED_MANAGEMENT_ROUTES)[number] => r.mutates === false && r.go !== undefined,
    );
    expect(marked).toEqual(GO_OWNED_MANAGEMENT_ROUTES);
    for (const route of marked) {
      expect(route.mutates).toBe(false);
    }
    // And explicitly: no mutating route anywhere in the table declares Go ownership.
    const writesWithGo = MANAGEMENT_ROUTES.filter(r => r.mutates === true && "go" in r);
    expect(writesWithGo).toEqual([]);
  });

  test("every Go-owned route declares a duplicate-free volatile set (empty = strict byte equality)", () => {
    expect(GO_OWNED_MANAGEMENT_ROUTES.length).toBeGreaterThan(0);
    for (const route of GO_OWNED_MANAGEMENT_ROUTES) {
      // An EMPTY volatile set is the strict contract: the route body must be
      // byte-identical between the TS handler and the Go sidecar with no
      // normalisation. A non-empty set names exactly the keys that may differ
      // (process values). Either way, no key may be listed twice.
      expect(Array.isArray(route.go.volatileFields), `${route.method} ${route.path}`).toBe(true);
      expect(new Set(route.go.volatileFields).size, `${route.method} ${route.path}`).toBe(route.go.volatileFields.length);
    }
  });

  test("the dispatch lookup is exact on method and path, and sees only the declared surface", () => {
    const health = GO_OWNED_MANAGEMENT_ROUTES.find(r => r.path === "/api/system/health");
    expect(health).toBeDefined();
    expect(findGoOwnedManagementRoute("GET", "/api/system/health")).toBe(health);
    expect(findGoOwnedManagementRoute("POST", "/api/system/health")).toBeUndefined();
    expect(findGoOwnedManagementRoute("GET", "/api/system/health/")).toBeUndefined();
    expect(findGoOwnedManagementRoute("GET", "/api/system/memory")).toBeUndefined();
    expect(findGoOwnedManagementRoute("GET", "/api/config")).toBeUndefined();
    const shadowCall = GO_OWNED_MANAGEMENT_ROUTES.find(r => r.path === "/api/shadow-call-settings");
    expect(shadowCall).toBeDefined();
    expect(findGoOwnedManagementRoute("GET", "/api/shadow-call-settings")).toBe(shadowCall);
    expect(findGoOwnedManagementRoute("PUT", "/api/shadow-call-settings")).toBeUndefined();
    expect(findGoOwnedManagementRoute("GET", "/api/shadow-call-settings/")).toBeUndefined();
    const customModels = GO_OWNED_MANAGEMENT_ROUTES.find(r => r.path === "/api/custom-models");
    expect(customModels).toBeDefined();
    expect(findGoOwnedManagementRoute("GET", "/api/custom-models")).toBe(customModels);
    expect(findGoOwnedManagementRoute("POST", "/api/custom-models")).toBeUndefined();
    expect(findGoOwnedManagementRoute("GET", "/api/custom-models/")).toBeUndefined();
  });

  test("the forwarding branch in management-api.ts names no route of its own", () => {
    // "Migrating a read route is a marker flip, not dispatch edits": the single
    // branch must be driven by the registry lookup, so it may not mention any
    // concrete management path. If a future migration adds a literal here, that
    // is a dispatch edit and this test fails. (handleSystemRoutes itself is
    // legitimately in the handler chain below the branch; the branch must not
    // special-case it.)
    const src = readFileSync(join(repoRoot, "src/server/management-api.ts"), "utf8");
    expect(src).toContain("findGoOwnedManagementRoute");
    expect(src).toContain("tryForwardGoOwnedRoute");
    expect(src).not.toContain('"/api/system/health"');
    expect(src).not.toContain('"/api/system/memory"');
    expect(src).not.toContain('"/api/custom-models"');
    expect(src).not.toContain("tryForwardGoOwnedRoute(\"/");
  });
});

// ---------------------------------------------------------------------------
// 2. Dispatch behaviour: one registry-driven branch forwards declared Go-owned
//    routes and leaves everything else (and every supervision state) in-process.
// ---------------------------------------------------------------------------

describe("single forwarding branch serves declared Go-owned routes (ticket #14)", () => {
  runFixtureTest("a registered forwarder answers the declared route and nothing else", async (token) => {
    const calls: string[] = [];
    const fakeBody = JSON.stringify({
      status: "ok",
      service: "opencodex",
      version: "go-sidecar",
      uptime: 1,
      pid: 987654,
    });
    const detach = setGoOwnedRouteForwarder(async (method, pathAndSearch) => {
      calls.push(`${method} ${pathAndSearch}`);
      return new Response(fakeBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    try {
      expect(hasGoOwnedRouteForwarder()).toBe(true);
      const server = startServer(0);
      try {
        // The declared Go-owned route is served by the "sidecar" (the fake).
        const health = await getJson(token, server, "/api/system/health");
        expect(health.status).toBe(200);
        expect(health.body).toBe(fakeBody);
        expect(health.pid).toBe(987654);

        // A read route that is NOT declared Go-owned stays in-process: the
        // branch forwards only what the registry declares.
        const memory = await getJson(token, server, "/api/system/memory");
        expect(memory.status).toBe(200);
        expect(memory.pid).toBe(process.pid);
        expect(calls).toEqual(["GET /api/system/health"]);
      } finally {
        await server.stop(true);
      }
    } finally {
      detach();
    }
    expect(hasGoOwnedRouteForwarder()).toBe(false);
  });

  runFixtureTest("a forwarder returning null falls back to the in-process handler", async (token) => {
    // This is the supervision-blip contract: when the sidecar is attached but
    // unreachable, the route answers from TypeScript exactly as without Go.
    const detach = setGoOwnedRouteForwarder(async () => null);
    try {
      const server = startServer(0);
      try {
        const health = await getJson(token, server, "/api/system/health");
        expect(health.status).toBe(200);
        expect(health.pid).toBe(process.pid);
      } finally {
        await server.stop(true);
      }
    } finally {
      detach();
    }
  });

  runFixtureTest("a throwing forwarder is contained by the slot, never by dispatch", async (token) => {
    const detach = setGoOwnedRouteForwarder(async () => {
      throw new Error("sidecar exploded");
    });
    try {
      const server = startServer(0);
      try {
        const health = await getJson(token, server, "/api/system/health");
        expect(health.status).toBe(200);
        expect(health.pid).toBe(process.pid);
      } finally {
        await server.stop(true);
      }
    } finally {
      detach();
    }
  });

  runFixtureTest("no forwarder installed: default install answers in-process, unchanged", async (token) => {
    // Zero behaviour change for a build that never heard of Go.
    expect(hasGoOwnedRouteForwarder()).toBe(false);
    const server = startServer(0);
    try {
      const health = await getJson(token, server, "/api/system/health");
      expect(health.status).toBe(200);
      expect(health.pid).toBe(process.pid);
    } finally {
      await server.stop(true);
    }
  });
});
