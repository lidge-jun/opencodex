import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installIsolatedCodexHome } from "./helpers/isolated-codex-home";
import {
  filterCatalogVisibleModels,
  mergeConfiguredModelsIntoLiveCatalog,
  reconcileProviderFetchWarnings,
  warnRetainedModel404Once,
  retainedWithoutDiscoveryRefs,
  warnedRetained404Refs,
} from "../src/codex/catalog/provider-fetch";
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

  test("reports retainedConfiguredIds only for retainModels-kept models omitted by live discovery", () => {
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
  test("warnRetainedModel404Once warns on first 404, suppresses on second, and resets after reconcileProviderFetchWarnings", () => {
    reconcileProviderFetchWarnings(1);
    retainedWithoutDiscoveryRefs.set("test-prov", new Set(["gemini-3.7-flash"]));

    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };

    try {
      // First 404 should emit warning
      warnRetainedModel404Once("test-prov", "gemini-3.7-flash");
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]).toContain('Model "gemini-3.7-flash" on provider "test-prov" is retained via retainModels');

      // Second 404 for same provider/model should be suppressed
      warnRetainedModel404Once("test-prov", "gemini-3.7-flash");
      expect(warnCalls.length).toBe(1);

      // Model not in retainedWithoutDiscoveryRefs should NOT warn
      warnRetainedModel404Once("test-prov", "other-model");
      expect(warnCalls.length).toBe(1);

      // Advance generation via reconcileProviderFetchWarnings
      reconcileProviderFetchWarnings(2);
      expect(retainedWithoutDiscoveryRefs.size).toBe(0);
      expect(warnedRetained404Refs.size).toBe(0);

      // Re-populate and verify warning can fire again in new generation
      retainedWithoutDiscoveryRefs.set("test-prov", new Set(["gemini-3.7-flash"]));
      warnRetainedModel404Once("test-prov", "gemini-3.7-flash");
      expect(warnCalls.length).toBe(2);
    } finally {
      console.warn = originalWarn;
    }
  });

  test("multi-pass retention (live -> forCache -> returned) preserves retainedWithoutDiscoveryRefs", () => {
    reconcileProviderFetchWarnings(10);
    const prov: OcxProviderConfig = {
      adapter: "google",
      baseUrl: "https://daily-cloudcode-pa.googleapis.com",
      retainModels: ["gemini-3.7-flash"],
    };
    const live = [model("gemini-3.5-flash")];
    const configured = [model("gemini-3.7-flash")];

    // Pass 1: live evaluation with recordRetainedDiagnostics: true
    const { models: forCache, retainedConfiguredIds: pass1Retained } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: live,
      configured,
    });
    expect(pass1Retained).toEqual(["gemini-3.7-flash"]);
    retainedWithoutDiscoveryRefs.set("google-antigravity", new Set(pass1Retained));

    // Pass 2: returned / cached evaluation on forCache
    const { models: returned, retainedConfiguredIds: pass2Retained } = mergeConfiguredModelsIntoLiveCatalog({
      name: "google-antigravity",
      provider: prov,
      models: forCache,
      configured,
    });
    expect(pass2Retained).toEqual([]);
    // retainedWithoutDiscoveryRefs must still have the model
    expect(retainedWithoutDiscoveryRefs.get("google-antigravity")?.has("gemini-3.7-flash")).toBe(true);
  });

});

describe("server 404 diagnostics for retained models", () => {
  test("/v1/chat/completions triggers warnRetainedModel404Once on upstream 404 even without code: model_not_found", async () => {
    const isolated = installIsolatedCodexHome("ocx-retain-chat-");
    const testDir = mkdtempSync(join(tmpdir(), "ocx-retain-chat-"));
    const prevHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;

    reconcileProviderFetchWarnings(20);
    retainedWithoutDiscoveryRefs.set("test-chat-prov", new Set(["retained-chat-model"]));

    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          error: {
            message: "Model does not exist",
            type: "invalid_request_error",
          },
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

  test("non-passthrough responses error handling triggers warnRetainedModel404Once on 404", async () => {
    const isolated = installIsolatedCodexHome("ocx-retain-resp-");
    const testDir = mkdtempSync(join(tmpdir(), "ocx-retain-resp-"));
    const prevHome = process.env.OPENCODEX_HOME;
    process.env.OPENCODEX_HOME = testDir;

    reconcileProviderFetchWarnings(30);
    retainedWithoutDiscoveryRefs.set("test-anthropic-prov", new Set(["claude-retained"]));

    const warnCalls: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: any[]) => {
      warnCalls.push(args.join(" "));
    };

    const upstream = Bun.serve({
      port: 0,
      fetch() {
        return Response.json({
          type: "error",
          error: {
            type: "not_found_error",
            message: "model: claude-retained",
          },
        }, { status: 404 });
      },
    });

    saveConfig({
      port: 0,
      defaultProvider: "test-anthropic-prov",
      providers: {
        "test-anthropic-prov": {
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
      const response = await fetch(new URL("/v1/responses", server.url), {
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
      expect(response.status).toBe(404);
      expect(warnCalls.length).toBe(1);
      expect(warnCalls[0]).toContain('Model "claude-retained" on provider "test-anthropic-prov" is retained via retainModels');
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
});
