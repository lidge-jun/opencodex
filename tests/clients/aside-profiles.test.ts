import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExportModel } from "../../src/clients/config-export";
import { AsideProfileError, type AsideProfilesInput } from "../../src/integrations/aside-profile-context";
import { getAsideProfileState, listAsideProfileStates, mutateAsideProfiles, refreshAsideProfiles } from "../../src/integrations/aside-profiles";
import { asideOperationMatchesCurrent, deleteAsideOperation, findAsideOperation, listAsideOperations, restoreAsideProfile } from "../../src/integrations/aside-profile-journal";
import { createIntegrationStateStore, type IntegrationStateStore } from "../../src/integrations/store";
import { applyIntegration } from "../../src/integrations/writer";
import type { OcxConfig } from "../../src/types";
import { removeTreeWithRetry } from "../helpers/remove-tree";

describe("Aside profile desired state, ownership and history", () => {
  const models: ExportModel[] = [
    { namespaced: "mock/alpha", provider: "mock", id: "alpha", contextWindow: 128_000 },
    { namespaced: "mock/beta", provider: "mock", id: "beta", contextWindow: 64_000 },
  ];
  const original = JSON.stringify({ theme: "dark", providers: { personal: { models: [{ id: "mine" }] } } });
  let root: string;
  let home: string;
  let store: IntegrationStateStore;
  let config: OcxConfig;
  let saved: OcxConfig | undefined;
  let saves: number;

  function manifest(currentAccountId = 0, ids = [0, 1, 2]): void {
    writeFileSync(join(home, ".aside", "accounts.json"), JSON.stringify({
      currentAccountId, accounts: ids.map(id => ({ id, name: `Profile ${id}` })),
    }));
  }
  function path(id: number): string { return join(home, ".aside", "u", String(id), "models.json"); }
  function input(extra: Partial<AsideProfilesInput> = {}): AsideProfilesInput {
    return { config, models, port: 10100, env: {}, home, store,
      persistConfig: next => { saved = structuredClone(next); saves += 1; }, ...extra };
  }
  function reload(): void { expect(saved).toBeDefined(); config = structuredClone(saved!); }
  function seedLegacy(id = 0): string {
    manifest(id);
    const result = applyIntegration({ ...input(), models, clientId: "aside" });
    expect(result.ok).toBe(true);
    manifest();
    return store.readRecords().aside!.opId;
  }
  function modelIds(id: number): string[] {
    const doc = JSON.parse(readFileSync(path(id), "utf8")) as { providers?: { opencodex?: { models: Array<{ id: string }> } } };
    return doc.providers?.opencodex?.models.map(model => model.id) ?? [];
  }
  function bytes(): string[] { return [0, 1, 2].map(id => readFileSync(path(id), "utf8")); }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ocx-aside-profiles-"));
    home = join(root, "home");
    for (const id of [0, 1, 2]) {
      mkdirSync(join(home, ".aside", "u", String(id)), { recursive: true });
      writeFileSync(path(id), original);
    }
    manifest();
    store = createIntegrationStateStore(join(root, "state", "integrations"));
    config = { port: 10100, hostname: "127.0.0.1", defaultProvider: "mock",
      providers: { mock: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } } } as OcxConfig;
    saved = undefined;
    saves = 0;
  });
  afterEach(() => removeTreeWithRetry(root));

  test.each([false, true])("implicit sync stays quiet for unconfigured or disabled Aside (legacy=%s)", async legacy => {
    if (legacy) {
      seedLegacy();
      config.asideProfileSync = { allProfiles: false };
    }
    removeTreeWithRetry(join(home, ".aside"));
    let loads = 0;
    expect(await refreshAsideProfiles(input({ models: async () => { loads += 1; return models; } }))).toEqual([]);
    expect(loads).toBe(0);
    expect(saves).toBe(0);
  });

  test("sync retains backup and incomplete-recovery diagnostics for a failed profile", async () => {
    seedLegacy();
    const io = store.io();
    let attempts = 0;
    const outcomes = await refreshAsideProfiles(input({ models: models.slice(0, 1),
      store: { ...store, putRecord() { throw new Error("synthetic ownership failure"); } }, io: {
      ...io,
      writeText(target, text) {
        if (target !== path(0)) return io.writeText(target, text);
        attempts += 1;
        if (attempts === 1) return io.writeText(target, text);
        throw new Error("synthetic write and compensation failure");
      },
    } }));
    const failure = outcomes.find(row => row.profileId === 0);
    expect(failure).toMatchObject({ ok: false, refusalReason: "write_failed", residual: true });
    expect(failure?.snapshotPath).toBeString();
    expect(existsSync(failure!.snapshotPath!)).toBe(true);
  });

  test("legacy connection defaults all profiles on and refresh shares one catalog load", async () => {
    seedLegacy();
    expect((await listAsideProfileStates(input())).enabledCount).toBe(3);
    let loads = 0;
    const results = await refreshAsideProfiles(input({ models: async () => { loads += 1; return models.slice(0, 1); } }));
    expect(results.map(result => [result.profileId, result.ok])).toEqual([[0, true], [1, true], [2, true]]);
    expect(loads).toBe(1);
    for (const id of [0, 1, 2]) expect(modelIds(id)).toEqual(["mock/alpha"]);
    expect(store.readRecords().aside?.configPath).toBe(path(0));
    for (const id of [1, 2]) {
      expect(createIntegrationStateStore(join(store.root, "aside-profiles", String(id))).readRecords().aside?.configPath).toBe(path(id));
      expect(JSON.parse(readFileSync(path(id), "utf8"))).toMatchObject(JSON.parse(original));
    }
    expect(saves).toBe(0);
  });

  test("disabling legacy profile 0 pins its root and preserves sibling intent after reload", async () => {
    seedLegacy();
    expect((await mutateAsideProfiles(input(), { profileId: 0, enabled: false })).ok).toBe(true);
    expect(saved?.asideProfileSync).toEqual({ allProfiles: true, profiles: { "0": false }, legacyProfileId: 0 });
    reload();
    const results = await refreshAsideProfiles(input());
    expect(results.map(row => row.profileId)).toEqual([1, 2]);
    expect(modelIds(0)).toEqual([]);
    expect(modelIds(1)).toEqual(["mock/alpha", "mock/beta"]);
    expect(modelIds(2)).toEqual(["mock/alpha", "mock/beta"]);
    expect(store.readRecords().aside).toBeUndefined();
    expect((await getAsideProfileState(input(), 0)).enabled).toBe(false);
  });

  test("a disconnected single-profile enable leaves other profiles off", async () => {
    expect((await mutateAsideProfiles(input(), { profileId: 1, enabled: true })).ok).toBe(true);
    reload();
    expect(config.asideProfileSync).toEqual({ allProfiles: false, profiles: { "1": true }, legacyProfileId: null });
    expect((await refreshAsideProfiles(input())).map(row => row.profileId)).toEqual([1]);
    expect(bytes()[0]).toBe(original);
    expect(bytes()[2]).toBe(original);
    expect((await listAsideProfileStates(input())).enabledCount).toBe(1);
  });

  test("a disconnected implicit refresh loads no catalog and creates no ownership store", async () => {
    let loads = 0;
    expect(await refreshAsideProfiles(input({ models: async () => { loads += 1; return models; } }))).toEqual([]);
    expect(loads).toBe(0);
    expect(bytes()).toEqual([original, original, original]);
    expect(existsSync(store.root)).toBe(false);
  });

  test("bulk intent clears overrides without conflating desired and actual outcomes", async () => {
    await mutateAsideProfiles(input(), { profileId: 1, enabled: true });
    await mutateAsideProfiles(input(), { enabled: false });
    expect(saved?.asideProfileSync).toEqual({ allProfiles: false, profiles: {}, legacyProfileId: null });
    expect((await listAsideProfileStates(input())).enabledCount).toBe(0);
    expect((await mutateAsideProfiles(input(), { enabled: true })).results).toHaveLength(3);
    expect((await listAsideProfileStates(input())).appliedCount).toBe(3);
  });

  test("save failure restores the original in-memory policy before any model or file work", async () => {
    seedLegacy();
    const before = bytes();
    const records = store.readRecords();
    const operations = store.listOperations();
    const previous = config.asideProfileSync;
    let loads = 0;
    await expect(mutateAsideProfiles(input({
      persistConfig: () => { throw new Error("synthetic save failure"); },
      models: async () => { loads += 1; return models; },
    }), { enabled: false })).rejects.toMatchObject({ code: "aside_profile_persist_failed", status: 500 });
    expect(config.asideProfileSync).toBe(previous);
    expect(loads).toBe(0);
    expect(bytes()).toEqual(before);
    expect(store.readRecords()).toEqual(records);
    expect(store.listOperations()).toEqual(operations);
    expect(existsSync(join(store.root, "aside-profiles"))).toBe(false);
  });

  test("foreign and malformed profiles refuse independently after desired policy is saved", async () => {
    const foreign = JSON.stringify({ providers: { opencodex: { models: [{ id: "manual" }] } } });
    writeFileSync(path(1), foreign);
    writeFileSync(path(2), "{broken");
    const result = await mutateAsideProfiles(input(), { enabled: true });
    expect(result.ok).toBe(false);
    expect(result.results.map(row => [row.profileId, row.ok])).toEqual([[0, true], [1, false], [2, false]]);
    expect(saved?.asideProfileSync?.allProfiles).toBe(true);
    expect(readFileSync(path(1), "utf8")).toBe(foreign);
    expect(readFileSync(path(2), "utf8")).toBe("{broken");
    expect(modelIds(0)).toEqual(["mock/alpha", "mock/beta"]);
  });

  test("implicit refresh preserves removed owned blocks and foreign edits", async () => {
    await mutateAsideProfiles(input(), { enabled: true });
    writeFileSync(path(1), original);
    const drifted = readFileSync(path(2), "utf8").replace("http://127.0.0.1:10100/v1", "http://user.invalid/v1");
    writeFileSync(path(2), drifted);
    const result = await refreshAsideProfiles(input({ models: models.slice(0, 1) }));
    expect(result[0]).toMatchObject({ profileId: 0, ok: true, changed: true });
    expect(result[1]).toMatchObject({ profileId: 1, ok: true, changed: false });
    expect(result[2]).toMatchObject({ profileId: 2, ok: false });
    expect(readFileSync(path(1), "utf8")).toBe(original);
    expect(readFileSync(path(2), "utf8")).toBe(drifted);
  });

  test("one profile IO failure does not suppress later writes", async () => {
    const io = store.io();
    const result = await mutateAsideProfiles(input({ io: { ...io, writeText: (target, text) => {
      if (target === path(1)) throw new Error("synthetic profile write failure");
      io.writeText(target, text);
    } } }), { enabled: true });
    expect(result.results.map(row => [row.profileId, row.ok])).toEqual([[0, true], [1, false], [2, true]]);
    expect(readFileSync(path(1), "utf8")).toBe(original);
    expect(modelIds(2)).toEqual(["mock/alpha", "mock/beta"]);
    expect(saved?.asideProfileSync?.allProfiles).toBe(true);
  });

  test("missing account directories and aliased child stores are not created or adopted", async () => {
    removeTreeWithRetry(join(home, ".aside", "u", "2"));
    const children = join(store.root, "aside-profiles");
    mkdirSync(children, { recursive: true });
    const external = join(root, "external-store");
    mkdirSync(external);
    symlinkSync(external, join(children, "1"), process.platform === "win32" ? "junction" : "dir");
    const result = await mutateAsideProfiles(input(), { enabled: true });
    expect(result.results.map(row => [row.profileId, row.ok])).toEqual([[0, true], [1, false], [2, false]]);
    expect(existsSync(join(external, "records.json"))).toBe(false);
    expect(existsSync(join(home, ".aside", "u", "2"))).toBe(false);
  });

  test("an account switch during persistence does not retarget a selected write", async () => {
    const result = await mutateAsideProfiles(input({ persistConfig: next => {
      saved = structuredClone(next); manifest(2);
    } }), { profileId: 1, enabled: true });
    expect(result.ok).toBe(true);
    expect(modelIds(1)).toEqual(["mock/alpha", "mock/beta"]);
    expect(readFileSync(path(0), "utf8")).toBe(original);
    expect(readFileSync(path(2), "utf8")).toBe(original);
  });

  test("enable then Undo stays off through reload and sync", async () => {
    const enabled = await mutateAsideProfiles(input(), { profileId: 1, enabled: true });
    const enabledResult = enabled.results[0]!;
    if (!enabledResult.ok) throw new Error("fixture enable failed");
    const opId = enabledResult.opId!;
    const row = findAsideOperation(input(), opId, 1)!;
    expect(asideOperationMatchesCurrent(input(), row)).toBe(true);
    expect((await restoreAsideProfile(input(), { opId, profileId: 1 })).ok).toBe(true);
    reload();
    expect(await refreshAsideProfiles(input())).toEqual([]);
    expect(readFileSync(path(1), "utf8")).toBe(original);
    expect((await getAsideProfileState(input(), 1)).enabled).toBe(false);
  });

  test("disable then Undo restores target intent without changing sibling overrides", async () => {
    seedLegacy();
    await mutateAsideProfiles(input(), { profileId: 2, enabled: false });
    const disabled = await mutateAsideProfiles(input(), { profileId: 0, enabled: false });
    const result = disabled.results[0]!;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((await restoreAsideProfile(input(), { opId: result.opId!, profileId: 0 })).ok).toBe(true);
    reload();
    expect(config.asideProfileSync).toEqual({ allProfiles: true, legacyProfileId: 0, profiles: { "0": true, "2": false } });
    expect((await refreshAsideProfiles(input())).map(row => row.profileId)).toEqual([0, 1]);
    expect(modelIds(0)).toEqual(["mock/alpha", "mock/beta"]);
    expect(readFileSync(path(2), "utf8")).toBe(original);
  });

  test("Undo of explicit overwrite restores a foreign block and leaves its profile off", async () => {
    const foreign = JSON.stringify({ providers: { opencodex: { models: [{ id: "user-owned" }] } } });
    writeFileSync(path(1), foreign);
    const overwritten = await mutateAsideProfiles(input(), { profileId: 1, enabled: true, overwriteConflict: true });
    const result = overwritten.results[0]!;
    if (!result.ok) throw new Error("fixture overwrite failed");
    expect((await restoreAsideProfile(input(), { opId: result.opId!, profileId: 1 })).ok).toBe(true);
    reload();
    expect(await refreshAsideProfiles(input())).toEqual([]);
    expect(readFileSync(path(1), "utf8")).toBe(foreign);
    expect((await getAsideProfileState(input(), 1)).enabled).toBe(false);
  });

  test("restore preflight refuses drift and expired snapshots before saving intent", async () => {
    const enabled = await mutateAsideProfiles(input(), { profileId: 1, enabled: true });
    const result = enabled.results[0]!;
    if (!result.ok) throw new Error("fixture enable failed");
    const row = findAsideOperation(input(), result.opId!, 1)!;
    writeFileSync(path(1), original);
    const beforeSaves = saves;
    expect(asideOperationMatchesCurrent(input(), row)).toBe(false);
    expect(await restoreAsideProfile(input(), { opId: result.opId!, profileId: 1 }))
      .toMatchObject({ ok: false, reason: "drift_requires_confirm" });
    expect(saves).toBe(beforeSaves);
    const snapshot = row.store.readSnapshot(row.entry);
    if (snapshot.kind !== "stored") throw new Error("fixture snapshot missing");
    removeTreeWithRetry(snapshot.path);
    expect(await restoreAsideProfile(input(), { opId: result.opId!, profileId: 1, confirmDrift: true }))
      .toMatchObject({ ok: false, reason: "snapshot_expired" });
    expect(saves).toBe(beforeSaves);
  });

  test("mixed legacy history imports a sibling snapshot without clobbering the root owner", async () => {
    const siblingOp = seedLegacy(1);
    const ownerOp = seedLegacy(0);
    const owner = store.readRecords().aside;
    expect(listAsideOperations(input(), 1).map(row => row.entry.opId)).toEqual([siblingOp]);
    expect(listAsideOperations(input(), 0).map(row => row.entry.opId)).toEqual([ownerOp]);
    expect((await restoreAsideProfile(input(), { opId: siblingOp })).ok).toBe(true);
    expect(store.readRecords().aside).toEqual(owner);
    expect(store.findOperation(siblingOp)).not.toBeNull();
    const child = createIntegrationStateStore(join(store.root, "aside-profiles", "1"));
    expect(child.findOperation(siblingOp)).toEqual(store.findOperation(siblingOp));
    expect(listAsideOperations(input(), 1).filter(row => row.entry.opId === siblingOp)).toHaveLength(1);
    const latest = listAsideOperations(input(), 1)[0]!;
    await expect(deleteAsideOperation(input(), { opId: latest.entry.opId, profileId: 1 }))
      .rejects.toMatchObject({ code: "integration_journal_newest_protected", status: 409 });
    expect((await deleteAsideOperation(input(), { opId: siblingOp, profileId: 1 })).ok).toBe(true);
    expect(child.findOperation(siblingOp)).toBeNull();
    expect(store.findOperation(siblingOp)).toBeNull();
    expect(store.readRecords().aside).toEqual(owner);
  });

  test.each(["child", "legacy"] as const)("history restores from the remaining copy when %s retention expires", async expired => {
    const opId = seedLegacy(1);
    seedLegacy(0);
    const rootOwner = store.readRecords().aside;
    const applied = readFileSync(path(1), "utf8");
    expect((await restoreAsideProfile(input(), { opId })).ok).toBe(true);
    const child = createIntegrationStateStore(join(store.root, "aside-profiles", "1"));
    const entry = store.findOperation(opId)!;
    expect(child.findOperation(opId)).toEqual(entry);
    const expiredStore = expired === "child" ? child : store;
    const remainingStore = expired === "child" ? store : child;
    const snapshot = expiredStore.readSnapshot(entry);
    if (snapshot.kind !== "stored") throw new Error("fixture snapshot missing");
    removeTreeWithRetry(snapshot.path);
    expect(expiredStore.readSnapshot(entry).kind).toBe("expired");
    expect(remainingStore.readSnapshot(entry)).toMatchObject({ kind: "stored", text: original });
    const selected = findAsideOperation(input(), opId, 1)!;
    expect(selected.store.root).toBe(remainingStore.root);
    expect(listAsideOperations(input(), 1).filter(row => row.entry.opId === opId)).toHaveLength(1);
    // Recreate the operation's result so ordinary Undo needs no drift override.
    writeFileSync(path(1), applied);
    expect(asideOperationMatchesCurrent(input(), selected)).toBe(true);
    expect((await restoreAsideProfile(input(), { opId, profileId: 1 })).ok).toBe(true);
    expect(readFileSync(path(1), "utf8")).toBe(original);
    expect(child.readSnapshot(entry)).toMatchObject({ kind: "stored", text: original });
    expect(child.listOperations("aside").filter(row => row.opId === opId)).toHaveLength(1);
    expect(store.listOperations("aside").filter(row => row.opId === opId)).toHaveLength(1);
    expect(store.readRecords().aside).toEqual(rootOwner);
    if (expired === "legacy") expect(store.readSnapshot(entry).kind).toBe("expired");
  });

  test("conflicting available snapshot copies refuse lookup and restore before saving or writing", async () => {
    const opId = seedLegacy(1);
    seedLegacy(0);
    expect((await restoreAsideProfile(input(), { opId })).ok).toBe(true);
    const child = createIntegrationStateStore(join(store.root, "aside-profiles", "1"));
    const entry = store.findOperation(opId)!;
    const snapshot = child.readSnapshot(entry);
    if (snapshot.kind !== "stored") throw new Error("fixture snapshot missing");
    writeFileSync(snapshot.path, JSON.stringify({ theme: "conflicting-copy" }));
    expect(child.findOperation(opId)).toEqual(entry);
    const before = bytes();
    const beforeSaves = saves;
    const beforeHistory = child.listOperations("aside");
    expect(() => findAsideOperation(input(), opId, 1)).toThrow("conflicting snapshot copies");
    expect(() => listAsideOperations(input(), 1)).toThrow("conflicting snapshot copies");
    await expect(restoreAsideProfile(input(), { opId, profileId: 1, confirmDrift: true }))
      .rejects.toMatchObject({ code: "aside_operation_ambiguous", status: 409 });
    expect(saves).toBe(beforeSaves);
    expect(bytes()).toEqual(before);
    expect(child.listOperations("aside")).toEqual(beforeHistory);
    expect(store.readSnapshot(entry)).toMatchObject({ kind: "stored", text: original });
  });

  test("unknown profile selectors and unregistered historical targets are not retargeted", async () => {
    await expect(getAsideProfileState(input(), 9)).rejects.toMatchObject({ code: "aside_profile_not_found", status: 404 });
    await expect(mutateAsideProfiles(input(), { profileId: -1, enabled: true })).rejects.toBeInstanceOf(AsideProfileError);
    const opId = seedLegacy(1);
    manifest(0, [0, 2]);
    expect(() => findAsideOperation(input(), opId)).toThrow("no longer registered");
    expect(saves).toBe(0);
  });

  test("default status is safe when discovery fails and non-Aside history stays available", async () => {
    const opId = seedLegacy();
    const aside = store.findOperation(opId)!;
    store.appendJournal({ ...aside, opId: "mcode-history", clientId: "mcode" });
    writeFileSync(join(home, ".aside", "accounts.json"), "{invalid");
    const state = await listAsideProfileStates(input());
    expect(state).toMatchObject({ clientId: "aside", profiles: [], installed: false, state: "unsafe", total: 0 });
    expect(state.error).toBeDefined();
    expect(findAsideOperation(input(), "mcode-history")).toBeNull();
    expect(listAsideOperations(input())).toEqual([]);
    await expect(mutateAsideProfiles(input(), { profileId: 0, enabled: true }))
      .rejects.toMatchObject({ code: "aside_profiles_unavailable", status: 409 });
    expect(saves).toBe(0);
  });

  test("restore save failure leaves history, bytes and existing policy unchanged", async () => {
    const enabled = await mutateAsideProfiles(input(), { profileId: 1, enabled: true });
    const result = enabled.results[0]!;
    if (!result.ok) throw new Error("fixture enable failed");
    const previous = config.asideProfileSync;
    const before = bytes();
    const rows = listAsideOperations(input(), 1).map(row => row.entry);
    await expect(restoreAsideProfile(input({ persistConfig: async () => { throw new Error("save unavailable"); } }), { opId: result.opId! }))
      .rejects.toMatchObject({ code: "aside_profile_persist_failed" });
    expect(config.asideProfileSync).toBe(previous);
    expect(bytes()).toEqual(before);
    expect(listAsideOperations(input(), 1).map(row => row.entry)).toEqual(rows);
  });

  test("Undo never enables policy from a snapshot whose prior owner names another profile", async () => {
    seedLegacy();
    const disabled = await mutateAsideProfiles(input(), { profileId: 0, enabled: false });
    const result = disabled.results[0]!;
    if (!result.ok) throw new Error("fixture disable failed");
    const entry = store.findOperation(result.opId!)!;
    store.appendJournal({ ...entry, opId: "wrong-owner", snapshot: { kind: "none" },
      priorRecord: { ...entry.priorRecord!, configPath: path(1) } });
    const before = bytes();
    const beforeSaves = saves;
    await expect(restoreAsideProfile(input(), { opId: "wrong-owner", profileId: 0 }))
      .rejects.toMatchObject({ code: "aside_operation_invalid", status: 409 });
    expect(saves).toBe(beforeSaves);
    expect(bytes()).toEqual(before);
  });

  test("one flight covers save and writes across different profile scopes", async () => {
    let release!: () => void;
    let observe!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { observe = resolve; });
    const first = mutateAsideProfiles(input({ persistConfig: async next => {
      observe(); await gate; saved = structuredClone(next);
    } }), { profileId: 0, enabled: true });
    try {
      await started;
      await expect(mutateAsideProfiles(input(), { profileId: 1, enabled: true }))
        .rejects.toMatchObject({ code: "integration_mutation_busy", status: 409 });
      await expect(refreshAsideProfiles(input())).rejects.toMatchObject({ code: "integration_mutation_busy" });
      await expect(refreshAsideProfiles(input({ store: createIntegrationStateStore(join(root, "other-state")) })))
        .rejects.toMatchObject({ code: "integration_mutation_busy" });
      expect(bytes()).toEqual([original, original, original]);
    } finally { release(); await first; }
    expect(modelIds(0)).toEqual(["mock/alpha", "mock/beta"]);
    expect(readFileSync(path(1), "utf8")).toBe(original);
    expect((await mutateAsideProfiles(input(), { profileId: 1, enabled: true })).ok).toBe(true);
  });
});
