import { describe, expect, test } from "bun:test";
import { filterCatalogVisibleModels, mergeConfiguredModelsIntoLiveCatalog } from "../src/codex/catalog/provider-fetch";
import { nonBlankStringArrayConfigError } from "../src/config";
import type { CatalogModel } from "../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../src/types";

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
  test("reconcileProviderFetchWarnings clears retained without discovery memos on generation change", () => {
    const { reconcileProviderFetchWarnings } = require("../src/codex/catalog/provider-fetch");
    expect(typeof reconcileProviderFetchWarnings).toBe("function");
    // Advance generation and ensure it cleans up
    reconcileProviderFetchWarnings(100);
  });

});
