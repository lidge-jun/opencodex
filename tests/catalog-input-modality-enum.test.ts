import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCatalogEntries,
  ensureStrictCatalogFields,
  mergeCatalogEntriesForSync,
  repairCatalogInputModalities,
  resetCatalogRuntimeStateForTests,
  sanitizeCodexInputModalities,
  syncCatalogModels,
} from "../src/codex/catalog";
import { catalogHintsFromModelsApiItem } from "../src/codex/catalog/provider-fetch";
import { handleManagementAPI } from "../src/server/management-api";
import type { OcxConfig } from "../src/types";

const previousCodexHome = process.env.CODEX_HOME;

afterEach(() => {
  resetCatalogRuntimeStateForTests();
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
});

describe("Codex catalog input_modalities enum", () => {
  test("sanitizeCodexInputModalities drops video and keeps text|image|audio", () => {
    expect(sanitizeCodexInputModalities(["text", "video", "image", "audio", "video"])).toEqual(["text", "image", "audio"]);
    expect(sanitizeCodexInputModalities(["video"])).toEqual(["text"]);
    expect(sanitizeCodexInputModalities(undefined)).toEqual(["text"]);
  });

  test("ensureStrictCatalogFields strips video even when preserveExactInputModalities is true", () => {
    const entry = ensureStrictCatalogFields({
      slug: "combo/test-alias",
      input_modalities: ["text", "video", "image"],
    }, { preserveExactInputModalities: true, isRouted: true });
    expect(entry.input_modalities).toEqual(["text", "image"]);
  });

  test("provider model discovery metadata never advertises video to the catalog builder", () => {
    const hints = catalogHintsFromModelsApiItem("zenmux", {
      id: "meta-muse-spark-1.1",
      input_modalities: ["text", "image", "video"],
    });
    expect(hints.inputModalities).toEqual(["text", "image"]);
  });

  test("mergeCatalogEntriesForSync repairs poisoned on-disk modalities", () => {
    const merged = mergeCatalogEntriesForSync(
      [{
        slug: "fakeprov/poisoned",
        input_modalities: ["text", "video"],
        visibility: "list",
        priority: 5,
      }],
      [],
      new Map(),
      [],
      false,
    );
    expect(merged[0]?.input_modalities).toEqual(["text"]);
  });

  test("syncCatalogModels rewrites a poisoned catalog file to Codex-safe modalities", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-catalog-enum-"));
    process.env.CODEX_HOME = dir;
    const catalogPath = join(dir, "opencodex-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      models: [{
        slug: "gpt-5.5",
        display_name: "gpt-5.5",
        description: "native",
        priority: 1,
        visibility: "list",
        base_instructions: "You are a helpful coding assistant.",
        input_modalities: ["text", "video"],
      }, {
        slug: "fakeprov/routed",
        display_name: "fakeprov/routed",
        description: "routed",
        priority: 5,
        visibility: "list",
        base_instructions: "You are a helpful coding assistant.",
        input_modalities: ["text", "video", "image"],
      }],
    }, null, 2) + "\n");
    writeFileSync(join(dir, "config.toml"), `model_catalog_json = "${catalogPath.replace(/\\/g, "/")}"\n`);

    const config: OcxConfig = {
      port: 10100,
      defaultProvider: "fakeprov",
      providers: {
        fakeprov: {
          adapter: "openai-chat",
          baseUrl: "https://api.example.test/v1",
          liveModels: false,
          models: ["routed"],
          fetch: (() => { throw new Error("unexpected fetch"); }) as typeof fetch,
        },
      },
    };

    await syncCatalogModels(config);
    const written = JSON.parse(readFileSync(catalogPath, "utf8")) as { models: Array<{ slug?: string; input_modalities?: string[] }> };
    for (const entry of written.models) {
      expect(entry.input_modalities?.includes("video")).toBe(false);
      expect(entry.input_modalities?.every(value => value === "text" || value === "image" || value === "audio")).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("GET /api/catalog", () => {
  test("returns the on-disk catalog under management auth without secrets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ocx-catalog-api-"));
    process.env.CODEX_HOME = dir;
    const catalogPath = join(dir, "opencodex-catalog.json");
    writeFileSync(catalogPath, JSON.stringify({
      models: [{
        slug: "gpt-5.5",
        display_name: "gpt-5.5",
        description: "native",
        priority: 1,
        visibility: "list",
        base_instructions: "You are a helpful coding assistant.",
        input_modalities: ["text", "image"],
      }],
    }, null, 2) + "\n");
    writeFileSync(join(dir, "config.toml"), `model_catalog_json = "${catalogPath.replace(/\\/g, "/")}"\n`);

    const url = new URL("http://127.0.0.1/api/catalog");
    const response = await handleManagementAPI(
      new Request(url, { headers: { Host: "127.0.0.1" } }),
      url,
      { port: 10100, hostname: "127.0.0.1" },
    );
    expect(response?.status).toBe(200);
    const body = await response!.json() as { models: Array<{ slug?: string }> };
    expect(body.models.some(entry => entry.slug === "gpt-5.5")).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/api[_-]?key|sk-[a-z0-9]/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("catalog builder choke point", () => {
  test("buildCatalogEntries never serializes video into input_modalities", () => {
    const entries = buildCatalogEntries(null, [], [{
      provider: "fakeprov",
      id: "video-model",
      inputModalities: ["text", "video", "image"],
    }], [], false);
    const routed = entries.find(entry => entry.slug === "fakeprov/video-model");
    expect(routed?.input_modalities).toEqual(["text", "image"]);
  });

  test("repairCatalogInputModalities reports and fixes poisoned rows", () => {
    const catalog = { models: [{ slug: "x/y", input_modalities: ["text", "video"] }] };
    expect(repairCatalogInputModalities(catalog)).toBe(true);
    expect(catalog.models[0]?.input_modalities).toEqual(["text"]);
    expect(repairCatalogInputModalities(catalog)).toBe(false);
  });
});
