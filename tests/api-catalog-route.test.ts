import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handleManagementAPI } from "../src/server/management-api";
import { loadConfig, saveConfig } from "../src/config";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { ManagementRequest, managementHeaders } from "./helpers/management-auth";
import type { OcxConfig } from "../src/types";

const TEST_DIR = join(import.meta.dir, `.tmp-api-catalog-route-${process.pid}`);
const previousOpencodexHome = process.env.OPENCODEX_HOME;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  if (previousOpencodexHome === undefined) mkdirSync(TEST_DIR, { recursive: true });
  process.env.OPENCODEX_HOME = TEST_DIR;
  isolatedCodexHome = null;
  saveConfig({
    port: 10100,
    hostname: "127.0.0.1",
    defaultProvider: "mock",
    providers: {
      mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
    },
  } as OcxConfig);
});

afterEach(() => {
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (previousOpencodexHome === undefined) {
    delete process.env.OPENCODEX_HOME;
    rmSync(TEST_DIR, { recursive: true, force: true });
  } else {
    process.env.OPENCODEX_HOME = previousOpencodexHome;
  }
});

describe("GET /api/catalog route (#709)", () => {
  test("returns the on-disk catalog and omits sync runtime probes for version hint", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ocx-api-catalog-");
    const catalog = {
      models: [{
        slug: "mock/test-model",
        display_name: "Mock Test",
        description: "fixture",
        priority: 1,
        visibility: "list",
        base_instructions: "You are a helpful coding assistant.",
        input_modalities: ["text"],
      }],
    };
    writeFileSync(join(isolatedCodexHome.path, "opencodex-catalog.json"), JSON.stringify(catalog));

    const url = new URL("http://localhost/api/catalog");
    const response = await handleManagementAPI(
      new ManagementRequest(url, { headers: managementHeaders() }),
      url,
      loadConfig(),
    );
    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual(catalog);
    expect(response!.headers.get("x-opencodex-codex-version")).toBeNull();
  });

  test("returns 404 when the catalog file is missing", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ocx-api-catalog-missing-");
    const url = new URL("http://localhost/api/catalog");
    const response = await handleManagementAPI(
      new ManagementRequest(url, { headers: managementHeaders() }),
      url,
      loadConfig(),
    );
    expect(response?.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "catalog not found" });
  });
});

describe("GET|HEAD /v1/catalog least-privilege data-plane route (#809)", () => {
  const DATA_KEY = "ocx_data_catalogreadonly";

  /**
   * Binds 0.0.0.0 deliberately. `isApiAuthRequired` returns false for a loopback bind, so a
   * 127.0.0.1 server admits every data-plane request as `kind: "loopback"` and an auth test
   * against it would pass while asserting nothing.
   */
  function dataPlaneConfig(): OcxConfig {
    return {
      port: 0,
      hostname: "0.0.0.0",
      defaultProvider: "mock",
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:1/v1", apiKey: "k", allowPrivateNetwork: true, models: ["test-model"] },
      },
      apiKeys: [{ id: "catalog-reader", name: "catalog reader", key: DATA_KEY, createdAt: "2026-08-30T00:00:00.000Z" }],
    } as OcxConfig;
  }

  const catalogFixture = {
    models: [{
      slug: "mock/test-model",
      display_name: "Mock Test",
      description: "fixture",
      priority: 1,
      visibility: "list",
      base_instructions: "You are a helpful coding assistant.",
      input_modalities: ["text"],
    }],
  };

  test("serves the catalog to a data credential and byte-matches the management route", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ocx-v1-catalog-");
    writeFileSync(join(isolatedCodexHome.path, "opencodex-catalog.json"), JSON.stringify(catalogFixture));
    saveConfig(dataPlaneConfig());

    const { startServer } = await import("../src/server");
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(JSON.parse(body)).toEqual(catalogFixture);
      expect(res.headers.get("cache-control")).toBe("private, no-cache");
      const etag = res.headers.get("etag");
      expect(etag).toBeTruthy();

      // The whole point of the shared serializer: the two planes must not drift.
      const mgmtUrl = new URL("http://localhost/api/catalog");
      const mgmt = await handleManagementAPI(
        new ManagementRequest(mgmtUrl, { headers: managementHeaders() }),
        mgmtUrl,
        loadConfig(),
      );
      expect(mgmt?.status).toBe(200);
      expect(await mgmt!.text()).toBe(body);

      // Conditional GET re-validates without resending the payload.
      const revalidated = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY, "if-none-match": etag! },
      });
      expect(revalidated.status).toBe(304);
      expect(await revalidated.text()).toBe("");

      // HEAD is the same status and headers with no body.
      const head = await fetch(new URL("/v1/catalog", server.url), {
        method: "HEAD",
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(head.status).toBe(200);
      expect(head.headers.get("etag")).toBe(etag);
      expect(await head.text()).toBe("");
    } finally {
      await server.stop(true);
    }
  });

  test("rejects a missing credential and never widens /api/* for a data credential", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ocx-v1-catalog-auth-");
    writeFileSync(join(isolatedCodexHome.path, "opencodex-catalog.json"), JSON.stringify(catalogFixture));
    saveConfig(dataPlaneConfig());

    const { startServer } = await import("../src/server");
    const server = startServer(0);
    try {
      const anonymous = await fetch(new URL("/v1/catalog", server.url));
      expect(anonymous.status).toBe(401);

      const wrong = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": "ocx_data_not_a_real_key" },
      });
      expect(wrong.status).toBe(401);

      // The point of #809: the data credential reads the catalog but must gain NOTHING on the
      // management plane. If this ever passes, the fix became the vulnerability.
      for (const path of ["/api/catalog", "/api/config", "/api/providers"]) {
        const escalation = await fetch(new URL(path, server.url), {
          headers: { "x-opencodex-api-key": DATA_KEY },
        });
        expect(escalation.status).toBe(401);
      }

      // Mutations stay out of /v1 entirely.
      const post = await fetch(new URL("/v1/catalog", server.url), {
        method: "POST",
        headers: { "x-opencodex-api-key": DATA_KEY, "content-type": "application/json" },
        body: "{}",
      });
      expect(post.status).not.toBe(200);
    } finally {
      await server.stop(true);
    }
  });

  test("serves a supported large catalog on both planes", async () => {
    // The repo supports up to 2,000 discovered models. A 2,000-row catalog serializes to
    // roughly 92 MB, so an earlier 32 MiB ceiling in the shared serializer rejected a VALID
    // catalog — and, because both routes shared it, turned the pre-existing /api/catalog
    // response into a 507 for those operators. The ceiling now belongs to the remote route
    // alone and clears the supported bound.
    isolatedCodexHome = installIsolatedCodexHome("ocx-v1-catalog-large-");
    const template = catalogFixture.models[0]!;
    const big = {
      models: Array.from({ length: 2000 }, (_, i) => ({
        ...template,
        slug: `mock/test-model-${i}`,
        display_name: `Mock Test ${i}`,
        // Pad so the serialized document clears 32 MiB, matching a real large catalog's
        // per-row instruction text rather than a synthetic blob.
        base_instructions: template.base_instructions + " ".repeat(20000),
      })),
    };
    writeFileSync(join(isolatedCodexHome.path, "opencodex-catalog.json"), JSON.stringify(big));
    saveConfig(dataPlaneConfig());

    const { serializePersistedCatalog, MAX_REMOTE_CATALOG_BYTES } = await import("../src/server/catalog-download");
    const serialized = await serializePersistedCatalog();
    expect(serialized.body).not.toBeNull();
    expect(serialized.bytes!).toBeGreaterThan(32 * 1024 * 1024);
    expect(serialized.bytes!).toBeLessThan(MAX_REMOTE_CATALOG_BYTES);

    // The management route must still answer 200 for it.
    const mgmtUrl = new URL("http://localhost/api/catalog");
    const mgmt = await handleManagementAPI(
      new ManagementRequest(mgmtUrl, { headers: managementHeaders() }),
      mgmtUrl,
      loadConfig(),
    );
    expect(mgmt?.status).toBe(200);
  });

  test("reports a distinguishable code when no catalog is materialized", async () => {
    isolatedCodexHome = installIsolatedCodexHome("ocx-v1-catalog-missing-");
    saveConfig(dataPlaneConfig());

    const { startServer } = await import("../src/server");
    const server = startServer(0);
    try {
      const res = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_KEY },
      });
      expect(res.status).toBe(404);
      // catalog_not_found rather than the generic not_found: this is what distinguishes
      // "route exists, no catalog" from "route is gone", so a deleted route cannot pass
      // the AUTH_MATRIX check in tests/api-key-attribution.test.ts vacuously.
      const body = await res.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe("catalog_not_found");
    } finally {
      await server.stop(true);
    }
  });
});
