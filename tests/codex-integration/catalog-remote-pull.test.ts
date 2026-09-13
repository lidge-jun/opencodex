import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

import {
  fetchRemoteCatalog,
  pullRemoteCatalog,
  RemoteCatalogError,
  validateRemoteCatalogDocument,
  validateRemoteCatalogUrl,
} from "../../src/codex/catalog/remote";
import { resolveCodexCatalogSerializationDatabasePath, resolveEffectiveUserIdentity } from "../../src/codex/user-identity";
import { withCatalogWriteSerialization } from "../../src/codex/catalog-write-serialization";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const homes: string[] = [];
afterEach(() => { while (homes.length) removeTreeWithRetry(homes.pop()!); });

function home(): string {
  const value = mkdtempSync(join(tmpdir(), "ocx-catalog-pull-"));
  homes.push(value);
  return value;
}

const catalog = { version: 1, models: [{ slug: "provider/model", input_modalities: ["text", "image"], extension: { safe: true } }] };
const response = (value: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(value), {
  headers: { "Content-Type": "application/json", ...init.headers }, status: init.status,
});

describe("remote catalog acquisition", () => {
  test("accepts HTTPS and loopback HTTP but rejects credentials and insecure remote HTTP", () => {
    expect(validateRemoteCatalogUrl("https://hub.example.com/v1/catalog").href).toBe("https://hub.example.com/v1/catalog");
    expect(validateRemoteCatalogUrl("http://127.0.0.1:10100/v1/catalog").protocol).toBe("http:");
    expect(() => validateRemoteCatalogUrl("http://hub.example.com/v1/catalog")).toThrow(RemoteCatalogError);
    expect(() => validateRemoteCatalogUrl("https://user:secret@example.com/v1/catalog")).toThrow(RemoteCatalogError);
    expect(() => validateRemoteCatalogUrl("https://hub.example.com/v1/catalog?q=secret")).toThrow(RemoteCatalogError);
  });

  test("sends optional bearer authentication from the caller without following redirects", async () => {
    const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer env-token");
      expect(init?.redirect).toBe("manual");
      return response(catalog);
    }) as typeof fetch;
    const fetched = await fetchRemoteCatalog("https://hub.example/v1/catalog", { token: "env-token", fetchImpl });
    expect(fetched.document).toEqual(catalog);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await expect(fetchRemoteCatalog("https://hub.example/v1/catalog", {
      token: "secret-marker", fetchImpl: async () => new Response("body-marker", { status: 302, headers: { Location: "https://other.example/secret" } }),
    })).rejects.toMatchObject({ code: "redirect_refused", message: "Remote catalog redirect was refused" });
  });

  test("never reflects credentials, remote bodies, URLs, or transport causes", async () => {
    for (const fetchImpl of [
      async () => new Response("remote-body-marker", { status: 401 }),
      async () => { throw new Error("secret-marker https://private.example/path"); },
    ]) {
      let caught: unknown;
      try { await fetchRemoteCatalog("https://hub.example/v1/catalog", { token: "secret-marker", fetchImpl: fetchImpl as typeof fetch }); }
      catch (error) { caught = error; }
      expect(String(caught)).not.toContain("secret-marker");
      expect(String(caught)).not.toContain("remote-body-marker");
      expect(String(caught)).not.toContain("private.example");
      expect((caught as Error).cause).toBeUndefined();
    }
  });

  test.each([401, 403, 404, 500])("rejects HTTP %s", async status => {
    await expect(fetchRemoteCatalog("https://hub.example/v1/catalog", {
      fetchImpl: async () => new Response(null, { status }),
    })).rejects.toMatchObject({ code: "http_error", status });
  });

  test("enforces declared and streamed byte limits", async () => {
    await expect(fetchRemoteCatalog("https://hub.example/v1/catalog", {
      maxBytes: 10, fetchImpl: async () => new Response("{}", { headers: { "Content-Type": "application/json", "Content-Length": "11" } }),
    })).rejects.toMatchObject({ code: "body_too_large" });
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new TextEncoder().encode('{"models":['));
      controller.enqueue(new Uint8Array(128)); controller.close();
    } });
    await expect(fetchRemoteCatalog("https://hub.example/v1/catalog", {
      maxBytes: 32, fetchImpl: async () => new Response(stream, { headers: { "Content-Type": "application/json", "Content-Length": "1" } }),
    })).rejects.toMatchObject({ code: "body_too_large" });
  });

  test("bounds headers and stalled streams", async () => {
    await expect(fetchRemoteCatalog("https://hub.example/v1/catalog", {
      timeoutMs: 10,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("secret timeout cause")), { once: true });
      }),
    })).rejects.toMatchObject({ code: "request_failed" });
  });
});

describe("remote catalog validation", () => {
  test.each([
    [null], [[]], [{}], [{ models: [] }], [{ models: [null] }], [{ models: [[]] }],
    [{ models: [{}] }], [{ models: [{ slug: "" }] }], [{ models: [{ slug: " padded " }] }],
    [{ models: [{ slug: "bad\u0000slug" }] }], [{ models: [{ slug: "a" }, { slug: "a" }] }],
    [{ models: [{ slug: "a", input_modalities: [] }] }],
    [{ models: [{ slug: "a", input_modalities: ["video"] }] }],
  ])("rejects invalid document %#", value => {
    expect(() => validateRemoteCatalogDocument(value)).toThrow(RemoteCatalogError);
  });

  test("preserves safe additive fields", () => {
    expect(validateRemoteCatalogDocument(catalog)).toEqual(catalog);
  });
});

describe("remote catalog coordinated installation", () => {
  test("updates catalog and cache under the shared writer even when desired integration is disabled", async () => {
    const codexHome = home();
    const opencodexHome = home();
    const previous = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = opencodexHome;
    writeFileSync(join(opencodexHome, "config.json"), JSON.stringify({ providers: {}, defaultProvider: "openai", desiredIntegrations: { codex: false } }));
    try {
      const result = await pullRemoteCatalog("https://hub.example/v1/catalog", {
        codexHome, fetchImpl: async () => response(catalog),
      });
      expect(result).toMatchObject({ status: "updated", catalogWritten: true, cacheSynced: true, modelCount: 1 });
      expect(JSON.parse(readFileSync(result.catalogPath, "utf8"))).toEqual(catalog);
      expect(JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")).models).toEqual(catalog.models);
    } finally {
      if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
    }
  });

  test("an identical pull preserves catalog and cache mtimes", async () => {
    const codexHome = home();
    const fetchImpl = async () => response(catalog);
    const first = await pullRemoteCatalog("https://hub.example/v1/catalog", { codexHome, fetchImpl });
    const cachePath = join(codexHome, "models_cache.json");
    const before = [statSync(first.catalogPath).mtimeMs, statSync(cachePath).mtimeMs];
    await Bun.sleep(20);
    const second = await pullRemoteCatalog("https://hub.example/v1/catalog", { codexHome, fetchImpl });
    expect(second).toMatchObject({ status: "unchanged", catalogWritten: false, cacheSynced: false });
    expect([statSync(first.catalogPath).mtimeMs, statSync(cachePath).mtimeMs]).toEqual(before);
  });

  test("lock contention is typed and preserves last-known-good files", async () => {
    const codexHome = home();
    // Materialize K, then hold BEGIN IMMEDIATE from a separate connection while pull attempts it.
    expect(withCatalogWriteSerialization(codexHome, () => null).kind).toBe("completed");
    const lockPath = resolveCodexCatalogSerializationDatabasePath(resolveEffectiveUserIdentity(), codexHome);
    const holder = new Database(lockPath);
    holder.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE");
    try {
      await expect(pullRemoteCatalog("https://hub.example/v1/catalog", {
        codexHome, fetchImpl: async () => response(catalog),
      })).rejects.toMatchObject({ code: "lock_busy" });
      expect(existsSync(join(codexHome, "opencodex-catalog.json"))).toBe(false);
      expect(existsSync(join(codexHome, "models_cache.json"))).toBe(false);
    } finally {
      holder.exec("ROLLBACK"); holder.close();
    }
  });

  test("fetch and validation failures preserve last-known-good files", async () => {
    const codexHome = home();
    const catalogPath = join(codexHome, "opencodex-catalog.json");
    const cachePath = join(codexHome, "models_cache.json");
    writeFileSync(catalogPath, "catalog-before"); writeFileSync(cachePath, "cache-before");
    for (const fetchImpl of [async () => new Response(null, { status: 500 }), async () => response({ models: [] })]) {
      await expect(pullRemoteCatalog("https://hub.example/v1/catalog", { codexHome, fetchImpl: fetchImpl as typeof fetch })).rejects.toBeInstanceOf(RemoteCatalogError);
      expect(readFileSync(catalogPath, "utf8")).toBe("catalog-before");
      expect(readFileSync(cachePath, "utf8")).toBe("cache-before");
    }
    expect(existsSync(join(codexHome, "models_cache.json"))).toBe(true);
  });
});

describe("catalog pull CLI envelope", () => {
  test("emits a stable JSON failure without reflecting the secret environment value", async () => {
    const { handleCatalogCommand } = await import("../../src/cli/catalog");
    const old = process.env.OCX_CATALOG_TEST_TOKEN;
    process.env.OCX_CATALOG_TEST_TOKEN = "secret-cli-marker";
    const output: string[] = [];
    const errors: string[] = [];
    const log = console.log;
    const error = console.error;
    console.log = (...values) => { output.push(values.map(String).join(" ")); };
    console.error = (...values) => { errors.push(values.map(String).join(" ")); };
    try {
      expect(await handleCatalogCommand([
        "pull", "http://remote.example/v1/catalog", "--auth-env", "OCX_CATALOG_TEST_TOKEN", "--json",
      ])).toBe(1);
      expect(output).toHaveLength(1);
      expect(JSON.parse(output[0]!)).toEqual({
        schemaVersion: 1, ok: false, status: "failed", catalogWritten: false,
        cacheSynced: false, codexRestarted: false, code: "insecure_http_refused",
      });
      expect(output.join("\n") + errors.join("\n")).not.toContain("secret-cli-marker");
    } finally {
      console.log = log; console.error = error;
      if (old === undefined) delete process.env.OCX_CATALOG_TEST_TOKEN; else process.env.OCX_CATALOG_TEST_TOKEN = old;
    }
  });
});
