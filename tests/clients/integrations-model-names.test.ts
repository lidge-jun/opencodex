import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, refreshIntegration, refreshIntegrationCoordinated, restoreIntegration } from "../../src/integrations/writer";
import { previewIntegration } from "../../src/integrations/mutation-plan";
import { readIntegrationState } from "../../src/integrations/state";
import { isOwnershipRecord } from "../../src/integrations/ownership";
import { hermesProfileStore } from "../../src/integrations/hermes-profiles";
import { parseConfig } from "../../src/integrations/config-io";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { namingConfig, namingModels, exportedKeys, ALIAS_KEYS, ROUTED_KEYS } from "../helpers/export-model-names";

let root: string;
let store: IntegrationStateStore;
const policyOf = (client: "hermes" | "commandcode") => (store.readRecords()[client] as unknown as { modelNames?: unknown }).modelNames;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ocx-naming-")); store = createIntegrationStateStore(join(root, "integrations")); });
afterEach(() => removeTreeWithRetry(root));

describe("persisted integration model names", () => {
  for (const clientId of ["hermes", "commandcode"] as const) {
    async function fixture() {
      const config = namingConfig();
      const home = join(root, "home");
      const env = {};
      const spec = INTEGRATION_CLIENTS[clientId];
      mkdirSync(spec.detectDir(env, home), { recursive: true });
      const path = spec.configPath(env, home);
      mkdirSync(dirname(path), { recursive: true });
      const input = { clientId, config, models: await namingModels(config), port: 10100, store, home, env };
      const keys = () => exportedKeys(clientId, parseConfig(readFileSync(path, "utf8"), clientId === "hermes" ? "yaml" : "json"));
      return { config, path, input, keys };
    }

    test(`${clientId}: connect, omitted apply, renamed/removed alias refresh and idempotence`, async () => {
      const { config, input, keys } = await fixture();
      const opted = { ...input, modelNames: "alias" as const };
      expect(applyIntegration(opted).ok).toBe(true);
      expect(policyOf(clientId)).toBe("alias");
      expect(keys()).toEqual(ALIAS_KEYS);
      config.preferModelAliasIds = true;
      input.models = await namingModels(config);
      expect(readIntegrationState(input).state).toBe("current");
      expect(applyIntegration(input)).toMatchObject({ ok: true, changed: false });
      config.providers.acme!.modelAliases!["vendor/model-x"] = "renamed";
      input.models = await namingModels(config);
      expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: true });
      expect(keys()).toContain("AC/renamed");
      expect(keys()).not.toContain("AC/AC-model-x");
      delete config.providers.acme!.modelAliases!["vendor/model-x"];
      input.models = await namingModels(config);
      expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: true });
      expect(keys()).toContain("acme/vendor-model-x");
      expect(keys()).not.toContain("AC/renamed");
      const record = store.readRecords()[clientId];
      const operations = store.listOperations(clientId);
      const snapshots = store.countSnapshots(clientId);
      expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: false });
      expect(store.readRecords()[clientId]).toEqual(record);
      expect(store.listOperations(clientId)).toEqual(operations);
      expect(store.countSnapshots(clientId)).toBe(snapshots);
    });

    test(`${clientId}: foreign edits refuse alias migration without changing ownership`, async () => {
      const { config, input, path } = await fixture();
      const opted = { ...input, modelNames: "alias" as const };
      expect(applyIntegration(opted).ok).toBe(true);
      expect(policyOf(clientId)).toBe("alias");
      const beforeRecord = store.readRecords()[clientId];
      const edited = readFileSync(path, "utf8").replace("AC/AC-model-x", "foreign-model");
      writeFileSync(path, edited, "utf8");
      delete config.providers.acme!.modelAliases!["vendor/model-x"];
      input.models = await namingModels(config);
      expect(refreshIntegration(input)).toMatchObject({ ok: false, reason: "conflict" });
      expect(readFileSync(path, "utf8")).toBe(edited);
      expect(store.readRecords()[clientId]).toEqual(beforeRecord);
    });

    test(`${clientId}: mode-only apply binds preview, persists and undo restores old policy`, async () => {
      const { config, input, path } = await fixture();
      config.providers.acme!.modelAliases = {};
      input.models = await namingModels(config);
      expect(applyIntegration(input)).toMatchObject({ ok: true, changed: true });
      const original = readFileSync(path, "utf8");
      const routed = previewIntegration(input, { operation: "apply" });
      const opted = { ...input, modelNames: "alias" as const };
      const alias = previewIntegration(opted, { operation: "apply" });
      expect(alias.fingerprint).not.toBe(routed.fingerprint);
      expect(alias.willChange).toBe(true);
      const changed = applyIntegration(opted);
      expect(changed).toMatchObject({ ok: true, changed: true });
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(policyOf(clientId)).toBe("alias");
      if (!changed.ok || !changed.opId) throw new Error("missing apply receipt");
      expect(restoreIntegration({ ...input, opId: changed.opId }).ok).toBe(true);
      expect(policyOf(clientId)).toBe("routed");
    });

    test(`${clientId}: legacy omission is routed and read-only; invalid stored mode refuses`, async () => {
      const { input, keys } = await fixture();
      expect(applyIntegration(input).ok).toBe(true);
      expect(keys()).toEqual(ROUTED_KEYS);
      const record = store.readRecords()[clientId]!;
      delete (record as unknown as { modelNames?: unknown }).modelNames;
      store.putRecord(record);
      expect(readIntegrationState(input).state).toBe("current");
      expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: false });
      expect(policyOf(clientId)).toBeUndefined();
      const corrupt = { ...record, modelNames: "raw" };
      store.putRecord(corrupt as unknown as typeof record);
      expect(isOwnershipRecord(store.readRecords()[clientId])).toBe(false);
      expect(applyIntegration(input).ok).toBe(false);
    });

    test(`${clientId}: policy-only journal failure compensates bytes and previous mode`, async () => {
      const { config, input, path } = await fixture();
      config.providers.acme!.modelAliases = {};
      input.models = await namingModels(config);
      expect(applyIntegration(input).ok).toBe(true);
      const before = readFileSync(path, "utf8");
      const prior = store.readRecords()[clientId];
      const journal = store.listOperations(clientId);
      const failing = { ...input, modelNames: "alias" as const,
        io: { ...store.io(), appendJournal: () => { throw new Error("fixture journal failure"); } } };
      expect(applyIntegration(failing)).toMatchObject({ ok: false, reason: "write_failed" });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(store.readRecords()[clientId]).toEqual(prior);
      expect(store.listOperations(clientId)).toEqual(journal);
    });

    test(`${clientId}: old discovery candidates are re-proven against the write configuration`, async () => {
      const { config, input, keys } = await fixture();
      // Capture proof under the old configuration, as a raced discovery load does.
      config.providers.acme!.modelAliases = { "vendor/model-x": "pick" };
      input.models = await namingModels(config);
      expect(input.models.find(model => model.id === "vendor/model-x")?.aliasNamespaced).toBe("AC/pick");
      config.providers.acme!.modelAliases = { "model-y:free": "pick" };
      const opted = { ...input, modelNames: "alias" as const };
      expect(applyIntegration(opted).ok).toBe(true);
      expect(policyOf(clientId)).toBe("alias");
      expect(keys()).toContain("acme/vendor-model-x");
      expect(keys()).toContain("AC/pick");
      expect(keys()).toHaveLength(5);
    });

    test(`${clientId}: refresh never reconnects a removed managed block`, async () => {
      const { input, path } = await fixture();
      const opted = { ...input, modelNames: "alias" as const };
      expect(applyIntegration(opted).ok).toBe(true);
      expect(policyOf(clientId)).toBe("alias");
      writeFileSync(path, "{}\n", "utf8");
      const prior = store.readRecords()[clientId];
      expect(refreshIntegration(input)).toMatchObject({ ok: true, changed: false, state: "absent" });
      expect(readFileSync(path, "utf8")).toBe("{}\n");
      expect(store.readRecords()[clientId]).toEqual(prior);
    });

    test(`${clientId}: coordinated refresh refuses post-capture alias reassignment and retries safely`, async () => {
      const { config, input, path, keys } = await fixture();
      config.providers.acme!.modelAliases = { "vendor/model-x": "pick" };
      input.models = await namingModels(config);
      const opted = { ...input, modelNames: "alias" as const };
      expect(applyIntegration(opted).ok).toBe(true);
      const before = readFileSync(path, "utf8");
      const record = store.readRecords()[clientId];
      const operations = store.listOperations(clientId);
      const raced = await refreshIntegrationCoordinated(input, { revalidate: async () => {
        config.providers.acme!.modelAliases = { "model-y:free": "pick" };
        return null;
      } });
      expect(raced).toMatchObject({ ok: false, reason: "conflict" });
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(store.readRecords()[clientId]).toEqual(record);
      expect(store.listOperations(clientId)).toEqual(operations);
      expect(await refreshIntegrationCoordinated(input)).toMatchObject({ ok: true, changed: true });
      expect(keys()).toEqual(["AC-combo", "AC/pick", "acme/deep-nested-model-z", "acme/vendor-model-x", "beta/model-x"].sort());
      expect(policyOf(clientId)).toBe("alias");
    });
  }

  test("named Hermes profile stores keep independent naming policies", async () => {
    const config = namingConfig();
    const models = await namingModels(config);
    const home = join(root, "home");
    const firstHome = join(home, "profiles", "one");
    const secondHome = join(home, "profiles", "two");
    mkdirSync(firstHome, { recursive: true });
    mkdirSync(secondHome, { recursive: true });
    const firstStore = hermesProfileStore(store, "one");
    const secondStore = hermesProfileStore(store, "two");
    const first = { clientId: "hermes" as const, config, models, port: 10100, home,
      env: { HERMES_HOME: firstHome }, store: firstStore };
    const second = { ...first, env: { HERMES_HOME: secondHome }, store: secondStore };
    const alias = { ...first, modelNames: "alias" as const };
    expect(applyIntegration(alias).ok).toBe(true);
    expect(applyIntegration(second).ok).toBe(true);
    expect(firstStore.readRecords().hermes?.modelNames).toBe("alias");
    expect(secondStore.readRecords().hermes?.modelNames).toBe("routed");
    expect(store.readRecords().hermes).toBeUndefined();
    expect(readIntegrationState(first).state).toBe("current");
    expect(readIntegrationState(second).state).toBe("current");
  });
});
