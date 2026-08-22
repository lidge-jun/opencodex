import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  filterCatalogVisibleModels,
  isRetainedModelWithoutDiscoveryForTests,
  mergeConfiguredModelsIntoLiveCatalog,
  reconcileProviderFetchWarnings,
  resetRetainedModelWarningsForTests,
  warnRetainedModel404Once,
} from "../src/codex/catalog/provider-fetch";
import { clearModelCache } from "../src/codex/model-cache";
import { nonBlankStringArrayConfigError } from "../src/config";
import { saveConfig } from "../src/config";
import { startServer } from "../src/server";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import type { OcxConfig, OcxProviderConfig } from "../src/types";

function model(id: string, provider = "test-prov"): CatalogModel {
  return { id, provider };
}

describe("#1690 retainModels provider configuration", () => {
  test("retains configured models listed in retainModels when live discovery omits them", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.5-flash")];
    const configured = [model("gemini-3.7-flash"), model("unrelated-model")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.5-flash", "gemini-3.7-flash"]);
    expect(droppedConfiguredIds).toEqual(["unrelated-model"]);
    expect(models.find(m => m.id === "gemini-3.7-flash")?.retainedWithoutDiscovery).toBe(true);
    expect(models.find(m => m.id === "gemini-3.5-flash")?.retainedWithoutDiscovery).toBeUndefined();
  });

  test("drops unlisted models when retainModels is empty", () => {
    const prov: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      retainModels: [],
    };
    const live = [model("live-model-1")];
    const configured = [model("configured-model-1")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "custom-prov",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["live-model-1"]);
    expect(droppedConfiguredIds).toEqual(["configured-model-1"]);
  });

  test("drops unlisted models when retainModels is undefined", () => {
    const prov: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.com/v1",
    };
    const live = [model("live-model-1")];
    const configured = [model("configured-model-1")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "custom-prov",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["live-model-1"]);
    expect(droppedConfiguredIds).toEqual(["configured-model-1"]);
  });

  test("preserves discovered models that match retainModels without duplication", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.7-flash")];
    const configured = [model("gemini-3.7-flash")];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.7-flash"]);
    expect(droppedConfiguredIds).toEqual([]);
    expect(models[0]!.retainedWithoutDiscovery).toBeUndefined();
  });

  test("retains multiple specified models across an empty live discovery", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash", "claude-sonnet-4-6"],
    };
    const live: CatalogModel[] = [];
    const configured = [
      model("gemini-3.7-flash"),
      model("claude-sonnet-4-6"),
      model("dropped-model"),
    ];

    const { models, droppedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.7-flash", "claude-sonnet-4-6"]);
    expect(droppedConfiguredIds).toEqual(["dropped-model"]);
  });

  test("reports retainedConfiguredIds and stamps retainedWithoutDiscovery", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash", "claude-sonnet-4-6"],
    };
    const live = [model("gemini-3.5-flash")];
    const configured = [
      model("gemini-3.7-flash"),
      model("claude-sonnet-4-6"),
      model("unrelated-model"),
    ];

    const { models, droppedConfiguredIds, retainedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.5-flash", "gemini-3.7-flash", "claude-sonnet-4-6"]);
    expect(retainedConfiguredIds.sort()).toEqual(["claude-sonnet-4-6", "gemini-3.7-flash"]);
    expect(droppedConfiguredIds).toEqual(["unrelated-model"]);
  });

  test("does not report live-discovered models as retainedConfiguredIds", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.7-flash")];
    const configured = [model("gemini-3.7-flash")];

    const { models, retainedConfiguredIds } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.7-flash"]);
    expect(retainedConfiguredIds).toEqual([]);
  });

  test("rejects whitespace-only retainModels entries via nonBlankStringArrayConfigError", () => {
    const error = nonBlankStringArrayConfigError(["   "], "retainModels");
    expect(error).not.toBeNull();
    expect(error).toContain("nonblank");
    expect(nonBlankStringArrayConfigError(["gemini-3.7-flash", " gemini-3.5-flash "], "retainModels")).toBeNull();
  });

  test("respects selectedModels and disabledModels filtering after retaining models", () => {
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash", "retained-unselected"],
      selectedModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.5-flash", "google-antigravity")];
    const configured = [model("gemini-3.7-flash", "google-antigravity"), model("retained-unselected", "google-antigravity")];

    const { models } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });

    expect(models.map(m => m.id)).toEqual(["gemini-3.5-flash", "gemini-3.7-flash", "retained-unselected"]);

    const visible = filterCatalogVisibleModels(models, {
      providers: { "google-antigravity": prov },
    });
    expect(visible.map(m => m.id)).toEqual(["gemini-3.7-flash"]);
  });

  test("warnRetainedModel404Once warns on first 404, suppresses on second, and resets on new generation", () => {
    resetRetainedModelWarningsForTests();
    reconcileProviderFetchWarnings(1);

    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };

    try {
      // Model not in retained refs does not warn
      warnRetainedModel404Once("test-prov", "unknown-model");
      expect(warnCalls.length).toBe(0);
    } finally {
      console.warn = originalWarn;
    }
  });
});

describe("catalog lifecycle and server 404 diagnostics for retained models", () => {
  test("warm-cache gather restores provenance after generation reconcile and permits 404 warning", async () => {
    const isolated = installIsolatedCodexHome("ocx-retain-warm-");
    const testDir = mkdtempSync(join(tmpdir(), "ocx-retain-warm-"));
    const prevHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;

    resetRetainedModelWarningsForTests();
    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };

    let upstreamCalls = 0;
    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("/models")) {
          upstreamCalls += 1;
          return Response.json({
            data: [{ id: "claude-live-1", owned_by: "anthropic" }],
          });
        }
        return Response.json({
          type: "error",
          error: { type: "not_found_error", message: "model: claude-retained" },
        }, { status: 404 });
      },
    });

    saveConfig({
      port: 0,
      defaultProvider: "test-warm-prov",
      providers: {
        "test-warm-prov": {
          adapter: "anthropic",
          baseUrl: `http://127.0.0.1:${upstream.port}`,
          apiKey: "test-key",
          allowPrivateNetwork: true,
          retainModels: ["claude-retained"],
        },
      },
    } as OcxConfig);
    const server = startServer(0);

    try {
      // 1. Initial live gather populates cache with claude-live-1 and retained claude-retained
      const catRes1 = await fetch(new URL("/v1/models", server.url), {
        headers: { authorization: "Bearer test-caller-token" },
      });
      expect(catRes1.status).toBe(200);
      const cat1 = (await catRes1.json()) as { data: Array<{ id: string }> };
      expect(cat1.data.map(m => m.id)).toEqual(["test-warm-prov/claude-live-1", "test-warm-prov/claude-retained"]);
      expect(upstreamCalls).toBe(1);
      expect(isRetainedModelWithoutDiscoveryForTests("test-warm-prov", "claude-retained")).toBe(true);

      // 2. Generation reconcile clears in-memory maps
      reconcileProviderFetchWarnings(100);
      expect(isRetainedModelWithoutDiscoveryForTests("test-warm-prov", "claude-retained")).toBe(false);

      // 3. Second gather within TTL hits fresh cache (no upstream /models request)
      const catRes2 = await fetch(new URL("/v1/models", server.url), {
        headers: { authorization: "Bearer test-caller-token" },
      });
      expect(catRes2.status).toBe(200);
      expect(upstreamCalls).toBe(1); // No new upstream discovery request
      // Provenance MUST be restored from cached metadata!
      expect(isRetainedModelWithoutDiscoveryForTests("test-warm-prov", "claude-retained")).toBe(true);

      // 4. Request for retained model fails with 404 upstream -> emits exactly one warning
      const resp404 = await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-caller-token",
        },
        body: JSON.stringify({
          model: "claude-retained",
          input: [{ type: "message", role: "user", content: "hello" }],
        }),
      });
      expect(resp404.status).toBe(404);
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]).toContain('Model "claude-retained" on provider "test-warm-prov" is retained via retainModels');

      // 5. Second 404 is suppressed
      await fetch(new URL("/v1/responses", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-caller-token",
        },
        body: JSON.stringify({
          model: "claude-retained",
          input: [{ type: "message", role: "user", content: "hello" }],
        }),
      });
      expect(warnCalls.length).toBe(1);
    } finally {
      await server.stop(true);
      upstream.stop(true);
      console.warn = originalWarn;
      if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = prevHome;
      isolated.restore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("/v1/chat/completions triggers warnRetainedModel404Once on plain 404 and model_not_found", async () => {
    const isolated = installIsolatedCodexHome("ocx-retain-chat-");
    const testDir = mkdtempSync(join(tmpdir(), "ocx-retain-chat-"));
    const prevHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;

    resetRetainedModelWarningsForTests();
    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };

    const upstream = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname.includes("/models")) {
          return Response.json({ data: [] });
        }
        return Response.json({
          error: { message: "Model does not exist", type: "invalid_request_error" },
        }, { status: 404 });
      },
    });

    saveConfig({
      port: 0,
      defaultProvider: "test-chat-prov",
      providers: {
        "test-chat-prov": {
          adapter: "openai-chat",
          baseUrl: `http://127.0.0.1:${upstream.port}/v1`,
          apiKey: "test-key",
          allowPrivateNetwork: true,
          retainModels: ["retained-chat-model"],
        },
      },
    } as OcxConfig);
    const server = startServer(0);

    try {
      // Populate models
      await fetch(new URL("/v1/models", server.url), {
        headers: { authorization: "Bearer test-caller-token" },
      });

      const response = await fetch(new URL("/v1/chat/completions", server.url), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer test-caller-token",
        },
        body: JSON.stringify({
          model: "retained-chat-model",
          stream: false,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(response.status).toBe(404);
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]).toContain('Model "retained-chat-model" on provider "test-chat-prov" is retained via retainModels');
    } finally {
      await server.stop(true);
      upstream.stop(true);
      console.warn = originalWarn;
      if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
      else process.env.OPENCODEX_HOME = prevHome;
      isolated.restore();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  test("delayed stale writer from prior generation cannot install stale diagnostic state", async () => {
    const { fetchProviderModels } = await import("../src/codex/catalog/provider-fetch");
    resetRetainedModelWarningsForTests();
    clearModelCache();

    let resolveDelayedDiscovery: (res: Response) => void;
    const delayedPromise = new Promise<Response>(resolve => {
      resolveDelayedDiscovery = resolve;
    });

    const provGen1: OcxProviderConfig = {
      adapter: "openai-chat",
      baseUrl: "https://api.example.com/v1",
      apiKey: "test-key",
      retainModels: ["retained-gen1"],
      fetch: (async (url: RequestInfo | URL) => {
        if (String(url).includes("/models")) {
          return delayedPromise;
        }
        return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
    };

    // 1. Start live gather for Gen 1 (hangs on delayedPromise)
    const inFlightGather = fetchProviderModels("test-stale-prov", provGen1, 60_000);

    // 2. Cache is cleared / generation bumped (e.g. config changed to Gen 2 without retainModels)
    clearModelCache("test-stale-prov");
    reconcileProviderFetchWarnings(200);

    // 3. Resolve delayed discovery from Gen 1
    resolveDelayedDiscovery!(new Response(JSON.stringify({ data: [{ id: "live-gen1" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await inFlightGather;

    // Stale writer was rejected by setCached, so retainedWithoutDiscoveryRefs must not have retained-gen1!
    expect(isRetainedModelWithoutDiscoveryForTests("test-stale-prov", "retained-gen1")).toBe(false);
  });
});
