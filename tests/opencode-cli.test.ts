import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearModelCache } from "../src/codex/model-cache";
import { loadServiceTokenFromFile, serviceApiTokenFilePath } from "../src/lib/service-secrets";
import {
  OPENCODE_API_KEY_ENV,
  OPENCODE_API_KEY_ENV_REF,
  OPENCODE_CONFIG_CONTENT_ENV,
  OPENCODE_PROVIDER_ID,
  SCHEMA_REQUIRED_OUTPUT_BUDGET,
  buildOpencodeConfig,
  buildOpencodeEnv,
  buildOpencodeProviderBlock,
  buildOpencodeProviderBlockFromCatalog,
  buildOpencodeProviderBlocksFromCatalog,
  buildOpencodeV2ProviderBlock,
  fetchOpencodeProxyModels,
  isOpencodeRuntimeConfigError,
  mergeOpencodeRuntimeConfig,
  opencodeApiKey,
  opencodeCatalogFromProxyRows,
  opencodeGlobalConfigPath,
  opencodeLaunchNativeSlugs,
  opencodeModelKey,
  opencodeNotFoundHint,
  opencodeProviderOverridePath,
  opencodeProxyBaseUrl,
  opencodeProxyStartEnv,
  parseJsonc,
  projectConfigOverridesProvider,
  serializeOpencodeRuntimeConfig,
} from "../src/cli/opencode";
import type { OcxConfig } from "../src/types";

function cfg(extra?: Partial<OcxConfig>): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "mock",
    providers: { mock: { adapter: "openai-chat", baseUrl: "http://x/v1" } },
    ...extra,
  } as OcxConfig;
}

describe("ocx opencode provider block", () => {
  test("points at the live proxy port over the OpenAI-compatible surface", () => {
    const block = buildOpencodeProviderBlock(10123, [], []);
    expect(block.options.baseURL).toBe("http://127.0.0.1:10123/v1");
    expect(block.npm).toBe("@ai-sdk/openai-compatible");
  });

  test("uses probeHostname for IPv6 and specific-interface binds", () => {
    expect(buildOpencodeProviderBlock(10100, [], [], () => undefined, "::1").options.baseURL)
      .toBe("http://[::1]:10100/v1");
    expect(buildOpencodeProviderBlock(10100, [], [], () => undefined, "192.168.4.10").options.baseURL)
      .toBe("http://192.168.4.10:10100/v1");
    expect(opencodeProxyBaseUrl(8080, "fe80::1")).toBe("http://[fe80::1]:8080/v1");
  });

  test("apiKey is an env reference, never a literal secret", () => {
    const block = buildOpencodeProviderBlock(10100, [], []);
    expect(block.options.apiKey).toBe(OPENCODE_API_KEY_ENV_REF);
    expect(JSON.stringify(block)).not.toContain("sk-");
  });

  test("non-loopback binds add x-opencodex-api-key via env reference", () => {
    const block = buildOpencodeProviderBlock(
      10100,
      [],
      [],
      () => undefined,
      "0.0.0.0",
      cfg({ hostname: "0.0.0.0" }),
    );
    expect(block.options.headers).toEqual({ "x-opencodex-api-key": OPENCODE_API_KEY_ENV_REF });
    expect(block.options.apiKey).toBeUndefined();
    expect(JSON.stringify(block.options)).not.toContain("sk-");
  });

  test("loopback binds use apiKey and omit the dedicated admission header", () => {
    const block = buildOpencodeProviderBlock(
      10100,
      [],
      [],
      () => undefined,
      "127.0.0.1",
      cfg({ hostname: "127.0.0.1" }),
    );
    expect(block.options.apiKey).toBe(OPENCODE_API_KEY_ENV_REF);
    expect(block.options.headers).toBeUndefined();
  });

  test("routed models key on provider/id, native slugs stay bare", () => {
    const block = buildOpencodeProviderBlock(10100, ["gpt-5.6-sol"], [
      { provider: "kiro", id: "glm-5" },
    ]);
    expect(Object.keys(block.models).sort()).toEqual(["gpt-5.6-sol", "kiro/glm-5"]);
  });

  test("limit.context is emitted only from an authoritative contextWindow — never guessed", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "with-window", contextWindow: 200_000 },
      { provider: "kiro", id: "no-window" },
      { provider: "kiro", id: "zero-window", contextWindow: 0 },
    ]);
    expect(block.models["kiro/with-window"]?.limit?.context).toBe(200_000);
    expect(block.models["kiro/no-window"]?.limit).toBeUndefined();
    expect(block.models["kiro/zero-window"]?.limit).toBeUndefined();
  });

  test("limit.output rides along with context because opencode's schema requires the pair", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "m", contextWindow: 200_000 },
    ]);
    expect(block.models["kiro/m"]?.limit).toEqual({ context: 200_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
  });

  test("limit.output is clamped to the context window for small-context models", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "local", id: "tiny", contextWindow: 8_192 },
    ]);
    expect(block.models["local/tiny"]?.limit).toEqual({ context: 8_192, output: 8_192 });
  });

  test("native slugs pick up authoritative context windows from the resolver", () => {
    const block = buildOpencodeProviderBlock(10100, ["gpt-5.4", "unknown-native"], [], slug =>
      slug === "gpt-5.4" ? 1_000_000 : undefined);
    expect(block.models["gpt-5.4"]?.limit).toEqual({ context: 1_000_000, output: SCHEMA_REQUIRED_OUTPUT_BUDGET });
    expect(block.models["unknown-native"]?.limit).toBeUndefined();
  });

  test("displayName is used for the label when the catalog provides one", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "glm-5", displayName: "GLM-5" },
      { provider: "kiro", id: "qwen3-coder-next" },
    ]);
    expect(block.models["kiro/glm-5"]?.name).toBe("GLM-5 (kiro)");
    expect(block.models["kiro/qwen3-coder-next"]?.name).toBe("qwen3-coder-next (kiro)");
  });

  test("duplicate keys keep the first entry instead of throwing", () => {
    const block = buildOpencodeProviderBlock(10100, [], [
      { provider: "kiro", id: "dup", displayName: "First" },
      { provider: "kiro", id: "dup", displayName: "Second" },
    ]);
    expect(block.models["kiro/dup"]?.name).toBe("First (kiro)");
  });

  test("model key helper distinguishes native from routed", () => {
    expect(opencodeModelKey("native", "gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(opencodeModelKey("kiro", "glm-5")).toBe("kiro/glm-5");
  });
});

describe("ocx opencode runtime config", () => {
  test("serializes only the generated provider block for OPENCODE_CONFIG_CONTENT", () => {
    const runtime = buildOpencodeConfig(10100, [], [{ provider: "kiro", id: "glm-5" }]);
    const parsed = JSON.parse(serializeOpencodeRuntimeConfig(runtime)) as { provider?: Record<string, unknown> };
    expect(Object.keys(parsed.provider ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
    expect(parsed.provider?.[OPENCODE_PROVIDER_ID]).toBeTruthy();
  });

  test("merges inherited inline settings and overrides only our own provider blocks", () => {
    const inherited = JSON.stringify({
      model: "other/default",
      agents: { coder: { model: "x" } },
      provider: {
        other: { npm: "@other/pkg", name: "Other" },
        [OPENCODE_PROVIDER_ID]: { npm: "stale", name: "Stale" },
      },
      providers: {
        other: { package: "@other/pkg", name: "Other" },
        [OPENCODE_PROVIDER_ID]: { package: "stale", name: "Stale" },
      },
    });
    const routed = [{ provider: "kiro", id: "glm-5" }];
    const block = buildOpencodeProviderBlock(10100, [], routed);
    const v2Block = buildOpencodeV2ProviderBlock(10100, [], routed);
    const merged = mergeOpencodeRuntimeConfig(inherited, { v1: block, v2: v2Block });
    expect(isOpencodeRuntimeConfigError(merged)).toBe(false);
    if (isOpencodeRuntimeConfigError(merged)) return;
    expect(merged.model).toBe("other/default");
    expect(merged.agents).toEqual({ coder: { model: "x" } });
    expect(merged.provider.other).toEqual({ npm: "@other/pkg", name: "Other" });
    expect(merged.provider[OPENCODE_PROVIDER_ID]).toEqual(block);
    expect(merged.providers.other).toEqual({ package: "@other/pkg", name: "Other" });
    expect(merged.providers[OPENCODE_PROVIDER_ID]).toEqual(v2Block);
  });

  test("rejects invalid inherited OPENCODE_CONFIG_CONTENT", () => {
    const block = buildOpencodeProviderBlock(10100, [], []);
    const v2Block = buildOpencodeV2ProviderBlock(10100, [], []);
    const blocks = { v1: block, v2: v2Block };
    expect(mergeOpencodeRuntimeConfig("{ not json", blocks))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT is not valid JSON." });
    expect(mergeOpencodeRuntimeConfig("[]", blocks))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT must be a JSON object." });
    expect(mergeOpencodeRuntimeConfig(JSON.stringify({ provider: "bad" }), blocks))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT provider must be a JSON object when present." });
    expect(mergeOpencodeRuntimeConfig(JSON.stringify({ providers: "bad" }), blocks))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT providers must be a JSON object when present." });
  });
});

describe("ocx opencode JSONC parsing", () => {
  test("plain JSON parses unchanged", () => {
    expect(parseJsonc('{"a":1}')).toEqual({ a: 1 });
  });

  test("line and block comments are accepted", () => {
    expect(parseJsonc('{\n // lead\n "a": 1 /* trail */\n}')).toEqual({ a: 1 });
  });

  test("trailing commas are accepted", () => {
    expect(parseJsonc('{"a":[1,2,],"b":2,}')).toEqual({ a: [1, 2], b: 2 });
  });

  test("comment-like and comma-like text inside strings is preserved", () => {
    expect(parseJsonc('{"url":"http://x/v1","note":"a // b /* c */","t":"x,"}'))
      .toEqual({ url: "http://x/v1", note: "a // b /* c */", t: "x," });
  });

  test("escaped quotes do not break string tracking", () => {
    expect(parseJsonc('{"a":"he said \\"hi\\" // not a comment"}'))
      .toEqual({ a: 'he said "hi" // not a comment' });
  });

  test("genuinely malformed input still throws", () => {
    expect(() => parseJsonc("{ not json")).toThrow();
  });
});

describe("ocx opencode proxy model catalog", () => {
  const ENV_KEY = "OCX_TEST_OPENCODE_PROXY_ONLY_KEY";
  const RESOLVED = "proxy-only-resolved-key";
  const PROVIDER = "proxyenv";

  test("uses /api/models namespaced selectors and resolves env-backed provider keys only in the proxy", async () => {
    const originalFetch = globalThis.fetch;
    let requestedAuth: string | undefined;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target.includes("proxyenv.test")) {
        requestedAuth = new Headers(init?.headers).get("authorization") ?? undefined;
        if (requestedAuth === `Bearer ${RESOLVED}`) {
          return new Response(JSON.stringify({
            data: [{ id: "live-via-proxy-env", context_length: 128_000 }],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response("unauthorized", { status: 401 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const config = {
      port: 10100,
      defaultProvider: PROVIDER,
      providers: {
        [PROVIDER]: {
          adapter: "openai-chat",
          authMode: "key",
          baseUrl: "https://proxyenv.test/v1",
          apiKey: `\${${ENV_KEY}}`,
          models: ["static-fallback"],
          // Discovery runs on the pinned transport; hand it back the stub above.
          fetch: ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch,
        },
      },
    } as OcxConfig;

    const previous = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
    clearModelCache(PROVIDER);
    try {
      const { fetchAllModels } = await import("../src/server/management/shared");
      const cliModels = await fetchAllModels(config);
      const cliIds = cliModels.filter(m => m.provider === PROVIDER).map(m => m.id).sort();
      expect(cliIds).toEqual(["static-fallback"]);
      expect(cliIds).not.toContain("live-via-proxy-env");

      process.env[ENV_KEY] = RESOLVED;
      clearModelCache(PROVIDER);
      requestedAuth = undefined;

      const { handleManagementAPI } = await import("../src/server/management-api");
      const modelsRes = await handleManagementAPI(
        new Request("http://localhost/api/models"),
        new URL("http://localhost/api/models"),
        config,
      );
      const rows = await modelsRes!.json() as Array<{
        namespaced?: string;
        displayName?: string;
        displayNameSource?: "operator" | "provider" | "fallback";
        contextWindow?: number;
      }>;
      expect(requestedAuth).toBe(`Bearer ${RESOLVED}`);

      const liveRow = rows.find(r => r.namespaced === `${PROVIDER}/live-via-proxy-env`);
      expect(liveRow).toBeTruthy();
      expect(liveRow?.displayNameSource).toBe("fallback");
      expect(liveRow?.contextWindow).toBe(128_000);

      const catalog = opencodeCatalogFromProxyRows(rows, config);
      const liveCatalogRow = catalog.find(m => m.namespaced === `${PROVIDER}/live-via-proxy-env`);
      expect(liveCatalogRow).toBeTruthy();
      expect(liveCatalogRow?.displayName).toBeUndefined();

      const block = buildOpencodeProviderBlockFromCatalog(10100, catalog, undefined, config);
      expect(block.models[`${PROVIDER}/live-via-proxy-env`]?.limit?.context).toBe(128_000);
      expect(block.models[`${PROVIDER}/live-via-proxy-env`]?.name).toBe("live-via-proxy-env (proxyenv)");

      const fetched = await fetchOpencodeProxyModels(
        { port: 10100, hostname: "127.0.0.1", pid: 1 },
        "sk-mgmt",
        {
          fetchImpl: async (url, init) => {
            expect(String(url)).toBe("http://127.0.0.1:10100/api/models");
            expect(new Headers(init?.headers).get("X-OpenCodex-API-Key")).toBe("sk-mgmt");
            return new Response(JSON.stringify(rows), { status: 200 });
          },
        },
      );
      expect(fetched.find(r => r.namespaced === `${PROVIDER}/live-via-proxy-env`)).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
      clearModelCache(PROVIDER);
      if (previous === undefined) delete process.env[ENV_KEY];
      else process.env[ENV_KEY] = previous;
    }
  });

  test("carries /api/models effort ladders into the V2 block the launcher injects", () => {
    // The launcher's own path: proxy rows -> catalog -> blocks. A renamed field here would
    // ship a launcher without selectable efforts while every unit test stayed green.
    const rows = [
      { namespaced: "opencode-go/glm-5.3", provider: "opencode-go", id: "glm-5.3", reasoningEfforts: ["max", "low", "high"] },
      { namespaced: "opencode-go/plain", provider: "opencode-go", id: "plain" },
      { namespaced: "opencode-go/hidden", provider: "opencode-go", id: "hidden", disabled: true, reasoningEfforts: ["low"] },
    ];
    const catalog = opencodeCatalogFromProxyRows(rows, cfg());
    const blocks = buildOpencodeProviderBlocksFromCatalog(10100, catalog, undefined, cfg());

    expect(blocks.v2.models["opencode-go/glm-5.3"]!.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
      { id: "max", settings: { reasoningEffort: "max" } },
    ]);
    expect(blocks.v2.models["opencode-go/plain"]!.variants).toBeUndefined();
    // The legacy block never carries variants, and both generations describe the same models:
    // that is what makes opencode's merge produce one entry per model.
    expect(blocks.v1.models["opencode-go/glm-5.3"]).not.toHaveProperty("variants");
    expect(Object.keys(blocks.v2.models)).toEqual(Object.keys(blocks.v1.models));
    expect(Object.keys(blocks.v1.models)).not.toContain("opencode-go/hidden");
  });

  test("the launcher's V1 and V2 blocks share one connection", () => {
    const blocks = buildOpencodeProviderBlocksFromCatalog(
      10100,
      [{ namespaced: "opencode-go/glm-5.3", provider: "opencode-go", id: "glm-5.3" }],
      "192.168.4.10",
      cfg({ hostname: "0.0.0.0" }),
    );
    // Built in one pass, so a later tweak to one generation cannot desync the endpoint.
    expect(blocks.v2.settings).toEqual(blocks.v1.options);
    expect(blocks.v2.settings.headers).toEqual({
      "x-opencodex-api-key": OPENCODE_API_KEY_ENV_REF,
    });
  });

  test("fetchOpencodeProxyModels aborts stalled /api/models fetch and body reads", async () => {
    const live = { port: 10100, hostname: "127.0.0.1", pid: 1 };
    const stall = (init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")));
    });

    await expect(fetchOpencodeProxyModels(live, "sk-mgmt", {
      timeoutMs: 25,
      fetchImpl: async (_url, init) => stall(init),
    })).rejects.toThrow("Management API timed out while fetching /api/models.");

    await expect(fetchOpencodeProxyModels(live, "sk-mgmt", {
      timeoutMs: 25,
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        text: () => new Promise<string>(() => {}),
      } as Response),
    })).rejects.toThrow("Management API timed out while fetching /api/models.");
  });

  test("opencodeCatalogFromProxyRows omits disabled and direct-mode native rows", () => {
    const directConfig = cfg({
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://x/v1" },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    const rows = [
      { namespaced: "gpt-5.6-sol", native: true, disabled: false, provider: "openai", id: "gpt-5.6-sol" },
      { namespaced: "gpt-5.5", native: true, disabled: true, provider: "openai", id: "gpt-5.5" },
      { namespaced: "kiro/glm-5", native: false, disabled: false, provider: "kiro", id: "glm-5", displayName: "GLM-5" },
    ];
    expect(opencodeCatalogFromProxyRows(rows, directConfig).map(m => m.namespaced)).toEqual(["kiro/glm-5"]);

    const poolConfig = cfg({
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://x/v1" },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    expect(opencodeCatalogFromProxyRows(rows, poolConfig).map(m => m.namespaced)).toEqual([
      "gpt-5.6-sol",
      "kiro/glm-5",
    ]);
  });
});

describe("ocx opencode native slug selection", () => {
  test("omits native slugs in Codex Direct mode", () => {
    const config = cfg({
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://x/v1" },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "direct",
        },
      },
    });
    expect(opencodeLaunchNativeSlugs(config)).toEqual([]);
    const block = buildOpencodeProviderBlock(10100, opencodeLaunchNativeSlugs(config), [], () => undefined, undefined, config);
    expect(Object.keys(block.models)).toEqual([]);
  });

  test("keeps native slugs in pool mode", () => {
    const config = cfg({
      providers: {
        mock: { adapter: "openai-chat", baseUrl: "http://x/v1" },
        openai: {
          adapter: "openai-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authMode: "forward",
          codexAccountMode: "pool",
        },
      },
    });
    expect(opencodeLaunchNativeSlugs(config).length).toBeGreaterThan(0);
  });
});

/**
 * Every case passes an empty env and a temp home. Without them the global branch reads the
 * developer's real ~/.config/opencode/opencode.json, so on a machine that has the integration
 * applied these tests would assert against that machine instead of their own fixture.
 */
describe("ocx opencode project-layer detection", () => {
  function detect(cwd: string, home: string): string | null {
    return opencodeProviderOverridePath(cwd, {}, home);
  }

  test("detects a global config that redefines our provider key", () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-opencode-global-"));
    const globalDir = join(home, ".config", "opencode");
    mkdirSync(globalDir, { recursive: true });
    const globalPath = join(globalDir, "opencode.json");
    writeFileSync(globalPath, JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(opencodeProviderOverridePath(join(home, "project"), { XDG_CONFIG_HOME: join(home, ".config") }, home))
      .toBe(globalPath);
  });

  test("detects a project config that redefines our provider key", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(detect(dir, dir)).toBe(join(dir, "opencode.json"));
  });

  test("detects a project config that defines only the V2 provider key", () => {
    // The launcher overwrites `providers.opencodex` as well, so a V2-only config has to warn
    // exactly like the legacy spelling does.
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ providers: { [OPENCODE_PROVIDER_ID]: { package: "x" } } }));
    expect(detect(dir, dir)).toBe(join(dir, "opencode.json"));
  });

  test("detects opencode.jsonc and parent directories up to the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-root-"));
    mkdirSync(join(root, "packages", "app"), { recursive: true });
    mkdirSync(join(root, ".git"));
    writeFileSync(join(root, "packages", "opencode.jsonc"), `{
      // project override
      "provider": { "${OPENCODE_PROVIDER_ID}": { "npm": "x" } }
    }`);
    expect(detect(join(root, "packages", "app"), root)).toBe(join(root, "packages", "opencode.jsonc"));
  });

  test("does not walk above the git root", () => {
    const root = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-stop-"));
    const parent = join(root, "parent");
    const repo = join(parent, "repo");
    mkdirSync(repo, { recursive: true });
    mkdirSync(join(repo, ".git"));
    writeFileSync(join(root, "opencode.json"), JSON.stringify({ provider: { [OPENCODE_PROVIDER_ID]: { npm: "x" } } }));
    expect(detect(join(repo, "src"), root)).toBeNull();
  });

  test("ignores a project config that defines other providers", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    writeFileSync(join(dir, "opencode.json"), JSON.stringify({ provider: { other: { npm: "x" } } }));
    expect(detect(dir, dir)).toBeNull();
  });

  test("no project config is not a warning", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-proj-"));
    expect(detect(dir, dir)).toBeNull();
  });
});

describe("ocx opencode env assembly", () => {
  test("OPENCODE_CONFIG_CONTENT carries only the runtime provider blocks", () => {
    const routed = [{ provider: "kiro", id: "glm-5" }];
    const blocks = {
      v1: buildOpencodeProviderBlock(10100, [], routed),
      v2: buildOpencodeV2ProviderBlock(10100, [], routed),
    };
    const built = buildOpencodeEnv(blocks, "sk-ocx-123", { OPENCODE_CONFIG: "/user/mine.json", PATH: "/bin" });
    expect(isOpencodeRuntimeConfigError(built)).toBe(false);
    if (isOpencodeRuntimeConfigError(built)) return;
    expect(built.OPENCODE_CONFIG).toBe("/user/mine.json");
    expect(built.PATH).toBe("/bin");
    const parsed = JSON.parse(built[OPENCODE_CONFIG_CONTENT_ENV]!) as {
      provider?: Record<string, unknown>;
      providers?: Record<string, unknown>;
    };
    expect(Object.keys(parsed.provider ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
    expect(Object.keys(parsed.providers ?? {})).toEqual([OPENCODE_PROVIDER_ID]);
  });

  test("preserves inherited inline settings in OPENCODE_CONFIG_CONTENT", () => {
    const routed = [{ provider: "kiro", id: "glm-5" }];
    const block = buildOpencodeProviderBlock(10100, [], routed);
    const v2Block = buildOpencodeV2ProviderBlock(10100, [], routed);
    const inherited = JSON.stringify({
      model: "custom/model",
      provider: { other: { npm: "@other/pkg" } },
    });
    const built = buildOpencodeEnv(
      { v1: block, v2: v2Block },
      "sk-ocx-123",
      { [OPENCODE_CONFIG_CONTENT_ENV]: inherited },
    );
    expect(isOpencodeRuntimeConfigError(built)).toBe(false);
    if (isOpencodeRuntimeConfigError(built)) return;
    const parsed = JSON.parse(built[OPENCODE_CONFIG_CONTENT_ENV]!) as {
      model?: string;
      provider?: Record<string, unknown>;
      providers?: Record<string, unknown>;
    };
    expect(parsed.model).toBe("custom/model");
    expect(parsed.provider?.other).toEqual({ npm: "@other/pkg" });
    expect(parsed.provider?.[OPENCODE_PROVIDER_ID]).toEqual(block);
    expect(parsed.providers?.[OPENCODE_PROVIDER_ID]).toEqual(v2Block);
  });

  test("surfaces invalid inherited OPENCODE_CONFIG_CONTENT as an error", () => {
    const blocks = {
      v1: buildOpencodeProviderBlock(10100, [], []),
      v2: buildOpencodeV2ProviderBlock(10100, [], []),
    };
    expect(buildOpencodeEnv(blocks, "sk-ocx-123", { [OPENCODE_CONFIG_CONTENT_ENV]: "[]" }))
      .toEqual({ error: "OPENCODE_CONFIG_CONTENT must be a JSON object." });
  });

  test("the admission key travels in the child env, matching the config's {env:…} reference", () => {
    const blocks = {
      v1: buildOpencodeProviderBlock(10100, [], []),
      v2: buildOpencodeV2ProviderBlock(10100, [], []),
    };
    const built = buildOpencodeEnv(blocks, "sk-ocx-123", {});
    expect(isOpencodeRuntimeConfigError(built)).toBe(false);
    if (isOpencodeRuntimeConfigError(built)) return;
    expect(built[OPENCODE_API_KEY_ENV]).toBe("sk-ocx-123");
    expect(built[OPENCODE_CONFIG_CONTENT_ENV]).not.toContain("sk-ocx-123");
  });
});

describe("ocx opencode admission key", () => {
  test("the environment token wins over a configured API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, { OPENCODEX_API_AUTH_TOKEN: "sk-env" })).toBe("sk-env");
  });

  test("falls back to the hardened service token file before config.apiKeys", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-token-"));
    const tokenFile = join(dir, "service-api-token");
    writeFileSync(tokenFile, "sk-service\n", "utf8");
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, { OCX_API_TOKEN_FILE: tokenFile })).toBe("sk-service");
  });

  test("falls back to the configured proxy API key", () => {
    const config = cfg({ apiKeys: [{ id: "1", name: "main", key: "sk-cfg", createdAt: "2026-01-01" }] });
    expect(opencodeApiKey(config, {})).toBe("sk-cfg");
  });

  test("falls back to a placeholder on an open loopback proxy", () => {
    expect(opencodeApiKey(cfg(), {})).toBe("ocx");
  });
});

describe("ocx opencode proxy auto-start env", () => {
  test("passes OCX_API_TOKEN_FILE to ocx start when only the hardened service token exists", () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-opencode-start-"));
    const tokenFile = join(dir, "service-api-token");
    writeFileSync(tokenFile, "sk-service-only\n", "utf8");
    const config = cfg({ hostname: "0.0.0.0", apiKeys: [] as OcxConfig["apiKeys"] });

    const startEnv = opencodeProxyStartEnv({ OCX_API_TOKEN_FILE: tokenFile });
    expect(startEnv.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    expect(startEnv.OCX_API_TOKEN_FILE).toBe(tokenFile);
    expect(startEnv.OCX_SERVICE).toBe("1");
    expect(JSON.stringify(startEnv)).not.toContain("sk-service-only");
    expect(loadServiceTokenFromFile(startEnv)).toBe("sk-service-only");
    expect(opencodeApiKey(config, startEnv)).toBe("sk-service-only");
  });

  test("defaults OCX_API_TOKEN_FILE when admission env token is absent", () => {
    const startEnv = opencodeProxyStartEnv({ hostname: "0.0.0.0" });
    expect(startEnv.OPENCODEX_API_AUTH_TOKEN).toBeUndefined();
    expect(startEnv.OCX_API_TOKEN_FILE).toBe(serviceApiTokenFilePath());
    expect(startEnv.OCX_SERVICE).toBe("1");
  });

  test("does not inject OCX_API_TOKEN_FILE when OPENCODEX_API_AUTH_TOKEN is already set", () => {
    const startEnv = opencodeProxyStartEnv({ OPENCODEX_API_AUTH_TOKEN: "sk-env", hostname: "0.0.0.0" });
    expect(startEnv.OPENCODEX_API_AUTH_TOKEN).toBe("sk-env");
    expect(startEnv.OCX_API_TOKEN_FILE).toBeUndefined();
  });
});

describe("ocx opencode global config path", () => {
  test("global path follows XDG_CONFIG_HOME when set", () => {
    expect(opencodeGlobalConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(join("/xdg", "opencode", "opencode.json"));
    expect(opencodeGlobalConfigPath({}, "/home/u")).toBe(join("/home/u", ".config", "opencode", "opencode.json"));
  });
});

describe("ocx opencode not-found hint", () => {
  test("cmd.exe reports command-not-found as 9009", () => {
    expect(opencodeNotFoundHint(9009, null, "win32")).toContain("npm install -g opencode-ai");
  });

  test("signal exits and other platforms are not hints", () => {
    expect(opencodeNotFoundHint(9009, "SIGTERM", "win32")).toBeNull();
    expect(opencodeNotFoundHint(9009, null, "linux")).toBeNull();
    expect(opencodeNotFoundHint(0, null, "win32")).toBeNull();
  });
});
import { ManagementRequest as Request } from "./helpers/management-auth";
