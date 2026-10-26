import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCatalogEntries } from "../../src/codex/catalog/build-entries";
import { applyProviderConfigHints } from "../../src/codex/catalog/model-hints";
import type { CatalogModel, RawEntry } from "../../src/codex/catalog/parsing";
import type { OcxProviderConfig } from "../../src/types";
import { repoRoot } from "../helpers/repo-root";

const slug = "gateway/task-model";

/** Derive the declaration from provider policy, as live discovery does. */
function model(overrides: Partial<OcxProviderConfig> = {}): CatalogModel {
  return applyProviderConfigHints("gateway", {
    adapter: "openai-responses", baseUrl: "https://provider.invalid/v1", liveModels: false,
    models: ["task-model"], modelSupportsServiceTier: { "task-model": true },
    fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", ultrafast: "ultrafast" }, foreignCallerTiers: "verbatim" },
    ...overrides,
  }, { provider: "gateway", id: "task-model" });
}

/** Use the public builder called by GET /v1/models?client_version, without a disk merge. */
function build(models: CatalogModel[], template: RawEntry | null = null): RawEntry[] {
  return buildCatalogEntries(template, [], models);
}

describe("live Codex catalog Ultra Fast", () => {
  test("the direct builder publishes the choice without changing its default or inputs", () => {
    const models = [model()];
    const before = structuredClone(models);
    const first = build(models);
    const row = first.find(entry => entry.slug === slug)!;
    expect(row.service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "ultrafast"]);
    expect(row.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    expect(row.default_service_tier).toBeNull();
    expect(row.service_tier).toBeUndefined();
    expect(row.opencodex_managed_ultrafast).toBe(slug);
    expect(build(models)).toEqual(first);
    expect(models).toEqual(before);
  });

  test.each([
    ["ordinary Fast", { fastWire: undefined }],
    ["model opt-out", { modelSupportsServiceTier: { "task-model": false } }],
    ["wrong wire tier", { fastWire: { kind: "service-tier", canonicalToWire: { ultrafast: "priority" }, foreignCallerTiers: "verbatim" } }],
  ] as [string, Partial<OcxProviderConfig>][])("%s cannot borrow Ultra Fast from a template", (_label, override) => {
    const template = { slug: "gpt-5.5", service_tiers: [{ id: "ultrafast", name: "Stale" }], additional_speed_tiers: ["ultrafast"] };
    const row = build([model(override)], template).find(entry => entry.slug === slug)!;
    expect(row.service_tiers?.some((tier: { id: string }) => tier.id === "ultrafast") ?? false).toBe(false);
    expect(row.additional_speed_tiers ?? []).not.toContain("ultrafast");
    expect(row.opencodex_managed_ultrafast).toBeUndefined();
  });

  test.each([false, true])("conflicting duplicate declarations fail closed in either order: %s", reverse => {
    const supported = model();
    const unsupported = { ...supported, supportsUltraFastTier: false };
    const rows = build(reverse ? [unsupported, supported] : [supported, unsupported]);
    expect(rows.filter(row => row.slug === slug).length).toBeGreaterThan(0);
    for (const row of rows.filter(row => row.slug === slug)) {
      expect(row.additional_speed_tiers ?? []).not.toContain("ultrafast");
      expect(row.opencodex_managed_ultrafast).toBeUndefined();
    }
  });

  test("exact routed aliases receive the choice while combos and native/account rows keep their policy", () => {
    const supported = model();
    const combo = { ...supported, provider: "combo", id: "task-combo", alias: "friendly-combo", nativeAlias: true };
    const entries = buildCatalogEntries(null, ["gpt-6.1-sol"], [
      { ...supported, alias: "gateway/friendly" }, combo,
    ], undefined, false, "default", new Set(["friendly-combo"]), ["main"]);
    expect(entries.find(row => row.slug === "gateway/friendly")!.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
    for (const nativeSlug of ["friendly-combo", "gpt-6.1-sol", "main/gpt-6.1-sol"]) {
      const row = entries.find(entry => entry.slug === nativeSlug)!;
      expect(row).toBeDefined();
      expect(row.opencodex_managed_ultrafast).toBeUndefined();
    }
  });
});

test("the real HTTP catalog repeatedly publishes only the declared routed tier", () => {
  const root = mkdtempSync(join(tmpdir(), "ocx-ultrafast-http-"));
  const codexHome = join(root, "codex");
  const ocxHome = join(root, "ocx");
  mkdirSync(codexHome); mkdirSync(ocxHome);
  writeFileSync(join(codexHome, "config.toml"), 'model_catalog_json = "opencodex-catalog.json"\n');
  writeFileSync(join(codexHome, "opencodex-catalog.json"), JSON.stringify({ models: [
    { slug: "gpt-5.5", visibility: "list", base_instructions: "You are Codex." },
  ] }));
  writeFileSync(join(ocxHome, "config.json"), JSON.stringify({
    port: 0, hostname: "127.0.0.1", defaultProvider: "gateway", ultraFastTier: true,
    providers: { gateway: {
      adapter: "openai-responses", baseUrl: "https://provider.invalid/v1", apiKey: "fixture-key", liveModels: false,
      models: ["task-model", "ordinary-model"], modelSupportsServiceTier: { "task-model": true },
      fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", ultrafast: "ultrafast" }, foreignCallerTiers: "verbatim" },
    } },
  }));
  const script = `
    const { startServer } = require("./src/server");
    const server = startServer(0);
    const passes = [];
    try {
      for (let read = 0; read < 2; read++) {
        const response = await fetch(new URL("/v1/models?client_version=0.160.0", server.url), { signal: AbortSignal.timeout(10000) });
        if (response.status !== 200) throw new Error("HTTP status " + response.status);
        const body = await response.json();
        passes.push(body.models.filter(row => row.slug.startsWith("gateway/")));
      }
      console.log("ULTRAFAST_HTTP_RESULT=" + JSON.stringify(passes));
    } finally { await server.stop(true); }
  `;
  try {
    const result = spawnSync(process.execPath, ["--eval", script], {
      cwd: repoRoot(), env: { ...process.env, CODEX_HOME: codexHome, OPENCODEX_HOME: ocxHome },
      encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 40_000,
    });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    const receipt = result.stdout.split("\n").find(line => line.startsWith("ULTRAFAST_HTTP_RESULT="));
    expect(receipt).toBeDefined();
    const passes = JSON.parse(receipt!.slice("ULTRAFAST_HTTP_RESULT=".length)) as RawEntry[][];
    expect(passes).toHaveLength(2);
    expect(passes[1]).toEqual(passes[0]);
    for (const rows of passes) {
      const row = rows.find(entry => entry.slug === slug)!;
      expect(row).toBeDefined();
      expect(row.service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "ultrafast"]);
      expect(row.additional_speed_tiers).toEqual(["fast", "ultrafast"]);
      expect(row.default_service_tier).toBeNull();
      const ordinary = rows.find(entry => entry.slug === "gateway/ordinary-model")!;
      expect(ordinary).toBeDefined();
      expect(ordinary.additional_speed_tiers ?? []).not.toContain("ultrafast");
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 45_000);

describe("declared Flex choice on routed models", () => {
  const flexWire: OcxProviderConfig["fastWire"] = {
    kind: "service-tier",
    canonicalToWire: { priority: "priority", flex: "flex" },
    foreignCallerTiers: "verbatim",
  };

  test("advertises Flex in both live and derived catalogs only for an eligible final route", () => {
    const declared = model({ fastWire: flexWire });
    const before = structuredClone(declared);
    const row = build([declared]).find(entry => entry.slug === slug)!;
    expect(row.service_tiers.map((tier: { id: string }) => tier.id)).toEqual(["priority", "flex"]);
    expect(row.additional_speed_tiers).toEqual(["fast", "flex"]);
    expect(row.default_service_tier).toBeNull();
    expect(build([declared]).find(entry => entry.slug === slug)).toEqual(row);
    expect(declared).toEqual(before);
  });

  test("ordinary Fast, unavailable wire, and explicit model opt-out never advertise Flex", () => {
    const candidates = [
      model({ fastWire: undefined }),
      model({ fastWire: { kind: "service-tier", canonicalToWire: { priority: "priority", flex: "priority" }, foreignCallerTiers: "verbatim" } }),
      model({ fastWire: flexWire, modelSupportsServiceTier: { "task-model": false } }),
      model({ fastWire: { ...flexWire!, foreignCallerTiers: "drop" } }),
    ];
    for (const candidate of candidates) {
      const row = build([candidate]).find(entry => entry.slug === slug)!;
      expect(row.service_tiers?.some((tier: { id: string }) => tier.id === "flex") ?? false).toBe(false);
      expect(row.additional_speed_tiers ?? []).not.toContain("flex");
    }
  });

  test("a provider's declared Flex does not leak into unrelated native or combo rows", () => {
    const declared = model({ fastWire: flexWire });
    const combo = { ...declared, provider: "combo", id: "task-combo", alias: "friendly-combo", nativeAlias: true };
    const rows = buildCatalogEntries(null, ["gpt-6.1-sol"], [declared, combo], undefined, false, "default",
      new Set(["friendly-combo"]), ["main"]);
    expect(rows.find(row => row.slug === slug)!.additional_speed_tiers).toContain("flex");
    for (const id of ["friendly-combo", "gpt-6.1-sol", "main/gpt-6.1-sol"]) {
      const row = rows.find(row => row.slug === id)!;
      expect(row).toBeDefined();
      expect(row.service_tiers?.some((tier: { id: string }) => tier.id === "flex") ?? false).toBe(false);
      expect(row.additional_speed_tiers ?? []).not.toContain("flex");
    }
  });
});
