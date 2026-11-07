import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { captureCatalogAdmissionSnapshot } from "../../src/codex/catalog-admission";
import { commitCodexCatalogCandidate, gatherCodexCatalogCandidate } from "../../src/codex/convergence";
import { invalidateCodexModelsCache, resetCatalogRuntimeStateForTests, syncCatalogModels } from "../../src/codex/catalog";
import { findSupportedNativeTemplate, type RawCatalog, type RawEntry } from "../../src/codex/catalog/parsing";
import { getConfigPath, loadConfig, saveConfig } from "../../src/config";
import type { OcxConfig } from "../../src/types";
import { CODEX_FORWARD_BASE_URL } from "../../src/providers/openai-tiers";
import { startServer } from "../../src/server";
import { buildCodexModelList } from "../../src/server/codex-model-list";
import { desktopAllowlistSuppressedNativeSlugs } from "../../src/codex/catalog/metadata";
import { NATIVE_OPENAI_MODELS } from "../../src/codex/catalog/native-models";
import { CODEX_ACCOUNT_BOUND_CATALOG_KIND } from "../../src/codex/catalog/account-models";
import { omitDisabledNativeCatalogEntries } from "../../src/codex/catalog/native-omission";
import { routeModel } from "../../src/router";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import { removeTreeAfterBackgroundWork } from "../helpers/remove-tree";

let home: TempHome;
let path: string;
const SOURCE_FIELD = "opencodex_native_inheritance_template";
const native = (): RawEntry => ({
  slug: "gpt-5.5", display_name: "Native", priority: 1, visibility: "list",
  base_instructions: "Fixture native instructions", shell_type: "shell_command",
  model_messages: { instructions_template: "Fixture template" },
  input_modalities: ["text", "image"], supports_image_detail_original: true,
  experimental_supported_tools: ["fixture_tool"],
  supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
});
const config = (flag?: boolean): OcxConfig => ({
  port: 0, hostname: "127.0.0.1", defaultProvider: "fixture", subagentModels: [],
  catalogAutoRefresh: { enabled: false }, disabledModels: ["gpt-5.5"],
  ...(flag === undefined ? {} : { omitDisabledNativeModels: flag }),
  providers: {
    openai: { adapter: "openai-responses", baseUrl: CODEX_FORWARD_BASE_URL, authMode: "forward", models: ["gpt-5.5"] },
    fixture: { adapter: "openai-chat", baseUrl: "https://omit-fixture.invalid/v1", liveModels: false, models: ["model"] },
  },
});
const source = () => JSON.stringify({ fixture: "native source", models: [native()] });
const read = (): RawCatalog => JSON.parse(readFileSync(path, "utf8"));
const routed = (catalog: RawCatalog) => JSON.stringify(catalog.models?.filter(row => row.slug === "fixture/model"));
const liveList = (next: OcxConfig): RawCatalog => buildCodexModelList({
  config: next, nativeSlugs: ["gpt-5.5"], availableAccountNativeSlugs: [], accountNativeSlugs: [],
  accountNativeSlugsBySelector: new Map(), goOrdered: [{ provider: "fixture", id: "model" }],
  exactComboSlugs: new Set(), accountSelectors: [],
  suppressedBareNativeSlugs: desktopAllowlistSuppressedNativeSlugs(next),
  disabledModels: new Set(next.disabledModels),
});

beforeEach(() => {
  home = createTempHome("ocx-omit-native-");
  mkdirSync(home.codexHome);
  path = join(home.codexHome, "fixture-catalog.json");
  writeFileSync(join(home.codexHome, "config.toml"), 'model_catalog_json = "fixture-catalog.json"\n', "utf8");
  writeFileSync(path, source(), "utf8");
  resetCatalogRuntimeStateForTests();
});
afterEach(async () => {
  resetCatalogRuntimeStateForTests();
  await removeTreeAfterBackgroundWork(home.root);
  home.remove();
});

async function converge(next: OcxConfig) {
  saveConfig(next);
  const result = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(next));
  expect(result.kind).toBe("candidate");
  if (result.kind !== "candidate") throw new Error(JSON.stringify(result));
  const committed = await commitCodexCatalogCandidate(result.candidate, 1_000);
  expect(committed.kind).toBe("committed");
  return read();
}

test("default output matches the pre-option snapshot; explicit false is byte-identical", async () => {
  await converge(config());
  const baseline = readFileSync(path, "utf8");
  expect(createHash("sha256").update(baseline).digest("hex")).toMatchSnapshot();
  expect(read().models?.find(row => row.slug === "gpt-5.5")?.visibility).toBe("hide");
  expect(read()[SOURCE_FIELD]).toBeUndefined();
  writeFileSync(path, source(), "utf8");
  await converge(config(false));
  expect(readFileSync(path, "utf8")).toBe(baseline);
});

test("convergence omits disabled natives and preserves routed bytes across repeated builds", async () => {
  const off = await converge(config(false));
  writeFileSync(path, source(), "utf8");
  const on = await converge(config(true));
  expect(on.models?.some(row => row.slug === "gpt-5.5")).toBe(false);
  expect(routed(on)).toBe(routed(off));
  expect(on[SOURCE_FIELD]).toEqual(native());
  const repeated = await converge(config(true));
  expect(routed(repeated)).toBe(routed(off));
  expect(repeated.models?.some(row => row.slug === "gpt-5.5")).toBe(false);
});

test("retained sync keeps routed rows byte-identical with omission enabled", async () => {
  const off = config(false);
  saveConfig(off);
  expect((await syncCatalogModels(off, { allowWhenDesiredDisabled: true })).refreshOutcome).toBe("committed");
  const offRows = routed(read());
  const offLiveRows = routed(liveList(off));
  writeFileSync(path, source(), "utf8");
  const next = config(true);
  saveConfig(next);
  const first = await syncCatalogModels(next, { allowWhenDesiredDisabled: true });
  expect(first.refreshOutcome).toBe("committed");
  expect(read().models?.some(row => row.slug === "gpt-5.5")).toBe(false);
  expect(read()[SOURCE_FIELD]).toEqual(native());
  expect(routed(read())).toBe(offRows);
  expect(routed(liveList(next))).toBe(offLiveRows);
});

test("retained sync keeps the sole disabled template and a second sync is a no-op", async () => {
  const next = config(true);
  saveConfig(next);
  expect((await syncCatalogModels(next, { allowWhenDesiredDisabled: true })).refreshOutcome).toBe("committed");
  const firstBytes = readFileSync(path, "utf8");
  const mtime = statSync(path).mtimeMs;
  const second = await syncCatalogModels(next, { allowWhenDesiredDisabled: true });
  expect(second.refreshOutcome).toBe("committed");
  expect(second.catalogWritten).toBe(false);
  expect(readFileSync(path, "utf8")).toBe(firstBytes);
  expect(statSync(path).mtimeMs).toBe(mtime);
  expect(read()[SOURCE_FIELD]).toEqual(native());
});

test("omitting every native row keeps the only supported source through convergence", async () => {
  const next = { ...config(true), disabledModels: [...NATIVE_OPENAI_MODELS] };
  const first = await converge(next);
  expect(first.models?.map(row => row.slug)).toEqual(["fixture/model"]);
  const second = await converge(next);
  expect(routed(second)).toBe(routed(first));
  expect(second[SOURCE_FIELD]).toEqual(native());
});

test("exact selector disables omit only their native row and do not consume a combo alias", () => {
  const entries = [
    native(),
    { ...native(), slug: "first/gpt-5.5", opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND },
    { ...native(), slug: "second/gpt-5.5", opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND },
    { ...native(), slug: "gpt-5.6-sol", opencodex_catalog_kind: "combo-native-alias-v1" },
  ];
  const next = { omitDisabledNativeModels: true, disabledModels: ["first/gpt-5.5", "gpt-5.6-sol"] };
  expect(omitDisabledNativeCatalogEntries(entries, next).map(row => row.slug))
    .toEqual(["gpt-5.5", "second/gpt-5.5", "gpt-5.6-sol"]);
  expect(omitDisabledNativeCatalogEntries(entries, { ...next, disabledModels: ["gpt-5.5"] }).map(row => row.slug))
    .toEqual(["gpt-5.6-sol"]);
  expect(omitDisabledNativeCatalogEntries(entries, { ...next, omitDisabledNativeModels: false })).toBe(entries);
});

test("an omission pass that drops nothing leaves control-plane rows in place", () => {
  const entries = [
    { ...native(), slug: "gpt-5.6-sol", opencodex_catalog_kind: "combo-native-alias-v1" },
    { ...native(), slug: "codex-auto-review" },
  ];
  const next = { omitDisabledNativeModels: true, disabledModels: ["gpt-5.5"] };
  expect(omitDisabledNativeCatalogEntries(entries, next).map(row => row.slug))
    .toEqual(["gpt-5.6-sol", "codex-auto-review"]);
});

test("no supported native source keeps the existing null-template behavior", async () => {
  const unknown = { ...native(), slug: "gpt-unknown-fixture" };
  writeFileSync(path, JSON.stringify({ models: [unknown] }), "utf8");
  const off = await converge(config(false));
  writeFileSync(path, JSON.stringify({ models: [unknown] }), "utf8");
  const on = await converge(config(true));
  expect(on[SOURCE_FIELD]).toBeUndefined();
  expect(routed(on)).toBe(routed(off));
  expect(findSupportedNativeTemplate({ models: [unknown] })).toBeNull();
});

test("config loading and salvage preserve the opt-in and malformed values stay off", () => {
  for (const flag of [true, false, "true", 1, null, {}]) {
    writeFileSync(getConfigPath(), JSON.stringify({ ...config(), omitDisabledNativeModels: flag }), "utf8");
    expect((loadConfig() as OcxConfig & { omitDisabledNativeModels?: boolean }).omitDisabledNativeModels).toBe(flag === true);
  }
  writeFileSync(getConfigPath(), JSON.stringify({ ...config(true), combos: { broken: { strategy: "invalid", targets: [] } } }), "utf8");
  const salvaged = loadConfig() as OcxConfig & { omitDisabledNativeModels?: boolean };
  expect(salvaged.omitDisabledNativeModels).toBe(true);
  expect(salvaged.providers.fixture?.models).toEqual(["model"]);
});

test("retained sync and serve-options omit the same rows without changing routed bytes", async () => {
  const outputs: RawCatalog[] = [];
  for (const flag of [false, true]) {
    const next = config(flag);
    outputs.push(liveList(next));
    expect(outputs.at(-1)?.models?.some(row => row.slug === "gpt-5.5")).toBe(!flag);
  }
  expect(routed(outputs[1]!)).toBe(routed(outputs[0]!));
  const next = config(true);
  saveConfig(next);
  expect((await syncCatalogModels(next, { allowWhenDesiredDisabled: true })).refreshOutcome).toBe("committed");
  const server = startServer(0);
  try {
    const response = await fetch(new URL("/v1/models?client_version=0.160.0", server.url));
    expect(response.status).toBe(200);
    const live = await response.json() as RawCatalog;
    for (const catalog of [read(), live, JSON.parse(readFileSync(join(home.codexHome, "models_cache.json"), "utf8"))]) {
      expect(catalog.models?.some((row: RawEntry) => row.slug === "gpt-5.5")).toBe(false);
      expect(catalog.models?.find((row: RawEntry) => row.slug === "fixture/model")).toMatchObject({
        input_modalities: ["text", "image"], experimental_supported_tools: ["fixture_tool"], shell_type: "unified_exec",
      });
    }
  } finally { await server.stop(true); }
});

test("disabled native requests still use the same direct routing decision", () => {
  const destination = (next: OcxConfig) => {
    const { providerName, modelId, provider } = routeModel(next, "gpt-5.5");
    return { providerName, modelId, provider };
  };
  expect(destination(config(true))).toEqual(destination(config(false)));
  expect(destination(config(true))).toMatchObject({ providerName: "openai", modelId: "gpt-5.5" });
});

test("a retained template must pass exactly the existing supported native validation", () => {
  // Retained root validation must not soften malformed source-row failure behavior.
  expect(() => findSupportedNativeTemplate({ models: [null] as unknown as RawEntry[] })).toThrow();
  expect(findSupportedNativeTemplate({ models: [], [SOURCE_FIELD]: native() })).toEqual(native());
  for (const bad of [null, [], 5, { slug: "gpt-5.5" },
    { ...native(), slug: "gpt-unknown-fixture" }, { ...native(), slug: "fixture/gpt-5.5" },
    { ...native(), owned_by: "combo" }, { ...native(), opencodex_catalog_kind: "combo-native-alias-v1" },
    { ...native(), description: "Routed via opencodex → fixture" }]) {
    expect(findSupportedNativeTemplate({ models: [], [SOURCE_FIELD]: bad })).toBeNull();
  }
});

async function upgradedOutputs(flag: boolean, model: string, method: "convergence" | "retained sync", passCount: number) {
  // Astra's old self-authored label and a slug-labelled fallback both need native upgrades.
  const old = { ...native(), slug: model, display_name: model === "gpt-6-astra" ? "GPT-6 Astra" : model };
  writeFileSync(path, JSON.stringify({ models: [old] }), "utf8");
  resetCatalogRuntimeStateForTests();
  const next = config(flag);
  next.disabledModels = [model];
  next.providers.openai!.models = [model];
  for (let pass = 0; pass < passCount; pass++) {
    if (method === "convergence") await converge(next);
    else {
      saveConfig(next);
      expect((await syncCatalogModels(next, { allowWhenDesiredDisabled: true })).refreshOutcome).toBe("committed");
      invalidateCodexModelsCache({ allowWhenDesiredDisabled: true });
    }
  }
  const catalog = read();
  expect(catalog.models?.some(row => row.slug === model)).toBe(!flag);
  const template = flag ? catalog[SOURCE_FIELD] as RawEntry : catalog.models!.find(row => row.slug === model)!;
  if (!flag) {
    expect(template.display_name).not.toBe(old.display_name);
    expect(template.base_instructions).not.toBe(old.base_instructions);
  }
  const cache = JSON.parse(readFileSync(join(home.codexHome, "models_cache.json"), "utf8")) as RawCatalog;
  const live = liveList(next);
  const server = startServer(0);
  let http: RawCatalog;
  try {
    const response = await fetch(new URL("/v1/models?client_version=0.160.0", server.url));
    expect(response.status).toBe(200);
    http = await response.json() as RawCatalog;
  } finally { await server.stop(true); }
  for (const output of [catalog, cache, live, http]) {
    expect(output.models?.some(row => row.slug === "fixture/model")).toBe(true);
  }
  return { catalog: routed(catalog), cache: routed(cache), live: routed(live), http: routed(http), template };
}

for (const method of ["convergence", "retained sync"] as const) {
  test(`an upgraded sole source survives ${method} when every native is omitted without an orphan reviewer`, async () => {
    writeFileSync(path, JSON.stringify({ models: [{ ...native(), slug: "gpt-6-astra", display_name: "GPT-6 Astra" }] }), "utf8");
    const next = { ...config(true), disabledModels: [...NATIVE_OPENAI_MODELS] };
    if (method === "convergence") await converge(next);
    else {
      saveConfig(next);
      expect((await syncCatalogModels(next, { allowWhenDesiredDisabled: true })).refreshOutcome).toBe("committed");
    }
    expect(read().models?.map(row => row.slug)).toEqual(["fixture/model"]);
    expect((read()[SOURCE_FIELD] as RawEntry).display_name).toBe("GPT-6-Astra");
  });
}

for (const model of ["gpt-6-astra", "gpt-6-luna"]) {
  for (const method of ["convergence", "retained sync"] as const) {
    for (const passCount of [1, 2]) {
      describe(`upgraded ${model} after ${passCount} ${method} passes`, () => {
        let off: Awaited<ReturnType<typeof upgradedOutputs>>;
        // Keep each independent server lifecycle within the unchanged default test budget.
        beforeEach(async () => {
          off = await upgradedOutputs(false, model, method, passCount);
          expect(createHash("sha256").update(JSON.stringify(off)).digest("hex")).toMatchSnapshot();
        });
        test("preserves catalog, derived cache, live builder and HTTP discovery bytes", async () => {
          expect(await upgradedOutputs(true, model, method, passCount)).toEqual(off);
        });
      });
    }
  }
}
