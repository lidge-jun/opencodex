import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clineConfigPath } from "../../src/clients/config-export";
import { createClineIO, clinePendingPath } from "../../src/integrations/cline-io";
import { decodeClinePair } from "../../src/integrations/cline-document";
import { applyIntegration, disableIntegration, overwriteIntegration, refreshIntegration, restoreIntegration, type IntegrationWriteInput } from "../../src/integrations/writer";
import { createIntegrationStateStore } from "../../src/integrations/store";
import { readIntegrationState } from "../../src/integrations/state";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import type { IntegrationTransaction } from "../../src/integrations/config-io";
import type { OcxConfig } from "../../src/types";
import { refreshOwnedCatalogIntegrations } from "../../src/integrations/catalog-refresh";

let root: string;
let input: IntegrationWriteInput;
let settings: string;
let catalog: string;
const originalSettings = '{ "version": 1, "lastUsedProvider": "mine", "modes": {}, "providers": {"mine":{"settings":{"provider":"mine"},"updatedAt":"2026-01-01T00:00:00.000Z","tokenSource":"manual"}} }\n';
const originalCatalog = '{\n "version":1, "providers":{"mine":{"models":{"keep":{"name":"Keep"}}}}\n}\n';
const models = [{ namespaced: "mock/a", provider: "mock", id: "a", contextWindow: 120000 }, { namespaced: "mock/b", provider: "mock", id: "b" }];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ocx-cline-"));
  const home = join(root, "home");
  settings = clineConfigPath({}, home);
  catalog = join(dirname(settings), "models.json");
  mkdirSync(dirname(settings), { recursive: true });
  input = {
    clientId: "cline", home, env: {}, models, port: 10100,
    config: { hostname: "127.0.0.1", port: 10100, defaultProvider: "mock", providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } } } as OcxConfig,
    store: createIntegrationStateStore(join(root, "store")),
  };
});
afterEach(() => removeTreeWithRetry(root));

function seed() { writeFileSync(settings, originalSettings); writeFileSync(catalog, originalCatalog); }
function settingsDoc() { return JSON.parse(readFileSync(settings, "utf8")); }
function catalogDoc() { return JSON.parse(readFileSync(catalog, "utf8")); }

describe("Cline journaled pair", () => {
  test("explicit catalog sync leaves unowned clients alone and refreshes owned pairs", async () => {
    let loads = 0;
    const request = { ...input, models: async () => { loads += 1; return [models[0]!]; } };
    expect(await refreshOwnedCatalogIntegrations(request, ["cline"])).toEqual([]);
    expect(loads).toBe(0);
    expect(existsSync(settings)).toBe(false);
    expect(applyIntegration(input).ok).toBe(true);
    expect(await refreshOwnedCatalogIntegrations(request, ["cline"])).toEqual([{ client: "cline", ok: true, changed: true }]);
    expect(loads).toBe(1);
    expect(Object.keys(catalogDoc().providers.opencodex.models)).toEqual(["mock/a"]);
  });
  test("preserves foreign providers/default, journals both originals, and restores exact bytes", () => {
    seed();
    const applied = applyIntegration(input);
    expect(applied.ok).toBe(true);
    expect(settingsDoc().lastUsedProvider).toBe("mine");
    expect(catalogDoc().providers.mine.models.keep.name).toBe("Keep");
    expect(Object.keys(catalogDoc().providers.opencodex.models)).toEqual(["mock/a", "mock/b"]);
    expect(readIntegrationState(input).state).toBe("current");
    const op = input.store!.listOperations("cline")[0]!;
    const snapshot = input.store!.readSnapshot(op);
    expect(snapshot.kind).toBe("stored");
    if (snapshot.kind === "stored") expect(decodeClinePair(snapshot.text)).toEqual({ settings: originalSettings, catalog: originalCatalog });
    expect(restoreIntegration({ ...input, opId: op.opId }).ok).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(originalSettings);
    expect(readFileSync(catalog, "utf8")).toBe(originalCatalog);
  });

  test("restore preserves initially absent members, including both absent", () => {
    for (const partial of [false, true]) {
      if (partial) writeFileSync(settings, originalSettings);
      const applied = applyIntegration(input);
      expect(applied.ok).toBe(true);
      if (!applied.ok || !applied.opId) throw new Error("missing operation");
      expect(restoreIntegration({ ...input, opId: applied.opId }).ok).toBe(true);
      expect(existsSync(settings)).toBe(partial);
      expect(existsSync(catalog)).toBe(false);
    }
  });

  test("refresh removes retired models and preserves only still-routed user selection", () => {
    seed();
    expect(applyIntegration(input).ok).toBe(true);
    const edited = settingsDoc();
    edited.providers.opencodex.settings.model = "mock/b";
    edited.providers.opencodex.updatedAt = "2026-09-12T00:00:00.000Z";
    writeFileSync(settings, JSON.stringify(edited));
    expect(refreshIntegration({ ...input, port: 12100 }).ok).toBe(true);
    expect(settingsDoc().providers.opencodex.settings.model).toBe("mock/b");
    expect(settingsDoc().providers.opencodex.settings.baseUrl).toContain(":12100/");
    expect(refreshIntegration({ ...input, models: [models[0]!] }).ok).toBe(true);
    expect(Object.keys(catalogDoc().providers.opencodex.models)).toEqual(["mock/a"]);
    expect(settingsDoc().providers.opencodex.settings.model).toBeUndefined();
    expect(disableIntegration(input).ok).toBe(true);
    expect(settingsDoc().providers.opencodex).toBeUndefined();
    expect(catalogDoc().providers.opencodex).toBeUndefined();
    expect(settingsDoc().version).toBe(1);
    expect(settingsDoc().lastUsedProvider).toBe("mine");
  });

  test("protected edits refuse refresh and drifted pair requires explicit restore confirmation", () => {
    seed();
    const applied = applyIntegration(input);
    if (!applied.ok || !applied.opId) throw new Error("apply failed");
    const edited = settingsDoc();
    edited.providers.opencodex.settings.baseUrl = "http://127.0.0.1:9999/v1";
    writeFileSync(settings, JSON.stringify(edited));
    expect(readIntegrationState(input).state).toBe("conflict");
    expect(refreshIntegration(input).ok).toBe(false);
    const refused = restoreIntegration({ ...input, opId: applied.opId });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toBe("drift_requires_confirm");
    expect(restoreIntegration({ ...input, opId: applied.opId, confirmDrift: true }).ok).toBe(true);
    expect(readFileSync(catalog, "utf8")).toBe(originalCatalog);
  });

  test("unsafe second file and remote admission refuse without replacing the first file", () => {
    seed();
    writeFileSync(catalog, '{"version":2}');
    expect(applyIntegration(input).ok).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(originalSettings);
    seed();
    expect(applyIntegration({ ...input, config: { ...input.config, hostname: "0.0.0.0" } }).ok).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(originalSettings);
    expect(input.store!.listOperations()).toHaveLength(0);
  });

  test("missing install and no-follow member refusals leave both files alone", () => {
    const absentHome = join(root, "never-installed");
    const absent = applyIntegration({ ...input, home: absentHome });
    expect(absent.ok).toBe(false);
    if (!absent.ok) expect(absent.reason).toBe("not_installed");
    seed();
    const io = input.store!.io();
    const refused = applyIntegration({ ...input, io: { ...io, lstatKind: path => path === catalog ? "other" : io.statKind(path) } });
    expect(refused.ok).toBe(false);
    expect(readFileSync(settings, "utf8")).toBe(originalSettings);
    expect(readFileSync(catalog, "utf8")).toBe(originalCatalog);
  });

  test("occupied custom provider requires explicit overwrite and remains reversible", () => {
    seed();
    const doc = settingsDoc();
    doc.providers.opencodex = { settings: { provider: "opencodex", baseUrl: "http://127.0.0.1:9999/v1" }, updatedAt: "2026-01-01T00:00:00.000Z", tokenSource: "manual" };
    const before = JSON.stringify(doc);
    writeFileSync(settings, before);
    expect(applyIntegration(input).ok).toBe(false);
    const applied = overwriteIntegration(input);
    expect(applied.ok).toBe(true);
    if (!applied.ok || !applied.opId) throw new Error("overwrite failed");
    expect(restoreIntegration({ ...input, opId: applied.opId }).ok).toBe(true);
    expect(readFileSync(settings, "utf8")).toBe(before);
  });

  test("second-file and journal failures compensate both files and ownership", () => {
    for (const point of ["catalog", "journal"] as const) {
      seed();
      const io = input.store!.io();
      let failed = false;
      const result = applyIntegration({ ...input, io: {
        ...io,
        writeText: (path, text) => {
          if (point === "catalog" && path === catalog && !failed) { failed = true; throw new Error("injected"); }
          io.writeText(path, text);
        },
        appendJournal: entry => {
          if (point === "journal") throw new Error("injected");
          io.appendJournal(entry);
        },
      } });
      expect(result.ok).toBe(false);
      expect(readFileSync(settings, "utf8")).toBe(originalSettings);
      expect(readFileSync(catalog, "utf8")).toBe(originalCatalog);
      expect(input.store!.readRecords().cline).toBeUndefined();
      expect(existsSync(clinePendingPath(input.store!, settings))).toBe(false);
    }
  });

  test("pending pair is read-only unsafe; an explicit mutation recovers interrupted files", () => {
    seed();
    const io = input.store!.io();
    let failWrites = false;
    const result = applyIntegration({ ...input, io: { ...io, writeText: (path, text) => {
      if (path === catalog) failWrites = true;
      if (failWrites && (path === settings || path === catalog)) throw new Error("disk offline");
      io.writeText(path, text);
    } } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.residual).toBe(true);
    const intermediate = readFileSync(settings, "utf8");
    expect(readIntegrationState(input).state).toBe("unsafe");
    expect(readFileSync(settings, "utf8")).toBe(intermediate);
    expect(applyIntegration(input).ok).toBe(true);
    expect(readIntegrationState(input).state).toBe("current");
  });

  test("journaled mixed pair cannot be blessed by marker cleanup", () => {
    seed();
    const io = input.store!.io();
    const marker = clinePendingPath(input.store!, settings);
    expect(applyIntegration({ ...input, io: { ...io, removeFile: path => {
      if (path === marker) throw new Error("cleanup unavailable");
      io.removeFile(path);
    } } }).ok).toBe(true);
    const pending = JSON.parse(readFileSync(marker, "utf8")) as IntegrationTransaction;
    writeFileSync(settings, decodeClinePair(pending.before).settings!);
    expect(readIntegrationState(input).state).toBe("unsafe");
    expect(applyIntegration(input).ok).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });

  test("an uncommitted marker never authorizes overwriting a foreign edit", () => {
    seed();
    const io = input.store!.io();
    let offline = false;
    expect(applyIntegration({ ...input, io: { ...io, writeText: (path, text) => {
      if (path === catalog) offline = true;
      if (offline && (path === settings || path === catalog)) throw new Error("offline");
      io.writeText(path, text);
    } } }).ok).toBe(false);
    const foreign = '{"version":1,"providers":{"mine":{"changed":true}}}';
    writeFileSync(catalog, foreign);
    expect(applyIntegration(input).ok).toBe(false);
    expect(readFileSync(catalog, "utf8")).toBe(foreign);
    expect(existsSync(clinePendingPath(input.store!, settings))).toBe(true);
  });

  test("cleanup failure after append keeps success and permits safe later cleanup", () => {
    seed();
    const io = input.store!.io();
    const marker = clinePendingPath(input.store!, settings);
    expect(applyIntegration({ ...input, io: { ...io, removeFile: path => {
      if (path === marker) throw new Error("cleanup unavailable");
      io.removeFile(path);
    } } }).ok).toBe(true);
    expect(input.store!.listOperations("cline")).toHaveLength(1);
    expect(readIntegrationState(input).state).toBe("current");
    expect(applyIntegration(input).ok).toBe(true);
    expect(existsSync(marker)).toBe(false);
    expect(input.store!.listOperations("cline")).toHaveLength(1);
  });

  test("uncertain history or ownership never authorizes recovery writes", () => {
    seed();
    const store = input.store!;
    const io = store.io();
    const marker = clinePendingPath(store, settings);
    expect(applyIntegration({ ...input, io: { ...io, removeFile: path => {
      if (path === marker) throw new Error("retain marker");
      io.removeFile(path);
    } } }).ok).toBe(true);
    const before = [readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(marker, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")];
    for (const method of ["findCommittedOperation", "readRecordsStrict"] as const) {
      const uncertain = { ...store, [method]: () => { throw new Error("unreadable"); } };
      expect(applyIntegration({ ...input, store: uncertain }).ok).toBe(false);
      expect([readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(marker, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")]).toEqual(before);
    }
    // Valid JSON with invalid schema is also uncertainty, not a missing commit.
    const journal = join(store.root, "journal.jsonl");
    const journalBefore = readFileSync(journal, "utf8");
    writeFileSync(journal, '{}\n');
    expect(applyIntegration(input).ok).toBe(false);
    writeFileSync(journal, journalBefore);
    expect([readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(marker, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")]).toEqual(before);
  });

  test("malformed pending authority is rejected before any recovery side effect", () => {
    seed();
    const store = input.store!;
    const io = store.io();
    const marker = clinePendingPath(store, settings);
    expect(applyIntegration({ ...input, io: { ...io, removeFile: path => {
      if (path === marker) throw new Error("retain marker");
      io.removeFile(path);
    } } }).ok).toBe(true);
    const valid = JSON.parse(readFileSync(marker, "utf8")) as IntegrationTransaction;
    const files = [readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")];
    const variants: unknown[] = [
      { ...valid, priorRecord: { clientId: "cline", configPath: settings } },
      { ...valid, entry: { ...valid.entry, priorRecord: valid.record } },
      { ...valid, entry: { ...valid.entry, resultFingerprint: "0000000000000000" } },
      { ...valid, entry: { ...valid.entry, resultAbsent: true, resultFingerprint: "" } },
      { ...valid, entry: { ...valid.entry, kind: ["apply"] } },
      { ...valid, record: { ...valid.record, fragmentPaths: [["settings", "providers", "mine"]] } },
    ];
    for (const variant of variants) {
      const text = JSON.stringify(variant);
      writeFileSync(marker, text);
      expect(applyIntegration(input).ok).toBe(false);
      expect([readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")]).toEqual(files);
      expect(readFileSync(marker, "utf8")).toBe(text);
    }
  });

  test("embedded NUL cannot turn malformed prior ownership into a valid recovery path", () => {
    seed();
    const store = input.store!;
    const io = store.io();
    let failedAppend = false;
    const result = applyIntegration({ ...input, io: { ...io,
      appendJournal: () => { failedAppend = true; throw new Error("append unavailable"); },
      writeText: (path, text) => {
        if (failedAppend && (path === settings || path === catalog)) throw new Error("rollback unavailable");
        io.writeText(path, text);
      },
    } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.residual).toBe(true);
    const marker = clinePendingPath(store, settings);
    const pending = JSON.parse(readFileSync(marker, "utf8")) as IntegrationTransaction;
    const priorRecord = { ...pending.record!, fragmentPaths: [["settings\0providers", "opencodex"], ["catalog", "providers", "opencodex"]] };
    const malformed = JSON.stringify({ ...pending, priorRecord, entry: { ...pending.entry, priorRecord } });
    writeFileSync(marker, malformed);
    const before = [readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")];
    expect(applyIntegration(input).ok).toBe(false);
    expect([readFileSync(settings, "utf8"), readFileSync(catalog, "utf8"), readFileSync(join(store.root, "records.json"), "utf8")]).toEqual(before);
    expect(readFileSync(marker, "utf8")).toBe(malformed);
  });

  test("adapter keeps non-target IO unchanged and reads a pair as one snapshot", () => {
    seed();
    const adapter = createClineIO(input.store!.io(), settings, input.store!);
    const result = adapter.readText(settings);
    if (result.kind !== "text") throw new Error("pair missing");
    expect(decodeClinePair(result.text)).toEqual({ settings: originalSettings, catalog: originalCatalog });
    expect(adapter.statKind(dirname(settings))).toBe("dir");
  });
});
