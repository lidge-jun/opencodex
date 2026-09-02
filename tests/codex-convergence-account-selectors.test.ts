import { afterEach, beforeEach, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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
  loadBundledCodexCatalog,
  NATIVE_OPENAI_MODELS,
  resetCatalogRuntimeStateForTests,
  syncCatalogModels,
} from "../src/codex/catalog";
import {
  commitCodexCatalogCandidate,
  convergeCodexCatalog,
  gatherCodexCatalogCandidate,
} from "../src/codex/convergence";
import {
  catalogBackupPathFor,
  type RawCatalog,
  type RawEntry,
} from "../src/codex/catalog/parsing";
import {
  resolveCodexCatalogSerializationDatabasePath,
  resolveEffectiveUserIdentity,
} from "../src/codex/user-identity";
import { getConfigPath, saveConfig } from "../src/config";
import { CODEX_FORWARD_BASE_URL } from "../src/providers/openai-tiers";
import type { OcxConfig } from "../src/types";
import { setBundledCatalogCacheForTests } from "../src/codex/catalog/bundled";
import {
  resetCodexRuntimeResolveCacheForTests,
  setCodexRuntimeResolveCacheForTests,
} from "../src/codex/runtime";
import { markModelsFetchFailure } from "../src/codex/model-cache";
import { legacyCustomModelCatalogSlugs } from "../src/codex/custom-model-catalog-migration";
import { resetCodexModelEntitlementCacheForTests } from "../src/codex/model-entitlements";
import { ACCOUNT_GATED_NATIVE_OPENAI_MODELS } from "../src/codex/catalog/native-models";
import { removeCodexAccountCredential, saveCodexAccountCredential } from "../src/codex/account-store";
import { removeTreeWithRetry } from "./helpers/remove-tree";

// The canonical-bytes case spawns real syncs and runs ~2.5s in isolation, on this
// tree and on a clean baseline alike. That is half of bun's 5s default, but full
// 680-file parallelism has pushed it past the line (observed 5709ms), which reads
// as a failure rather than the scheduling flake it is. Same remedy the heavier
// management suites already use.
setDefaultTimeout(30_000);

let root = "";
let codexHome = "";
let opencodexHome = "";
let catalogPath = "";
let previousCodexHome: string | undefined;
let previousOpencodexHome: string | undefined;
let previousCodexCliPath: string | undefined;
let previousFetch: typeof fetch;
let modelRostersByChatgptAccount: Map<string, readonly string[]>;

const GPT56_NATIVE_MODELS = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;

function grantGpt56NativeModels(...chatgptAccountIds: string[]): void {
  for (const accountId of chatgptAccountIds) {
    modelRostersByChatgptAccount.set(accountId, GPT56_NATIVE_MODELS);
  }
}

function nativeEntry(visibility = "list"): RawEntry {
  return {
    slug: "gpt-5.6-sol",
    display_name: "GPT-5.6-Sol",
    description: "Native",
    priority: 1,
    visibility,
    shell_type: "shell_command",
    comp_hash: "native-comp-hash",
    model_messages: { instructions_template: "You are Codex." },
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

function generatedRoutedEntry(slug: string, marker?: string): RawEntry {
  const provider = slug.slice(0, slug.indexOf("/"));
  return {
    ...nativeEntry(),
    slug,
    display_name: slug,
    description: `Routed via opencodex → ${provider} (${provider}).`,
    owned_by: provider,
    ...(marker ? { test_marker: marker } : {}),
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
    codexAccounts: [{
      id: "side-account-id",
      email: "side@example.test",
      alias: "Private Side Account",
      isMain: false,
    }],
    codexAccountNamespaces: {
      desktop: "@main",
      team: "side-account-id",
    },
    codexAccountPickerEnabled: pickerEnabled,
    disabledModels,
  };
}

function autoReviewConfig(models: string[]): OcxConfig {
  const nextConfig = config(false);
  nextConfig.providers.static = {
    adapter: "openai-chat",
    baseUrl: "https://static.example.test/v1",
    liveModels: false,
    models,
  };
  return nextConfig;
}

function writeAutoReviewModel(value?: string): void {
  writeFileSync(
    join(codexHome, "config.toml"),
    value === undefined ? "" : `auto_review_model = ${JSON.stringify(value)}\n`,
  );
}

function autoReviewSeed(routeOverride: string | null = "stale-override"): RawEntry[] {
  return [
    { ...nativeEntry(), slug: "gpt-5.4", auto_review_model_override: "native-upstream" },
    {
      ...generatedRoutedEntry("static/deepseek-v4-flash"),
      auto_review_model_override: routeOverride,
    },
  ];
}

function writeCatalog(models: RawEntry[]): void {
  writeFileSync(catalogPath, `${JSON.stringify({ models }, null, 2)}\n`);
}

function seedObservedRuntimeSupport(efforts = ["low", "medium", "high", "xhigh"]): void {
  rmSync(join(opencodexHome, "codex-runtime.json"), { force: true });
  const runtime = {
    command: "/tmp/codex",
    version: "0.145.0",
    source: "fallback" as const,
  };
  setCodexRuntimeResolveCacheForTests(
    { runtime, failures: [] },
    { discoverAlternatives: false },
  );
  setBundledCatalogCacheForTests(runtime, {
    models: [{
      ...nativeMetadataEntry("gpt-5.5", "Bundled runtime instructions.", 9),
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
      default_reasoning_level: "medium",
    }],
  });
}

function createCodexRuntimeFixture(efforts = ["low", "medium", "high", "xhigh"]): string {
  const scriptPath = join(root, "codex-runtime-fixture.js");
  const bundled = JSON.stringify({
    models: [{
      ...nativeMetadataEntry("gpt-5.5", "Fixture runtime instructions.", 9),
      supported_reasoning_levels: efforts.map(effort => ({ effort, description: effort })),
      default_reasoning_level: "medium",
    }],
  });
  writeFileSync(scriptPath, [
    'if (process.argv.includes("--version")) {',
    '  console.log("codex-cli 0.145.0");',
    '} else {',
    `  process.stdout.write(${JSON.stringify(bundled)});`,
    '}',
  ].join("\n"));

  if (process.platform === "win32") {
    const commandPath = join(root, "codex-runtime-fixture.cmd");
    writeFileSync(commandPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
    return commandPath;
  }

  const commandPath = join(root, "codex-runtime-fixture");
  writeFileSync(commandPath, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`);
  chmodSync(commandPath, 0o755);
  return commandPath;
}

function primeCodexRuntimeFixture(): void {
  process.env.CODEX_CLI_PATH = createCodexRuntimeFixture();
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetCodexModelEntitlementCacheForTests();
  expect(loadBundledCodexCatalog()?.models?.[0]?.slug).toBe("gpt-5.5");
}

async function convergeCatalog(nextConfig: OcxConfig): Promise<RawCatalog> {
  saveConfig(nextConfig);
  const gathered = await gatherCodexCatalogCandidate(captureCatalogAdmissionSnapshot(nextConfig));
  expect(gathered.kind).toBe("candidate");
  if (gathered.kind !== "candidate") throw new Error("expected a catalog candidate");
  expect((await commitCodexCatalogCandidate(gathered.candidate, 1_000)).kind).toBe("committed");
  return JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog;
}

async function convergeCatalogDisposition(nextConfig: OcxConfig) {
  saveConfig(nextConfig);
  return (await convergeCodexCatalog(
    captureCatalogAdmissionSnapshot(nextConfig),
    {
      action: "converge",
      scope: "catalog",
      reason: "management-mutation",
      mode: "explicit",
      deadlineMs: 1_000,
    },
  )).catalogRefresh;
}

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  previousOpencodexHome = process.env.OPENCODEX_HOME;
  previousCodexCliPath = process.env.CODEX_CLI_PATH;
  root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-convergence-accounts-")));
  codexHome = join(root, "codex");
  opencodexHome = join(root, "opencodex");
  catalogPath = join(codexHome, "opencodex-catalog.json");
  mkdirSync(codexHome);
  mkdirSync(opencodexHome);
  process.env.CODEX_HOME = codexHome;
  process.env.OPENCODEX_HOME = opencodexHome;
  previousFetch = globalThis.fetch;
  modelRostersByChatgptAccount = new Map();
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-token", account_id: "main-chatgpt-account" },
  }));
  saveCodexAccountCredential("side-account-id", {
    accessToken: "side-token",
    refreshToken: "side-refresh",
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: "side-chatgpt-account",
  });
  globalThis.fetch = (async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input : input.url);
    if (url.hostname === "chatgpt.com" && url.pathname.endsWith("/models")) {
      const accountId = new Headers(init?.headers).get("chatgpt-account-id") ?? "";
      return Response.json({
        models: (modelRostersByChatgptAccount.get(accountId) ?? []).map(slug => ({
          slug,
          supported_in_api: true,
          visibility: "list",
        })),
      });
    }
    return previousFetch(input, init);
  }) as typeof fetch;
  resetCatalogRuntimeStateForTests();
  resetCodexRuntimeResolveCacheForTests();
  resetCodexModelEntitlementCacheForTests();
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  const identity = resolveEffectiveUserIdentity();
  const serializationDb = resolveCodexCatalogSerializationDatabasePath(identity, codexHome);
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    rmSync(`${serializationDb}${suffix}`, { force: true });
  }
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  if (previousOpencodexHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousOpencodexHome;
  if (previousCodexCliPath === undefined) delete process.env.CODEX_CLI_PATH;
  else process.env.CODEX_CLI_PATH = previousCodexCliPath;
  resetCodexRuntimeResolveCacheForTests();
  removeTreeWithRetry(root);
});

test("convergence renders account-qualified rows and preserves only non-generated foreign rows", async () => {
  grantGpt56NativeModels("main-chatgpt-account", "side-chatgpt-account");
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

  const serializedCatalog = JSON.stringify(catalog);
  const serializedCache = readFileSync(join(codexHome, "models_cache.json"), "utf8");
  expect((JSON.parse(serializedCache) as { models?: RawEntry[] }).models).toEqual(models);
  for (const privateValue of ["side-account-id", "side@example.test", "Private Side Account"]) {
    expect(serializedCatalog).not.toContain(privateValue);
    expect(serializedCache).not.toContain(privateValue);
  }
});

test("convergence preserves one configured soft budget on bare and account-native rows", async () => {
  grantGpt56NativeModels("main-chatgpt-account", "side-chatgpt-account");
  writeCatalog([nativeEntry()]);
  const nextConfig = config(true);
  nextConfig.providers.openai!.modelAutoCompactTokenLimits = { "gpt-5.6-sol": 120_000 };

  const models = (await convergeCatalog(nextConfig)).models ?? [];
  for (const slug of ["gpt-5.6-sol", "desktop/gpt-5.6-sol", "team/gpt-5.6-sol"]) {
    expect(models.find(entry => entry.slug === slug)).toMatchObject({
      context_window: 272_000,
      max_context_window: 272_000,
      auto_compact_token_limit: 120_000,
    });
  }
});

test("disabling the picker removes generated rows, restores bare rows, and retains foreign rows", async () => {
  grantGpt56NativeModels("main-chatgpt-account", "side-chatgpt-account");
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

test("convergence projects the observed Daybreak row onto its selector and one bare row", async () => {
  writeCatalog([nativeEntry()]);
  removeCodexAccountCredential("side-account-id");
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-token", account_id: "main-chatgpt-account" },
  }));
  writeFileSync(join(codexHome, "models_cache.json"), JSON.stringify({
    models: [{
      slug: "gpt-daybreak-blue-latest",
      visibility: "hide",
      supported_in_api: true,
      shell_type: "shell_command",
      comp_hash: "native-comp-hash",
      model_messages: { instructions_template: "You are Codex." },
      base_instructions: "You are Codex.",
      supported_reasoning_levels: [{ effort: "medium", description: "Medium" }],
      opencodex_account_observed_native: true,
    }],
  }, null, 2) + "\n");

  modelRostersByChatgptAccount.set("main-chatgpt-account", ["gpt-daybreak-blue-latest"]);
  const catalog = await convergeCatalog(config(true));
  const models = catalog.models ?? [];
  const daybreak = models.find(entry => entry.slug === "desktop/gpt-daybreak-blue-latest");
  expect(daybreak).toMatchObject({
    visibility: "list",
    opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
    context_window: 272_000,
    max_context_window: 272_000,
    auto_compact_token_limit: 244_800,
    comp_hash: "3000",
    tool_mode: "code_mode_only",
    use_responses_lite: true,
    supports_parallel_tool_calls: true,
    multi_agent_version: "v2",
  });
  expect((daybreak?.supported_reasoning_levels as Array<{ effort: string }>).map(level => level.effort))
    .toEqual(["low", "medium", "high", "xhigh", "max", "ultra"]);
  // Main's authenticated roster confirms Daybreak, so the bare row and main selector exist.
  // The side account has no confirmed grant and must not receive a selector row.
  expect(models.filter(entry => entry.slug === "team/gpt-daybreak-blue-latest")).toHaveLength(0);
  expect(models.filter(entry => entry.slug === "desktop/gpt-daybreak-blue-latest")).toHaveLength(1);
  expect(models.filter(entry => entry.slug === "gpt-daybreak-blue-latest")).toHaveLength(1);
});

test("Direct convergence does not borrow a Pool-only Daybreak grant for the bare row", async () => {
  writeCatalog([nativeEntry()]);
  writeFileSync(join(codexHome, "auth.json"), JSON.stringify({
    tokens: { access_token: "main-token", account_id: "main-chatgpt-account" },
  }));
  saveCodexAccountCredential("side-account-id", {
    accessToken: "side-token",
    refreshToken: "side-refresh",
    expiresAt: Date.now() + 5 * 60_000,
    chatgptAccountId: "side-chatgpt-account",
  });

  modelRostersByChatgptAccount.set("main-chatgpt-account", ["gpt-5.6-sol"]);
  modelRostersByChatgptAccount.set(
    "side-chatgpt-account",
    ["gpt-5.6-sol", "gpt-daybreak-blue-latest"],
  );
  const directConfig = config(true);
  directConfig.providers.openai!.codexAccountMode = "direct";
  const catalog = await convergeCatalog(directConfig);
  const models = catalog.models ?? [];

  expect(models.filter(entry => entry.slug === "gpt-daybreak-blue-latest")).toHaveLength(0);
  expect(models.filter(entry => entry.slug === "desktop/gpt-daybreak-blue-latest")).toHaveLength(0);
  expect(models.filter(entry => entry.slug === "team/gpt-daybreak-blue-latest")).toHaveLength(1);
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

test("convergence preserves only provider-local degraded rows", async () => {
  writeCatalog([
    nativeEntry(),
    generatedRoutedEntry("offline/old-live"),
    generatedRoutedEntry("offline/fallback", "stale-copy"),
    generatedRoutedEntry("fresh/stale"),
    generatedRoutedEntry("empty/stale"),
    generatedRoutedEntry("removed/ghost"),
    foreignEntry(),
  ]);
  const nextConfig = config(false);
  nextConfig.providers.offline = {
    adapter: "openai-chat",
    baseUrl: "https://offline.example.test/v1",
    authMode: "oauth",
    models: ["fallback"],
  };
  nextConfig.providers.fresh = {
    adapter: "openai-chat",
    baseUrl: "https://fresh.example.test/v1",
    liveModels: false,
    models: ["current"],
  };
  nextConfig.providers.empty = {
    adapter: "openai-chat",
    baseUrl: "https://empty.example.test/v1",
    liveModels: false,
    models: [],
  };

  const models = (await convergeCatalog(nextConfig)).models ?? [];

  expect(models.some(entry => entry.slug === "offline/old-live")).toBe(true);
  expect(models.filter(entry => entry.slug === "offline/fallback")).toHaveLength(1);
  expect(models.find(entry => entry.slug === "offline/fallback")).not.toHaveProperty("test_marker");
  expect(models.some(entry => entry.slug === "fresh/current")).toBe(true);
  expect(models.some(entry => entry.slug === "fresh/stale")).toBe(false);
  expect(models.some(entry => entry.slug === "empty/stale")).toBe(false);
  expect(models.some(entry => entry.slug === "removed/ghost")).toBe(false);
  expect(models.some(entry => entry.slug === "external/vendor-model")).toBe(true);
});

function legacyCustomDeletionConfig(): OcxConfig {
  const nextConfig = config(false);
  nextConfig.providers.offline = {
    adapter: "openai-chat",
    baseUrl: "https://offline.example.test/v1",
    authMode: "oauth",
    models: ["fallback"],
  };
  nextConfig.customModels = [{
    id: "legacy-custom-id",
    provider: "offline",
    modelId: "my-model",
    addedAt: "2026-08-01T00:00:00.000Z",
  }];
  return nextConfig;
}

test("convergence removes a deleted pre-marker custom row while discovery is degraded", async () => {
  const withCustom = legacyCustomDeletionConfig();
  writeFileSync(getConfigPath(), `${JSON.stringify(withCustom, null, 2)}\n`);
  writeCatalog([
    nativeEntry(),
    generatedRoutedEntry("offline/my-model"),
    generatedRoutedEntry("offline/discovered-sibling"),
  ]);

  const afterDeletion = structuredClone(withCustom);
  delete afterDeletion.customModels;
  const models = (await convergeCatalog(afterDeletion)).models ?? [];

  expect(legacyCustomModelCatalogSlugs(afterDeletion)).toEqual(
    new Set(["offline/my-model"]),
  );
  expect(models.some(entry => entry.slug === "offline/my-model")).toBe(false);
  expect(models.some(entry => entry.slug === "offline/discovered-sibling")).toBe(true);
});

test("retained sync removes a deleted pre-marker custom row while discovery is degraded", async () => {
  const withCustom = legacyCustomDeletionConfig();
  writeFileSync(getConfigPath(), `${JSON.stringify(withCustom, null, 2)}\n`);
  writeCatalog([
    nativeEntry(),
    generatedRoutedEntry("offline/my-model"),
    generatedRoutedEntry("offline/discovered-sibling"),
  ]);

  const afterDeletion = structuredClone(withCustom);
  delete afterDeletion.customModels;
  saveConfig(afterDeletion);
  const result = await syncCatalogModels(afterDeletion);
  const models = (JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog).models ?? [];

  expect(result.catalogWritten).toBe(true);
  expect(legacyCustomModelCatalogSlugs(afterDeletion)).toEqual(
    new Set(["offline/my-model"]),
  );
  expect(models.some(entry => entry.slug === "offline/my-model")).toBe(false);
  expect(models.some(entry => entry.slug === "offline/discovered-sibling")).toBe(true);
});

test("retained and convergence writers resolve, clear, reject, and recover auto-review selectors", async () => {
  primeCodexRuntimeFixture();

  for (const writer of ["retained", "convergence"] as const) {
    const write = async (nextConfig: OcxConfig): Promise<RawCatalog> => {
      if (writer === "retained") {
        const result = await syncCatalogModels(nextConfig);
        expect(result.catalogWritten).toBe(true);
      } else {
        const disposition = await convergeCatalogDisposition(nextConfig);
        expect(disposition).toMatchObject({ status: "committed" });
      }
      return JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog;
    };

    // A configured selector is resolved against the final catalog and trimmed before stamping.
    writeAutoReviewModel("  static/deepseek-v4-flash  ");
    writeCatalog(autoReviewSeed());
    let catalog = await write(autoReviewConfig(["deepseek-v4-flash"]));
    expect(catalog.models?.find(entry => entry.slug === "static/deepseek-v4-flash"))
      .toHaveProperty("auto_review_model_override", "static/deepseek-v4-flash");

    // Clearing the root key removes stale routed state while preserving an upstream native value.
    writeAutoReviewModel();
    writeCatalog(autoReviewSeed());
    catalog = await write(autoReviewConfig(["deepseek-v4-flash"]));
    expect(catalog.models?.find(entry => entry.slug === "gpt-5.4"))
      .toHaveProperty("auto_review_model_override", "native-upstream");
    expect(catalog.models?.find(entry => entry.slug === "static/deepseek-v4-flash"))
      .toHaveProperty("auto_review_model_override", null);

    // A syntactically valid but missing selector is diagnosed and cannot persist a dead override.
    writeAutoReviewModel("static/missing-model");
    writeCatalog(autoReviewSeed());
    const unresolvedWarning = spyOn(console, "warn").mockImplementation(() => {});
    let unresolvedWarningCalls: unknown[][] = [];
    try {
      catalog = await write(autoReviewConfig(["deepseek-v4-flash"]));
      unresolvedWarningCalls = unresolvedWarning.mock.calls;
    } finally {
      unresolvedWarning.mockRestore();
    }
    expect(unresolvedWarningCalls.some(call => String(call[0]).includes("not found in the final catalog"))).toBe(true);
    expect(catalog.models?.find(entry => entry.slug === "static/deepseek-v4-flash"))
      .toHaveProperty("auto_review_model_override", null);

    // Removing the configured model from the provider makes the target unresolved; recovery
    // must stamp it again once the model is advertised by the next catalog.
    writeAutoReviewModel("static/deepseek-v4-flash");
    writeCatalog(autoReviewSeed());
    const removedWarning = spyOn(console, "warn").mockImplementation(() => {});
    let removedWarningCalls: unknown[][] = [];
    try {
      catalog = await write(autoReviewConfig([]));
      removedWarningCalls = removedWarning.mock.calls;
    } finally {
      removedWarning.mockRestore();
    }
    expect(removedWarningCalls.some(call => String(call[0]).includes("not found in the final catalog"))).toBe(true);
    expect(catalog.models?.find(entry => entry.slug === "static/deepseek-v4-flash")).toBeUndefined();

    writeAutoReviewModel("static/deepseek-v4-flash");
    writeCatalog(autoReviewSeed(null));
    catalog = await write(autoReviewConfig(["deepseek-v4-flash"]));
    expect(catalog.models?.find(entry => entry.slug === "static/deepseek-v4-flash"))
      .toHaveProperty("auto_review_model_override", "static/deepseek-v4-flash");
  }
});

test("degraded preservation still honors explicit routed visibility policy", async () => {
  writeCatalog([
    nativeEntry(),
    generatedRoutedEntry("offline/allowed-old"),
    generatedRoutedEntry("offline/disabled-old"),
    generatedRoutedEntry("offline/unselected-old"),
  ]);
  const nextConfig = config(false, ["offline/disabled-old"]);
  nextConfig.providers.offline = {
    adapter: "openai-chat",
    baseUrl: "https://offline.example.test/v1",
    authMode: "oauth",
    models: [],
    selectedModels: ["allowed-old", "disabled-old"],
  };

  const models = (await convergeCatalog(nextConfig)).models ?? [];

  expect(models.some(entry => entry.slug === "offline/allowed-old")).toBe(true);
  expect(models.some(entry => entry.slug === "offline/disabled-old")).toBe(false);
  expect(models.some(entry => entry.slug === "offline/unselected-old")).toBe(false);
});

  test("custom-catalog convergence reports network degradation without a fallback notice", async () => {
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  primeCodexRuntimeFixture();
  writeCatalog([nativeEntry(), generatedRoutedEntry("offline/old-live")]);
  const nextConfig = config(false);
  nextConfig.codexAccounts = [];
  nextConfig.codexAccountNamespaces = {};
  rmSync(join(codexHome, "auth.json"), { force: true });
  nextConfig.providers.offline = {
    adapter: "openai-chat",
    baseUrl: "https://offline.example.test/v1",
    authMode: "key",
    apiKey: "fixture-key",
    allowPrivateNetwork: true,
    models: ["fallback"],
  };
  markModelsFetchFailure("offline");
  const fetchSpy = spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("{}", { status: 503 }));
  try {
    const disposition = await convergeCatalogDisposition(nextConfig);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(disposition).toMatchObject({
      status: "committed",
      degraded: true,
      notices: ["provider-network"],
    });
  } finally {
    fetchSpy.mockRestore();
  }
});

test("routed-only custom catalogs remain authoritative across convergence and retained sync", async () => {
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  primeCodexRuntimeFixture();
  writeFileSync(catalogPath, `${JSON.stringify({
    root_marker: "active-custom",
    models: [generatedRoutedEntry("static/old")],
  }, null, 2)}\n`);
  const nextConfig: OcxConfig = {
    port: 10100,
    defaultProvider: "static",
    providers: {
      static: {
        adapter: "openai-chat",
        baseUrl: "https://static.example.test/v1",
        liveModels: false,
        models: ["fresh"],
      },
    },
  };

  const first = await convergeCatalogDisposition(nextConfig);
  expect(first).toMatchObject({ status: "committed", notices: [] });
  let catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog;
  expect(catalog.root_marker).toBe("active-custom");
  expect(catalog.models?.some(entry => entry.slug === "static/old")).toBe(false);
  expect(catalog.models?.some(entry => entry.slug === "static/fresh")).toBe(true);
  expect(catalog.models?.some(entry => (
    typeof entry.slug === "string" && !entry.slug.includes("/")
  ))).toBe(false);
  expect(existsSync(catalogBackupPathFor(catalogPath))).toBe(false);

  writeFileSync(catalogBackupPathFor(catalogPath), `${JSON.stringify({
    root_marker: "stale-backup",
    models: [nativeEntry()],
  }, null, 2)}\n`);
  nextConfig.providers.static!.models = ["newer"];
  const second = await convergeCatalogDisposition(nextConfig);
  expect(second).toMatchObject({ status: "committed", notices: [] });
  catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog;
  expect(catalog.root_marker).toBe("active-custom");
  expect(catalog.models?.some(entry => entry.slug === "static/fresh")).toBe(false);
  expect(catalog.models?.some(entry => entry.slug === "static/newer")).toBe(true);

  const convergenceBytes = readFileSync(catalogPath, "utf8");
  // Agreement, not a rewrite: the retained sync runs to completion (no policy skip)
  // and reports no write because convergence already produced these exact bytes.
  // Rewriting them would move the catalog mtime and mark every running Codex stale (#857).
  const resync = await syncCatalogModels(nextConfig);
  expect(resync.skippedReason).toBeUndefined();
  expect(resync.catalogWritten).toBe(false);
  expect(readFileSync(catalogPath, "utf8")).toBe(convergenceBytes);
});

test("OAuth admission degradation is auth-only and does not masquerade as a network failure", async () => {
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  primeCodexRuntimeFixture();
  writeCatalog([nativeEntry(), generatedRoutedEntry("offline/old-live")]);
  const nextConfig = config(false);
  nextConfig.codexAccounts = [];
  nextConfig.codexAccountNamespaces = {};
  rmSync(join(codexHome, "auth.json"), { force: true });
  nextConfig.providers.offline = {
    adapter: "openai-chat",
    baseUrl: "https://offline.example.test/v1",
    authMode: "oauth",
    models: ["fallback"],
  };
  const fetchSpy = spyOn(globalThis, "fetch");
  try {
    const disposition = await convergeCatalogDisposition(nextConfig);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(disposition).toMatchObject({
      status: "committed",
      degraded: true,
      notices: ["provider-auth"],
    });
  } finally {
    fetchSpy.mockRestore();
  }
});

test("disabled-provider selections cannot delete a foreign row in either writer", async () => {
  primeCodexRuntimeFixture();
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  const foreign = { ...foreignEntry(), slug: "disabled/foreign-model" };
  writeCatalog([nativeEntry(), foreign]);
  const nextConfig = config(false);
  nextConfig.providers.disabled = {
    adapter: "openai-chat",
    baseUrl: "https://disabled.example.test/v1",
    disabled: true,
    liveModels: false,
    selectedModels: ["some-other-model"],
  };

  await convergeCatalog(nextConfig);
  const convergenceBytes = readFileSync(catalogPath, "utf8");
  expect((JSON.parse(convergenceBytes) as RawCatalog).models)
    .toContainEqual(expect.objectContaining({ slug: "disabled/foreign-model" }));

  const resync = await syncCatalogModels(nextConfig);
  expect(resync.skippedReason).toBeUndefined();
  expect(resync.catalogWritten).toBe(false);
  expect(readFileSync(catalogPath, "utf8")).toBe(convergenceBytes);
});

test("convergence clamps native, routed, and account rows to observed runtime support", async () => {
  grantGpt56NativeModels("main-chatgpt-account", "side-chatgpt-account");
  seedObservedRuntimeSupport();
  writeCatalog([nativeEntry()]);
  const nextConfig = config(true);
  nextConfig.providers.static = {
    adapter: "openai-chat",
    baseUrl: "https://static.example.test/v1",
    liveModels: false,
    models: ["reasoning-model"],
    modelReasoningEfforts: {
      "reasoning-model": ["low", "medium", "high", "xhigh", "max", "ultra"],
    },
    modelDefaultReasoningEfforts: { "reasoning-model": "ultra" },
  };

  const catalog = await convergeCatalog(nextConfig);
  const models = catalog.models ?? [];
  for (const slug of [
    "gpt-5.6-sol",
    "static/reasoning-model",
    "desktop/gpt-5.6-sol",
    "team/gpt-5.6-sol",
  ]) {
    const entry = models.find(model => model.slug === slug);
    const efforts = (entry?.supported_reasoning_levels ?? []) as Array<{ effort?: string }>;
    expect(entry).toBeDefined();
    expect(efforts.map(level => level.effort)).not.toContain("max");
    expect(efforts.map(level => level.effort)).not.toContain("ultra");
    if (typeof entry?.default_reasoning_level === "string") {
      expect(efforts.some(level => level.effort === entry.default_reasoning_level)).toBe(true);
    }
  }
  const cache = JSON.parse(readFileSync(join(codexHome, "models_cache.json"), "utf8")) as {
    models?: RawEntry[];
  };
  expect(cache.models).toEqual(models);
});

test("generated account rows silently win freshly gathered provider collisions", async () => {
  grantGpt56NativeModels("main-chatgpt-account", "side-chatgpt-account");
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
  primeCodexRuntimeFixture();
  const seed = (): void => {
    writeCatalog([
      nativeEntry(),
      unsupportedNativeEntry(),
      foreignBareNativeEntry(),
    ]);
  };
  const readBytes = (): string => readFileSync(catalogPath, "utf8");
  const expectCanonicalContent = (bytes: string, pickerEnabled: boolean): void => {
    const models = (JSON.parse(bytes) as RawCatalog).models ?? [];
    const slugs = models
      ?.flatMap(entry => typeof entry.slug === "string" ? [entry.slug] : []) ?? [];
    for (const slug of NATIVE_OPENAI_MODELS) {
      if (ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(slug)) expect(slugs).not.toContain(slug);
      else expect(slugs).toContain(slug);
    }
    for (const entry of models.filter(entry => (
      entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND
    ))) {
      const baseSlug = entry.slug?.slice(entry.slug.indexOf("/") + 1);
      expect(ACCOUNT_GATED_NATIVE_OPENAI_MODELS.has(baseSlug ?? "")).toBe(false);
    }
    expect(slugs).not.toContain("gpt-legacy-unsupported");
    expect(slugs).toContain("user-native");
    expect(models.find(entry => entry.slug === "gpt-5.5")?.visibility)
      .toBe(pickerEnabled ? "hide" : "list");
    expect(models.some(entry => (
      entry.opencodex_catalog_kind === CODEX_ACCOUNT_BOUND_CATALOG_KIND
    ))).toBe(pickerEnabled);
    if (pickerEnabled) {
      expect(models.find(entry => entry.slug === "desktop/gpt-5.5")).toMatchObject({
        display_name: "desktop / 5.5",
        opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      });
      expect(models.find(entry => entry.slug === "team/gpt-5.5")).toMatchObject({
        display_name: "team / 5.5",
        opencodex_catalog_kind: CODEX_ACCOUNT_BOUND_CATALOG_KIND,
      });
    }
  };

  for (const pickerEnabled of [false, true]) {
    const nextConfig = config(pickerEnabled);
    seed();
    await convergeCatalog(nextConfig);
    const convergenceFirst = readBytes();
    expectCanonicalContent(convergenceFirst, pickerEnabled);
    const resync = await syncCatalogModels(nextConfig);
    expect(resync.skippedReason).toBeUndefined();
    expect(resync.catalogWritten).toBe(false);
    expect(readBytes()).toBe(convergenceFirst);

    seed();
    expect((await syncCatalogModels(nextConfig)).catalogWritten).toBe(true);
    const retainedFirst = readBytes();
    expectCanonicalContent(retainedFirst, pickerEnabled);
    expect(retainedFirst).toBe(convergenceFirst);
    await convergeCatalog(nextConfig);
    expect(readBytes()).toBe(retainedFirst);
  }
});

test("both writers refuse an irreplaceable combo shadow when no pristine backup exists", async () => {
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  primeCodexRuntimeFixture();

  const withCombo = config(false);
  withCombo.providers.target = {
    adapter: "openai-chat",
    baseUrl: "https://target.example.test/v1",
    liveModels: false,
    models: ["m1"],
    modelContextWindows: { m1: 128_000 },
    modelInputModalities: { m1: ["text"] },
    modelReasoningEfforts: { m1: ["low", "medium"] },
  };
  withCombo.combos = {
    shadow: {
      alias: "user-native",
      targets: [{ provider: "target", model: "m1" }],
    },
  };
  const withoutCombo = structuredClone(withCombo);
  delete withoutCombo.combos;
  const backupPath = catalogBackupPathFor(catalogPath);
  const seed = (): void => {
    rmSync(backupPath, { force: true });
    writeCatalog([foreignBareNativeEntry(), foreignEntry()]);
  };
  const assertUserRow = (): void => {
    const models = (JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog).models ?? [];
    expect(models.filter(entry => entry.slug === "user-native")).toEqual([
      expect.objectContaining({
        display_name: "User native",
        description: "Managed by another catalog tool.",
      }),
    ]);
    expect(models.some(entry => entry.slug === "external/vendor-model")).toBe(true);
    expect(existsSync(backupPath)).toBe(false);
  };

  for (const writer of ["convergence", "retained"] as const) {
    seed();
    if (writer === "convergence") await convergeCatalog(withCombo);
    else {
      saveConfig(withCombo);
      expect((await syncCatalogModels(withCombo)).catalogWritten).toBe(true);
    }
    assertUserRow();

    if (writer === "convergence") await convergeCatalog(withoutCombo);
    else {
      saveConfig(withoutCombo);
      expect((await syncCatalogModels(withoutCombo)).catalogWritten).toBe(true);
    }
    assertUserRow();
  }
});

test("convergence refuses a combo shadow when every backup target is present but invalid", async () => {
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  primeCodexRuntimeFixture();

  const withCombo = config(false);
  withCombo.providers.target = {
    adapter: "openai-chat",
    baseUrl: "https://target.example.test/v1",
    liveModels: false,
    models: ["m1"],
    modelContextWindows: { m1: 128_000 },
    modelInputModalities: { m1: ["text"] },
    modelReasoningEfforts: { m1: ["low", "medium"] },
  };
  withCombo.combos = {
    shadow: {
      alias: "user-native",
      targets: [{ provider: "target", model: "m1" }],
    },
  };
  const withoutCombo = structuredClone(withCombo);
  delete withoutCombo.combos;
  const backupPath = catalogBackupPathFor(catalogPath);
  const invalidBackup = "{ invalid catalog backup\n";
  writeCatalog([foreignBareNativeEntry()]);
  writeFileSync(backupPath, invalidBackup);

  const assertPreserved = (): void => {
    const models = (JSON.parse(readFileSync(catalogPath, "utf8")) as RawCatalog).models ?? [];
    expect(models.filter(entry => entry.slug === "user-native")).toEqual([
      expect.objectContaining({
        display_name: "User native",
        description: "Managed by another catalog tool.",
      }),
    ]);
    expect(readFileSync(backupPath, "utf8")).toBe(invalidBackup);
  };

  await convergeCatalog(withCombo);
  assertPreserved();
  await convergeCatalog(withoutCombo);
  assertPreserved();
});

test("both writers restore pristine native priorities after featured-model transitions", async () => {
  grantGpt56NativeModels("main-chatgpt-account", "side-chatgpt-account");
  primeCodexRuntimeFixture();
  catalogPath = join(codexHome, "custom-catalog.json");
  writeFileSync(
    join(codexHome, "config.toml"),
    'model_catalog_json = "custom-catalog.json"\n',
  );
  const pristineModels = [
    { ...nativeEntry(), priority: 41 },
    nativeMetadataEntry("gpt-5.5", "Installed GPT-5.5 instructions.", 57),
  ];
  const backupPath = catalogBackupPathFor(catalogPath);
  const seed = (): void => {
    writeCatalog(pristineModels);
    writeFileSync(backupPath, `${JSON.stringify({ models: pristineModels }, null, 2)}\n`);
  };
  const transition = async (
    first: "convergence" | "retained",
  ): Promise<string> => {
    seed();
    for (const featured of [["gpt-5.5"], ["gpt-5.6-sol"], []] as const) {
      const nextConfig = config(false);
      nextConfig.subagentModels = [...featured];
      saveConfig(nextConfig);
      if (first === "convergence") {
        await convergeCatalog(nextConfig);
        await syncCatalogModels(nextConfig);
      } else {
        await syncCatalogModels(nextConfig);
        await convergeCatalog(nextConfig);
      }
    }
    return readFileSync(catalogPath, "utf8");
  };

  const convergenceFirst = await transition("convergence");
  const retainedFirst = await transition("retained");
  expect(retainedFirst).toBe(convergenceFirst);
  const finalModels = (JSON.parse(convergenceFirst) as RawCatalog).models ?? [];
  expect(finalModels.find(entry => entry.slug === "gpt-5.6-sol")?.priority).toBe(41);
  expect(finalModels.find(entry => entry.slug === "gpt-5.5")?.priority).toBe(57);
});
