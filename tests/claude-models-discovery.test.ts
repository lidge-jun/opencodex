import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveConfig } from "../src/config";
import {
  resetCodexModelEntitlementCacheForTests,
} from "../src/codex/model-entitlements";
import { handleManagementAPI } from "../src/server/management-api";
import { startServer } from "../src/server";
import type { OcxConfig } from "../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "./helpers/isolated-codex-home";
import { ManagementRequest } from "./helpers/management-auth";

// Full-suite Windows load: startServer + discovery GETs exceed the default 5s budget
// (same flake class as 810fa115 / claude-management-api).
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-claude-discovery-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-claude-discovery-"));
  process.env.OPENCODEX_HOME = testDir;
});

afterEach(() => {
  resetCodexModelEntitlementCacheForTests();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  isolatedCodexHome?.restore();
  isolatedCodexHome = null;
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

function configWithStaticModels(claudeCode?: OcxConfig["claudeCode"]): OcxConfig {
  return {
    port: 0,
    defaultProvider: "mock",
    openaiProviderTierVersion: 2,
    providers: {
      mock: {
        adapter: "openai-chat",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "k",
        allowPrivateNetwork: true,
        liveModels: false,
        models: ["test-model", "other-model"],
      },
    },
    ...(claudeCode ? { claudeCode } : {}),
  } as OcxConfig;
}

test("anthropic-version header flips /v1/models to the discovery contract", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?limit=1000", server.url), {
      headers: { "anthropic-version": "2023-06-01", "authorization": "Bearer placeholder" },
    });
    expect(response.status).toBe(200);
    const { desktop3pAlias } = await import("../src/claude/desktop-3p");
    const json = await response.json() as { data: { id: string; display_name?: string; type?: string; created_at?: string; capabilities?: Record<string, unknown>; max_tokens?: unknown }[] };
    expect(Array.isArray(json.data)).toBe(true);
    const mockAlias = desktop3pAlias("mock", "test-model");
    const ids = json.data.map(m => m.id);
    expect(mockAlias).toMatch(/^claude-opus-4-8-[a-z][0-9a-z]{2}$/);
    expect(ids).toContain(mockAlias);
    // Every entry must satisfy the picker prefix rule (003 G3).
    for (const entry of json.data) {
      expect(entry.id.startsWith("claude") || entry.id.startsWith("anthropic")).toBe(true);
      expect(typeof entry.display_name).toBe("string");
      // Full ModelInfo contract (devlog 130 B4b): capabilities ride discovery.
      expect(entry.type).toBe("model");
      expect(entry.created_at).toBe("2026-01-01T00:00:00Z");
      expect(entry.capabilities).toBeDefined();
      expect(entry.max_tokens).toBeNull();
    }
    expect(json.data.find(m => m.id === mockAlias)?.display_name).toBe("test-model (mock)");
    // Contract shape only: no OpenAI list fields on the top level.
    expect((json as Record<string, unknown>).object).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("?flavor=anthropic works without the header; disabled -> empty data", async () => {
  saveConfig(configWithStaticModels());
  let server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic", server.url));
    const json = await response.json() as { data: { id: string }[] };
    const { desktop3pAlias } = await import("../src/claude/desktop-3p");
    expect(json.data.some(m => m.id === desktop3pAlias("mock", "other-model"))).toBe(true);
  } finally {
    await server.stop(true);
  }

  saveConfig(configWithStaticModels({ enabled: false }));
  server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?flavor=anthropic", server.url));
    const json = await response.json() as { data: unknown[] };
    expect(json.data).toEqual([]);
  } finally {
    await server.stop(true);
  }
});

test("per-surface id style: ?ids= wins, claude-code UA gets readable, unknown UA stays hashed (devlog 050)", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const readable = "claude-ocx-mock--test-model";
    // 1) explicit ?ids=cli -> readable
    let json = await fetch(new URL("/v1/models?flavor=anthropic&ids=cli", server.url)).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(true);
    // 2) claude-code discovery UA -> readable
    json = await fetch(new URL("/v1/models?flavor=anthropic", server.url), {
      headers: { "user-agent": "claude-code/2.1.207 (external, cli)" },
    }).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(true);
    // 3) unknown UA -> hashed desktop family (safe default)
    json = await fetch(new URL("/v1/models?flavor=anthropic", server.url), {
      headers: { "user-agent": "Claude/1.0 (Macintosh)" },
    }).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(false);
    expect(json.data.some(m => /^claude-opus-4-8-[a-z][0-9a-z]{2}$/.test(m.id))).toBe(true);
    // 4) query beats UA: ?ids=desktop + claude-code UA -> hashed
    json = await fetch(new URL("/v1/models?flavor=anthropic&ids=desktop", server.url), {
      headers: { "user-agent": "claude-code/2.1.207 (external, cli)" },
    }).then(r => r.json()) as { data: { id: string }[] };
    expect(json.data.some(m => m.id === readable)).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("OpenAI list shape and Codex catalog shape stay unchanged", async () => {
  saveConfig(configWithStaticModels());
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url));
    const plainJson = await plain.json() as { object: string; data: { id: string; object: string }[] };
    expect(plainJson.object).toBe("list");
    expect(plainJson.data.some(m => m.id === "mock/test-model")).toBe(true);
    for (const m of plainJson.data) expect(m.object).toBe("model");

    const codex = await fetch(new URL("/v1/models?client_version=1.0.0", server.url), {
      // A Codex client that happens to send an anthropic-version header must still get the catalog.
      headers: { "anthropic-version": "2023-06-01" },
    });
    const codexJson = await codex.json() as { models?: unknown[]; data?: unknown };
    expect(Array.isArray(codexJson.models)).toBe(true);
    expect(codexJson.data).toBeUndefined();
  } finally {
    await server.stop(true);
  }
});

test("Codex discovery applies the OpenAI context cap to native rows (#1430)", async () => {
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "context-cap-access", account_id: "context-cap-account" },
  }), "utf8");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/backend-api/codex/models") {
      const entitled = request.headers.get("authorization") === "Bearer context-cap-access"
        && request.headers.get("chatgpt-account-id") === "context-cap-account";
      const slugs = entitled ? ["gpt-5.6-sol"] : [];
      return Response.json({
        models: slugs.map(slug => ({ slug, supported_in_api: true, visibility: "list" })),
      });
    }
    return originalFetch(request);
  }) as typeof fetch;
  const config = configWithStaticModels();
  config.providers.openai = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    liveModels: false,
  };
  config.providerContextCaps = { openai: 272_000 };
  saveConfig(config);
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?client_version=1.0.0", server.url));
    expect(response.status).toBe(200);
    const json = await response.json() as {
      models: Array<{
        slug: string;
        context_window?: number;
        max_context_window?: number;
        auto_compact_token_limit?: number;
      }>;
    };
    expect(json.models.find(model => model.slug === "gpt-5.6-sol")).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 244_800,
    });
  } finally {
    await server.stop(true);
    globalThis.fetch = originalFetch;
  }
});

test("exact account disables affect only the matching OpenAI and Codex discovery row", async () => {
  const config = configWithStaticModels();
  config.providers.openai = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    liveModels: false,
  };
  config.codexAccounts = [{
    id: "stored-side-account",
    email: "private@example.test",
    alias: "Private Display Name",
    isMain: false,
  }];
  config.codexAccountNamespaces = {
    desktop: "@main",
    team: "stored-side-account",
    removed: "missing-account",
  };
  config.disabledModels = ["team/gpt-5.5"];
  saveConfig(config);
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url)).then(response => response.json()) as {
      data: Array<{ id: string; reasoning_efforts?: unknown[] }>;
    };
    const plainIds = plain.data.map(model => model.id);
    expect(plainIds).toContain("gpt-5.5");
    expect(plainIds).toContain("desktop/gpt-5.5");
    expect(plainIds).not.toContain("team/gpt-5.5");
    expect(plainIds.some(id => id.startsWith("removed/"))).toBe(false);
    expect(plain.data.find(model => model.id === "desktop/gpt-5.5")?.reasoning_efforts)
      .toEqual(plain.data.find(model => model.id === "gpt-5.5")?.reasoning_efforts);

    const catalog = await fetch(new URL("/v1/models?client_version=1.0.0", server.url))
      .then(response => response.json()) as {
        models: Array<{ slug: string; display_name?: string; visibility?: string; priority?: number }>;
      };
    expect(catalog.models.find(model => model.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(catalog.models.find(model => model.slug === "desktop/gpt-5.5"))
      .toMatchObject({ display_name: "desktop / 5.5", visibility: "list" });
    expect(catalog.models.find(model => model.slug === "team/gpt-5.5")?.visibility).toBe("hide");
    expect(catalog.models.some(model => model.slug.startsWith("removed/"))).toBe(false);
    for (const privateValue of ["stored-side-account", "private@example.test", "Private Display Name"]) {
      expect(JSON.stringify(catalog)).not.toContain(privateValue);
      expect(JSON.stringify(plain)).not.toContain(privateValue);
    }
  } finally {
    await server.stop(true);
  }
});

test("Codex discovery restores account rows for supported natives hidden on disk", async () => {
  const config = configWithStaticModels();
  config.providers.openai = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    liveModels: false,
  };
  saveConfig(config);

  const catalogPath = join(isolatedCodexHome!.path, "hidden-native-catalog.json");
  writeFileSync(
    join(isolatedCodexHome!.path, "config.toml"),
    'model_catalog_json = "hidden-native-catalog.json"\n',
    "utf8",
  );
  writeFileSync(catalogPath, JSON.stringify({
    models: [
      { slug: "gpt-5.5", visibility: "hide" },
      { slug: "gpt-5.4", visibility: "list" },
      { slug: "gpt-99-internal", visibility: "hide" },
      { slug: "provider/gpt-5.5", visibility: "hide" },
    ],
  }), "utf8");
  const {
    listCatalogNativeSlugs,
    resetCatalogRuntimeStateForTests,
    visibleNativeSlugs,
  } = await import("../src/codex/catalog");
  resetCatalogRuntimeStateForTests();
  expect(listCatalogNativeSlugs()).toContain("gpt-5.5");
  expect(listCatalogNativeSlugs()).not.toContain("gpt-99-internal");
  expect(listCatalogNativeSlugs()).not.toContain("provider/gpt-5.5");
  expect(visibleNativeSlugs(config)).toContain("gpt-5.5");
  expect(visibleNativeSlugs({ ...config, disabledModels: ["gpt-5.5"] })).not.toContain("gpt-5.5");

  let server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url))
      .then(response => response.json()) as { data: Array<{ id: string }> };
    expect(plain.data.some(model => model.id === "gpt-5.4-mini")).toBe(false);

    const catalog = await fetch(new URL("/v1/models?client_version=1.0.0", server.url))
      .then(response => response.json()) as {
        models: Array<{ slug: string; visibility?: string }>;
      };
    expect(catalog.models.find(model => model.slug === "gpt-5.5")?.visibility).toBe("list");
  } finally {
    await server.stop(true);
  }

  config.codexAccountNamespaces = { team: "@main" };
  config.disabledModels = ["gpt-5.4"];
  saveConfig(config);
  resetCatalogRuntimeStateForTests();
  expect(visibleNativeSlugs(config)).toContain("gpt-5.5");
  expect(visibleNativeSlugs(config)).not.toContain("gpt-5.4");
  server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url))
      .then(response => response.json()) as {
        data: Array<{ id: string; reasoning_efforts?: unknown[] }>;
      };
    expect(plain.data.find(model => model.id === "gpt-5.5")?.reasoning_efforts).toBeArray();
    expect(plain.data.find(model => model.id === "team/gpt-5.5")?.reasoning_efforts)
      .toEqual(plain.data.find(model => model.id === "gpt-5.5")?.reasoning_efforts);
    expect(plain.data.some(model => model.id === "gpt-5.4")).toBe(false);
    expect(plain.data.some(model => model.id === "team/gpt-5.4")).toBe(false);
    // Activating account selectors makes both bare and qualified discovery mirror the complete
    // enabled supported set, even when a partial custom catalog omitted this native.
    expect(plain.data.find(model => model.id === "gpt-5.4-mini")?.reasoning_efforts)
      .toBeArray();
    expect(plain.data.find(model => model.id === "team/gpt-5.4-mini")?.reasoning_efforts)
      .toEqual(plain.data.find(model => model.id === "gpt-5.4-mini")?.reasoning_efforts);

    const catalog = await fetch(new URL("/v1/models?client_version=1.0.0", server.url))
      .then(response => response.json()) as {
        models: Array<{
          slug: string;
          visibility?: string;
          opencodex_catalog_kind?: string;
        }>;
      };
    expect(catalog.models.find(model => model.slug === "gpt-5.5")?.visibility).toBe("hide");
    expect(catalog.models.find(model => model.slug === "team/gpt-5.5")).toMatchObject({
      visibility: "list",
      opencodex_catalog_kind: "account-selector-v1",
    });
    expect(catalog.models.find(model => model.slug === "team/gpt-5.4")?.visibility)
      .toBe("hide");
    expect(catalog.models.find(model => model.slug === "team/gpt-5.4-mini")?.visibility)
      .toBe("list");
  } finally {
    await server.stop(true);
  }
});

test("Codex discovery exposes the observed native as a selector row plus one global bare row", async () => {
  const config = configWithStaticModels();
  config.providers.openai = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    liveModels: false,
  };
  config.codexAccountNamespaces = { team: "@main" };
  saveConfig(config);

  const catalogPath = join(isolatedCodexHome!.path, "observed-native-catalog.json");
  writeFileSync(
    join(isolatedCodexHome!.path, "config.toml"),
    'model_catalog_json = "observed-native-catalog.json"\n',
    "utf8",
  );
  writeFileSync(catalogPath, JSON.stringify({
    models: [
      { slug: "gpt-5.5", visibility: "list", supported_in_api: true },
    ],
  }), "utf8");
  writeFileSync(join(isolatedCodexHome!.path, "models_cache.json"), JSON.stringify({
    models: [{
      slug: "gpt-daybreak-blue-latest",
      visibility: "hide",
      supported_in_api: true,
      shell_type: "shell_command",
      comp_hash: "native-comp-hash",
      model_messages: { instructions_template: "You are Codex." },
      base_instructions: "You are Codex.",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      opencodex_account_observed_native: true,
    }],
  }), "utf8");
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-token", account_id: "main-account" },
  }), "utf8");

  const { resetCatalogRuntimeStateForTests } = await import("../src/codex/catalog");
  const { resetCodexModelEntitlementCacheForTests } = await import("../src/codex/model-entitlements");
  resetCatalogRuntimeStateForTests();
  resetCodexModelEntitlementCacheForTests();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/models")) {
      return Response.json({ models: [{
        slug: "gpt-daybreak-blue-latest",
        supported_in_api: true,
        visibility: "list",
      }] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url))
      .then(response => response.json()) as { data: Array<{ id: string }> };
    expect(plain.data).toContainEqual(expect.objectContaining({ id: "team/gpt-daybreak-blue-latest" }));
    // Main's authenticated roster confirmed Daybreak above, so the bare id is discoverable
    // exactly once alongside the mapped selector row.
    expect(plain.data.filter(model => model.id === "gpt-daybreak-blue-latest")).toHaveLength(1);

    const managementUrl = new URL("http://localhost/api/models");
    const managementResponse = await handleManagementAPI(
      new ManagementRequest(managementUrl),
      managementUrl,
      config,
    );
    const management = await managementResponse!.json() as Array<{ id: string; native?: boolean }>;
    // The confirmed main entitlement makes the management surface report the bare native row.
    // Management rows intentionally use the bare identity rather than duplicating selector rows.
    expect(management).toContainEqual(expect.objectContaining({
      id: "gpt-daybreak-blue-latest",
      native: true,
    }));
    expect(management.filter(model => model.id === "gpt-daybreak-blue-latest")).toHaveLength(1);
    expect(management.some(model => model.id === "team/gpt-daybreak-blue-latest")).toBe(false);

    const catalog = await fetch(new URL("/v1/models?client_version=1.0.0", server.url))
      .then(response => response.json()) as { models: Array<{ slug: string; visibility?: string }> };
    expect(catalog.models.find(model => model.slug === "team/gpt-daybreak-blue-latest"))
      .toMatchObject({ visibility: "list" });
    expect(catalog.models.find(model => model.slug === "gpt-daybreak-blue-latest")?.visibility).toBe("hide");

    const { claudeCodeNativeAlias } = await import("../src/claude/alias");
    const anthropic = await fetch(new URL("/v1/models?flavor=anthropic&ids=cli", server.url), {
      headers: { "anthropic-version": "2023-06-01" },
    }).then(response => response.json()) as { data: Array<{ id: string }> };
    // Claude discovery advertises only rows visible in the Codex catalog. The global bare
    // Daybreak row is synthesized as visibility "hide" (asserted above), and the
    // account-qualified projection is no longer produced now that the slug is globally
    // allowlisted, so neither identity reaches the Anthropic surface. Verified empirically:
    // the filtered id list contained gpt-5.5 only.
    expect(anthropic.data.some(model => model.id === claudeCodeNativeAlias("gpt-daybreak-blue-latest"))).toBe(false);
    expect(anthropic.data.some(model => model.id === claudeCodeNativeAlias("team/gpt-daybreak-blue-latest"))).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
    await server.stop(true);
  }
});

test("account selectors stay out of discovery when no canonical OpenAI provider is enabled", async () => {
  const config = configWithStaticModels();
  config.codexAccountNamespaces = { desktop: "@main" };
  saveConfig(config);
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url)).then(response => response.json()) as {
      data: Array<{ id: string }>;
    };
    expect(plain.data.some(model => model.id.startsWith("desktop/"))).toBe(false);
    expect(plain.data.some(model => model.id.startsWith("gpt-"))).toBe(false);

    const catalog = await fetch(new URL("/v1/models?client_version=1.0.0", server.url))
      .then(response => response.json()) as { models: Array<{ slug: string }> };
    expect(catalog.models.some(model => model.slug.startsWith("desktop/"))).toBe(false);
    expect(catalog.models.some(model => model.slug.startsWith("gpt-"))).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("disabled canonical OpenAI preserves bare bootstrap rows without advertising account routes", async () => {
  const config = {
    port: 0,
    defaultProvider: "openai",
    openaiProviderTierVersion: 2,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        disabled: true,
        liveModels: false,
      },
    },
    codexAccounts: [{ id: "stored-side-account", isMain: false }],
    codexAccountNamespaces: { team: "stored-side-account" },
  } as OcxConfig;
  saveConfig(config);
  const server = startServer(0);
  try {
    const plain = await fetch(new URL("/v1/models", server.url)).then(response => response.json()) as {
      data: Array<{ id: string }>;
    };
    expect(plain.data.some(model => model.id.startsWith("gpt-"))).toBe(true);
    expect(plain.data.some(model => model.id.startsWith("team/"))).toBe(false);

    const catalog = await fetch(new URL("/v1/models?client_version=1.0.0", server.url))
      .then(response => response.json()) as { models: Array<{ slug: string }> };
    expect(catalog.models.some(model => model.slug.startsWith("gpt-"))).toBe(true);
    expect(catalog.models.some(model => model.slug.startsWith("team/"))).toBe(false);
  } finally {
    await server.stop(true);
  }
});

test("the request's client_version reaches entitlement discovery (#2886)", async () => {
  // Codex sends client_version on this route and the value used to be discarded, so upstream
  // was always asked as 0.0.0 — which it answers with a short roster, and the fail-closed gate
  // reads that as a confirmed denial. This asserts the forwarding itself: the version observed
  // on the OUTBOUND /codex/models request must be the one the client sent.
  const config = configWithStaticModels();
  config.providers.openai = {
    adapter: "openai-responses",
    baseUrl: "https://chatgpt.com/backend-api/codex",
    liveModels: false,
  };
  saveConfig(config);
  writeFileSync(join(isolatedCodexHome!.path, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-token", account_id: "main-account" },
  }), "utf8");

  const { resetCatalogRuntimeStateForTests } = await import("../src/codex/catalog");
  resetCatalogRuntimeStateForTests();
  resetCodexModelEntitlementCacheForTests();

  const askedVersions: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/models")) {
      askedVersions.push(url.searchParams.get("client_version") ?? "");
      return Response.json({ models: [{ slug: "gpt-5.5", supported_in_api: true, visibility: "list" }] });
    }
    return originalFetch(input, init);
  }) as typeof fetch;

  // Started INSIDE the try: if startServer throws, the mocked global fetch must still be
  // restored, or every later test in this file inherits it.
  let server: ReturnType<typeof startServer> | null = null;
  try {
    server = startServer(0);
    await fetch(new URL("/v1/models?client_version=0.151.7", server.url))
      .then(response => response.json());
    expect(askedVersions.length).toBeGreaterThan(0);
    // Forwarded verbatim, and in particular never the placeholder that caused #2886.
    expect(askedVersions).toEqual(askedVersions.map(() => "0.151.7"));
    expect(askedVersions).not.toContain("0.0.0");
  } finally {
    globalThis.fetch = originalFetch;
    if (server) await server.stop(true);
  }
});
