import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig } from "../../src/config";
import { sanitizeCapabilityDeclarationsForLoad } from "../../src/config/load-degrade";
import { providerConfigSchema } from "../../src/config/schema/leaf-validators";
import * as destinationPolicy from "../../src/lib/destination-policy";
import { registryInputModalitiesForDestination } from "../../src/providers/derive";
import { routedProviderConfig } from "../../src/providers/routed-config";
import { candidateCapabilityEvidence } from "../../src/routing/capability";
import { parseProviderEditorConfigDTO, providerEditorConfigDTO, providerManagementConfigError } from "../../src/server/auth-cors";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { isVisionSidecarConsumer } from "../../src/vision/eligibility";
import { requiresVisionPreprocessing } from "../../src/vision/plan";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const provider: OcxProviderConfig = { adapter: "openai-chat", baseUrl: "https://aistupidlevel.info/v1" };
const malformed = [null, "image", 42, true, {}, [], ["unknown"], ["text", 1], ["image", null], [["image"]]];
const config = (row: OcxProviderConfig = provider): OcxConfig => ({
  port: 10100, defaultProvider: "aistupidlevel", providers: { aistupidlevel: { ...row } },
});

describe("provider-wide modality write admission", () => {
  test.each(malformed.map((value, index) => ({ value, index })))("schema rejects malformed value $index", ({ value }) => {
    const result = providerConfigSchema.safeParse({ ...provider, inputModalities: value });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues.some(issue => issue.path[0] === "inputModalities")).toBe(true);
  });

  test.each(malformed.map((value, index) => ({ value, index })))("management rejects malformed value $index", ({ value }) => {
    expect(providerManagementConfigError("aistupidlevel", { ...provider, inputModalities: value })).toContain("inputModalities");
    const editor = providerEditorConfigDTO(config());
    const next = structuredClone(editor);
    (next.providers.aistupidlevel as Record<string, unknown>).inputModalities = value;
    // DTO parsing checks field ownership; the write route validates the parsed provider.
    const parsed = parseProviderEditorConfigDTO(next);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(providerManagementConfigError("aistupidlevel", parsed.value.providers.aistupidlevel)).toContain("inputModalities");
  });

  test("omission and every supported modality remain valid, with editor round-trip", () => {
    for (const inputModalities of [undefined, ["text"], ["image"], ["audio"], ["video"], ["text", "image", "audio", "video"]]) {
      const row = { ...provider, ...(inputModalities ? { inputModalities } : {}) };
      expect(providerConfigSchema.safeParse(row).success).toBe(true);
      expect(providerManagementConfigError("aistupidlevel", row)).toBeNull();
      const dto = providerEditorConfigDTO(config(row));
      expect(dto.providers.aistupidlevel?.inputModalities).toEqual(inputModalities);
      expect(parseProviderEditorConfigDTO(dto).ok).toBe(true);
    }
  });

  test("the editor still refuses credentials, runtime-only and unknown fields", () => {
    const dto = providerEditorConfigDTO(config({ ...provider, inputModalities: ["text"], apiKey: "fixture-key" }));
    expect(dto.providers.aistupidlevel).not.toHaveProperty("apiKey");
    for (const field of ["apiKey", "apiKeyPool", "headers", "_apiKeyAttempt", "unknownProviderField"]) {
      const next = structuredClone(dto);
      (next.providers.aistupidlevel as Record<string, unknown>)[field] = "fixture-key";
      expect(parseProviderEditorConfigDTO(next)).toMatchObject({ ok: false, code: "invalid_provider_editor_field" });
    }
  });
});

describe("tolerant modality load and management persistence", () => {
  let previousHome: string | undefined;
  let home: string;
  let codexHome: IsolatedCodexHome;
  beforeEach(() => {
    previousHome = process.env.OPENCODEX_HOME;
    home = mkdtempSync(join(tmpdir(), "ocx-provider-modalities-"));
    process.env.OPENCODEX_HOME = home;
    codexHome = installIsolatedCodexHome("ocx-provider-modalities-codex-");
  });
  afterEach(() => {
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    codexHome.restore();
    removeTreeWithRetry(home);
  });

  test.each(malformed.map((value, index) => ({ value, index })))("malformed load $index restricts to text without losing the provider", ({ value }) => {
    const raw = { ...config(), providers: { aistupidlevel: { ...provider, inputModalities: value } } };
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const repaired = structuredClone(raw);
      sanitizeCapabilityDeclarationsForLoad(repaired);
      expect(repaired.providers.aistupidlevel.inputModalities).toEqual(["text"]);
      writeFileSync(join(home, "config.json"), JSON.stringify(raw), "utf8");
      const loaded = loadConfig();
      expect(loaded.defaultProvider).toBe("aistupidlevel");
      expect(loaded.providers.aistupidlevel?.inputModalities).toEqual(["text"]);
      const routed = routedProviderConfig("aistupidlevel", loaded.providers.aistupidlevel!);
      expect(requiresVisionPreprocessing(loaded, routed, "unlisted-model", "aistupidlevel")).toBe(true);
      expect(candidateCapabilityEvidence(loaded, "aistupidlevel", "unlisted-model", routed).image).toBe(false);
      expect(warning).toHaveBeenCalled();
      expect(readFileSync(join(home, "config.json"), "utf8")).toBe(JSON.stringify(raw));
    } finally { warning.mockRestore(); }
  });

  test("valid declarations and omission survive tolerant loading", () => {
    for (const inputModalities of [undefined, ["text", "image"]]) {
      const raw = config({ ...provider, inputModalities });
      writeFileSync(join(home, "config.json"), JSON.stringify(raw), "utf8");
      expect(loadConfig().providers.aistupidlevel?.inputModalities).toEqual(inputModalities);
    }
  });

  test.each(["create", "replace", "editor"])("%s refuses malformed modalities before memory, disk, DNS or catalog changes", async mode => {
    const cfg = config();
    saveConfig(cfg);
    const before = structuredClone(cfg);
    const disk = readFileSync(join(home, "config.json"));
    const resolved = spyOn(destinationPolicy, "providerDestinationResolvedError").mockResolvedValue(null);
    let refreshes = 0;
    try {
      const baseline = providerEditorConfigDTO(cfg);
      const next = structuredClone(baseline);
      (next.providers.aistupidlevel as Record<string, unknown>).inputModalities = "image";
      const url = new URL("http://127.0.0.1/api/providers");
      const response = await handleManagementAPI(new ManagementRequest(url, {
        method: mode === "editor" ? "PUT" : "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(mode === "editor" ? { baseline, next } : {
          name: mode === "create" ? "new-provider" : "aistupidlevel", provider: { ...provider, inputModalities: "image" },
        }),
      }), url, cfg, { createManagementConvergeCodex: catalogConvergenceFactory(() => { refreshes++; }) });
      expect(response?.status).toBe(400);
      expect(await response!.json()).toMatchObject({ error: expect.stringContaining("inputModalities") });
      expect(cfg).toEqual(before);
      expect(readFileSync(join(home, "config.json"))).toEqual(disk);
      expect(resolved).not.toHaveBeenCalled();
      expect(refreshes).toBe(0);
    } finally { resolved.mockRestore(); }
  });
});

describe("runtime provider modality authority", () => {
  test("renamed fixed-key destinations retain vision eligibility without saving defaults", () => {
    for (const baseUrl of [provider.baseUrl, " https://AISTUPIDLEVEL.info:443/v1/// "]) {
      const saved = { ...provider, baseUrl };
      const cfg: OcxConfig = { port: 10100, providers: { "my-asl": saved } };
      const modalities = registryInputModalitiesForDestination("my-asl", saved);
      expect(modalities).toEqual(["text"]);
      modalities!.push("image");
      expect(registryInputModalitiesForDestination("my-asl", saved)).toEqual(["text"]);
      expect(isVisionSidecarConsumer(cfg, "my-asl", "unlisted-model")).toBe(true);
      expect(saved.inputModalities).toBeUndefined();
    }
  });

  test("renamed routed providers inherit a detached runtime modality fallback", () => {
    const saved = { ...provider, baseUrl: " https://AISTUPIDLEVEL.info:443/v1/// " };
    const routed = routedProviderConfig("my-asl", saved);
    expect(routed.inputModalities).toEqual(["text"]);
    routed.inputModalities!.push("image");
    expect(routedProviderConfig("my-asl", saved).inputModalities).toEqual(["text"]);
    expect(saved.inputModalities).toBeUndefined();
  });

  test("renamed rows reject custom destinations and retain explicit modality authority", () => {
    for (const row of [
      { ...provider, baseUrl: "https://relay.example.test/v1" },
      { ...provider, baseUrl: "https://aistupidlevel.info/another-path" },
      { ...provider, baseUrl: "https://aistupidlevel.info/v1?custom=1" },
      { ...provider, adapter: "openai-responses" as const },
      { ...provider, authMode: "oauth" as const },
    ]) {
      expect(registryInputModalitiesForDestination("my-asl", row)).toBeUndefined();
      expect(routedProviderConfig("my-asl", row).inputModalities).toBeUndefined();
      expect(isVisionSidecarConsumer({ providers: { "my-asl": row } }, "my-asl", "unlisted-model")).toBe(false);
    }
    for (const override of [
      { inputModalities: ["text", "image"] },
      { modelInputModalities: { "unlisted-model": ["text", "image"] } },
      { modelCapabilities: { "unlisted-model": { inputModalities: ["text", "image"] } } },
    ]) {
      const saved = { ...provider, ...override };
      const cfg: OcxConfig = { port: 10100, providers: { "my-asl": saved } };
      const routed = routedProviderConfig("my-asl", saved);
      if (override.inputModalities) expect(routed.inputModalities).toEqual(["text", "image"]);
      expect(isVisionSidecarConsumer(cfg, "my-asl", "unlisted-model")).toBe(false);
      expect(requiresVisionPreprocessing(cfg, routed, "unlisted-model", "my-asl")).toBe(false);
      expect(candidateCapabilityEvidence(cfg, "my-asl", "unlisted-model", routed).image).toBe(true);
    }
  });

  test("registry backfill is destination-bound, cloned, and never saved", () => {
    for (const baseUrl of [provider.baseUrl, `${provider.baseUrl}/`, " https://aistupidlevel.info/v1/ "]) {
      const saved = { ...provider, baseUrl };
      const first = routedProviderConfig("aistupidlevel", saved);
      expect(first.inputModalities).toEqual(["text"]);
      first.inputModalities!.push("image");
      expect(routedProviderConfig("aistupidlevel", saved).inputModalities).toEqual(["text"]);
      expect(saved.inputModalities).toBeUndefined();
    }
    for (const row of [
      { ...provider, baseUrl: "https://relay.example.test/v1" },
      { ...provider, baseUrl: "https://aistupidlevel.info/another-path" },
      { ...provider, adapter: "openai-responses" as const },
    ]) {
      expect(registryInputModalitiesForDestination("aistupidlevel", row)).toBeUndefined();
      expect(routedProviderConfig("aistupidlevel", row).inputModalities).toBeUndefined();
    }
    expect(routedProviderConfig("aistupidlevel", { ...provider, inputModalities: ["text", "image"] }).inputModalities)
      .toEqual(["text", "image"]);
  });

  test.each([true, false])("exact model declarations override opposing provider and legacy hints: image=$each", image => {
    const row: OcxProviderConfig = { ...provider, inputModalities: image ? ["text"] : ["text", "image"],
      modelInputModalities: { pinned: image ? ["text"] : ["text", "image"] },
      noVisionModels: image ? ["pinned"] : [],
      modelCapabilities: { pinned: { inputModalities: image ? ["text", "image"] : ["text"] } },
    };
    const cfg = config(row);
    const routed = routedProviderConfig("aistupidlevel", row);
    expect(candidateCapabilityEvidence(cfg, "aistupidlevel", "pinned", routed).image).toBe(image);
    expect(requiresVisionPreprocessing(cfg, routed, "pinned", "aistupidlevel")).toBe(!image);
  });
});
