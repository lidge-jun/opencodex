import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import { DATA_PLANE_CATALOG_MAX_BYTES } from "../src/server/data-plane-catalog";
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
// Fixture secrets use the shapes `scripts/privacy-scan.ts` already recognizes as
// obviously-fake test sentinels, so this file cannot trip the gate it exists to defend.
const PROVIDER_API_KEY = "sk-test-809providerkeysentinel";
const CODEX_ACCOUNT_ID = "codex-account-privateid-9f2c";
const CODEX_ACCOUNT_EMAIL = "operator@pool.example.test";
/** An operator-chosen public namespace; the catalog may carry it, the account id may not. */
const PUBLIC_SELECTOR = "workspace-a";
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

/**
 * A configuration carrying every class of secret the response must never echo: a provider
 * API key, a management token, the caller's own admission key, and a private Codex account
 * identity behind a public selector.
 */
function secretfulConfig(): OcxConfig {
  return {
    ...remoteConfig(),
    providers: {
      fixture: {
        adapter: "openai-chat",
        baseUrl: "https://fixture.test/v1",
        apiKey: PROVIDER_API_KEY,
        disabled: true,
        models: ["gpt-fixture"],
      },
    },
    codexAccountPickerEnabled: true,
    codexAccounts: [{ id: CODEX_ACCOUNT_ID, email: CODEX_ACCOUNT_EMAIL, isMain: false }],
    codexAccountNamespaces: { [PUBLIC_SELECTOR]: CODEX_ACCOUNT_ID },
  } as OcxConfig;
}

function writeCatalogFixture(): void {
  codexHome = installIsolatedCodexHome("ocx-v1-catalog-");
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify(CATALOG_FIXTURE), "utf8");
}

/** A catalog that legitimately carries an account-bound entry keyed by the public selector. */
function writeAccountBoundCatalogFixture(): void {
  codexHome = installIsolatedCodexHome("ocx-v1-catalog-account-");
  const catalog = {
    models: [
      ...CATALOG_FIXTURE.models,
      {
        slug: `${PUBLIC_SELECTOR}/gpt-5.3-codex`,
        display_name: `${PUBLIC_SELECTOR} / 5.3 Codex`,
        description: "fixture account-bound entry",
        priority: 3,
        visibility: "list",
        input_modalities: ["text"],
        opencodex_catalog_kind: "account-selector-v1",
      },
    ],
  };
  writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify(catalog), "utf8");
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

describe("HEAD /v1/catalog (#809)", () => {
  test("answers the same status and headers as GET, with no body", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const get = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      const head = await fetch(new URL("/v1/catalog", server.url), {
        method: "HEAD",
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(head.status).toBe(get.status);
      for (const header of ["content-type", "cache-control", "x-content-type-options"]) {
        expect(head.headers.get(header)).toBe(get.headers.get(header));
      }
      // The reason to offer HEAD at all: a client can learn the size and version
      // skew before spending the download.
      expect(head.headers.get("content-length")).toBe(
        String(Buffer.byteLength(JSON.stringify(CATALOG_FIXTURE), "utf8")),
      );
      expect(await head.text()).toBe("");
    } finally {
      await server.stop(true);
    }
  });

  test("an absent catalog fails the same way it does for GET", async () => {
    codexHome = installIsolatedCodexHome("ocx-v1-catalog-head-missing-");
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        method: "HEAD",
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop(true);
    }
  });

  test("a missing credential is rejected before the catalog is read", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), { method: "HEAD" });
      expect(response.status).toBe(401);
    } finally {
      await server.stop(true);
    }
  });
});

describe("/v1/catalog is read-only (#809)", () => {
  test.each(["POST", "PUT", "PATCH", "DELETE"])("%s is rejected with Allow: GET, HEAD", async method => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        method,
        headers: { "content-type": "application/json", "x-opencodex-api-key": DATA_PLANE_KEY },
        ...(method === "DELETE" ? {} : { body: JSON.stringify({ models: [] }) }),
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe("method_not_allowed");
      // A rejected mutation must not have been treated as a catalog write.
      expect(JSON.stringify(body)).not.toContain("gpt-5.3-codex");
    } finally {
      await server.stop(true);
    }
  });

  test.each(["POST", "DELETE"])("%s without a credential is rejected as unauthenticated, not as a bad method", async method => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        method,
        headers: { "content-type": "application/json" },
        ...(method === "DELETE" ? {} : { body: "{}" }),
      });
      // Admission runs first on purpose: an anonymous caller learns nothing about
      // which methods the route would have accepted.
      expect(response.status).toBe(401);
      expect(response.headers.get("allow")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });
});

describe("the catalog read buys nothing on the management plane (#809)", () => {
  /**
   * The half of #809 that makes the route worth having. Reading `/v1/catalog` must not
   * become a foothold on `/api/*` — including `/api/catalog` itself, which is why the
   * accepted design added a route instead of widening management admission.
   */
  test.each([
    ["GET", "/api/catalog"],
    ["GET", "/api/config"],
    ["GET", "/api/providers"],
    ["GET", "/api/keys"],
    ["POST", "/api/providers"],
    ["POST", "/api/oauth/login"],
    ["POST", "/api/codex-auth/login"],
    ["PUT", "/api/disabled-models"],
    ["POST", "/api/stop"],
  ])("the data-plane credential is denied on %s %s", async (method, path) => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const catalog = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      // Pin that this exact credential is the one that just read the catalog, so a
      // denial below cannot be explained by the key being unusable everywhere.
      expect(catalog.status).toBe(200);

      const management = await fetch(new URL(path, server.url), {
        method,
        headers: { "content-type": "application/json", "x-opencodex-api-key": DATA_PLANE_KEY },
        ...(method === "GET" ? {} : { body: JSON.stringify({ provider: "fixture", models: [] }) }),
      });
      expect(management.status).toBe(401);
      // 503 would mean management auth was unavailable rather than that it refused
      // this credential, which would make the assertion above vacuous.
      expect(await management.text()).toContain("admin token required");
    } finally {
      await server.stop(true);
    }
  });

  test("the bearer and x-api-key forms of the data-plane credential are denied too", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      for (const headers of [
        { authorization: `Bearer ${DATA_PLANE_KEY}` },
        { "x-api-key": DATA_PLANE_KEY },
      ]) {
        const response = await fetch(new URL("/api/config", server.url), { headers });
        expect(response.status).toBe(401);
      }
    } finally {
      await server.stop(true);
    }
  });

  test("a management-only credential does not open the data-plane route", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      // The boundary is mutual: the admin token is not a data-plane admission secret,
      // so it must not silently become one just because this route reads a document
      // the management plane also serves.
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": ADMIN_TOKEN },
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("slug");
    } finally {
      await server.stop(true);
    }
  });
});

describe("the data-plane catalog response carries no management state (#809)", () => {
  /** Every byte a caller can observe: status line values, header values, and the body. */
  async function observableSurface(response: Response): Promise<string> {
    const headers = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\n");
    return `${response.status}\n${headers}\n${await response.text()}`;
  }

  function forbiddenStrings(): Array<[string, string]> {
    return [
      ["provider API key", PROVIDER_API_KEY],
      ["management token", ADMIN_TOKEN],
      ["the caller's own data-plane key", DATA_PLANE_KEY],
      ["Codex account id", CODEX_ACCOUNT_ID],
      ["Codex account email", CODEX_ACCOUNT_EMAIL],
      ["raw provider base URL", "fixture.test"],
      ["the Codex home path", codexHome?.path ?? "«no codex home»"],
      ["the opencodex home path", testHome],
    ];
  }

  test("a successful read exposes no credential, account identity, provider config, or local path", async () => {
    writeAccountBoundCatalogFixture();
    saveConfig(secretfulConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(200);
      const surface = await observableSurface(response);
      // Guard against a vacuous pass: the account-bound entry really is in the
      // document, so the assertions below are about redaction, not about an empty
      // catalog that happens to mention nothing.
      expect(surface).toContain(`${PUBLIC_SELECTOR}/gpt-5.3-codex`);
      for (const [label, secret] of forbiddenStrings()) {
        expect({ label, leaked: surface.includes(secret) }).toEqual({ label, leaked: false });
      }
    } finally {
      await server.stop(true);
    }
  });

  test("the absent-catalog error names no path on the operator's disk", async () => {
    codexHome = installIsolatedCodexHome("ocx-v1-catalog-leak-missing-");
    saveConfig(secretfulConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(404);
      const surface = await observableSurface(response);
      for (const [label, secret] of forbiddenStrings()) {
        expect({ label, leaked: surface.includes(secret) }).toEqual({ label, leaked: false });
      }
    } finally {
      await server.stop(true);
    }
  });
});

describe("data-plane catalog response boundaries (#809)", () => {
  test("declares its type, refuses intermediary caching, and blocks sniffing", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    } finally {
      await server.stop(true);
    }
  });

  test("reports the selected Codex version when the proxy has an authoritative one", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    writeFileSync(join(testHome, "codex-runtime.json"), JSON.stringify({
      version: 1,
      command: "codex",
      source: "path",
      selectedVersion: "0.133.0",
      updatedAt: "2026-08-12T00:00:00.000Z",
    }), "utf8");
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.headers.get("x-opencodex-codex-version")).toBe("0.133.0");
    } finally {
      await server.stop(true);
    }
  });

  test("omits the version header rather than inventing one when no runtime is recorded", async () => {
    writeCatalogFixture();
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-opencodex-codex-version")).toBeNull();
    } finally {
      await server.stop(true);
    }
  });

  test("refuses a catalog beyond the declared response ceiling instead of streaming it", async () => {
    codexHome = installIsolatedCodexHome("ocx-v1-catalog-oversized-");
    const oversized = {
      models: [{
        slug: "fixture/oversized",
        display_name: "oversized",
        description: "x".repeat(DATA_PLANE_CATALOG_MAX_BYTES + 1024),
        visibility: "list",
        input_modalities: ["text"],
      }],
    };
    writeFileSync(join(codexHome.path, "opencodex-catalog.json"), JSON.stringify(oversized), "utf8");
    saveConfig(remoteConfig());
    const server = startServer(0);
    try {
      const response = await fetch(new URL("/v1/catalog", server.url), {
        headers: { "x-opencodex-api-key": DATA_PLANE_KEY },
      });
      expect(response.status).toBe(500);
      const body = await response.json() as { error?: { code?: string } };
      expect(body.error?.code).toBe("catalog_too_large");
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
