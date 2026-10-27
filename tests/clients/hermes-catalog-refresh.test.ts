import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExportModel } from "../../src/clients/config-export";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";
import { defaultIntegrationIO } from "../../src/integrations/config-io";
import { hermesProfileEnv, hermesProfilePaths, hermesProfileStore, resolveHermesProfile } from "../../src/integrations/hermes-profiles";
import { INTEGRATION_CLIENTS } from "../../src/integrations/registry";
import { fingerprint } from "../../src/integrations/ownership";
import { readIntegrationState } from "../../src/integrations/state";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration, disableIntegration, refreshIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const config: OcxConfig = {
  port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
  providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1:10100/v1" } },
};
const models: ExportModel[] = [{
  namespaced: "mock/reasoner", provider: "mock", id: "reasoner", contextWindow: 100_000,
  maxTokens: 8_192, reasoningEfforts: ["none", "low", "high"], defaultReasoningEffort: "low",
  inputModalities: ["text", "image"],
}];
describe("Hermes default-profile catalog refresh", () => {
  let root: string;
  let home: string;
  let store: IntegrationStateStore;
  let path: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-hermes-catalog-"));
    home = join(root, "home");
    store = createIntegrationStateStore(join(root, "state", "integrations"));
    path = INTEGRATION_CLIENTS.hermes.configPath({}, home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "# Personal settings\nmodel:\n  default: personal/model\nproviders:\n  other:\n    api: http://localhost:9000/v1\n");
  });
  afterEach(() => removeTreeWithRetry(root));
  function input(clientId: "hermes" = "hermes", roster = models) {
    return { clientId, config, models: roster, port: 10100, env: {}, home, store };
  }
  const grown = [...models, { namespaced: "mock/next", provider: "mock", id: "next" }];

  test("a connected Hermes block refreshes its models and keeps unrelated YAML bytes and comments", async () => {
    const hermesPath = INTEGRATION_CLIENTS.hermes.configPath({}, home);
    mkdirSync(join(hermesPath, ".."), { recursive: true });
    const hermesPrefix = "# Hermes personal settings\nmodel:\n  default: user-choice # keep this comment\nproviders:\n  other:\n    api: http://localhost:9000/v1 # other provider\n";
    const hermesTrailer = "terminal:\n  shell: zsh # trailing user section\n";
    writeFileSync(hermesPath, hermesPrefix + hermesTrailer);
    expect(applyIntegration(input("hermes")).ok).toBe(true);
    const applied = readFileSync(hermesPath, "utf8");
    expect(applied.startsWith(hermesPrefix)).toBe(true);
    expect(applied.endsWith(hermesTrailer)).toBe(true);
    const updated = [...models, { namespaced: "mock/next", provider: "mock", id: "next", contextWindow: 64_000 }];
    let loads = 0;
    // No explicit client list: this exercises the default fan-out that a background catalog change uses.
    const outcomes = await refreshOwnedCatalogIntegrations({ ...input("hermes"), models: async () => {
      loads++;
      return updated;
    } });
    expect(outcomes).toEqual([{ client: "hermes", ok: true, changed: true }]);
    expect(loads).toBe(1);
    const refreshed = readFileSync(hermesPath, "utf8");
    // Only the managed providers.opencodex range may change; the user's prefix and trailer stay byte-identical.
    expect(refreshed.startsWith(hermesPrefix)).toBe(true);
    expect(refreshed.endsWith(hermesTrailer)).toBe(true);
    const provider = (Bun.YAML.parse(refreshed) as { providers: { opencodex: { models: Record<string, unknown> } } }).providers.opencodex;
    expect(Object.keys(provider.models).sort()).toEqual(["mock/next", "mock/reasoner"]);
    expect(refreshed).toContain("other provider");
    expect(refreshed).toContain("# keep this comment");
    expect(Bun.YAML.parse(refreshed)).toMatchObject({ model: { default: "user-choice" }, providers: { other: { api: "http://localhost:9000/v1" } } });
  });

  test("a Hermes block edited by hand is refused and reported, not overwritten", async () => {
    const path = INTEGRATION_CLIENTS.hermes.configPath({}, home);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "providers: {}\n");
    expect(applyIntegration(input("hermes")).ok).toBe(true);
    // A protected managed value changed by hand (not a comment) is a foreign edit.
    const before = readFileSync(path, "utf8");
    const edited = before.replace("api_mode: chat_completions", "api_mode: codex_responses");
    expect(edited).not.toBe(before);
    writeFileSync(path, edited);
    const grown = [...models, { namespaced: "mock/next", provider: "mock", id: "next", contextWindow: 64_000 }];
    const outcomes = await refreshOwnedCatalogIntegrations(input("hermes", grown), ["hermes"]);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ client: "hermes", ok: false, state: "conflict" });
    expect(readFileSync(path, "utf8")).toBe(edited);
  });

  test("a Hermes config that was never connected is not touched or loaded", async () => {
    const path = INTEGRATION_CLIENTS.hermes.configPath({}, home);
    mkdirSync(join(path, ".."), { recursive: true });
    const never = "providers:\n  opencodex:\n    api: http://127.0.0.1:10100/v1 # never connected\n";
    writeFileSync(path, never);
    let loads = 0;
    expect(await refreshOwnedCatalogIntegrations({ ...input("hermes"), models: async () => {
      loads++;
      return models;
    } }, ["hermes"])).toEqual([]);
    expect(loads).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(never);
  });

  test.each(["comment", "unrelated key"])("an external %s with an unchanged catalog keeps refresh current", async kind => {
    expect(applyIntegration(input())).toMatchObject({ ok: true, changed: true });
    const record = store.readRecords().hermes!;
    const recordsPath = join(store.root, "records.json");
    const journalPath = join(store.root, "journal.jsonl");
    const records = readFileSync(recordsPath);
    const journal = readFileSync(journalPath);
    const snapshots = store.countSnapshots("hermes");
    const edited = readFileSync(path, "utf8") + (kind === "comment" ? "# My note\n" : "terminal:\n  shell: zsh\n");
    writeFileSync(path, edited, "utf8");
    const bytes = readFileSync(path);
    expect(fingerprint(edited)).not.toBe(record.fileFingerprint);
    expect(readIntegrationState(input()).state).toBe("current");

    expect(refreshIntegration(input())).toMatchObject({ ok: true, changed: false, state: "current" });
    expect(await refreshOwnedCatalogIntegrations(input(), ["hermes"]))
      .toEqual([{ client: "hermes", ok: true, changed: false }]);
    expect(readIntegrationState(input()).state).toBe("current");
    expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(journalPath)).toEqual(journal);
    expect(readFileSync(recordsPath)).toEqual(records);
    expect(store.readRecords().hermes).toEqual(record);
    expect(store.countSnapshots("hermes")).toBe(snapshots);
  });

  test.each(["setting", "comment"])("an external %s edit refuses refresh without touching file or journal", async kind => {
    expect(applyIntegration(input()).ok).toBe(true);
    const edited = readFileSync(path, "utf8") + (kind === "comment" ? "# My note\n" : "terminal:\n  shell: zsh\n");
    writeFileSync(path, edited);
    const history = store.listOperations("hermes");
    const record = store.readRecords().hermes;
    expect(await refreshOwnedCatalogIntegrations(input("hermes", grown), ["hermes"]))
      .toMatchObject([{ client: "hermes", ok: false, refusalReason: "conflict", state: "conflict" }]);
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(store.listOperations("hermes")).toEqual(history);
    expect(store.readRecords().hermes).toEqual(record);
  });

  test("an external edit while the catalog loads is rechecked before writing", async () => {
    expect(applyIntegration(input()).ok).toBe(true);
    const edited = readFileSync(path, "utf8") + "# Added during model discovery\n";
    const results = await refreshOwnedCatalogIntegrations({ ...input(), models: async () => {
      writeFileSync(path, edited);
      return grown;
    } }, ["hermes"]);
    expect(results).toMatchObject([{ client: "hermes", ok: false, state: "conflict" }]);
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });

  test("the file loaded by the transaction, including an edit at its read boundary, is checked", async () => {
    expect(applyIntegration(input()).ok).toBe(true);
    const edited = readFileSync(path, "utf8") + "# Concurrent editor save\n";
    const io = defaultIntegrationIO(store);
    let reads = 0;
    const outcomes = await refreshOwnedCatalogIntegrations({ ...input("hermes", grown), io: {
      ...io, readText: target => {
        if (target === path && ++reads === 1) writeFileSync(path, edited);
        return io.readText(target);
      },
    } }, ["hermes"]);
    expect(outcomes).toMatchObject([{ client: "hermes", ok: false, state: "conflict" }]);
    expect(readFileSync(path, "utf8")).toBe(edited);
    expect(store.listOperations("hermes")).toHaveLength(1);
  });

  test("Apply with an unchanged roster is a no-op; applying a pending catalog change resumes refresh", async () => {
    expect(applyIntegration(input()).ok).toBe(true);
    const edited = readFileSync(path, "utf8") + "# Retain this note\n";
    writeFileSync(path, edited);
    const record = store.readRecords().hermes;
    expect(applyIntegration(input())).toMatchObject({ ok: true, changed: false });
    expect(store.readRecords().hermes).toEqual(record);
    expect(await refreshOwnedCatalogIntegrations(input("hermes", grown), ["hermes"]))
      .toMatchObject([{ ok: false, state: "conflict" }]);
    expect(applyIntegration(input("hermes", grown))).toMatchObject({ ok: true, changed: true });
    const next = [...grown, { namespaced: "mock/third", provider: "mock", id: "third" }];
    expect(await refreshOwnedCatalogIntegrations(input("hermes", next), ["hermes"]))
      .toEqual([{ client: "hermes", ok: true, changed: true }]);
    expect(readFileSync(path, "utf8")).toContain("# Retain this note\n");
  });

  test("disabled Hermes is never reconnected or used to load models", async () => {
    expect(applyIntegration(input()).ok).toBe(true);
    expect(disableIntegration(input())).toMatchObject({ ok: true });
    const before = readFileSync(path, "utf8");
    let loads = 0;
    expect(await refreshOwnedCatalogIntegrations({ ...input(), models: async () => {
      loads++; return grown;
    } }, ["hermes"])).toEqual([]);
    expect(loads).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("disable while loading models leaves the config disabled", async () => {
    expect(applyIntegration(input()).ok).toBe(true);
    let disabled = "";
    await refreshOwnedCatalogIntegrations({ ...input(), models: async () => {
      expect(disableIntegration(input())).toMatchObject({ ok: true });
      disabled = readFileSync(path, "utf8");
      return grown;
    } }, ["hermes"]);
    expect(readFileSync(path, "utf8")).toBe(disabled);
    expect(store.readRecords().hermes).toBeUndefined();
    expect(store.listOperations("hermes")).toHaveLength(2);
  });

  test("named profiles remain unchanged and expose stale state for explicit Apply", async () => {
    const namedPath = join(path, "..", "profiles", "coder", "config.yaml");
    mkdirSync(join(namedPath, ".."), { recursive: true });
    writeFileSync(namedPath, "model:\n  default: personal/coder\nproviders: {}\n");
    const profile = resolveHermesProfile("coder", {}, home);
    const named = { ...input(), env: hermesProfileEnv(profile, {}), resolvedPaths: hermesProfilePaths(profile),
      store: hermesProfileStore(store, "coder") };
    expect(applyIntegration(input()).ok).toBe(true);
    expect(applyIntegration(named).ok).toBe(true);
    const before = readFileSync(namedPath, "utf8");
    const history = named.store.listOperations("hermes");
    expect(await refreshOwnedCatalogIntegrations(input("hermes", grown)))
      .toEqual([{ client: "hermes", ok: true, changed: true }]);
    expect(readFileSync(namedPath, "utf8")).toBe(before);
    expect(named.store.listOperations("hermes")).toEqual(history);
    expect(readIntegrationState({ ...named, models: grown }).state).toBe("stale");
    expect(applyIntegration({ ...named, models: grown }).ok).toBe(true);
    expect(readIntegrationState({ ...named, models: grown }).state).toBe("current");
  });

  test("Hermes IO failure is reported without blocking another connected client", async () => {
    expect(applyIntegration(input()).ok).toBe(true);
    const pi = { ...input(), clientId: "pi" as const };
    const piPath = INTEGRATION_CLIENTS.pi.configPath({}, home);
    mkdirSync(join(piPath, ".."), { recursive: true });
    writeFileSync(piPath, "{}\n");
    expect(applyIntegration(pi).ok).toBe(true);
    const io = defaultIntegrationIO(store);
    const outcomes = await refreshOwnedCatalogIntegrations({ ...input("hermes", grown), io: {
      ...io, readText: target => {
        if (target === path) throw new Error("Hermes read failed");
        return io.readText(target);
      },
    } }, ["hermes", "pi"]);
    expect(outcomes).toEqual([{ client: "hermes", ok: false, reason: "Hermes read failed" },
      { client: "pi", ok: true, changed: true }]);
    expect(readIntegrationState({ ...pi, models: grown }).state).toBe("current");
    expect(store.listOperations("hermes")).toHaveLength(1);
  });
});
