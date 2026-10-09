import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntries } from "../../src/codex/catalog";
import { applyProviderConfigHints, catalogHintsFromModelsApiItem, routedMaxOutputTokens } from "../../src/codex/catalog/model-hints";
import { azureVendorModelMetadata } from "../../src/providers/derive";
import { getModelMetadata } from "../../src/generated/model-metadata";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import type { CatalogModel } from "../../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../../src/types";
import { refreshAzureModelMetadata, resetAzureModelMetadataForTests } from "../../src/providers/azure-model-metadata";
import { fetchProviderModels } from "../../src/codex/catalog/provider-models";
import { clearModelCache } from "../../src/codex/model-cache";
import { stubbedProviderFetch } from "../helpers/catalog-provider-fetch";

const originalHome = process.env.OPENCODEX_HOME;
const originalFetch = globalThis.fetch;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-azure-metadata-"));
  process.env.OPENCODEX_HOME = root;
  resetAzureModelMetadataForTests();
  clearModelCache();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = originalHome;
  resetAzureModelMetadataForTests();
  clearModelCache();
  rmSync(root, { recursive: true, force: true });
});

const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

const AZURE: OcxProviderConfig = {
  adapter: "azure-openai",
  baseUrl: "https://resource.openai.azure.com/openai",
  apiKey: "sk-test",
};
const discovered = (id = "gpt-5.6-terra"): CatalogModel => ({
  provider: "custom-azure", id, owned_by: "custom-azure",
});
const hint = (model = discovered(), provider = AZURE, cap?: number) =>
  applyProviderConfigHints("custom-azure", provider, model, cap);

describe("Azure destination vendor model metadata", () => {
  test("warm provider cache applies each root's Azure metadata across A to B to A", async () => {
    const otherRoot = mkdtempSync(join(root, "other-"));
    const id = "warm-root-model";
    const first = { input: ["text"], contextWindow: 111_111, maxTokens: 11_111 };
    const second = { input: ["text", "image"], contextWindow: 222_222, maxTokens: 22_222 };
    for (const [dir, metadata] of [[root, first], [otherRoot, second]] as const) {
      writeFileSync(join(dir, "azure-model-metadata-cache.json"), JSON.stringify({
        version: 1, fetchedAt: Date.now(), models: { [id]: metadata },
      }));
    }
    let calls = 0;
    globalThis.fetch = (async () => { calls++; return jsonResponse({ data: [{ id }] }); }) as typeof fetch;
    const provider = { ...AZURE, fetch: stubbedProviderFetch };
    for (const [dir, metadata] of [[root, first], [otherRoot, second], [root, first]] as const) {
      process.env.OPENCODEX_HOME = dir;
      const models = await fetchProviderModels("custom-azure", provider, 60_000);
      expect(models.find(model => model.id === id)).toMatchObject({
        inputModalities: metadata.input, contextWindow: metadata.contextWindow, maxOutputTokens: metadata.maxTokens,
      });
    }
    expect(calls).toBe(1);
    // Stale fallback and its subsequent failure cooldown must also project B's metadata.
    process.env.OPENCODEX_HOME = otherRoot;
    globalThis.fetch = (async () => { calls++; throw new Error("offline"); }) as typeof fetch;
    for (let attempt = 0; attempt < 2; attempt++) {
      const models = await fetchProviderModels("custom-azure", provider, 0);
      expect(models.find(model => model.id === id)).toMatchObject({
        inputModalities: second.input, contextWindow: second.contextWindow, maxOutputTokens: second.maxTokens,
      });
    }
    expect(calls).toBe(2);
    process.env.OPENCODEX_HOME = root;
    const models = await fetchProviderModels("custom-azure", provider, 0);
    expect(models.find(model => model.id === id)).toMatchObject({
      inputModalities: first.input, contextWindow: first.contextWindow, maxOutputTokens: first.maxTokens,
    });
    expect(calls).toBe(2);
  });

  for (const pauseAt of ["metadata", "models"] as const) {
    test(`admitted discovery keeps its metadata root across the ${pauseAt} await`, async () => {
      const otherRoot = mkdtempSync(join(root, "other-"));
      const id = "admitted-root-model";
      const first = { input: ["text"], contextWindow: 111_111, maxTokens: 11_111 };
      const second = { input: ["text", "image"], contextWindow: 222_222, maxTokens: 22_222 };
      writeFileSync(join(otherRoot, "azure-model-metadata-cache.json"), JSON.stringify({
        version: 1, fetchedAt: Date.now(), models: { [id]: second },
      }));
      if (pauseAt === "models") writeFileSync(join(root, "azure-model-metadata-cache.json"), JSON.stringify({
        version: 1, fetchedAt: Date.now(), models: { [id]: first },
      }));
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      globalThis.fetch = (async (url: RequestInfo | URL) => {
        const metadata = String(url) === "https://models.dev/api.json";
        if (metadata === (pauseAt === "metadata")) {
          entered.resolve();
          await release.promise;
        }
        return jsonResponse(metadata ? { azure: { models: {
          [id]: { modalities: { input: first.input }, limit: { context: first.contextWindow, output: first.maxTokens } },
        } } } : { data: [{ id }] });
      }) as typeof fetch;
      const pending = fetchProviderModels("custom-azure", { ...AZURE, fetch: stubbedProviderFetch });
      await entered.promise;
      process.env.OPENCODEX_HOME = otherRoot;
      release.resolve();
      const models = await pending;
      expect(models.find(model => model.id === id)).toMatchObject({
        inputModalities: ["text"], contextWindow: 111_111, maxOutputTokens: 11_111,
      });
      expect(hint(discovered(id))).toMatchObject({
        inputModalities: ["text", "image"], contextWindow: 222_222, maxOutputTokens: 22_222,
      });
    });
  }

  test("public metadata redirects to loopback are rejected and discovery keeps stale fallback", async () => {
    const id = "redirect-model";
    const stale = { input: ["text"], contextWindow: 111_111, maxTokens: 11_111 };
    writeFileSync(join(root, "azure-model-metadata-cache.json"), JSON.stringify({
      version: 1, fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000, models: { [id]: stale },
    }));
    let redirects = 0;
    let loopbackHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/metadata") {
          redirects++;
          return new Response(null, { status: 302, headers: { location: new URL("/loopback", request.url).href } });
        }
        loopbackHits++;
        return jsonResponse({ azure: { models: {
          [id]: { modalities: { input: ["text", "image"] }, limit: { context: 222_222, output: 22_222 } },
        } } });
      },
    });
    try {
      globalThis.fetch = ((url: RequestInfo | URL, init?: RequestInit) => String(url) === "https://models.dev/api.json"
        ? originalFetch(new URL("/metadata", server.url), init)
        : Promise.resolve(jsonResponse({ data: [{ id }] }))) as typeof fetch;
      const models = await fetchProviderModels("custom-azure", { ...AZURE, fetch: stubbedProviderFetch });
      expect(redirects).toBe(1);
      expect(loopbackHits).toBe(0);
      expect(models.find(model => model.id === id)).toMatchObject({
        inputModalities: ["text"], contextWindow: 111_111, maxOutputTokens: 11_111,
      });
      expect(JSON.parse(readFileSync(join(root, "azure-model-metadata-cache.json"), "utf8")).models[id]).toEqual(stale);
    } finally { await server.stop(true); }
  });

  test("config-root switches isolate snapshots and reuse the original root on return", () => {
    const otherRoot = mkdtempSync(join(root, "other-"));
    for (const [dir, input] of [[root, ["text"]], [otherRoot, ["text", "image"]]] as const) {
      writeFileSync(join(dir, "azure-model-metadata-cache.json"), JSON.stringify({
        version: 1, fetchedAt: Date.now(), models: { "root-model": { input } },
      }));
    }
    expect(hint(discovered("root-model")).inputModalities).toEqual(["text"]);
    process.env.OPENCODEX_HOME = otherRoot;
    expect(hint(discovered("root-model")).inputModalities).toEqual(["text", "image"]);
    process.env.OPENCODEX_HOME = root;
    expect(hint(discovered("root-model")).inputModalities).toEqual(["text"]);
  });

  test("config-root switches isolate flights and capture each write destination before awaiting", async () => {
    const otherRoot = mkdtempSync(join(root, "other-"));
    let resolveFirst!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.headers).toEqual({ accept: "application/json" });
      calls++;
      if (calls === 1) return new Promise<Response>(resolve => { resolveFirst = resolve; });
      return jsonResponse({ azure: { models: { "root-model": { modalities: { input: ["text", "image"] } } } } });
    }) as typeof fetch;
    const first = refreshAzureModelMetadata(AZURE.baseUrl);
    const coalesced = refreshAzureModelMetadata(AZURE.baseUrl);
    process.env.OPENCODEX_HOME = otherRoot;
    // Both roots must start a fetch while the first root remains in flight.
    const second = refreshAzureModelMetadata(AZURE.baseUrl);
    try { expect(calls).toBe(2); }
    finally {
      resolveFirst(jsonResponse({ azure: { models: { "root-model": { modalities: { input: ["text"] } } } } }));
      await Promise.all([first, coalesced, second]);
    }
    expect(hint(discovered("root-model")).inputModalities).toEqual(["text", "image"]);
    expect(JSON.parse(readFileSync(join(root, "azure-model-metadata-cache.json"), "utf8"))
      .models["root-model"].input).toEqual(["text"]);
    expect(JSON.parse(readFileSync(join(otherRoot, "azure-model-metadata-cache.json"), "utf8"))
      .models["root-model"].input).toEqual(["text", "image"]);
    process.env.OPENCODEX_HOME = root;
    expect(hint(discovered("root-model")).inputModalities).toEqual(["text"]);
  });

  test("config-root switches do not share failed-refresh retry cooldowns", async () => {
    const otherRoot = mkdtempSync(join(root, "other-"));
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("offline"); }) as typeof fetch;
    await refreshAzureModelMetadata(AZURE.baseUrl);
    await refreshAzureModelMetadata(AZURE.baseUrl);
    process.env.OPENCODEX_HOME = otherRoot;
    await refreshAzureModelMetadata(AZURE.baseUrl);
    expect(calls).toBe(2);
    expect(existsSync(join(otherRoot, "azure-model-metadata-cache.json"))).toBe(false);
    process.env.OPENCODEX_HOME = root;
    await refreshAzureModelMetadata(AZURE.baseUrl);
    expect(calls).toBe(2);
  });

  test("public catalogs larger than provider discovery limits refresh within their own byte ceiling", async () => {
    for (const size of [5, 17]) {
      resetAzureModelMetadataForTests();
      globalThis.fetch = (async () => jsonResponse({
        padding: "x".repeat(size * 1024 * 1024),
        azure: { models: { "large-catalog-model": { modalities: { input: ["text", "image"] } } } },
      })) as typeof fetch;
      await refreshAzureModelMetadata(AZURE.baseUrl);
      expect(hint(discovered("large-catalog-model")).inputModalities)
        .toEqual(size === 5 ? ["text", "image"] : undefined);
      rmSync(join(root, "azure-model-metadata-cache.json"), { force: true });
    }
  });

  test("newly published Azure image models reach live and static catalogs without bundled rows", async () => {
    const id = "new-image-model";
    expect(getModelMetadata("openai", id)).toBeUndefined();
    let metadataCalls = 0;
    globalThis.fetch = (async (url: RequestInfo | URL) => {
      if (String(url) === "https://models.dev/api.json") {
        metadataCalls++;
        return jsonResponse({ azure: { models: {
          [id]: { modalities: { input: ["text", "image", "pdf"] }, limit: { context: 1_050_000, output: 128_000 } },
          "text-model": { modalities: { input: ["text"] }, limit: { context: 200_000 } },
        } } });
      }
      return jsonResponse({ data: [{ id, capabilities: { inference: true } }, { id: "text-model" }] });
    }) as typeof fetch;
    const models = await fetchProviderModels("custom-azure", { ...AZURE, fetch: stubbedProviderFetch });
    expect(models.find(model => model.id === id)).toMatchObject({
      inputModalities: ["text", "image"], contextWindow: 1_050_000, maxOutputTokens: 128_000,
    });
    expect(models.find(model => model.id === "text-model")?.inputModalities).toEqual(["text"]);
    const entry = buildCatalogEntries(null, [], models).find(row => row.slug === `custom-azure/${id}`);
    expect(entry?.input_modalities).toEqual(["text", "image"]);
    const configured = await fetchProviderModels("static-azure", { ...AZURE, liveModels: false, models: [id] });
    expect(configured[0]?.inputModalities).toEqual(["text", "image"]);
    expect(metadataCalls).toBe(1);
    resetAzureModelMetadataForTests();
    expect(hint(discovered(id)).inputModalities).toEqual(["text", "image"]);
    expect(hint(discovered(id), { ...AZURE, modelCapabilities: { [id]: { inputModalities: ["audio"] } } }).inputModalities).toEqual(["audio"]);
  });

  test("Azure published metadata wins over conflicting vendor rows and respects case", async () => {
    globalThis.fetch = (async () => jsonResponse({
      azure: { models: { "deepseek-v4-flash": { modalities: { input: ["text"] }, limit: { context: 1_000_000, output: 384_000 } } } },
      deepseek: { models: { "deepseek-v4-flash": { modalities: { input: ["text", "image"] }, limit: { context: 1_048_576, output: 393_216 } } } },
    })) as typeof fetch;
    await refreshAzureModelMetadata(AZURE.baseUrl);
    expect(hint(discovered("DEEPSEEK-V4-FLASH"))).toMatchObject({
      inputModalities: ["text"], contextWindow: 1_000_000, maxOutputTokens: 384_000,
    });
    expect(routedMaxOutputTokens("azure-openai", AZURE, discovered("deepseek-v4-flash"))).toBe(384_000);
    expect(hint(discovered("deepseek-v4-flash-2099-01-01")).inputModalities).toBeUndefined();
  });

  test("failed refresh preserves stale published data and coalesces discovery callers", async () => {
    writeFileSync(join(root, "azure-model-metadata-cache.json"), JSON.stringify({
      version: 1, fetchedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      models: { "cached-model": { input: ["text", "image"] } },
    }));
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("offline"); }) as typeof fetch;
    await Promise.all([refreshAzureModelMetadata(AZURE.baseUrl), refreshAzureModelMetadata(AZURE.baseUrl)]);
    await refreshAzureModelMetadata(AZURE.baseUrl);
    expect(calls).toBe(1);
    expect(hint(discovered("cached-model")).inputModalities).toEqual(["text", "image"]);
    expect(JSON.parse(readFileSync(join(root, "azure-model-metadata-cache.json"), "utf8")).models["cached-model"].input).toEqual(["text", "image"]);
  });

  test("missing or malformed public metadata never prevents upstream discovery", async () => {
    for (const payload of [null, { azure: { models: { bad: { modalities: { input: ["pdf", 42] }, limit: { context: -1, output: "128000" } } } } }]) {
      resetAzureModelMetadataForTests();
      clearModelCache();
      globalThis.fetch = (async (url: RequestInfo | URL) => String(url) === "https://models.dev/api.json"
        ? jsonResponse(payload) : jsonResponse({ data: [{ id: "gpt-6-sol" }] })) as typeof fetch;
      const models = await fetchProviderModels("custom-azure", { ...AZURE, fetch: stubbedProviderFetch });
      expect(models[0]?.inputModalities).toEqual(["text", "image"]);
    }
    globalThis.fetch = (async () => { throw new Error("non-Azure must not fetch"); }) as typeof fetch;
    await refreshAzureModelMetadata("https://gateway.example.test/v1");
  });

  test("known vendor ids resolve independently of the configured provider name", () => {
    expect(azureVendorModelMetadata(AZURE.baseUrl, "gpt-6-sol")?.contextWindow).toBe(1_050_000);
    expect(azureVendorModelMetadata(AZURE.baseUrl, "DeepSeek-V4-Flash")?.contextWindow).toBe(1_048_576);
    expect(azureVendorModelMetadata(AZURE.baseUrl, "glm-5.3")?.contextWindow).toBe(1_000_000);
  });

  test("unrecognized destinations and deployment aliases receive no guessed limit", () => {
    for (const baseUrl of [
      undefined, "not a url", "https://openrouter.test/api/v1",
      "https://api.example.com/resource.openai.azure.com",
      "https://openai.azure.com.example.test/openai",
    ]) {
      expect(azureVendorModelMetadata(baseUrl, "gpt-5.6-terra")).toBeUndefined();
    }
    expect(hint(discovered("my-deployment")).contextWindow).toBeUndefined();
  });

  test("an Azure row without upstream limits reaches the serialized Codex catalog", () => {
    const model = hint();
    expect(model.contextWindow).toBe(1_050_000);
    const entry = buildCatalogEntries(null, [], [model])
      .find(row => row.slug === "custom-azure/gpt-5.6-terra");
    expect(entry?.context_window).toBe(1_050_000);
    expect(entry?.max_context_window).toBe(1_050_000);
    expect(entry?.auto_compact_token_limit).toBe(945_000);
    expect(entry?.input_modalities).toEqual(["text", "image"]);
    expect(entry?.opencodex_capability_provenance).toMatchObject({ input_modalities: ["text", "image"] });
  });

  test("Azure inference flags do not hide missing vision metadata", () => {
    // Azure /models reports these flags without modalities or token limits.
    const apiHints = catalogHintsFromModelsApiItem("custom-azure", {
      id: "gpt-5.6-terra",
      capabilities: { inference: true, chat_completion: true, completion: false, embeddings: false },
    });
    expect(apiHints.inputModalities).toBeUndefined();
    expect(hint({ ...discovered(), ...apiHints })).toMatchObject({
      inputModalities: ["text", "image"], maxOutputTokens: 128_000,
      capabilities: ["inference", "chat_completion"],
    });
    expect(hint(discovered("GPT-6-SOL")).inputModalities).toEqual(["text", "image"]);
  });

  test("known text-only models do not acquire native vision", () => {
    for (const id of ["DeepSeek-V4-Flash", "glm-5.3"]) {
      expect(hint(discovered(id)).inputModalities).toEqual(["text"]);
    }
    expect(hint(discovered("my-deployment")).inputModalities).toBeUndefined();
    expect(hint(discovered(), { ...AZURE, baseUrl: "https://gateway.example.test/v1" }).inputModalities).toBeUndefined();
  });

  test("explicit Azure discovery modalities, including vision false, win over vendor hints", () => {
    for (const fields of [
      { input_modalities: ["text"] },
      { capabilities: { vision: false } },
      { capabilities: { supports: { vision: false } } },
    ]) {
      const apiHints = catalogHintsFromModelsApiItem("custom-azure", { id: "gpt-5.6-terra", ...fields });
      expect(hint({ ...discovered(), ...apiHints }).inputModalities).toEqual(["text"]);
    }
    const apiHints = catalogHintsFromModelsApiItem("custom-azure", { id: "my-deployment", capabilities: { vision: true } });
    expect(hint({ ...discovered("my-deployment"), ...apiHints }).inputModalities).toEqual(["text", "image"]);
  });

  test("configured modalities and sidecar coverage retain their existing precedence", () => {
    expect(hint(discovered(), {
      ...AZURE, modelCapabilities: { "gpt-5.6-terra": { inputModalities: ["audio"] } },
      modelInputModalities: { "gpt-5.6-terra": ["text", "image"] },
    }).inputModalities).toEqual(["audio"]);
    expect(hint(discovered(), {
      ...AZURE, modelInputModalities: { "GPT-5.6-TERRA": ["audio"] },
    }).inputModalities).toEqual(["audio"]);
    expect(hint(discovered("DeepSeek-V4-Flash"), {
      ...AZURE, noVisionModels: ["DeepSeek-V4-Flash"],
    }).inputModalities).toEqual(["text", "image"]);
  });

  test("output lookup applies across callers and keeps discovered limits and configured caps", () => {
    expect(routedMaxOutputTokens("custom-azure", AZURE, discovered())).toBe(128_000);
    expect(hint({ ...discovered(), maxOutputTokens: 16_000 }).maxOutputTokens).toBe(16_000);
    expect(hint(discovered(), {
      ...AZURE, modelMaxOutputTokens: { "gpt-5.6-terra": 8_000 },
    }).maxOutputTokens).toBe(8_000);
    expect(hint(discovered(), {
      ...AZURE, modelMaxOutputTokens: { "gpt-5.6-terra": 256_000 },
    }).maxOutputTokens).toBe(128_000);
    expect(hint(discovered("my-deployment")).maxOutputTokens).toBeUndefined();
  });

  test("reported and configured limits retain precedence", () => {
    expect(hint({ ...discovered(), contextWindow: 262_144 }).contextWindow).toBe(262_144);
    expect(hint(discovered(), { ...AZURE, contextWindow: 96_000 }).contextWindow).toBe(96_000);
    expect(hint(discovered(), {
      ...AZURE, modelContextWindows: { "gpt-5.6-terra": 64_000 },
    }).contextWindow).toBe(64_000);
  });

  test("providerContextCaps still clamps the vendor window", () => {
    expect(hint(discovered(), AZURE, 350_000)).toMatchObject({
      contextWindow: 350_000, contextCap: 350_000, contextCapped: true,
    });
  });

  test("refreshed OpenAI metadata matches the canonical API context seeds", () => {
    const declared = getProviderRegistryEntry("openai-apikey")!.modelContextWindows!;
    for (const id of [
      "gpt-5.6", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
      "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol",
    ]) {
      expect(declared[id], id).toBe(1_050_000);
      expect(getModelMetadata("openai", id)?.contextWindow, id).toBe(declared[id]);
    }
  });
});
