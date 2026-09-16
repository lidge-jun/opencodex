import { afterEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

const proxyEnvKeys = [
  "HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy",
  "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy",
] as const;

async function withProxyEnv(env: Record<string, string>, action: () => Promise<void>): Promise<void> {
  const previous = proxyEnvKeys.map(key => [key, process.env[key]] as const);
  try {
    for (const key of proxyEnvKeys) delete process.env[key];
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    await action();
  } finally {
    for (const key of proxyEnvKeys) delete process.env[key];
    for (const [key, value] of previous) {
      if (value !== undefined) process.env[key] = value;
    }
  }
}

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

  test("refuses proxied loopback HTTP before fetch without disclosing authentication or proxy details", async () => {
    const proxy = "http://proxy-user:proxy-secret@127.0.0.2:8080";
    const environments: Record<string, string>[] = [
      { HTTP_PROXY: proxy },
      { http_proxy: proxy },
      { HTTP_PROXY: "", http_proxy: proxy },
      { HTTP_PROXY: proxy, NO_PROXY: "elsewhere.example" },
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1:9999" },
      { HTTP_PROXY: proxy, NO_PROXY: "http://127.0.0.1" },
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1/path" },
      { HTTP_PROXY: proxy, NO_PROXY: "*.127.0.0.1" },
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1." },
      { HTTP_PROXY: proxy, NO_PROXY: "\u00a0127.0.0.1\u00a0" },
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1", no_proxy: "elsewhere.example" },
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1", no_proxy: " " },
    ];
    for (const env of environments) {
      await withProxyEnv(env, async () => {
        const fetchImpl = mock(async () => response(catalog)) as typeof fetch;
        const error: unknown = await fetchRemoteCatalog("http://127.0.0.1:10100/v1/catalog", {
          token: "catalog-token-marker", fetchImpl,
        }).catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(RemoteCatalogError);
        expect(error).toMatchObject({ code: "insecure_http_refused" });
        expect(fetchImpl).not.toHaveBeenCalled();
        for (const marker of ["catalog-token-marker", "proxy-user", "proxy-secret", "127.0.0.2", "127.0.0.1"]) {
          expect(String(error)).not.toContain(marker);
        }
      });
    }
  });

  test("permits direct loopback HTTP with matching proxy bypasses or fetch-irrelevant proxy variables", async () => {
    const proxy = "http://proxy.example:8080";
    const environments: Record<string, string>[] = [
      {},
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1" },
      { http_proxy: proxy, no_proxy: "127.0.0.1" },
      { HTTP_PROXY: proxy, NO_PROXY: "127.0.0.1:10100" },
      { HTTP_PROXY: proxy, NO_PROXY: "*" },
      { HTTP_PROXY: proxy, NO_PROXY: ".127.0.0.1" },
      { HTTP_PROXY: proxy, NO_PROXY: "elsewhere.example", no_proxy: "127.0.0.1" },
      { HTTP_PROXY: proxy, NO_PROXY: "\v\f127.0.0.1\r\n" },
      { HTTP_PROXY: '""' },
      { http_proxy: "''" },
      { HTTP_PROXY: proxy, http_proxy: '""' },
      { ALL_PROXY: proxy },
      { all_proxy: proxy },
      { HTTPS_PROXY: proxy },
      { https_proxy: proxy },
    ];
    for (const env of environments) {
      await withProxyEnv(env, async () => {
        const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer catalog-token-marker");
          expect(init?.redirect).toBe("manual");
          return response(catalog);
        }) as typeof fetch;
        await expect(fetchRemoteCatalog("http://127.0.0.1:10100/v1/catalog", {
          token: "catalog-token-marker", fetchImpl,
        })).resolves.toMatchObject({ document: catalog });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      });
    }
  });

  test.each([
    ["http://127.0.0.1", false],
    ["127.0.0.1", true],
  ] as const)("real Bun transport respects the catalog guard for NO_PROXY=%s", async (bypass, direct) => {
    let targetRequests = 0;
    let proxyRequests = 0;
    let authenticatedTargetRequests = 0;
    const token = "synthetic-catalog-runtime-token";
    let target: ReturnType<typeof Bun.serve> | undefined;
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    let child: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
      target = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) {
        targetRequests += 1;
        if (req.headers.get("authorization") === `Bearer ${token}`) authenticatedTargetRequests += 1;
        return response(catalog);
      } });
      proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
        proxyRequests += 1;
        return response(catalog);
      } });
      // Inherit process-launch necessities and test provenance only, never host credentials.
      const env: Record<string, string> = {};
      for (const key of ["PATH", "Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP",
        "OCX_TEST_HOME_GUARD", "OCX_TEST_RUN_ID"]) {
        const value = process.env[key];
        if (value !== undefined) env[key] = value;
      }
      for (const key of proxyEnvKeys) delete env[key];
      env.OPENCODEX_HOME = home();
      env.CODEX_HOME = home();
      env.HOME = env.USERPROFILE = home();
      // A local dotenv must not override the explicitly supplied routing fixture.
      writeFileSync(join(env.OPENCODEX_HOME, ".env"), "no_proxy=*\n");
      env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`;
      env.NO_PROXY = bypass;
      const source = new URL("../../src/codex/catalog/remote.ts", import.meta.url).href;
      const script = `
        const { fetchRemoteCatalog } = await import(${JSON.stringify(source)});
        try {
          const result = await fetchRemoteCatalog(${JSON.stringify(`http://127.0.0.1:${target.port}/v1/catalog`)},
            { token: ${JSON.stringify(token)} });
          console.log(JSON.stringify({ document: result.document }));
        } catch (error) {
          console.log(JSON.stringify({ code: error?.code ?? "unexpected_error" }));
        }
      `;
      child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], { cwd: env.OPENCODEX_HOME, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      timer = setTimeout(() => { timedOut = true; child?.kill("SIGKILL"); }, 10_000);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
      ]);
      const evidence = JSON.stringify({ exitCode, timedOut, targetRequests, proxyRequests, stdout, stderr });
      expect(timedOut, evidence).toBe(false);
      expect(exitCode, evidence).toBe(0);
      expect(proxyRequests, evidence).toBe(0);
      expect(targetRequests, evidence).toBe(direct ? 1 : 0);
      expect(authenticatedTargetRequests, evidence).toBe(direct ? 1 : 0);
      expect(JSON.parse(stdout)).toEqual(direct ? { document: catalog } : { code: "insecure_http_refused" });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (child && child.exitCode === null) { child.kill("SIGKILL"); await child.exited; }
      await proxy?.stop(true);
      await target?.stop(true);
    }
  }, 15_000);

  test("keeps authenticated HTTPS acquisition available with an outbound proxy", async () => {
    await withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080", HTTPS_PROXY: "http://proxy.example:8080" }, async () => {
      const fetchImpl = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer catalog-token-marker");
        expect(init?.redirect).toBe("manual");
        return response(catalog);
      }) as typeof fetch;
      await expect(fetchRemoteCatalog("https://hub.example/v1/catalog", {
        token: "catalog-token-marker", fetchImpl,
      })).resolves.toMatchObject({ document: catalog });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });

  test.each([
    ["http://[::1]:10100/v1/catalog", "::1", false],
    ["http://[::1]:10100/v1/catalog", "[::1]", true],
    ["http://[::1]:10100/v1/catalog", "[::1]:10100", true],
    ["http://[::1]:10100/v1/catalog", "[::1]:9999", false],
    ["http://127.0.0.1/v1/catalog", "127.0.0.1:80", false],
  ] as const)("uses Bun's literal host/port bypass for %s and %s", async (url, bypass, direct) => {
    await withProxyEnv({ HTTP_PROXY: "http://proxy.example:8080", NO_PROXY: bypass }, async () => {
      const fetchImpl = mock(async () => response(catalog)) as typeof fetch;
      const result = fetchRemoteCatalog(url, { token: "catalog-token-marker", fetchImpl });
      if (direct) {
        await expect(result).resolves.toMatchObject({ document: catalog });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      } else {
        await expect(result).rejects.toMatchObject({ code: "insecure_http_refused" });
        expect(fetchImpl).not.toHaveBeenCalled();
      }
    });
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

  test("a cache rebuild that fails after the catalog write puts the previous catalog back", async () => {
    const codexHome = home();
    const first = await pullRemoteCatalog("https://hub.example/v1/catalog", {
      codexHome, fetchImpl: async () => response(catalog),
    });
    const before = readFileSync(first.catalogPath, "utf8");
    // Make the cache write fail AFTER the catalog has already been replaced. The permit rolls
    // back SQLite; the catalog is an atomic file write that nothing else undoes.
    const cachePath = join(codexHome, "models_cache.json");
    rmSync(cachePath, { force: true });
    mkdirSync(cachePath);
    const next = { version: 1, models: [{ slug: "provider/second-model" }] };

    await expect(pullRemoteCatalog("https://hub.example/v1/catalog", {
      codexHome, fetchImpl: async () => response(next),
    })).rejects.toMatchObject({ code: "write_failed" });

    // Without the restore this reads the SECOND catalog while the cache is stale, and the
    // caller was told the pull wrote nothing.
    expect(readFileSync(first.catalogPath, "utf8")).toBe(before);
  });

  test("a cache rebuild that fails on a first pull leaves no catalog behind", async () => {
    const codexHome = home();
    const catalogPath = join(codexHome, "opencodex-catalog.json");
    const cachePath = join(codexHome, "models_cache.json");
    mkdirSync(cachePath);

    await expect(pullRemoteCatalog("https://hub.example/v1/catalog", {
      codexHome, fetchImpl: async () => response(catalog),
    })).rejects.toMatchObject({ code: "write_failed" });

    // Last-known-good for a home that had no catalog is its absence, not a catalog whose
    // cache was never built.
    expect(existsSync(catalogPath)).toBe(false);
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
