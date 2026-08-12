import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import type { OcxConfig } from "../src/types";

/**
 * `/v1/catalog` (#809) is the least-privilege projection of the catalog document the
 * management route already serves. These tests pin the half that matters: a remote
 * Codex client can read the catalog with the credential it already holds for
 * inference, and that credential still buys nothing on the management plane.
 */

const DATA_PLANE_KEY = "ocx_data_catalogreader";
const ADMIN_TOKEN = "admin-secret-for-v1-catalog";
const previousHome = process.env.OPENCODEX_HOME;
const previousDataToken = process.env.OPENCODEX_API_AUTH_TOKEN;
const previousAdminToken = process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
let testHome = "";
let codexHome: IsolatedCodexHome | null = null;

const CATALOG_FIXTURE = {
  models: [
    {
      slug: "gpt-5.3-codex",
      display_name: "GPT-5.3 Codex",
      description: "fixture native entry",
      priority: 1,
      visibility: "list",
      base_instructions: "You are a helpful coding assistant.",
      input_modalities: ["text"],
    },
    {
      slug: "fixture/gpt-fixture",
      display_name: "gpt-fixture",
      description: "Routed via opencodex → fixture",
      priority: 2,
      visibility: "list",
      input_modalities: ["text"],
      owned_by: "fixture",
    },
  ],
};

function remoteConfig(): OcxConfig {
  return {
    port: 0,
    hostname: "0.0.0.0",
    defaultProvider: "fixture",
    providers: {
      fixture: { adapter: "openai-chat", baseUrl: "https://fixture.test/v1", disabled: true, models: ["gpt-fixture"] },
    },
    apiKeys: [
      { id: "catalog-reader", name: "catalog reader", key: DATA_PLANE_KEY, createdAt: "2026-08-12T00:00:00.000Z" },
    ],
  } as OcxConfig;
}

function writeCatalogFixture(): void {
  codexHome = installIsolatedCodexHome("ocx-v1-catalog-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
}

beforeEach(() => {
  testHome = mkdtempSync(join(tmpdir(), "ocx-v1-catalog-home-"));
  process.env.OPENCODEX_HOME = testHome;
  delete process.env.OPENCODEX_API_AUTH_TOKEN;
  process.env.OPENCODEX_ADMIN_AUTH_TOKEN = ADMIN_TOKEN;
  codexHome = null;
});

afterEach(() => {
  codexHome?.restore();
  codexHome = null;
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  if (previousDataToken === undefined) delete process.env.OPENCODEX_API_AUTH_TOKEN;
  else process.env.OPENCODEX_API_AUTH_TOKEN = previousDataToken;
  if (previousAdminToken === undefined) delete process.env.OPENCODEX_ADMIN_AUTH_TOKEN;
  else process.env.OPENCODEX_ADMIN_AUTH_TOKEN = previousAdminToken;
  if (testHome) rmSync(testHome, { recursive: true, force: true });
  testHome = "";
});

describe("GET /v1/catalog admission (#809)", () => {
  test("a data-plane credential reads the generated catalog", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual(CATALOG_FIXTURE);
    } finally {
      await server.stop(true);
    }
  });

  test("a missing credential is rejected", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url));
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("slug");
    } finally {
      await server.stop(true);
    }
  });

  test("an invalid credential is rejected", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": "ocx_data_notaconfiguredkey" },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("slug");
    } finally {
      await server.stop(true);
    }
  });
});

describe("catalog authority is shared with the management route (#809)", () => {
  test("both routes serve byte-identical catalog documents", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const dataPlane = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      const management = await fetch(new URL("/api/catalog", server.url), {
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(dataPlane.status).toBe(200);
      expect(management.status).toBe(200);
      // Byte equality, not deep equality: a second serializer would be free to
      // reorder or re-shape the document while still passing a structural check.
      expect(await dataPlane.text()).toBe(await management.text());
    } finally {
      await server.stop(true);
    }
  });

  test("an absent catalog is a deterministic data-plane error, not an empty document", async () => {
    codexHome = installIsolatedCodexHome("ocx-v1-catalog-missing-");
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(404);
      const body = await response.json() as { error?: { code?: string } };
      // Distinct from the generic `not_found` an unknown /v1/* path returns, so a
      // client script can tell "no such route" from "catalog not materialized".
      expect(body.error?.code).toBe("catalog_not_found");
    } finally {
      await server.stop(true);
    }
  });
});
