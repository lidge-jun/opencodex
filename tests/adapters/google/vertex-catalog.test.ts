import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { gatherRoutedModels as gatherRoutedModelsDirect } from "../../../src/codex/catalog";
import { clearModelCache, markModelsFetchFailure, setCached } from "../../../src/codex/model-cache";
import type { OcxConfig } from "../../../src/types";
import { withStubbedProviderFetch } from "../../helpers/catalog-provider-fetch";

/** Discovery runs on the pinned transport; hand it back the stubbed global. */
const gatherRoutedModels: typeof gatherRoutedModelsDirect = (config, options) =>
  gatherRoutedModelsDirect(withStubbedProviderFetch(config), options);

const originalFetch = globalThis.fetch;
let warn: ReturnType<typeof spyOn> | undefined;

afterEach(() => {
  globalThis.fetch = originalFetch;
  clearModelCache();
  warn?.mockRestore();
  warn = undefined;
});

function vertexProvider(name: string): OcxConfig {
  return {
    providers: {
      [name]: {
        adapter: "google",
        googleMode: "vertex",
        baseUrl: "https://aiplatform.googleapis.com",
        apiKey: "test-key",
        liveModels: true,
        models: ["publisher-model-a"],
      },
    },
  };
}

describe("Vertex catalog configuration", () => {
  test("a renamed static Vertex provider exposes its configured default without a network probe", async () => {
    let sends = 0;
    globalThis.fetch = (() => { sends++; throw new Error("unexpected network request"); }) as typeof fetch;
    const config: OcxConfig = { providers: { "renamed-vertex": {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
      defaultModel: "gemini-3-pro", liveModels: false,
    } } };
    const rows = await gatherRoutedModels(config);
    expect(rows).toContainEqual(expect.objectContaining({ provider: "renamed-vertex", id: "gemini-3-pro" }));
    expect(sends).toBe(0);
  });

  test("a legacy Vertex provider without liveModels retains live discovery", async () => {
    let sends = 0;
    globalThis.fetch = (() => { sends++; return Promise.resolve(Response.json({ data: [{ id: "gemini-discovered" }] })); }) as typeof fetch;
    const config: OcxConfig = { providers: { "renamed-vertex": {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com", apiKey: "test-key",
    } } };
    const rows = await gatherRoutedModels(config);
    expect(rows).toContainEqual(expect.objectContaining({ provider: "renamed-vertex", id: "gemini-discovered" }));
    expect(sends).toBeGreaterThan(0);
  });
  test("an implicit canonical legacy Vertex row does not add an undiscovered default to a live catalog", async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({ data: [{ id: "upstream-available" }] }))) as typeof fetch;
    const config: OcxConfig = { providers: { "google-vertex": {
      adapter: "google", baseUrl: "https://aiplatform.googleapis.com", apiKey: "test-key", defaultModel: "not-in-upstream",
    } } };
    const rows = await gatherRoutedModels(config);
    expect(rows).toContainEqual(expect.objectContaining({ provider: "google-vertex", id: "upstream-available" }));
    expect(rows.some(row => row.provider === "google-vertex" && row.id === "not-in-upstream")).toBe(false);
  });
  test("defaultModel without models survives failed Vertex discovery", async () => {
    globalThis.fetch = (() => { throw new TypeError("offline"); }) as typeof fetch;
    const config: OcxConfig = {
      providers: {
        "vertex-default": {
          adapter: "google",
          googleMode: "vertex",
          baseUrl: "https://aiplatform.googleapis.com",
          apiKey: "test-key",
          defaultModel: "gemini-2.5-pro",
        },
      },
    };

    const rows = await gatherRoutedModels(config);

    expect(rows).toContainEqual(expect.objectContaining({
      provider: "vertex-default",
      id: "gemini-2.5-pro",
    }));
  });

  test("defaultModel-only Vertex configuration survives authoritative empty discovery", async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({ data: [] }))) as typeof fetch;
    const config: OcxConfig = {
      providers: {
        "vertex-empty": {
          adapter: "google",
          googleMode: "vertex",
          baseUrl: "https://aiplatform.googleapis.com",
          apiKey: "test-key",
          defaultModel: "gemini-2.5-pro",
        },
      },
    };

    const rows = await gatherRoutedModels(config);

    expect(rows).toContainEqual(expect.objectContaining({
      provider: "vertex-empty",
      id: "gemini-2.5-pro",
    }));
  });

  test("defaultModel-only Vertex configuration survives a fresh empty cache", async () => {
    globalThis.fetch = (() => { throw new Error("must not fetch"); }) as typeof fetch;
    const provider = "vertex-fresh-empty";
    setCached(provider, []);
    const config: OcxConfig = {
      providers: {
        [provider]: {
          adapter: "google",
          googleMode: "vertex",
          baseUrl: "https://aiplatform.googleapis.com",
          apiKey: "test-key",
          defaultModel: "gemini-2.5-pro",
        },
      },
    };

    const rows = await gatherRoutedModels(config);

    expect(rows).toContainEqual(expect.objectContaining({
      provider,
      id: "gemini-2.5-pro",
    }));
  });

  test("defaultModel-only Vertex configuration survives an empty stale cache during cooldown", async () => {
    globalThis.fetch = (() => { throw new Error("must not fetch"); }) as typeof fetch;
    const provider = "vertex-stale-empty";
    setCached(provider, [], 0);
    markModelsFetchFailure(provider);
    const config: OcxConfig = {
      modelCacheTtlMs: 1,
      providers: {
        [provider]: {
          adapter: "google",
          googleMode: "vertex",
          baseUrl: "https://aiplatform.googleapis.com",
          apiKey: "test-key",
          defaultModel: "gemini-2.5-pro",
        },
      },
    };

    const rows = await gatherRoutedModels(config);

    expect(rows).toContainEqual(expect.objectContaining({
      provider,
      id: "gemini-2.5-pro",
    }));
  });

  test("non-Vertex defaultModel without models is not seeded after discovery failure", async () => {
    globalThis.fetch = (() => { throw new TypeError("offline"); }) as typeof fetch;
    const config: OcxConfig = {
      providers: {
        "custom-openai": {
          adapter: "openai-chat",
          baseUrl: "https://example.invalid/v1",
          apiKey: "test-key",
          defaultModel: "typoed-default",
        },
      },
    };

    const rows = await gatherRoutedModels(config);

    expect(rows).not.toContainEqual(expect.objectContaining({
      provider: "custom-openai",
      id: "typoed-default",
    }));
  });

  test("models + liveModels false exposes configured Vertex ids without discovery", async () => {
    globalThis.fetch = (() => { throw new Error("must not fetch"); }) as typeof fetch;
    const config = vertexProvider("vertex-static");
    config.providers["vertex-static"]!.liveModels = false;
    const rows = await gatherRoutedModels(config);
    expect(rows).toContainEqual(expect.objectContaining({
      provider: "vertex-static",
      id: "publisher-model-a",
    }));
  });

  test("non-2xx diagnostic identifies provider, URL class, and configured fallback", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (() => Promise.resolve(new Response("missing", { status: 404 }))) as typeof fetch;
    await gatherRoutedModels(vertexProvider("vertex-http"));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'Provider model discovery for "vertex-http" failed with HTTP 404 [urlClass=vertex-aiplatform, fallback=configured]',
    );
  });

  test("exception diagnostic identifies provider, URL class, and configured fallback", async () => {
    warn = spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = (() => { throw new TypeError("offline"); }) as typeof fetch;
    await gatherRoutedModels(vertexProvider("vertex-throw"));
    expect(warn.mock.calls.flat().join(" ")).toContain(
      'Provider model discovery for "vertex-throw" threw TypeError [urlClass=vertex-aiplatform, fallback=configured]',
    );
  });

  test("discovers Vertex publisherModels including gemini-4-carbon with full capabilities and filters non-chat SKUs", async () => {
    let seenUrl = "";
    let seenApiKeyHeader = "";
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      seenUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      seenApiKeyHeader = headers.get("x-goog-api-key") ?? "";
      return Promise.resolve(Response.json({
        publisherModels: [
          { name: "publishers/google/models/gemini-4-hydrogen", versionId: "default", launchStage: "GA" },
          { name: "publishers/google/models/gemini-4-carbon", versionId: "default", launchStage: "GA" },
          { name: "publishers/google/models/gemini-4-argon", versionId: "default", launchStage: "GA" },
          { name: "publishers/google/models/gemini-embedding-2", versionId: "default", launchStage: "GA" },
          { name: "publishers/google/models/gemini-2.5-flash-tts", versionId: "default", launchStage: "GA" },
          { name: "publishers/google/models/gemini-live-2.5-flash", versionId: "default", launchStage: "GA" },
          { name: "publishers/google/models/imagen-4.0-generate-001", versionId: "001", launchStage: "GA" },
        ],
      }));
    }) as typeof fetch;

    const config: OcxConfig = {
      providers: {
        google: {
          adapter: "google",
          googleMode: "vertex",
          baseUrl: "https://aiplatform.googleapis.com",
          project: "demo-vertex-project",
          location: "global",
          apiKey: "vertex-api-key",
          liveModels: true,
        },
      },
    };
    const rows = await gatherRoutedModels(config);
    expect(seenUrl).toBe("https://aiplatform.googleapis.com/v1beta1/publishers/google/models?pageSize=300");
    expect(seenApiKeyHeader).toBe("vertex-api-key");

    const hydrogen = rows.find(row => row.provider === "google" && row.id === "gemini-4-hydrogen");
    expect(hydrogen).toMatchObject({
      provider: "google",
      id: "gemini-4-hydrogen",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high", "xhigh"],
      defaultReasoningEffort: "high",
    });
    const carbon = rows.find(row => row.provider === "google" && row.id === "gemini-4-carbon");
    expect(carbon).toMatchObject({
      provider: "google",
      id: "gemini-4-carbon",
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      inputModalities: ["text", "image"],
      reasoningEfforts: ["low", "medium", "high"],
    });
    expect(rows.some(row => row.id === "gemini-4-argon")).toBe(true);
    for (const excluded of [
      "gemini-embedding-2",
      "gemini-2.5-flash-tts",
      "gemini-live-2.5-flash",
      "imagen-4.0-generate-001",
    ]) {
      expect(rows.some(row => row.id === excluded)).toBe(false);
    }
  });
  test("a configured reasoning ladder wins over the registry ladder discovery advertises", async () => {
    globalThis.fetch = (() => Promise.resolve(Response.json({
      publisherModels: [{ name: "publishers/google/models/gemini-4-hydrogen" }, { name: "publishers/google/models/gemini-4-carbon" }],
    }))) as typeof fetch;
    const rows = await gatherRoutedModels({ providers: { "override-vertex": {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com", apiKey: "vertex-api-key", liveModels: true,
      modelReasoningEfforts: { "gemini-4-hydrogen": ["low", "high"] }, noReasoningModels: ["gemini-4-carbon"],
    } } });
    expect(rows.find(row => row.id === "gemini-4-hydrogen")?.reasoningEfforts).toEqual(["low", "high"]);
    expect(rows.find(row => row.id === "gemini-4-carbon")?.reasoningEfforts ?? []).toEqual([]);
  });

  test("a paginated Vertex listing publishes every page, and an unfinished one is not published as authoritative", async () => {
    const pageTokens: string[] = [];
    let failSecondPage = false;
    globalThis.fetch = ((input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const token = url.searchParams.get("pageToken");
      if (token) pageTokens.push(token);
      if (!token) {
        return Promise.resolve(Response.json({
          publisherModels: [{ name: "publishers/google/models/gemini-4-carbon" }],
          nextPageToken: "page-2",
        }));
      }
      if (failSecondPage) return Promise.resolve(new Response("unavailable", { status: 503 }));
      return Promise.resolve(Response.json({ publisherModels: [{ name: "publishers/google/models/gemini-4-hydrogen" }] }));
    }) as typeof fetch;
    const config: OcxConfig = { providers: { "paged-vertex": {
      adapter: "google", googleMode: "vertex", baseUrl: "https://aiplatform.googleapis.com",
      apiKey: "vertex-api-key", liveModels: true, models: ["configured-only"],
    } } };

    const complete = await gatherRoutedModels(config);
    expect(pageTokens).toEqual(["page-2"]);
    expect(complete.filter(row => row.provider === "paged-vertex").map(row => row.id))
      .toEqual(expect.arrayContaining(["gemini-4-carbon", "gemini-4-hydrogen"]));

    clearModelCache();
    failSecondPage = true;
    warn = spyOn(console, "warn").mockImplementation(() => {});
    const incomplete = await gatherRoutedModels(config);
    const ids = incomplete.filter(row => row.provider === "paged-vertex").map(row => row.id);
    expect(ids).toContain("configured-only");
    expect(ids).not.toContain("gemini-4-carbon");
    expect(warn.mock.calls.map(call => String(call[0])).join("\n")).toContain("incomplete paginated listing");
  });
});
