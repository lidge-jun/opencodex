import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  OPENCODE_PROVIDER_ID,
  ZCODE_STORE_MODEL_RULES_PATH,
  ZCODE_STORE_PROVIDER_RULES_PATH,
  ZCODE_STORE_SCHEMA_VERSION,
  buildZcodeStoreProviderRule,
  zcodeHomeDir,
  zcodeConfigPath,
  zcodeProviderStorePath,
  zcodeBootstrapSettingsPath,
  type ZcodeStoreProviderRule,
  type ExportModel,
} from "../../src/clients/config-export";
import { formatSelectorConjunction } from "../../src/integrations/merge";
import { DYNAMIC_SEGMENT, previewIntegration } from "../../src/integrations/mutation-plan";
import { fingerprint } from "../../src/integrations/ownership";
import { INTEGRATION_CLIENTS, resolveIntegrationPaths } from "../../src/integrations/registry";
import type { ReadResult } from "../../src/integrations/config-io";
import { exportContextOf, readIntegrationState, readPath } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration,
  applyIntegrationCoordinated,
  disableIntegration,
  overwriteIntegration,
  refreshIntegration,
  restoreIntegration,
  type IntegrationWriteInput,
} from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

/**
 * Writing the store the client actually reads (#5348).
 *
 * The sibling file covers the refusal, which is what happens when this file's
 * precondition fails. Here the store carries a schema whose shape has been
 * observed, so enable, refresh and disable all act on it — and the properties
 * worth pinning are the ones that make that safe rather than merely working:
 * a rule the user owns is never taken over, a rule belonging to another
 * provider is never matched by ours, and the client's file is never deleted.
 *
 * Every location comes from the exported schema constants rather than a
 * literal, so a change to where the store keeps its rules moves the fixture
 * with the source instead of leaving it green against a shape nobody writes.
 */
let home: string;
let store: IntegrationStateStore;

const TEST_ENV = {} as NodeJS.ProcessEnv;

const MODELS: ExportModel[] = [
  { namespaced: "anthropic/claude-opus-4-8", provider: "anthropic", id: "claude-opus-4-8", contextWindow: 200_000 },
];

const MORE_MODELS: ExportModel[] = [
  ...MODELS,
  { namespaced: "xai/grok-4-2", provider: "xai", id: "grok-4-2", contextWindow: 256_000 },
];

const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as unknown as OcxConfig;

const spec = () => INTEGRATION_CLIENTS.zcode;

function conjunction(criteria: Parameters<typeof formatSelectorConjunction>[0]): string {
  const selector = formatSelectorConjunction(criteria);
  if (selector === null) throw new Error("test fixture must be a valid conjunction");
  return selector;
}

function withoutLastCriterion(selector: string): string {
  const separator = selector.lastIndexOf(",");
  if (separator < 0) throw new Error("test fixture must contain multiple criteria");
  return `${selector.slice(0, separator)}${selector.slice(-1)}`;
}

/** The rule paths, spelled the way the contribution spells them. */
const OUR_PROVIDER_RULE = [...ZCODE_STORE_PROVIDER_RULES_PATH, `[providerId=${OPENCODE_PROVIDER_ID}]`];
const ourModelRule = (modelId: string) => [
  ...ZCODE_STORE_MODEL_RULES_PATH,
  conjunction([
    { field: "providerId", value: OPENCODE_PROVIDER_ID },
    { field: "modelId", value: modelId },
  ]),
];

beforeEach(() => {
  const base = mkdtempSync(join(tmpdir(), "ocx-current-store-"));
  home = join(base, "home");
  mkdirSync(home, { recursive: true });
  store = createIntegrationStateStore(join(base, "store", "integrations"));
});

afterEach(() => {
  removeTreeWithRetry(dirname(home));
});

function configPath(): string {
  return spec().configPath(TEST_ENV, home);
}

function storePath(): string {
  return spec().currentStore!.path(TEST_ENV, home);
}

/** Install the client and give it a store the way a first launch would. */
function installWithStore(contents: unknown = { schemaVersion: ZCODE_STORE_SCHEMA_VERSION, config: {} }): string {
  mkdirSync(spec().detectDir(TEST_ENV, home), { recursive: true });
  mkdirSync(dirname(configPath()), { recursive: true });
  const path = storePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`);
  return path;
}

function readStore(): unknown {
  return JSON.parse(readFileSync(storePath(), "utf8"));
}

function input(overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
  return { clientId: "zcode", models: MODELS, config: CONFIG, port: 10100, env: TEST_ENV, home, store, ...overrides };
}

describe("writing the provider store the client reads", () => {
  test("enable puts the intended provider in the store, and leaves the config file alone", () => {
    const path = installWithStore();

    const result = applyIntegration(input());

    expect(result.ok).toBe(true);
    // The whole point: the rule is in the file the client opens, in the shape
    // that file's reader understands.
    // Compared against the builder through the same context the writer derives,
    // so the base URL is the one `ocx export` composes rather than a literal.
    expect(readPath(readStore(), OUR_PROVIDER_RULE))
      .toEqual(buildZcodeStoreProviderRule(exportContextOf(input())));
    const writtenRule = readPath(readStore(), OUR_PROVIDER_RULE) as ZcodeStoreProviderRule;
    expect(writtenRule.config.access.type).toBe("api-key");
    expect(readPath(readStore(), ourModelRule("anthropic/claude-opus-4-8")))
      .toMatchObject({ config: { properties: { contextWindow: 200_000 } } });
    // And nothing was written to the file it stopped reading.
    expect(existsSync(configPath())).toBe(false);
    // Ownership follows the file that was written, so a later disable removes
    // from there rather than from the config path.
    expect(store.readRecords().zcode?.configPath).toBe(path);
  });

  test("status reports the store as the file this integration is about", () => {
    const path = installWithStore();
    expect(applyIntegration(input()).ok).toBe(true);

    const status = readIntegrationState(input());

    expect(status).toMatchObject({ state: "current", configPath: path });
    // No notice, because there is no second file the client reads instead.
    expect(status.supersededBy).toBeUndefined();
  });

  test("a catalog refresh updates the store rather than reporting nothing to do", () => {
    installWithStore();
    expect(applyIntegration(input()).ok).toBe(true);

    const refreshed = refreshIntegration(input({ models: MORE_MODELS }));

    expect(refreshed.ok).toBe(true);
    const rule = readPath(readStore(), OUR_PROVIDER_RULE) as { config: { personalModelIds: string[] } };
    expect(rule.config.personalModelIds).toEqual(MORE_MODELS.map(model => model.namespaced).sort());
    expect(readPath(readStore(), ourModelRule("xai/grok-4-2"))).toBeDefined();
  });

  test("an unrepresentable model stays in the provider roster without a model-rule fragment", () => {
    const unrepresentable: ExportModel = {
      namespaced: "anthropic/model,variant",
      provider: "anthropic",
      id: "model,variant",
      contextWindow: 128_000,
    };
    installWithStore();
    expect(applyIntegration(input({ models: [...MODELS, unrepresentable] })).ok).toBe(true);

    const provider = readPath(readStore(), OUR_PROVIDER_RULE) as { config: { personalModelIds: string[] } };
    const rules = readPath(readStore(), ZCODE_STORE_MODEL_RULES_PATH) as Array<{ modelId: string }>;
    expect(provider.config.personalModelIds).toContain(unrepresentable.namespaced);
    expect(rules.map(rule => rule.modelId)).toEqual(MODELS.map(model => model.namespaced));
  });

  test("disable leaves nothing this project put in the store, and keeps the file", () => {
    const theirProvider = { providerId: "their-provider", enabled: true, providerName: "Theirs", config: {} };
    const theirModel = {
      providerId: "their-provider",
      // The SAME model id as ours, under a different provider. A selector naming
      // only the model would have matched this rule and replaced it.
      modelId: "anthropic/claude-opus-4-8",
      config: { properties: { contextWindow: 1 } },
    };
    installWithStore({
      schemaVersion: ZCODE_STORE_SCHEMA_VERSION,
      config: {
        providerConfigRules: { providerRules: [theirProvider] },
        modelConfigRules: { providerModelRules: [theirModel] },
      },
    });
    expect(applyIntegration(input()).ok).toBe(true);
    expect(readPath(readStore(), ourModelRule("anthropic/claude-opus-4-8"))).toBeDefined();

    const disabled = disableIntegration(input());

    expect(disabled.ok).toBe(true);
    expect(readPath(readStore(), OUR_PROVIDER_RULE)).toBeUndefined();
    expect(readPath(readStore(), ourModelRule("anthropic/claude-opus-4-8"))).toBeUndefined();
    // Theirs survives, including the model rule our selector deliberately does
    // not match, and the file itself is still the file the client reads.
    expect(readPath(readStore(), [...ZCODE_STORE_PROVIDER_RULES_PATH, "[providerId=their-provider]"]))
      .toEqual(theirProvider);
    expect(readPath(readStore(), [...ZCODE_STORE_MODEL_RULES_PATH, conjunction([
      { field: "providerId", value: "their-provider" },
      { field: "modelId", value: "anthropic/claude-opus-4-8" },
    ])]))
      .toEqual(theirModel);
    expect(existsSync(storePath())).toBe(true);
    expect(readIntegrationState(input())).toMatchObject({ state: "absent" });
  });

  test("a rule the user owns is not taken over, and overwrite is the only way past it", () => {
    // The shape the client's own migration produces: our provider id, in the
    // store, with no ownership record of ours behind it.
    const migrated = {
      providerId: OPENCODE_PROVIDER_ID,
      enabled: false,
      providerName: "Hand edited",
      config: { personalModelIds: ["kept"] },
    };
    installWithStore({
      schemaVersion: ZCODE_STORE_SCHEMA_VERSION,
      config: { providerConfigRules: { providerRules: [migrated] } },
    });

    const refused = applyIntegration(input());

    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("conflict");
    expect(readPath(readStore(), OUR_PROVIDER_RULE)).toEqual(migrated);

    expect(overwriteIntegration(input()).ok).toBe(true);
    expect(readPath(readStore(), OUR_PROVIDER_RULE)).toMatchObject({ enabled: true });
  });

  test("a schema we cannot establish falls back to reporting the write as ineffective", () => {
    // One past the version whose shape has been observed. The file is perfectly
    // readable; what is missing is any basis for asserting a nesting inside it.
    const path = installWithStore({ schemaVersion: ZCODE_STORE_SCHEMA_VERSION + 1, config: {} });
    const before = readFileSync(path, "utf8");

    const result = applyIntegration(input());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("superseded_store");
      expect(result.message).toContain(path);
    }
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(configPath())).toBe(false);
    expect(readIntegrationState(input()).supersededBy).toBe(path);
  });

  test("a block applied before the client moved keeps the operation on that file", () => {
    // Applied while the client still read its config file...
    mkdirSync(spec().detectDir(TEST_ENV, home), { recursive: true });
    mkdirSync(dirname(configPath()), { recursive: true });
    expect(applyIntegration(input()).ok).toBe(true);
    // ...and only then does the client create the store it reads now.
    const path = installWithStore();

    const refused = refreshIntegration(input({ models: MORE_MODELS }));

    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.reason).toBe("superseded_store");
      // Both files, because the remedy names both.
      expect(refused.message).toContain(configPath());
      expect(refused.message).toContain(path);
    }
    // Nothing was orphaned: the store is untouched and our block is still
    // where the record says it is, so disable can remove it.
    expect(readPath(readStore(), OUR_PROVIDER_RULE)).toBeUndefined();
    expect(readIntegrationState(input())).toMatchObject({ state: "current", configPath: configPath(), supersededBy: path });

    expect(disableIntegration(input()).ok).toBe(true);
    expect(readFileSync(configPath(), "utf8")).not.toContain("opencodex");
    // And now the same switch reaches the client.
    expect(applyIntegration(input()).ok).toBe(true);
    expect(readPath(readStore(), OUR_PROVIDER_RULE)).toBeDefined();
  });

  test("an unreadable recorded selector keeps a config-file operation on that file", () => {
    mkdirSync(spec().detectDir(TEST_ENV, home), { recursive: true });
    mkdirSync(dirname(configPath()), { recursive: true });
    expect(applyIntegration(input()).ok).toBe(true);
    const record = store.readRecords().zcode!;
    const malformed = withoutLastCriterion(conjunction([
      { field: "providerId", value: OPENCODE_PROVIDER_ID },
      { field: "modelId", value: MODELS[0]!.namespaced },
    ]));
    store.putRecord({
      ...record,
      fragmentPaths: [[...ZCODE_STORE_MODEL_RULES_PATH, malformed]],
    });
    const currentStorePath = installWithStore();

    expect(readIntegrationState(input())).toMatchObject({
      state: "unsafe",
      reason: "unparseable",
      configPath: configPath(),
      supersededBy: currentStorePath,
    });
    expect(readPath(readStore(), OUR_PROVIDER_RULE)).toBeUndefined();
  });

  test("restore preview treats an unreadable prior selector as an unknown replacement", () => {
    const path = installWithStore();
    expect(applyIntegration(input()).ok).toBe(true);
    const priorRecord = store.readRecords().zcode!;
    const malformed = withoutLastCriterion(conjunction([
      { field: "providerId", value: OPENCODE_PROVIDER_ID },
      { field: "modelId", value: MODELS[0]!.namespaced },
    ]));
    const before = readFileSync(path, "utf8");
    const opId = "restore-malformed-selector";
    store.appendJournal({
      opId,
      clientId: "zcode",
      kind: "refresh",
      at: "2026-09-21T00:00:00.000Z",
      configPath: path,
      snapshot: store.captureSnapshot("zcode", opId, before),
      resultFingerprint: fingerprint(before),
      resultAbsent: false,
      priorRecord: {
        ...priorRecord,
        fragmentPaths: [[...ZCODE_STORE_MODEL_RULES_PATH, malformed]],
      },
    });

    const plan = previewIntegration(input(), { operation: "restore", opId });

    expect(plan.canApply).toBe(true);
    expect(plan.refusalReason).toBeUndefined();
    expect(plan.changes).toContainEqual({
      kind: "replace",
      path: `${ZCODE_STORE_MODEL_RULES_PATH.join(".")}.${DYNAMIC_SEGMENT}`,
    });
  });

  test("an undo of a store apply puts the store back", () => {
    const path = installWithStore();
    const before = readFileSync(path, "utf8");
    const applied = applyIntegration(input());
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Undo used to require the row to name the config file, which would have
    // made every store operation unrestorable.
    const undone = restoreIntegration({ ...input(), opId: applied.opId! });

    expect(undone.ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("the plan publishes the managed template, never a model id", () => {
    installWithStore();

    const plan = previewIntegration(input(), { operation: "apply" });

    expect(plan.canApply).toBe(true);
    const paths = plan.changes.map(change => change.path);
    expect(paths).toContain(`${ZCODE_STORE_PROVIDER_RULES_PATH.join(".")}.[providerId=${OPENCODE_PROVIDER_ID}]`);
    // The model rule carries the model id inside its own selector, so the
    // published segment is the dynamic template and the id never leaves.
    expect(paths.some(path => path.includes("anthropic/claude-opus-4-8"))).toBe(false);
  });
});


/** Bootstrap bytes are synthetic; writer/snapshot IO is bound to the temporary home/store. */
function bootstrapInput(read: ReadResult, overrides: Partial<IntegrationWriteInput> = {}): IntegrationWriteInput {
  const io = store.io();
  const bootstrap = zcodeBootstrapSettingsPath(home);
  return input({ ...overrides, io: { ...io, readText: path => path === bootstrap ? read : io.readText(path) } });
}
function relocatedInput(base = join(home, "relocated")): IntegrationWriteInput {
  return bootstrapInput({ kind: "text", text: JSON.stringify({ dataBaseDir: base }) });
}
function installResolvedStore(request: IntegrationWriteInput): string {
  const paths = resolveIntegrationPaths("zcode", request.env, request.home, undefined, request.io);
  mkdirSync(join(paths.detectDir, "v2"), { recursive: true });
  mkdirSync(dirname(paths.storePath!), { recursive: true });
  writeFileSync(paths.storePath!, JSON.stringify({ schemaVersion: ZCODE_STORE_SCHEMA_VERSION, config: {} }));
  return paths.storePath!;
}

/**
 * restoreIntegration re-stamps the restored ownership record with its own opId and time (see the
 * record written in src/integrations/writer.ts). Every other field -- path, fingerprints,
 * fragments, refreshable paths -- must be exactly the original record's.
 */
function expectRestoreRestamped(restored: ReturnType<typeof restoreIntegration>, prior: object): void {
  expect(restored.ok).toBe(true);
  if (!restored.ok || !restored.opId) throw new Error("restore did not return an operation id");
  const entry = store.findOperation(restored.opId);
  expect(entry).toMatchObject({ kind: "restore", opId: restored.opId });
  const record: unknown = store.readRecords().zcode;
  expect(record).toEqual({ ...prior, opId: restored.opId, appliedAt: entry!.at });
}

describe("ZCode bootstrap dataBaseDir (#6932)", () => {
  test("default roots and an absent dataBaseDir preserve current-store detection", () => {
    const path = installWithStore();
    for (const read of [{ kind: "missing" }, { kind: "text", text: "{}" }] as ReadResult[]) {
      const request = bootstrapInput(read);
      const paths = resolveIntegrationPaths("zcode", {}, home, undefined, request.io);
      expect(paths).toMatchObject({ configPath: configPath(), detectDir: join(home, ".zcode"), storePath: path });
      expect(previewIntegration(request, { operation: "apply" }).canApply).toBe(true);
    }
  });

  test("relocation resolves above .zcode and reads only the default-home bootstrap", () => {
    const base = join(home, "custom", ".zcode");
    const request = relocatedInput(base);
    const bootstrap = zcodeBootstrapSettingsPath(home);
    const reads: string[] = [];
    const io = { readText: (path: string): ReadResult => {
      reads.push(path);
      expect(path).toBe(bootstrap);
      return { kind: "text", text: JSON.stringify({ dataBaseDir: base }) };
    } };
    const root = join(base, ".zcode");
    expect(zcodeHomeDir({}, home, io)).toBe(root);
    expect(zcodeConfigPath({}, home, io)).toBe(join(root, "v2", "config.json"));
    expect(zcodeProviderStorePath({}, home, io)).toBe(join(root, "v2", "provider_config.json"));
    expect(spec().detectDir({}, home, io)).toBe(root);
    expect(spec().currentStore!.path({}, home, io)).toBe(join(root, "v2", "provider_config.json"));
    expect(reads.length).toBe(5);
    const paths = resolveIntegrationPaths("zcode", {}, home, undefined, request.io);
    expect(paths.detectDir).toBe(root);
  });

  test("status, preview, apply, refresh, disable and undo agree on the relocated store", () => {
    const request = relocatedInput();
    const path = installResolvedStore(request);
    const original = readFileSync(path, "utf8");
    expect(readIntegrationState(request)).toMatchObject({ installed: true, configPath: path, state: "absent" });
    expect(previewIntegration(request, { operation: "apply" }).canApply).toBe(true);
    const applied = applyIntegration(request);
    expect(applied.ok).toBe(true);
    expect(store.readRecords().zcode?.configPath).toBe(path);
    expect(readIntegrationState(request)).toMatchObject({ configPath: path, state: "current" });
    expect(refreshIntegration({ ...request, models: MORE_MODELS }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("xai/grok-4-2");
    const disabled = disableIntegration({ ...request, models: MORE_MODELS });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(previewIntegration(request, { operation: "restore", opId: disabled.opId! }).canApply).toBe(true);
    expect(restoreIntegration({ ...request, opId: disabled.opId! }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toContain("opencodex");
    // Explicit drift confirmation undoes the earlier apply after a catalog refresh.
    if (!applied.ok) return;
    expect(restoreIntegration({ ...request, opId: applied.opId!, confirmDrift: true }).ok).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(existsSync(join(home, ".zcode", "v2", "config.json"))).toBe(false);
  });

  test("ZCODE_DATA_DIR is an exact root override and bypasses invalid bootstrap settings", () => {
    const root = join(home, "explicit-root");
    const request = bootstrapInput({ kind: "failed" }, { env: { ZCODE_DATA_DIR: root } });
    const path = installResolvedStore(request);
    const io = { readText: (_path: string): ReadResult => { throw new Error("override must not read bootstrap"); } };
    expect(zcodeHomeDir(request.env, home, io)).toBe(root);
    expect(zcodeProviderStorePath(request.env, home, io)).toBe(join(root, "v2", "provider_config.json"));
    expect(applyIntegration(request).ok).toBe(true);
    expect(readIntegrationState(request).configPath).toBe(path);
  });

  test("ZCODE_PERSONAL_PROVIDER_CONFIG_FILE wins over relocation and ZCODE_DATA_DIR", () => {
    const path = join(home, "explicit-provider.json");
    const request = bootstrapInput({ kind: "text", text: JSON.stringify({ dataBaseDir: join(home, "relocated") }) }, {
      env: { ZCODE_DATA_DIR: join(home, "explicit-root"), ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path },
    });
    expect(installResolvedStore(request)).toBe(path);
    expect(applyIntegration(request).ok).toBe(true);
    expect(readIntegrationState(request)).toMatchObject({ state: "current", configPath: path });
    expect(restoreIntegration({ ...request, opId: store.readRecords().zcode!.opId }).ok).toBe(true);
  });

  test("an explicit provider file establishes the target despite unreadable bootstrap settings", () => {
    const path = join(home, "explicit-provider.json");
    const request = bootstrapInput({ kind: "failed" }, { env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: path } });
    installResolvedStore(request);
    expect(previewIntegration(request, { operation: "apply" }).canApply).toBe(true);
    expect(applyIntegration(request).ok).toBe(true);
    expect(readIntegrationState(request)).toMatchObject({ state: "current", configPath: path });
    expect(restoreIntegration({ ...request, opId: store.readRecords().zcode!.opId }).ok).toBe(true);
  });

  test("an absent explicit provider file cannot justify a legacy write when the root is unknown", () => {
    installZcodeLegacyDirectory();
    const request = bootstrapInput({ kind: "failed" }, { env: { ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: join(home, "missing.json") } });
    expect(applyIntegration(request)).toMatchObject({ ok: false, reason: "unsafe" });
    expect(existsSync(configPath())).toBe(false);
  });

  test("relative, malformed and unreadable settings block all writes without legacy fallback", () => {
    installWithStore();
    const bad: ReadResult[] = [
      { kind: "failed", code: "EACCES" }, { kind: "text", text: "{" },
      { kind: "text", text: "[]" }, { kind: "text", text: "null" },
      ...["relative", "~/relocated", "", null, 42].map(dataBaseDir => ({ kind: "text" as const, text: JSON.stringify({ dataBaseDir }) })),
    ];
    const original = readFileSync(storePath(), "utf8");
    for (const read of bad) {
      const request = bootstrapInput(read);
      expect(readIntegrationState(request)).toMatchObject({ state: "unsafe", reason: "unresolvable-path" });
      expect(previewIntegration(request, { operation: "apply" })).toMatchObject({ canApply: false, willChange: false, refusalReason: "unsafe" });
      for (const write of [applyIntegration, refreshIntegration, overwriteIntegration]) {
        const result = write(request);
        expect(result).toMatchObject({ ok: false, reason: "unsafe" });
        if (!result.ok) expect(result.message).toContain("active data root is unknown");
      }
      expect(existsSync(configPath())).toBe(false);
      expect(store.readRecords().zcode).toBeUndefined();
      expect(store.listOperations("zcode")).toEqual([]);
      expect(readFileSync(storePath(), "utf8")).toBe(original);
    }
  });

  test("native ZCODE_DATA_BASE_DIR is not given ZCODE_DATA_DIR suffix semantics", () => {
    const request = relocatedInput();
    const env = { ZCODE_DATA_BASE_DIR: join(home, "native-selector") };
    expect(zcodeHomeDir(env, home, request.io)).toBe(join(home, "relocated", ".zcode"));
  });

  test("legacy ownership, fingerprints and recovery remain intact after relocation", () => {
    installZcodeLegacyDirectory();
    const legacy = configPath();
    const applied = applyIntegration(input());
    expect(applied.ok).toBe(true);
    const prior = store.readRecords().zcode!;
    const original = readFileSync(legacy, "utf8");
    const request = relocatedInput();
    const path = installResolvedStore(request);
    const newStore = readFileSync(path, "utf8");
    expect(readIntegrationState(request)).toMatchObject({ state: "current", configPath: legacy, supersededBy: path, supersededReason: "owned-config-file" });
    expect(previewIntegration(request, { operation: "apply" })).toMatchObject({ canApply: false, supersededReason: "owned-config-file" });
    expect(applyIntegration(request)).toMatchObject({ ok: false, reason: "superseded_store" });
    expect(refreshIntegration({ ...request, models: MORE_MODELS })).toMatchObject({ ok: false, reason: "superseded_store" });
    expect(store.readRecords().zcode).toEqual(prior);
    expect(readFileSync(legacy, "utf8")).toBe(original);
    expect(readFileSync(path, "utf8")).toBe(newStore);
    const disabled = disableIntegration(request);
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(readFileSync(legacy, "utf8")).not.toContain("opencodex");
    expect(previewIntegration(request, { operation: "restore", opId: disabled.opId! }).canApply).toBe(true);
    const restored = restoreIntegration({ ...request, opId: disabled.opId! });
    expect(readFileSync(legacy, "utf8")).toBe(original);
    expectRestoreRestamped(restored, prior);
    expect(readFileSync(path, "utf8")).toBe(newStore);
  });

  test("existing default-store ownership is retained for disable and undo after relocation", () => {
    const originalPath = installWithStore();
    expect(applyIntegration(input()).ok).toBe(true);
    const prior = store.readRecords().zcode!;
    const original = readFileSync(originalPath, "utf8");
    const request = relocatedInput();
    const relocatedPath = installResolvedStore(request);
    const relocatedBytes = readFileSync(relocatedPath, "utf8");
    expect(readIntegrationState(request)).toMatchObject({ configPath: originalPath, state: "current", supersededBy: relocatedPath });
    expect(refreshIntegration(request)).toMatchObject({ ok: false, reason: "superseded_store" });
    expect(store.readRecords().zcode).toEqual(prior);
    const disabled = disableIntegration(request);
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(previewIntegration(request, { operation: "restore", opId: disabled.opId! }).canApply).toBe(true);
    const restored = restoreIntegration({ ...request, opId: disabled.opId! });
    expect(readFileSync(originalPath, "utf8")).toBe(original);
    expect(readFileSync(relocatedPath, "utf8")).toBe(relocatedBytes);
    expectRestoreRestamped(restored, prior);
  });

  test("legacy ownership does not refresh into a moved root whose store is absent", () => {
    installZcodeLegacyDirectory();
    expect(applyIntegration(input()).ok).toBe(true);
    const prior = store.readRecords().zcode!;
    const request = relocatedInput();
    mkdirSync(join(home, "relocated", ".zcode"), { recursive: true });
    expect(refreshIntegration(request)).toMatchObject({ ok: false, reason: "superseded_store" });
    expect(store.readRecords().zcode).toEqual(prior);
    expect(existsSync(join(home, "relocated", ".zcode", "v2", "config.json"))).toBe(false);
    expect(disableIntegration(request).ok).toBe(true);
  });

  test("unknown bootstrap keeps legacy recovery usable and never refreshes it", () => {
    installZcodeLegacyDirectory();
    expect(applyIntegration(input()).ok).toBe(true);
    const prior = store.readRecords().zcode!;
    const request = bootstrapInput({ kind: "failed" });
    expect(readIntegrationState(request)).toMatchObject({ state: "unsafe", configPath: prior.configPath, lastOpId: prior.opId, reason: "unresolvable-path" });
    expect(refreshIntegration(request)).toMatchObject({ ok: false, reason: "unsafe" });
    expect(store.readRecords().zcode).toEqual(prior);
    const disabled = disableIntegration(request);
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(previewIntegration(request, { operation: "restore", opId: disabled.opId! }).canApply).toBe(true);
    const restored = restoreIntegration({ ...request, opId: disabled.opId! });
    expectRestoreRestamped(restored, prior);
  });

  test("an older legacy undo cannot orphan the relocated store's ownership", () => {
    installZcodeLegacyDirectory();
    expect(applyIntegration(input()).ok).toBe(true);
    const disabled = disableIntegration(input());
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    const request = relocatedInput();
    const path = installResolvedStore(request);
    expect(applyIntegration(request).ok).toBe(true);
    const current = store.readRecords().zcode!;
    const original = readFileSync(path, "utf8");
    expect(previewIntegration(request, { operation: "restore", opId: disabled.opId! })).toMatchObject({ canApply: false, refusalReason: "conflict" });
    expect(restoreIntegration({ ...request, opId: disabled.opId!, confirmDrift: true })).toMatchObject({ ok: false, reason: "conflict" });
    expect(store.readRecords().zcode).toEqual(current);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(readFileSync(configPath(), "utf8")).not.toContain("opencodex");
  });

  test("an unrecognized earlier selector cannot silently abandon an existing owner", () => {
    const old = bootstrapInput({ kind: "missing" }, { env: { ZCODE_DATA_DIR: join(home, "earlier-root") } });
    const oldPath = installResolvedStore(old);
    expect(applyIntegration(old).ok).toBe(true);
    const prior = store.readRecords().zcode!;
    const request = relocatedInput();
    const newPath = installResolvedStore(request);
    const newBytes = readFileSync(newPath, "utf8");
    expect(readIntegrationState(request)).toMatchObject({ state: "unsafe", configPath: oldPath, lastOpId: prior.opId });
    expect(applyIntegration(request)).toMatchObject({ ok: false, reason: "unsafe" });
    expect(disableIntegration(request)).toMatchObject({ ok: false, reason: "unsafe" });
    expect(store.readRecords().zcode).toEqual(prior);
    expect(readFileSync(newPath, "utf8")).toBe(newBytes);
    expect(disableIntegration(old).ok).toBe(true);
  });

  test("coordinated apply re-observes bootstrap changes after revalidation", async () => {
    installWithStore();
    const request = relocatedInput();
    const path = installResolvedStore(request);
    let relocated = false;
    const io = store.io();
    const bootstrap = zcodeBootstrapSettingsPath(home);
    const mutable = { ...input(), io: { ...io, readText: (target: string): ReadResult =>
      target === bootstrap ? { kind: "text", text: JSON.stringify(relocated ? { dataBaseDir: join(home, "relocated") } : {}) } : io.readText(target) } };
    const before = previewIntegration(mutable, { operation: "apply" });
    const result = await applyIntegrationCoordinated(mutable, { revalidate: async () => { relocated = true; return null; } });
    expect(result.ok).toBe(true);
    expect(store.readRecords().zcode?.configPath).toBe(path);
    expect(readIntegrationState(mutable).configPath).toBe(path);
    expect(previewIntegration(mutable, { operation: "apply" }).fingerprint).not.toBe(before.fingerprint);
    expect(existsSync(configPath())).toBe(false);
  });
});

function installZcodeLegacyDirectory(): void {
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
}
