import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildClientContribution, type ExportModel } from "../src/clients/config-export";
import { fileIO, type IntegrationIO } from "../src/integrations/config-io";
import { canonicalContribution, fingerprint } from "../src/integrations/ownership";
import { protectedContributionFingerprint } from "../src/integrations/ownership-policy";
import { INTEGRATION_CLIENTS } from "../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../src/integrations/store";
import { exportContextOf, readIntegrationState } from "../src/integrations/state";
import {
  applyIntegration,
  disableIntegration,
  overwriteIntegration,
  restoreIntegration,
  type IntegrationWriteInput,
} from "../src/integrations/writer";
import type { OcxConfig } from "../src/types";
import { removeTreeWithRetry } from "./helpers/remove-tree";

/**
 * Activation coverage for devlog/_fin/260802_client_toggle_api/031 §6.
 *
 * Every test drives the real writer against a temp HOME and a temp store, so
 * "we never touch anything we do not own" is proven by the filesystem rather
 * than asserted in prose.
 */
let home: string;
let storeRoot: string;
let store: IntegrationStateStore;

/**
 * The environment every path resolution in this file goes through. Empty on
 * purpose: no `HERMES_HOME`/`LOCALAPPDATA` override, so the registry picks the
 * platform default and the fixture follows it instead of assuming one.
 */
const TEST_ENV = {} as NodeJS.ProcessEnv;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
  { namespaced: "openai/gpt-5.5", provider: "openai", id: "gpt-5.5", contextWindow: 400_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-integrations-writer-"));
  home = join(base, "home");
  storeRoot = join(base, "store", "integrations");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(storeRoot);
});

afterEach(() => {
  removeTreeWithRetry(dirname(home));
});

/**
 * Hermes: YAML, installed by creating its home directory.
 *
 * The directory is resolved through the registry rather than hardcoded to
 * `~/.hermes`: on Windows Hermes lives under `%LOCALAPPDATA%\hermes`, so a
 * hardcoded POSIX layout created a directory the detector never looks at and
 * every apply in this file refused with `not_installed`.
 */
function installHermes(): string {
  const spec = INTEGRATION_CLIENTS.hermes;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function installPi(): string {
  const spec = INTEGRATION_CLIENTS.pi;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function installOmp(): string {
  const spec = INTEGRATION_CLIENTS.omp;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function installDsh(): string {
  const spec = INTEGRATION_CLIENTS.dsh;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function installZcode(): string {
  const spec = INTEGRATION_CLIENTS.zcode;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function installOpencode(): string {
  const spec = INTEGRATION_CLIENTS.opencode;
  mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
  const configPath = spec.configPath(TEST_ENV, home);
  mkdirSync(dirname(configPath), { recursive: true });
  return configPath;
}

function input(overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
  return {
    clientId: "hermes",
    models: MODELS,
    config: CONFIG,
    port: 10100,
    env: TEST_ENV,
    home,
    store,
    ...overrides,
  };
}

function reverseJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseJsonObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .reverse()
      .map(([key, nested]) => [key, reverseJsonObjectKeys(nested)]),
  );
}

describe("apply", () => {
  test("refuses a client that is not installed, and writes nothing", () => {
    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_installed");
    expect(store.listOperations()).toHaveLength(0);
  });

  test("creates the file, journals the operation, and reads back as current", () => {
    const configPath = installHermes();
    const result = applyIntegration(input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(true);

    const text = readFileSync(configPath, "utf8");
    expect(Bun.YAML.parse(text)).toMatchObject({ providers: { opencodex: { api_mode: "chat_completions" } } });
    const rows = store.listOperations("hermes");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("apply");
    // Nothing existed before, so there is nothing to restore TO.
    expect(rows[0]!.snapshot.kind).toBe("none");
  });

  /**
   * opencode owns two fragments now, and only the V2 one carries the reasoning-effort
   * variants. None of the other clients exercise a two-block document, so the writer has to
   * be shown putting the variants on disk — not just building them.
   */
  test("opencode writes the reasoning-effort variants and keeps them on refresh", () => {
    const configPath = installOpencode();
    const models: ExportModel[] = [
      {
        namespaced: "opencode-go/glm-5.3",
        provider: "opencode-go",
        id: "glm-5.3",
        contextWindow: 1_000_000,
        reasoningEfforts: ["max", "low", "high"],
      },
      { namespaced: "openai/gpt-5.5", provider: "openai", id: "gpt-5.5", contextWindow: 400_000 },
    ];
    const request = input({ clientId: "opencode", models });
    expect(applyIntegration(request).ok).toBe(true);

    const doc = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: { opencodex: { models: Record<string, Record<string, unknown>> } };
      providers: {
        opencodex: { models: Record<string, { variants?: Array<{ id: string }> }> };
      };
    };
    expect(doc.providers.opencodex.models["opencode-go/glm-5.3"]!.variants!.map(v => v.id))
      .toEqual(["low", "high", "max"]);
    // The legacy block stays variant-free, and a model without a ladder gets no key at all.
    expect(doc.provider.opencodex.models["opencode-go/glm-5.3"]).not.toHaveProperty("variants");
    expect(doc.providers.opencodex.models["openai/gpt-5.5"]!.variants).toBeUndefined();

    expect(readIntegrationState(request)).toMatchObject({ state: "current" });
    expect(applyIntegration(request).ok).toBe(true);
    const after = JSON.parse(readFileSync(configPath, "utf8")) as typeof doc;
    expect(after.providers.opencodex.models["opencode-go/glm-5.3"]!.variants!.map(v => v.id))
      .toEqual(["low", "high", "max"]);
  });

  /**
   * Every opencode installation that predates the second block has a one-fragment record, so
   * this is the migration path every existing user takes. Kimi has an equivalent test; opencode
   * is the client that actually meets it in the field.
   */
  test("a legacy opencode record migrates to two fragments and disables cleanly", () => {
    const configPath = installOpencode();
    const request = input({ clientId: "opencode" });
    expect(applyIntegration(request).ok).toBe(true);

    // Rewind the file and the record to the pre-V2 shape: one fragment, one container, and
    // fingerprints computed from exactly that state — a record whose fingerprints disagree
    // with its own fragments is a foreign edit, which is a different (and correct) refusal.
    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: { opencodex: unknown };
    };
    delete (document as Record<string, unknown>).providers;
    const legacyText = `${JSON.stringify(document, null, 2)}\n`;
    writeFileSync(configPath, legacyText);

    const legacy = { ...store.readRecords().opencode! };
    legacy.fragmentPaths = [["provider", "opencodex"]];
    legacy.createdContainers = ["provider"];
    legacy.fileFingerprint = fingerprint(legacyText);
    legacy.blockFingerprint = fingerprint(canonicalContribution({
      clientId: "opencode",
      fragments: [{ path: ["provider", "opencodex"], value: document.provider.opencodex }],
    }));
    store.putRecord(legacy);

    expect(readIntegrationState(request)).toMatchObject({ state: "stale" });
    expect(applyIntegration(request).ok).toBe(true);

    const migrated = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(migrated.providers).toBeDefined();
    expect(store.readRecords().opencode!.fragmentPaths).toEqual([
      ["provider", "opencodex"],
      ["providers", "opencodex"],
    ]);

    // Disabling has to take both fragments with it, including the container we created.
    expect(disableIntegration(request).ok).toBe(true);
    const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(after.provider).toBeUndefined();
    expect(after.providers).toBeUndefined();
  });

  test("is idempotent: applying twice changes nothing the second time", () => {
    installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const second = applyIntegration(input());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(false);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });

  test("preserves a foreign provider and unknown top-level fields", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers:\n  other:\n    api: http://elsewhere\nunknown_top: keep-me\n");
    expect(applyIntegration(input()).ok).toBe(true);

    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(doc.unknown_top).toBe("keep-me");
    expect((doc.providers as Record<string, unknown>).other).toEqual({ api: "http://elsewhere" });
  });

  test("refuses when a managed provider field changes after we wrote it", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const edited = readFileSync(configPath, "utf8").replace(
      "api_mode: chat_completions",
      "api_mode: user_edited",
    );
    writeFileSync(configPath, edited);

    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    // The user's edit is still there.
    expect(readFileSync(configPath, "utf8")).toContain("api_mode: user_edited");
  });

  test("json clients re-apply after a sibling edit and keep the user's entry (#1631)", () => {
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);

    // The user adds an unrelated sibling — the routine edit that used to
    // dead-end the integration in `conflict` with no recovery path.
    const doc = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (doc.providers as Record<string, unknown>).mine = { baseUrl: "http://user.invalid/v1" };
    writeFileSync(configPath, `${JSON.stringify(doc, null, 4)}\n`);

    const second = applyIntegration(input({ clientId: "pi" }));
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(true);

    const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect((after.providers as Record<string, unknown>).mine).toEqual({ baseUrl: "http://user.invalid/v1" });
    // The block a fresh apply would write, not merely "something is there".
    expect((after.providers as Record<string, unknown>).opencodex).toMatchObject({
      baseUrl: "http://127.0.0.1:10100/v1",
    });

    // The re-apply re-owned the file: a third apply is a no-op again.
    const third = applyIntegration(input({ clientId: "pi" }));
    expect(third.ok).toBe(true);
    if (third.ok) expect(third.changed).toBe(false);
  });

  test("ZCode runtime-derived model metadata is refreshable without weakening the provider envelope (#2389)", () => {
    const configPath = installZcode();
    const models: ExportModel[] = [
      ...MODELS,
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
    ];
    const request = input({ clientId: "zcode", models });
    expect(applyIntegration(request).ok).toBe(true);

    const record = store.readRecords().zcode!;
    expect(record.protectedBlockFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(record.semanticBlockFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(record.semanticProtectedBlockFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(record.refreshablePaths).toContainEqual([
      "provider", "opencodex", "models", "mystery/model", "limit", "context",
    ]);
    expect(record.refreshablePaths).not.toContainEqual([
      "provider", "opencodex", "models", "anthropic/claude-opus-4-8", "limit", "context",
    ]);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, {
        models: Record<string, Record<string, unknown>>;
        options: Record<string, unknown>;
      }>;
    };
    const provider = document.provider.opencodex!;
    const authoritative = provider.models["anthropic/claude-opus-4-8"]!;
    authoritative.reasoning = { enabled: true, variants: ["off", "high"] };
    (authoritative.limit as Record<string, unknown>).output = 64_000;
    provider.models["mystery/model"]!.limit = { context: 128_000, output: 32_000 };
    provider.models["mystery/model"]!.reasoning = { enabled: false };
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    const status = readIntegrationState(request);
    expect(status.state).toBe("stale");
    expect(status.reason).toBeUndefined();

    const refreshed = applyIntegration(request);
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.changed).toBe(true);

    const after = JSON.parse(readFileSync(configPath, "utf8")) as typeof document;
    expect(after.provider.opencodex!.models["anthropic/claude-opus-4-8"]!.reasoning).toBeUndefined();
    expect((after.provider.opencodex!.models["anthropic/claude-opus-4-8"]!.limit as Record<string, unknown>).output).toBeUndefined();
    expect(after.provider.opencodex!.models["mystery/model"]!.limit).toBeUndefined();
  });

  test("ZCode on a hub writes and recognizes the unauthenticated loopback listener (#3306)", () => {
    const configPath = installZcode();
    const request = input({
      clientId: "zcode",
      config: {
        ...CONFIG,
        runtimeRole: "hub",
        hostname: "100.64.0.10",
        unauthenticatedLoopbackListener: { enabled: true, port: 10102 },
      },
    });

    const result = applyIntegration(request);
    expect(result.ok).toBe(true);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { options: { apiKey: string; baseURL: string } }>;
    };
    expect(document.provider.opencodex!.options).toMatchObject({
      apiKey: "opencodex-loopback",
      baseURL: "http://127.0.0.1:10102/v1",
    });
    expect(readIntegrationState(request)).toMatchObject({ state: "current" });
  });

  test("ZCode key-order normalization stays refreshable with derived metadata (#2759)", () => {
    const configPath = installZcode();
    const models: ExportModel[] = [
      ...MODELS,
      { namespaced: "mystery/model", provider: "mystery", id: "model" },
    ];
    const request = input({ clientId: "zcode", models });
    expect(applyIntegration(request).ok).toBe(true);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
    };
    document.provider.opencodex!.models["mystery/model"]!.limit = {
      context: 128_000,
      output: 32_000,
    };
    document.provider.opencodex!.models["mystery/model"]!.reasoning = { enabled: false };
    const reordered = reverseJsonObjectKeys(document);
    writeFileSync(configPath, `${JSON.stringify(reordered, null, 2)}\n`);

    expect(readIntegrationState(request)).toMatchObject({ state: "stale" });
    const refreshed = applyIntegration(request);
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) expect(refreshed.changed).toBe(true);
    expect(readIntegrationState(request)).toMatchObject({ state: "current" });
  });

  test("legacy ZCode records tolerate key reordering when the catalog is unchanged (#2759)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const legacy = { ...store.readRecords().zcode! };
    delete legacy.semanticBlockFingerprint;
    delete legacy.semanticProtectedBlockFingerprint;
    store.putRecord(legacy);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
    };
    document.provider.opencodex!.models["anthropic/claude-opus-4-8"]!.reasoning = {
      enabled: true,
    };
    writeFileSync(
      configPath,
      `${JSON.stringify(reverseJsonObjectKeys(document), null, 2)}\n`,
    );

    expect(readIntegrationState(request)).toMatchObject({ state: "stale" });
    expect(applyIntegration(request).ok).toBe(true);
  });

  test("a legacy ZCode record accepts derived drift only while its generated catalog is unchanged (#2389)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const legacy = { ...store.readRecords().zcode! };
    delete legacy.protectedBlockFingerprint;
    delete legacy.refreshablePaths;
    store.putRecord(legacy);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
    };
    document.provider.opencodex!.models["anthropic/claude-opus-4-8"]!.reasoning = { enabled: true };
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    expect(readIntegrationState(request).state).toBe("stale");
    expect(applyIntegration(request).ok).toBe(true);
  });

  test("a recorded ZCode policy keeps derived drift refreshable across later catalog changes (#2389)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
    };
    document.provider.opencodex!.models["anthropic/claude-opus-4-8"]!.reasoning = { enabled: true };
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    const changedCatalog = input({
      clientId: "zcode",
      models: [...MODELS, { namespaced: "new/model", provider: "new", id: "model" }],
    });
    expect(readIntegrationState(changedCatalog).state).toBe("stale");
    const result = applyIntegration(changedCatalog);
    expect(result.ok).toBe(true);
    const after = JSON.parse(readFileSync(configPath, "utf8")) as typeof document;
    expect(after.provider.opencodex!.models["new/model"]).toBeDefined();
  });

  test("a legacy ZCode record fails closed when derived drift overlaps catalog drift (#2389)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const legacy = { ...store.readRecords().zcode! };
    delete legacy.protectedBlockFingerprint;
    delete legacy.refreshablePaths;
    store.putRecord(legacy);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
    };
    document.provider.opencodex!.models["anthropic/claude-opus-4-8"]!.reasoning = { enabled: true };
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    const changedCatalog = input({
      clientId: "zcode",
      models: [...MODELS, { namespaced: "new/model", provider: "new", id: "model" }],
    });
    expect(readIntegrationState(changedCatalog)).toMatchObject({
      state: "conflict",
      reason: "foreign-edit",
    });
  });

  test("ZCode connection edits remain a hard conflict after derived-drift support (#2389)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };
    document.provider.opencodex!.options.baseURL = "http://user-edited.invalid/v1";
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    const status = readIntegrationState(request);
    expect(status).toMatchObject({ state: "conflict", reason: "foreign-edit" });
    const result = applyIntegration(request);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
  });

  test("a malformed recorded ZCode policy cannot widen refreshable drift (#2389)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const refreshablePaths = [["provider", "opencodex", "options", "baseURL"]] as const;
    const contribution = buildClientContribution("zcode", exportContextOf(request));
    store.putRecord({
      ...store.readRecords().zcode!,
      refreshablePaths,
      protectedBlockFingerprint: protectedContributionFingerprint(contribution, refreshablePaths),
    });

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { options: Record<string, unknown> }>;
    };
    document.provider.opencodex!.options.baseURL = "http://user-edited.invalid/v1";
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    expect(readIntegrationState(request)).toMatchObject({
      state: "conflict",
      reason: "foreign-edit",
    });
  });

  test("ZCode cannot rewrite an authoritative OpenCodex context limit (#2389)", () => {
    const configPath = installZcode();
    const request = input({ clientId: "zcode" });
    expect(applyIntegration(request).ok).toBe(true);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      provider: Record<string, { models: Record<string, Record<string, unknown>> }>;
    };
    const model = document.provider.opencodex!.models["anthropic/claude-opus-4-8"]!;
    (model.limit as Record<string, unknown>).context = 1;
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    expect(readIntegrationState(request)).toMatchObject({ state: "conflict", reason: "foreign-edit" });
  });

  test("json disable after a sibling edit keeps the sibling (#1631)", () => {
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);
    const doc = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    (doc.providers as Record<string, unknown>).mine = { baseUrl: "http://user.invalid/v1" };
    writeFileSync(configPath, `${JSON.stringify(doc, null, 2)}\n`);

    const result = disableIntegration(input({ clientId: "pi" }));
    expect(result.ok).toBe(true);

    const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect((after.providers as Record<string, unknown>).mine).toEqual({ baseUrl: "http://user.invalid/v1" });
    expect((after.providers as Record<string, unknown>).opencodex).toBeUndefined();
  });

  test("json apply refuses when a sibling number cannot round-trip", () => {
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);
    // 1e999 is valid strict JSON but parses to Infinity; a rewrite would bake
    // in `null`. The refusal must fire instead of reporting success.
    const drifted = readFileSync(configPath, "utf8")
      .replace(/^\{/, "{\n  \"quota\": 1e999,");
    writeFileSync(configPath, drifted);

    const result = applyIntegration(input({ clientId: "pi" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    // The file is untouched, the user's literal survives.
    expect(readFileSync(configPath, "utf8")).toContain("1e999");
  });

  test("json apply refuses a duplicate sibling member instead of deleting it", () => {
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);
    // Valid strict JSON, but JSON.parse keeps only the last "notes" — a
    // rewrite would silently delete the first one while reporting success.
    const drifted = readFileSync(configPath, "utf8")
      .replace(/^\{/, "{\n  \"notes\": \"keep me\",\n  \"notes\": \"second\",");
    writeFileSync(configPath, drifted);

    const result = applyIntegration(input({ clientId: "pi" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    // Byte-for-byte untouched: both members survive on disk.
    expect(readFileSync(configPath, "utf8")).toBe(drifted);
  });

  test("a sibling with an exactly-representable big number stays usable (#1631)", () => {
    // 2^54 round-trips value- and literal-exactly. classify promises 'stale'
    // (recoverable) for this file; apply must honor that promise instead of
    // refusing at serialize time — the asymmetry that re-created the dead-end.
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);
    const drifted = readFileSync(configPath, "utf8")
      .replace(/^\{/, "{\n  \"quota\": 18014398509481984,");
    writeFileSync(configPath, drifted);

    const second = applyIntegration(input({ clientId: "pi" }));
    expect(second.ok).toBe(true);

    expect(readFileSync(configPath, "utf8")).toContain("18014398509481984");
    const after = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(after.quota).toBe(2 ** 54);
  });

  test("disable also honors a 2^54 sibling: proceeds and keeps the literal", () => {
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);
    const drifted = readFileSync(configPath, "utf8")
      .replace(/^\{/, "{\n  \"quota\": 18014398509481984,");
    writeFileSync(configPath, drifted);

    const result = disableIntegration(input({ clientId: "pi" }));
    expect(result.ok).toBe(true);

    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("18014398509481984");
    const after = JSON.parse(text) as Record<string, unknown>;
    expect(after.quota).toBe(2 ** 54);
    expect((after.providers as Record<string, unknown> | undefined)?.opencodex).toBeUndefined();
  });

  test("json disable also refuses when a sibling number cannot round-trip", () => {
    const configPath = installPi();

    expect(applyIntegration(input({ clientId: "pi" })).ok).toBe(true);
    const drifted = readFileSync(configPath, "utf8")
      .replace(/^\{/, "{\n  \"quota\": 1e999,");
    writeFileSync(configPath, drifted);

    const result = disableIntegration(input({ clientId: "pi" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toContain("1e999");
  });

  test("yaml clients still refuse a sibling edit rather than risk user comments", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}unknown_top: added-later\n`);

    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(readFileSync(configPath, "utf8")).toContain("unknown_top: added-later");
  });

  test("refuses an unparseable config rather than overwriting it", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "{{{ not yaml\n");
    const result = applyIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe("{{{ not yaml\n");
  });

  test("refuses a loopback-only client on a remote bind without denying manual OMP headers", () => {
    for (const clientId of ["gajae", "omp", "dsh"] as const) {
      const spec = INTEGRATION_CLIENTS[clientId];
      mkdirSync(spec.detectDir(TEST_ENV, home), { recursive: true });
      const result = applyIntegration(input({
        clientId,
        config: { ...CONFIG, hostname: "0.0.0.0" } as OcxConfig,
      }));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("non_loopback");
        expect(result.message).toContain(`generated ${clientId} integration is loopback-only`);
        expect(result.message).not.toContain("writing one by hand would not help");
      }
    }
  });

  test("a write failure reports the snapshot rather than claiming success", () => {
    installHermes();
    const throwing: IntegrationIO = {
      ...fileIO(),
      writeText: () => { throw new Error("disk full"); },
      appendJournal: entry => store.appendJournal(entry),
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    };
    const result = applyIntegration(input({ io: throwing }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("write_failed");
      expect(result.message).toContain("disk full");
    }
  });
});

describe("disable", () => {
  test("removes only our block and leaves the rest byte-identical", () => {
    const configPath = installHermes();
    const original = "providers:\n  other:\n    api: http://elsewhere\nunknown_top: keep-me\n";
    writeFileSync(configPath, original);
    expect(applyIntegration(input()).ok).toBe(true);

    const result = disableIntegration(input());
    expect(result.ok).toBe(true);
    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(doc).toEqual(Bun.YAML.parse(original) as Record<string, unknown>);
  });

  test("disabling a config we never touched is a no-op, not an error", () => {
    installHermes();
    const result = disableIntegration(input());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.changed).toBe(false);
  });

  test("refuses to delete a block after someone edits a managed provider field", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const edited = readFileSync(configPath, "utf8").replace(
      "api_mode: chat_completions",
      "api_mode: user_edited",
    );
    writeFileSync(configPath, edited);

    const result = disableIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(readFileSync(configPath, "utf8")).toContain("api_mode: user_edited");
  });

  test("kimi loses its provider AND every model entry it owns", () => {
    mkdirSync(join(home, ".kimi-code"), { recursive: true });
    const configPath = join(home, ".kimi-code", "config.toml");
    // A user's own entry that merely looks like ours must survive.
    writeFileSync(configPath, '[models."opencodex/mine"]\nprovider = "elsewhere"\n');
    expect(applyIntegration(input({ clientId: "kimi" })).ok).toBe(true);

    const applied = Bun.TOML.parse(readFileSync(configPath, "utf8")) as { models: Record<string, unknown> };
    expect(Object.keys(applied.models).length).toBeGreaterThan(1);

    expect(disableIntegration(input({ clientId: "kimi" })).ok).toBe(true);
    const after = Bun.TOML.parse(readFileSync(configPath, "utf8")) as { models?: Record<string, unknown> };
    expect(after.models).toEqual({ "opencodex/mine": { provider: "elsewhere" } });
  });
});

describe("OMP source preservation", () => {
  test("disables a generated OMP config without leaving its created container", () => {
    const configPath = installOmp();
    expect(applyIntegration(input({ clientId: "omp" })).ok).toBe(true);
    expect(disableIntegration(input({ clientId: "omp" })).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe("");
  });

  test("preserves unrelated provider comments and formatting through apply, refresh, and disable", () => {
    const configPath = installOmp();
    const original = [
      "# user header",
      "providers:",
      "  freebuff: # keep provider comment",
      "    baseUrl: \"https://freebuff.invalid/v1\"",
      "    api: openai-completions # keep inline comment",
      "# user tail",
      "settings:",
      "  compact: false",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    const ompInput = input({ clientId: "omp" });
    expect(applyIntegration(ompInput).ok).toBe(true);
    const applied = readFileSync(configPath, "utf8");
    expect(applied).toContain("  freebuff: # keep provider comment\n");
    expect(applied).toContain("    api: openai-completions # keep inline comment\n");

    // This edit happens after OpenCodex recorded its file fingerprint. OMP's
    // source patcher must preserve it while refreshing only our stale block.
    const externallyEdited = applied.replace("# user header", "# user header edited later");
    writeFileSync(configPath, externallyEdited);
    const refreshedModels = [...MODELS, {
      namespaced: "openai/gpt-5.6",
      provider: "openai",
      id: "gpt-5.6",
      contextWindow: 272_000,
    }];
    expect(applyIntegration(input({ clientId: "omp", models: refreshedModels })).ok).toBe(true);
    const refreshed = readFileSync(configPath, "utf8");
    expect(refreshed).toContain("# user header edited later\n");
    expect(refreshed).toContain("  freebuff: # keep provider comment\n");
    expect(refreshed).toContain("    api: openai-completions # keep inline comment\n");

    expect(disableIntegration(input({ clientId: "omp", models: refreshedModels })).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(
      original.replace("# user header", "# user header edited later"),
    );
  });

  test("refuses to rewrite an ambiguous comment inside the managed YAML block", () => {
    const configPath = installOmp();
    expect(applyIntegration(input({ clientId: "omp" })).ok).toBe(true);
    const edited = readFileSync(configPath, "utf8").replace(
      "    baseUrl:",
      "    # user note inside managed block\n    baseUrl:",
    );
    writeFileSync(configPath, edited);

    const result = disableIntegration(input({ clientId: "omp" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe(edited);
  });

  test("refuses disable when removing the managed block would break a YAML alias", () => {
    const configPath = installOmp();
    expect(applyIntegration(input({ clientId: "omp" })).ok).toBe(true);
    const edited = readFileSync(configPath, "utf8")
      .replace("    baseUrl:", "    baseUrl: &opencodex_url")
      .concat("settings:\n  inheritedBase: *opencodex_url\n");
    expect(edited).toContain("    baseUrl: &opencodex_url");
    writeFileSync(configPath, edited);

    const journalBefore = store.listOperations("omp");
    const result = disableIntegration(input({ clientId: "omp" }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe(edited);
    expect(store.listOperations("omp")).toEqual(journalBefore);
  });
});

describe("DSH source preservation", () => {
  test("preserves defaults, namespaces, providers, comments, and formatting through refresh and disable", () => {
    const configPath = installDsh();
    const original = [
      "# DSH user header",
      "agent-default-model: deepseek-official/deepseek-chat",
      "llm-pi-ai:",
      "  providers:",
      "    deepseek-official:",
      "      api: openai-completions # native stays",
      "other-namespace:",
      "  compact: false",
      "# DSH user tail",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    expect(applyIntegration(input({ clientId: "dsh" })).ok).toBe(true);
    const applied = readFileSync(configPath, "utf8");
    expect(applied).toContain("agent-default-model: deepseek-official/deepseek-chat\n");
    expect(applied).toContain("      api: openai-completions # native stays\n");
    expect(applied).toContain("other-namespace:\n  compact: false\n");

    const externallyEdited = applied.replace("# DSH user header", "# DSH user header edited");
    writeFileSync(configPath, externallyEdited);
    const refreshedModels = [...MODELS, {
      namespaced: "openai/gpt-5.6",
      provider: "openai",
      id: "gpt-5.6",
      contextWindow: 272_000,
    }];
    expect(applyIntegration(input({ clientId: "dsh", models: refreshedModels })).ok).toBe(true);
    const refreshed = Bun.YAML.parse(readFileSync(configPath, "utf8")) as {
      "llm-pi-ai": { providers: { opencodex: { models: Array<{ id: string }> } } };
    };
    expect(refreshed["llm-pi-ai"].providers.opencodex.models.map(model => model.id))
      .toContain("openai/gpt-5.6");
    expect(disableIntegration(input({ clientId: "dsh", models: refreshedModels })).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(
      original.replace("# DSH user header", "# DSH user header edited"),
    );
  });

  test("an edit inside the owned DSH leaf refuses refresh and disable, preserving the edit", () => {
    const configPath = installDsh();
    expect(applyIntegration(input({ clientId: "dsh" })).ok).toBe(true);
    const edited = readFileSync(configPath, "utf8").replace(
      "api: openai-responses",
      "api: user-edited",
    );
    writeFileSync(configPath, edited);

    const refreshed = applyIntegration(input({
      clientId: "dsh",
      models: [...MODELS, {
        namespaced: "openai/gpt-5.6",
        provider: "openai",
        id: "gpt-5.6",
        contextWindow: 272_000,
      }],
    }));
    expect(refreshed.ok).toBe(false);
    if (!refreshed.ok) expect(refreshed.reason).toBe("conflict");
    expect(readFileSync(configPath, "utf8")).toBe(edited);

    const disabled = disableIntegration(input({ clientId: "dsh" }));
    expect(disabled.ok).toBe(false);
    if (!disabled.ok) expect(disabled.reason).toBe("conflict");
    expect(readFileSync(configPath, "utf8")).toBe(edited);
  });

  test("restores a disabled DSH integration to the exact applied bytes", () => {
    const configPath = installDsh();
    const original = [
      "agent-default-model: deepseek-official/deepseek-chat",
      "llm-pi-ai:",
      "  providers:",
      "    deepseek-official:",
      "      api: openai-completions # native stays",
      "",
    ].join("\n");
    writeFileSync(configPath, original);

    expect(applyIntegration(input({ clientId: "dsh" })).ok).toBe(true);
    const applied = readFileSync(configPath, "utf8");
    expect(disableIntegration(input({ clientId: "dsh" })).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(original);

    const disableOperation = store.listOperations("dsh")[0]!;
    expect(disableOperation.kind).toBe("disable");
    const restored = restoreIntegration({
      ...input({ clientId: "dsh" }),
      opId: disableOperation.opId,
    });
    expect(restored.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(applied);
  });

  test("a sibling added below a container we created survives disable", () => {
    const configPath = installDsh();
    writeFileSync(configPath, "agent-default-model: native\n");
    expect(applyIntegration(input({ clientId: "dsh" })).ok).toBe(true);
    const applied = readFileSync(configPath, "utf8");
    const edited = applied.replace(
      "    opencodex:\n",
      "    user-provider:\n      api: openai-completions # keep\n    opencodex:\n",
    );
    writeFileSync(configPath, edited);
    expect(disableIntegration(input({ clientId: "dsh" })).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe([
      "agent-default-model: native",
      "llm-pi-ai:",
      "  providers:",
      "    user-provider:",
      "      api: openai-completions # keep",
      "",
    ].join("\n"));
  });
});

describe("restore", () => {
  test("undoes an apply back to the exact prior bytes", () => {
    const configPath = installHermes();
    const original = "providers:\n  other:\n    api: http://elsewhere\n";
    writeFileSync(configPath, original);
    const applied = applyIntegration(input());
    expect(applied.ok).toBe(true);

    const opId = store.listOperations("hermes")[0]!.opId;
    const restored = restoreIntegration({ ...input(), opId });
    expect(restored.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("restoring an apply that created the file removes it again", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;

    const restored = restoreIntegration({ ...input(), opId });
    expect(restored.ok).toBe(true);
    expect(() => statSync(configPath)).toThrow();
  });

  test("refuses to replace post-operation edits without confirmation", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# later edit\n`);

    const refused = restoreIntegration({ ...input(), opId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("drift_requires_confirm");
    expect(readFileSync(configPath, "utf8")).toContain("# later edit");
  });

  test("a confirmed drift-restore keeps the replaced version recoverable", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;
    writeFileSync(configPath, `${readFileSync(configPath, "utf8")}# later edit\n`);

    const restored = restoreIntegration({ ...input(), opId, confirmDrift: true });
    expect(restored.ok).toBe(true);
    // The edit we replaced is in the newest snapshot, so nothing was lost.
    const newest = store.listOperations("hermes")[0]!;
    expect(newest.kind).toBe("restore");
    const snapshot = store.readSnapshot(newest);
    expect(snapshot.kind).toBe("stored");
    if (snapshot.kind === "stored") expect(snapshot.text).toContain("# later edit");
  });

  test("refuses an operation whose snapshot was collected", () => {
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    const row = store.listOperations("hermes")[0]!;
    // Simulate GC having removed the bytes.
    rmSync(join(storeRoot, "snapshots", "hermes", row.opId), { force: true });

    const result = restoreIntegration({ ...input(), opId: row.opId });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("snapshot_expired");
  });
});

describe("nothing leaks", () => {
  test("no client file contains a credential after a full apply", () => {
    // Assembled at runtime so the privacy scanner does not flag the literal;
    // the point is that whatever the config holds must not reach the file.
    const secret = ["sk", "live", "should", "never", "appear"].join("-");
    const configPath = installHermes();
    applyIntegration(input({
      config: { ...CONFIG, apiKeys: [{ key: secret }] } as unknown as OcxConfig,
    }));
    expect(readFileSync(configPath, "utf8")).not.toContain(secret);
  });

  test("a failed record write rolls the file back and says so", () => {
    const configPath = installHermes();
    const original = "providers: {}\n";
    writeFileSync(configPath, original);
    const io: IntegrationIO = {
      ...fileIO(),
      appendJournal: entry => store.appendJournal(entry),
      putRecord: () => { throw new Error("record disk full"); },
      dropRecord: clientId => store.dropRecord(clientId),
    };

    const result = applyIntegration(input({ io }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("write_failed");
      expect(result.message).toContain("rolled back");
    }
    // The file is back to what it was; no half-applied state survives.
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(store.listOperations("hermes")).toHaveLength(0);
  });

  test("a failed journal append rolls back and leaves no phantom row", () => {
    const configPath = installHermes();
    const original = "providers: {}\n";
    writeFileSync(configPath, original);
    const io: IntegrationIO = {
      ...fileIO(),
      appendJournal: () => { throw new Error("journal disk full"); },
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    };

    const result = applyIntegration(input({ io }));
    expect(result.ok).toBe(false);
    expect(readFileSync(configPath, "utf8")).toBe(original);
    // The row is written last precisely so this cannot leave one behind.
    expect(store.listOperations("hermes")).toHaveLength(0);
    // And the record it wrote first is gone again.
    expect(store.readRecords().hermes).toBeUndefined();
  });

  test("when compensation itself fails, the result says residual instead of claiming a rollback", () => {
    installHermes();
    let writes = 0;
    const io: IntegrationIO = {
      ...fileIO(),
      writeText: (path, text) => {
        writes += 1;
        // First write succeeds (the apply); the compensating write fails.
        if (writes > 1) throw new Error("rollback also failed");
        fileIO().writeText(path, text);
      },
      appendJournal: () => { throw new Error("journal disk full"); },
      putRecord: record => store.putRecord(record),
      dropRecord: clientId => store.dropRecord(clientId),
    };
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");

    const result = applyIntegration(input({ io }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.residual).toBe(true);
      expect(result.message).toContain("intermediate state");
    }
  });

  test("a record for one home cannot authorize a write to another", () => {
    // Reproduction from the WP3 audit: apply in home A, then point the same
    // client at home B whose file happens to have identical bytes. The record
    // must not be accepted as ownership proof for a file it was not written for.
    const configA = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const appliedBytes = readFileSync(configA, "utf8");

    /*
     * Home B is built through the registry, not by hand. Hermes resolves to
     * `%LOCALAPPDATA%\hermes` on Windows and ignores the `home` argument
     * entirely there, so a hand-built `<home-b>/.hermes` left both homes
     * pointing at the SAME file — the record legitimately matched and the
     * refusal this test exists for never fired. `HERMES_HOME` is honored on
     * every platform, so it is what actually separates the two.
     */
    const otherHome = join(dirname(home), "home-b");
    const otherEnv = { HERMES_HOME: join(otherHome, ".hermes") } as NodeJS.ProcessEnv;
    const spec = INTEGRATION_CLIENTS.hermes;
    mkdirSync(spec.detectDir(otherEnv, otherHome), { recursive: true });
    const configB = spec.configPath(otherEnv, otherHome);
    expect(configB).not.toBe(configA);
    writeFileSync(configB, appliedBytes);

    const result = disableIntegration(input({ home: otherHome, env: otherEnv }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("conflict");
    expect(readFileSync(configB, "utf8")).toBe(appliedBytes);
  });

  test("restore refuses when the client now resolves to a different file", () => {
    installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    const opId = store.listOperations("hermes")[0]!.opId;

    // Same reason as the test above: only `HERMES_HOME` separates two homes on
    // every platform. A hand-built `<home-c>/.hermes` collapses onto the same
    // file as home A under Windows' `%LOCALAPPDATA%` resolution.
    const otherHome = join(dirname(home), "home-c");
    const otherEnv = { HERMES_HOME: join(otherHome, ".hermes") } as NodeJS.ProcessEnv;
    const spec = INTEGRATION_CLIENTS.hermes;
    mkdirSync(spec.detectDir(otherEnv, otherHome), { recursive: true });
    const configC = spec.configPath(otherEnv, otherHome);
    writeFileSync(configC, "providers:\n  mine:\n    api: http://keep\n");

    const result = restoreIntegration({ ...input({ home: otherHome, env: otherEnv }), opId });
    expect(result.ok).toBe(false);
    expect(readFileSync(configC, "utf8")).toContain("mine");
  });

  test("an empty container the user wrote survives disable", () => {
    // `providers: {}` is the user's line, not ours. Pruning it because it went
    // empty would delete something we never owned.
    const configPath = installHermes();
    writeFileSync(configPath, "providers: {}\n");
    expect(applyIntegration(input()).ok).toBe(true);
    expect(disableIntegration(input()).ok).toBe(true);

    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(doc).toEqual({ providers: {} });
  });
});

describe("overwriting a conflict on purpose", () => {
  /*
   * Conflict was a dead end. The writer refused unconditionally, the GUI locked
   * the switch, and the only way forward was editing the file by hand -- the
   * thing a dashboard exists to avoid. These prove the escape hatch is real AND
   * that it stays narrow: it waives the conflict refusal and nothing else.
   */

  test("replaces a block we did not write, and the original is restorable", () => {
    const configPath = installHermes();
    // A block occupying our exact paths that we never wrote: unowned-key.
    writeFileSync(configPath, "providers:\n  opencodex:\n    api: http://someone-else.invalid\n    note: hand written\n");
    const before = readFileSync(configPath, "utf8");

    // The default still refuses, which is what makes the opt-in meaningful.
    const refused = applyIntegration(input());
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("conflict");
    expect(readFileSync(configPath, "utf8")).toBe(before);

    const forced = overwriteIntegration(input());
    expect(forced.ok).toBe(true);
    if (!forced.ok) return;
    expect(forced.changed).toBe(true);
    expect(forced.state).toBe("current");

    const after = readFileSync(configPath, "utf8");
    expect(after).not.toContain("someone-else.invalid");
    expect(after).not.toContain("hand written");
    expect(readIntegrationState(input())).toMatchObject({ state: "current" });

    // Journaled as its own kind: "applied" would be a lie about an operation that
    // replaced somebody else's block, and this list is where a user looks after a
    // mistake.
    const operations = store.listOperations("hermes");
    expect(operations).toHaveLength(1);
    expect(operations[0]!.kind).toBe("overwrite");

    // And it is undoable, byte for byte.
    const undone = restoreIntegration({ ...input(), opId: operations[0]!.opId });
    expect(undone.ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("discards an edit inside our own block without stranding what the old record owned", () => {
    const configPath = installHermes();
    expect(applyIntegration(input()).ok).toBe(true);
    writeFileSync(configPath, readFileSync(configPath, "utf8").replace(
      "api_mode: chat_completions",
      "api_mode: user_edited",
    ));
    expect(readIntegrationState(input())).toMatchObject({ state: "conflict", reason: "foreign-edit" });

    expect(overwriteIntegration(input()).ok).toBe(true);

    const after = readFileSync(configPath, "utf8");
    expect(after).not.toContain("api_mode: user_edited");
    expect(after).toContain("api_mode: chat_completions");
    /*
     * A foreign-edit force drops what the PREVIOUS record owned before merging,
     * the same way a stale refresh does. Without that, a path the old record
     * covered and the new one does not would be stranded, unremovable by any
     * later disable -- so disable has to return the file to a clean absence.
     */
    expect(disableIntegration(input()).ok).toBe(true);
    expect(readFileSync(configPath, "utf8")).not.toContain("opencodex");
  });

  test("leaves the user's own containers standing after a forced apply is disabled", () => {
    const configPath = installHermes();
    // The user already owns `providers`, and something they wrote sits in our slot.
    writeFileSync(configPath, "providers:\n  mine:\n    api: http://user.invalid\n  opencodex:\n    api: http://squatter.invalid\n");

    expect(overwriteIntegration(input()).ok).toBe(true);
    expect(disableIntegration(input()).ok).toBe(true);

    const doc = Bun.YAML.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
    // We did not create `providers`, so pruning it would be a second act of
    // destruction after the one the user actually authorized.
    expect(doc.providers).toBeDefined();
    expect((doc.providers as Record<string, unknown>).mine).toEqual({ api: "http://user.invalid" });
    expect((doc.providers as Record<string, unknown>).opencodex).toBeUndefined();
  });

  test("still refuses an unsafe document, where a snapshot is not a licence", () => {
    const configPath = installHermes();
    /*
     * A non-object where we would have to write a section. The merge would
     * replace a value it cannot reason about, so forcing it is data loss with a
     * receipt -- the force path must not reach it.
     */
    writeFileSync(configPath, "providers: not-a-mapping\n");
    const before = readFileSync(configPath, "utf8");

    const result = overwriteIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("unsafe");
    expect(readFileSync(configPath, "utf8")).toBe(before);
  });

  test("behaves exactly like apply when there is no conflict to overwrite", () => {
    installHermes();
    /*
     * Not a way to skip any other check: on a clean file this is an ordinary
     * apply, journaled as one, and on an already-current file it is the same
     * no-op apply performs.
     */
    const first = overwriteIntegration(input());
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.changed).toBe(true);
    expect(store.listOperations("hermes")[0]!.kind).toBe("apply");

    const second = overwriteIntegration(input());
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.changed).toBe(false);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });

  test("refuses a client that is not installed", () => {
    // installHermes() deliberately not called: a missing client is not a conflict.
    const result = overwriteIntegration(input());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("not_installed");
  });

  test("drops a path only the OLD record owned, so nothing is left unremovable", () => {
    /*
     * The stranding case the sibling test above cannot see. When every path the
     * old record owned is also a path the new contribution writes, dropping the
     * old fragments first changes nothing observable -- the merge overwrites them
     * anyway. The drop only matters when the layouts DISAGREE, which is what an
     * upgrade leaves behind: a path we owned under the previous shape and no
     * longer write. Without the drop, the replacement record never covers it, so
     * no later disable can ever remove it.
     */
    const configPath = installOpencode();
    const request = input({ clientId: "opencode" });
    expect(applyIntegration(request).ok).toBe(true);

    const document = JSON.parse(readFileSync(configPath, "utf8")) as {
      providers: Record<string, Record<string, unknown>>;
    };
    document.providers["opencodex-legacy"] = { api: "http://legacy.invalid" };
    // An edit inside a fragment we DO own is what makes this a foreign-edit
    // conflict rather than ordinary drift.
    document.providers.opencodex!.options = { baseURL: "http://user-edited.invalid" };
    writeFileSync(configPath, `${JSON.stringify(document, null, 2)}\n`);

    const record = { ...store.readRecords().opencode! };
    record.fragmentPaths = [...record.fragmentPaths, ["providers", "opencodex-legacy"]];
    store.putRecord(record);
    expect(readIntegrationState(request)).toMatchObject({ state: "conflict", reason: "foreign-edit" });

    expect(overwriteIntegration(request).ok).toBe(true);

    const after = JSON.parse(readFileSync(configPath, "utf8")) as {
      providers: Record<string, unknown>;
    };
    expect(after.providers["opencodex-legacy"]).toBeUndefined();
    expect(after.providers.opencodex).toBeDefined();
    expect(store.readRecords().opencode!.fragmentPaths).not.toContainEqual(["providers", "opencodex-legacy"]);
  });
});
