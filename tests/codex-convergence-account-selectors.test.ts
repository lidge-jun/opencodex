import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { captureCatalogAdmissionSnapshot } from "../src/codex/catalog-admission";
import {
  CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  NATIVE_OPENAI_MODELS,
  resetCatalogRuntimeStateForTests,
  syncCatalogModels,
} from "../src/codex/catalog";
import {
  commitCodexCatalogCandidate,
  gatherCodexCatalogCandidate,
} from "../src/codex/convergence";
import type { RawCatalog, RawEntry } from "../src/codex/catalog/parsing";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { saveConfig } from "../src/config";
import { CODEX_FORWARD_BASE_URL } from "../src/providers/openai-tiers";
import type { OcxConfig } from "../src/types";

let root = "";
let codexHome = "";
let opencodexHome = "";
let catalogPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;

function nativeEntry(visibility = "list"): RawEntry {
  return {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Native",
    priority: 1,
    visibility,
    base_instructions: "You are Codex.",
    supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
  };
}

function accountEntry(selector: string): RawEntry {
  return {
    ...nativeEntry(),
    slug: `${selector}/gpt-5.6-sol`,
    display_name: `${selector} / 5.6 Sol`,
    opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  };
}

function unsupportedNativeEntry(): RawEntry {
  return {
    ...nativeEntry(),
    slug: "gpt-legacy-unsupported",
    display_name: "GPT Legacy Unsupported",
  };
}

function foreignEntry(): RawEntry {
  return {
    slug: "external/vendor-model",
    display_name: "External model",
    description: "Managed by another catalog tool.",
    priority: 50,
    visibility: "list",
    base_instructions: "You are an external model.",
  };
}

function foreignBareNativeEntry(): RawEntry {
  return {
    ...nativeEntry(),
    slug: "user-native",
    display_name: "User native",
    description: "Managed by another catalog tool.",
  };
}

function nativeMetadataEntry(
  slug: "gpt-5.5" | "gpt-5.4",
  baseInstructions: string,
  priority: number,
): RawEntry {
  return {
    slug,
    display_name: slug === "gpt-5.5" ? "GPT-5.5 Live" : "GPT-5.4 Live",
    description: `${slug} installed metadata`,
    priority,
    visibility: "list",
    base_instructions: baseInstructions,
    supported_reasoning_levels: [{ effort: "medium", description: `${slug} medium` }],
  };
}

function config(pickerEnabled: boolean, disabledModels: string[] = []): OcxConfig {
  return {
    port: 10100,
    providers: {
      openai: {
        adapter: "openai-responses",
        baseUrl: CODEX_FORWARD_BASE_URL,
        authMode: "forward",
      },
    },
    defaultProvider: "openai",
    codexAccounts: [{ id: "side-account-id", email: "side@example.test", isMain: false }],
    codexAccountNamespaces: {
      desktop: "@main",
      team: "side-account-id",
    },
    codexAccountPickerEnabled: pickerEnabled,
    disabledModels,
  };
}

function writeCatalog(models: RawEntry[]): void {
  writeFileSync(catalogPath, `${JSON.stringify({ models }, null, 2)}\n`);
}

async function convergeCatalog(nextConfig: OcxConfig): Promise<RawCatalog> {
  saveConfig(nextConfig);
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(nextConfig));
  expect(gathered.kind).toBe("candidate");
  if (gathered.kind !== "candidate") throw new Error("expected a catalog candidate");
  expect((await commitCodexCatalogCandidate(gathered.candidate, 1_000)).kind).toBe("committed");
  return JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog;
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-convergence-accounts-")));
  codexHome = join(root, "codex");
  opencodexHome = join(root, "opencodex");
  catalogPath = join(codexHome, "opencodex-catalog.json");
  mkdirSync(codexHome);
  mkdirSync(opencodexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  resetCatalogRuntimeStateForTests();
});

afterEach(() => {
  const identity = resolveEffectiveUserIdentity();
  const serializationDb = resolveCodexCatalogSerializationDatabasePath(identity, codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${serializationDb}${suffix}`, { force: true });
  }
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  rmSync(root, { recursive: true, force: true });
});

test("convergence renders account-qualified rows and preserves only non-generated foreign rows", async () => {
  writeCatalog([
    nativeEntry(),
    accountEntry("stale-selector"),
    foreignEntry(),
    {
      ...foreignEntry(),
      slug: "removed-provider/ghost",
      description: "Routed via opencodex → removed-provider (removed-provider).",
    },
  ]);

  const catalog = await convergeCatalog(config(true, ["team/gpt-5.6-sol"]));
  const models = catalog.models ?? [];

  expect(models.find(entry => entry.slug === "gpt-5.6-sol")?.visibility).toBe("hide");
  expect(models.find(entry => entry.slug === "desktop/gpt-5.6-sol")).toMatchObject({
    display_name: "desktop / 5.6 Sol",
    visibility: "list",
    opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  });
  expect(models.find(entry => entry.slug === "team/gpt-5.6-sol")).toMatchObject({
    display_name: "team / 5.6 Sol",
    visibility: "hide",
    opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
  });
  expect(models.some(entry => entry.slug === "stale-selector/gpt-5.6-sol")).toBe(false);
  expect(models.some(entry => entry.slug === "external/vendor-model")).toBe(true);
  expect(models.some(entry => entry.slug === "removed-provider/ghost")).toBe(false);
});

test("disabling the picker removes generated rows, restores bare rows, and retains foreign rows", async () => {
  writeCatalog([
    nativeEntry("hide"),
    accountEntry("desktop"),
    accountEntry("team"),
    foreignEntry(),
  ]);

  const catalog = await convergeCatalog(config(false));
  const models = catalog.models ?? [];

  expect(models.find(entry => entry.slug === "gpt-5.6-sol")?.visibility).toBe("list");
  expect(models.some(entry => entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND)).toBe(false);
  expect(models.some(entry => entry.slug === "external/vendor-model")).toBe(true);
});

test("convergence drops unsupported bare native rows and never qualifies them", async () => {
  writeCatalog([
    nativeEntry(),
    unsupportedNativeEntry(),
  ]);

  const catalog = await convergeCatalog(config(true));
  const models = catalog.models ?? [];

  expect(models.some(entry => entry.slug === "gpt-legacy-unsupported")).toBe(false);
  expect(models.some(entry => entry.slug === "desktop/gpt-legacy-unsupported")).toBe(false);
  expect(models.some(entry => entry.slug === "team/gpt-legacy-unsupported")).toBe(false);
  expect(models
    .filter(entry => entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND)
    .every(entry => (
      typeof entry.slug === "string" && !entry.slug.endsWith("/gpt-legacy-unsupported")
    ))).toBe(true);
});

test("convergence preserves unrelated foreign rows alongside fresh configured provider rows", async () => {
  writeCatalog([
    nativeEntry(),
    foreignEntry(),
  ]);
  const nextConfig = config(true);
  nextConfig.providers.static = {
    adapter: "openai-chat",
    baseUrl: "https://static.example.test/v1",
    liveModels: false,
    models: ["fresh-model"],
  };

  const catalog = await convergeCatalog(nextConfig);
  const models = catalog.models ?? [];

  expect(models.some(entry => entry.slug === "static/fresh-model")).toBe(true);
  expect(models.some(entry => entry.slug === "external/vendor-model")).toBe(true);
});

test("generated account rows silently win freshly gathered provider collisions", async () => {
  writeCatalog([nativeEntry()]);
  const nextConfig = config(true);
  nextConfig.providers.team = {
    adapter: "openai-chat",
    baseUrl: "https://team.example.test/v1",
    liveModels: false,
    models: ["gpt-5.6-sol"],
  };
  const warn = spyOn(console, "warn").mockImplementation(() => {});

  try {
    const catalog = await convergeCatalog(nextConfig);
    const collisions = (catalog.models ?? [])
      .filter(entry => entry.slug === "team/gpt-5.6-sol");

    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      display_name: "team / 5.6 Sol",
      opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    });
    expect(warn.mock.calls.some(args => (
      args.some(value => String(value).includes("account selector collision"))
    ))).toBe(false);
  } finally {
    warn.mockRestore();
  }
});

test("qualified rows retain the matching installed metadata for each native model", async () => {
  const gpt55Instructions = "Installed instructions unique to GPT-5.5.";
  const gpt54Instructions = "Installed instructions unique to GPT-5.4.";
  writeCatalog([
    nativeMetadataEntry("gpt-5.5", gpt55Instructions, 3),
    nativeMetadataEntry("gpt-5.4", gpt54Instructions, 4),
  ]);

  const catalog = await convergeCatalog(config(true));
  const models = catalog.models ?? [];

  expect(models.find(entry => entry.slug === "gpt-5.5")?.base_instructions).toBe(gpt55Instructions);
  expect(models.find(entry => entry.slug === "gpt-5.4")?.base_instructions).toBe(gpt54Instructions);
  expect(models.find(entry => entry.slug === "team/gpt-5.5")?.base_instructions).toBe(gpt55Instructions);
  expect(models.find(entry => entry.slug === "team/gpt-5.4")?.base_instructions).toBe(gpt54Instructions);
});

test("a missing supported native is backfilled and restored when the picker is disabled", async () => {
  writeCatalog([nativeEntry()]);

  const enabled = await convergeCatalog(config(true));
  expect(enabled.models?.find(entry => entry.slug === "gpt-5.5")?.visibility).toBe("hide");
  expect(enabled.models?.find(entry => entry.slug === "team/gpt-5.5")?.visibility).toBe("list");

  const disabled = await convergeCatalog(config(false));
  expect(disabled.models?.find(entry => entry.slug === "gpt-5.5")?.visibility).toBe("list");
  expect(disabled.models?.some(entry => (
    entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND
  ))).toBe(false);
});

test("retained sync and convergence produce identical canonical bytes in either order", async () => {
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  const nextConfig = config(false);
  const seed = (): void => {
    writeCatalog([
      nativeEntry(),
      unsupportedNativeEntry(),
      foreignBareNativeEntry(),
    ]);
  };
  const readBytes = (): string => readFileSync(catalogPath, "utf8");
  const expectCanonicalContent = (bytes: string): void => {
    const slugs = (JSON.parse(bytes) as RawCatalog).models
      ?.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []) ?? [];
    for (const slug of NATIVE_OPENAI_MODELS) expect(slugs).toContain(slug);
    expect(slugs).not.toContain("gpt-legacy-unsupported");
    expect(slugs).toContain("user-native");
  };

  seed();
  await convergeCatalog(nextConfig);
  const convergenceFirst = readBytes();
  expectCanonicalContent(convergenceFirst);
  expect((await syncCatalogModels(nextConfig)).catalogWritten).toBe(true);
  expect(readBytes()).toBe(convergenceFirst);

  seed();
  expect((await syncCatalogModels(nextConfig)).catalogWritten).toBe(true);
  const retainedFirst = readBytes();
  expectCanonicalContent(retainedFirst);
  expect(retainedFirst).toBe(convergenceFirst);
  await convergeCatalog(nextConfig);
  expect(readBytes()).toBe(retainedFirst);
});
