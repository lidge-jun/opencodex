import { describe, expect, test } from "bun:test";
import { afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import {
  exportSnapshotIdentity,
  listManagementModelRows,
  loadExportModels,
  previewExportModels,
  resetExportSnapshotForTests,
} from "../../src/server/management/model-rows";
import type { CatalogModel } from "../../src/codex/catalog";
import type { OcxConfig } from "../../src/types";
import { clearModelCache, reconcileModelCacheProviders, setCached } from "../../src/codex/model-cache";

/**
 * A read-only caller has to be able to see what a writer would write without performing the
 * gather, because the gather reaches providers and can persist an initial model selection. What
 * it must NOT get is a different projection, or a preview and the commit that follows it would
 * disagree about the roster for a reason that has nothing to do with the roster changing.
 */
const CONFIG: OcxConfig = {
  port: 10100,
  hostname: "127.0.0.1",
  defaultProvider: "supplied",
  providers: { supplied: { adapter: "openai-chat", baseUrl: "http://127.0.0.1/v1" } },
} as OcxConfig;

const SUPPLIED: CatalogModel[] = [{ id: "supplied-model", provider: "supplied" }];

/**
 * A roster is identified by the configuration it was admitted under, so these cases need their own
 * configuration directory rather than whatever the machine running them happens to have.
 */
let configRoot = "";
let priorHome: string | undefined;

beforeEach(() => {
  configRoot = mkdtempSync(join(tmpdir(), "ocx-roster-config-"));
  priorHome = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = configRoot;
  mkdirSync(configRoot, { recursive: true });
});

afterEach(() => {
  if (priorHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = priorHome;
  removeTreeWithRetry(configRoot);
});

describe("a supplied roster replaces the gather and keeps the projection", () => {
  test("rows come from the roster the caller brought", async () => {
    const rows = await listManagementModelRows(CONFIG, { models: SUPPLIED });
    // No provider here serves this id, so a gather could not have produced this row. Its
    // presence is what proves the supplied roster was used instead.
    expect(rows.some(row => row.id === "supplied-model")).toBe(true);
  });

  test("the disabled computation still applies to a supplied roster", async () => {
    const rows = await listManagementModelRows(
      { ...CONFIG, disabledModels: ["supplied/supplied-model"] } as OcxConfig,
      { models: SUPPLIED },
    );
    const row = rows.find(candidate => candidate.id === "supplied-model");
    expect(row?.disabled).toBe(true);
  });

  test("the export projection accepts a supplied roster without gathering", async () => {
    // Visibility and provider selection decide which rows survive here, so this asserts the call
    // completes through the same path rather than pinning that policy from outside.
    await expect(loadExportModels(CONFIG, SUPPLIED)).resolves.toBeInstanceOf(Array);
  });
});

describe("a preview reads only a roster an authoritative load already finished", () => {
  test("a cold process has none, and an ordinary load leaves the final projection behind", async () => {
    resetExportSnapshotForTests();
    // Recoverable rather than broken: the operator opens the models view and the snapshot appears.
    expect(previewExportModels(CONFIG)).toBeNull();

    const exported = await loadExportModels(CONFIG, SUPPLIED);
    // The FINAL projection, not an input to it: rebuilding from raw provider caches would miss
    // static and forward providers and skip the filtering this applies afterwards.
    expect(previewExportModels(CONFIG)).toEqual(exported);
  });

  test("changing what the roster depends on retires the snapshot", async () => {
    resetExportSnapshotForTests();
    await loadExportModels(CONFIG, SUPPLIED);
    expect(previewExportModels(CONFIG)).not.toBeNull();

    // A blocklist edit changes which models a client would be given, so a plan built against the
    // old roster no longer describes what the user has.
    const blocked = { ...CONFIG, disabledModels: ["supplied/supplied-model"] } as OcxConfig;
    expect(previewExportModels(blocked)).toBeNull();

    const added = { ...CONFIG, customModels: [{ id: "c1", provider: "supplied", modelId: "extra" }] } as OcxConfig;
    expect(previewExportModels(added)).toBeNull();
  });

  test("a preview is refused to a caller holding a different in-memory configuration", async () => {
    resetExportSnapshotForTests();
    await loadExportModels(CONFIG, SUPPLIED);
    expect(previewExportModels(CONFIG)).not.toBeNull();

    // Same configuration file, different configuration object. The file digest alone cannot see
    // this, and neither could a hand-written list of the fields that seemed to matter: fastRows
    // changes what the export projection emits and no such list ever mentioned it.
    expect(previewExportModels({ ...CONFIG, fastRows: false } as OcxConfig)).toBeNull();

    // A difference that changes nothing about the roster is still a different configuration. The
    // identity is structural precisely so it does not depend on anyone deciding which fields count.
    expect(previewExportModels({ ...CONFIG, shutdownTimeoutMs: 7_000 } as OcxConfig)).toBeNull();

    // A separate object describing the same configuration is the same configuration: this is an
    // identity of the content, not of the object a caller happens to be holding.
    const equivalent = previewExportModels({ ...CONFIG } as OcxConfig);
    expect(equivalent).not.toBeNull();
    expect(equivalent).toEqual(previewExportModels(CONFIG));
  });

  test("a completed discovery retires the snapshot even though the config never changed", async () => {
    resetExportSnapshotForTests();
    await loadExportModels(CONFIG, SUPPLIED);
    expect(previewExportModels(CONFIG)).not.toBeNull();

    // The real trigger: a discovery that succeeded and published different rows. The config key
    // cannot see it, and an authority generation does not move for it either.
    expect(setCached("supplied", [{ id: "discovered-later", provider: "supplied" }])).toBe(true);
    expect(previewExportModels(CONFIG)).toBeNull();
  });

  test("an unchanged roster keeps the identity a caller is already holding", async () => {
    resetExportSnapshotForTests();
    await loadExportModels(CONFIG, SUPPLIED);
    const held = exportSnapshotIdentity(CONFIG);
    expect(held).not.toBeNull();

    // An ordinary read rebuilds the same rows, and the Integrations collection performs one on
    // every visit. Moving the identity for that turned a confirmation an operator was in the
    // middle of submitting into a stale one, for no change they could see.
    await loadExportModels(CONFIG, SUPPLIED);
    expect(exportSnapshotIdentity(CONFIG)).toBe(held);

    // A roster that genuinely differs still takes a new identity.
    await loadExportModels(CONFIG, [...SUPPLIED, { id: "second-model", provider: "supplied" }]);
    const moved = exportSnapshotIdentity(CONFIG);
    expect(moved).not.toBeNull();
    expect(moved).not.toBe(held);
  });

  test("a wholesale clear retires the snapshot even though no provider counter survives it", async () => {
    resetExportSnapshotForTests();
    await loadExportModels(CONFIG, SUPPLIED);
    expect(previewExportModels(CONFIG)).not.toBeNull();

    // The clear empties the map, so per-provider counters cannot record it. Only a global term
    // can, and without one every derived roster would read as unchanged.
    clearModelCache();
    expect(previewExportModels(CONFIG)).toBeNull();
  });

  test("a provider that leaves and returns cannot match a roster built before it left", async () => {
    resetExportSnapshotForTests();
    // The provider has to be CACHED for reconciliation to have anything to remove. Supplying a
    // roster skips the gather, so without this nothing tracks "supplied" and the prune is a no-op
    // that proves nothing.
    expect(setCached("supplied", [{ id: "cached-before-removal", provider: "supplied" }])).toBe(true);
    await loadExportModels(CONFIG, SUPPLIED);
    expect(previewExportModels(CONFIG)).not.toBeNull();

    // Reconciliation drops the provider's revision entry. If that were the whole story the entry
    // would come back at zero and the old stamp would match again, which is the ABA this guards.
    reconcileModelCacheProviders(new Set<string>());
    expect(previewExportModels(CONFIG)).toBeNull();

    expect(setCached("supplied", [{ id: "cached-after-return", provider: "supplied" }])).toBe(true);
    await loadExportModels(CONFIG, SUPPLIED);
    const reborn = previewExportModels(CONFIG);
    expect(reborn).not.toBeNull();
  });

  test("an absent config file is a configuration; an unreadable one is not", async () => {
    // Absent means defaults, which is a fresh install and CI. Refusing there would make the
    // feature look dead rather than safe.
    resetExportSnapshotForTests();
    await loadExportModels(CONFIG, SUPPLIED);
    expect(previewExportModels(CONFIG)).not.toBeNull();

    // A file that exists and cannot be parsed says nothing about which configuration this roster
    // belongs to, so it fails closed.
    writeFileSync(join(configRoot, "config.json"), "{ not valid json");
    expect(previewExportModels(CONFIG)).toBeNull();
  });

  test("the snapshot does not share objects with the caller that produced it", async () => {
    resetExportSnapshotForTests();
    const exported = await loadExportModels(CONFIG, SUPPLIED);
    const first = exported[0];
    expect(first).toBeDefined();

    // Freezing only the array left the models themselves shared, so a caller editing one in place
    // would have rewritten what a later preview plans against, and moved the fingerprint with it.
    if (first) first.id = "mutated-by-the-caller";
    const snapshot = previewExportModels(CONFIG);
    expect(snapshot?.some(model => model.id === "mutated-by-the-caller")).toBe(false);

    // The same has to hold for a reader: holding the retained objects would let a consumer edit
    // the roster every later preview plans against.
    const read = previewExportModels(CONFIG);
    const readFirst = read?.[0];
    expect(readFirst).toBeDefined();
    if (readFirst) {
      readFirst.id = "mutated-by-a-reader";
      readFirst.inputModalities = ["mutated"];
    }
    const fresh = previewExportModels(CONFIG);
    expect(fresh?.some(model => model.id === "mutated-by-a-reader")).toBe(false);
    expect(fresh?.some(model => model.inputModalities?.includes("mutated"))).toBe(false);
  });
});
