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
  type ExportModel,
} from "../../src/clients/config-export";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { exportContextOf, readIntegrationState, readPath } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import {
  applyIntegration,
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

/** The rule paths, spelled the way the contribution spells them. */
const OUR_PROVIDER_RULE = [...ZCODE_STORE_PROVIDER_RULES_PATH, `[providerId=${OPENCODE_PROVIDER_ID}]`];
const ourModelRule = (modelId: string) => [
  ...ZCODE_STORE_MODEL_RULES_PATH,
  `[providerId=${OPENCODE_PROVIDER_ID},modelId=${modelId}]`,
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
    expect(readPath(readStore(), [...ZCODE_STORE_MODEL_RULES_PATH, "[providerId=their-provider,modelId=anthropic/claude-opus-4-8]"]))
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
