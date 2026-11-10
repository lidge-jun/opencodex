import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CARRIED_OBSERVATION_FIELDS, CHILD_OBSERVATIONS_SCHEMA, emptyChildObservations, parseChildObservations, patchChildObservation,
  readChildObservations, updateChildObservations, withoutCarriedFields, type ChildObservation } from "../../src/link/child-observations";
import { childObservationsPath, linkStorePath } from "../../src/link/paths";
import { protectedHomeForTests } from "../../src/lib/test-home-guard";

const A = "lnk_0123456789abcdef", B = "lnk_fedcba9876543210";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function configDir(): string { const dir = mkdtempSync(join(tmpdir(), "ocx-child-obs-")); dirs.push(dir); return dir; }
function writeLinks(dir: string, ids: string[]): void {
  mkdirSync(join(dir, "link"), { recursive: true });
  writeFileSync(linkStorePath(dir), JSON.stringify({ version: 1, listenerPort: null, links: ids.map(id => ({ id, alias: "host-" + id.slice(-4),
    direction: "hub-initiated", hostKeyFingerprint: "SHA256:abcdefghijklmnopqrstuvwxyz012345", tunnelPort: 41000, apiKeyId: "key-" + id.slice(-4), createdAt: "2026-11-11T00:00:00.000Z" })) }));
}
const observation = (overrides: Partial<ChildObservation> = {}): ChildObservation => ({
  observedAt: "2026-11-11T00:00:00.000Z", source: "plan", installedVersion: "2.97.0", installKind: "bun", runtimeOwner: "service",
  updateRoute: "orchestrated", updateReason: null, targetVersion: "2.100.0", catalogPulledAt: 1_700_000_000_000,
  lastOperation: { op: "update", jobId: "job_1", state: "succeeded", reason: null, fromVersion: "2.96.0", toVersion: "2.97.0", finishedAt: "2026-11-10T00:00:00.000Z" },
  suppressedTarget: null, catalogPulledEtag: "\"etag-1\"", catalogSyncedEtag: null, autoUpdateAttempts: { target: "2.100.0", count: 1 },
  updateInFlight: false, pendingUpdateRecovery: null, ...overrides,
});
const file = (children: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ schema: CHILD_OBSERVATIONS_SCHEMA, homeCatalog: null, children, ...extra });

describe("tolerant reader", () => {
  test("missing and damaged files read empty; the next update rewrites a valid file", () => {
    const dir = configDir(); writeLinks(dir, [A]);
    const path = childObservationsPath(dir);
    expect(readChildObservations(path)).toEqual(emptyChildObservations());
    for (const damaged of ["{", JSON.stringify({ schema: "ocx.link.child-observations/2", homeCatalog: null, children: {} }), " ".repeat(1024 * 1024 + 1)]) {
      writeFileSync(path, damaged);
      expect(readChildObservations(path)).toEqual(emptyChildObservations());
    }
    updateChildObservations(state => { state.children[A] = observation(); }, { path, storePath: linkStorePath(dir) });
    expect(readChildObservations(path).children[A]).toEqual(observation());
    expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe(CHILD_OBSERVATIONS_SCHEMA);
  });

  test("unknown keys are dropped and invalid entries removed, valid siblings kept", () => {
    const parsed = parseChildObservations(file({ [A]: { ...observation(), future: "x" }, [B]: { ...observation(), installKind: "brew" }, bogus: observation() },
      { future: true, homeCatalog: { etag: "\"e\"", changedAt: 5, extra: 1 } }));
    expect(Object.keys(parsed)).toEqual(["schema", "homeCatalog", "children"]);
    expect(parsed.homeCatalog).toEqual({ etag: "\"e\"", changedAt: 5 });
    expect(parsed.children).toEqual({ [A]: observation() });
  });

  test("a damaged nested summary drops the entry, a bad header reads null", () => {
    const parsed = parseChildObservations(file({ [A]: observation({ lastOperation: { op: "reboot" } as never }), [B]: observation({ updateReason: "Has Spaces" }) },
      { homeCatalog: { etag: 1 } }));
    expect(parsed.homeCatalog).toBeNull();
    expect(parsed.children).toEqual({});
  });

  test("carried fields: a file written before revision 4 parses with the new fields null", () => {
    const legacy = Object.fromEntries(Object.entries(observation()).filter(([key]) =>
      !["catalogPulledEtag", "catalogSyncedEtag", "autoUpdateAttempts", "updateInFlight", "pendingUpdateRecovery"].includes(key)));
    expect(parseChildObservations(file({ [A]: legacy })).children[A]).toEqual(observation({ catalogPulledEtag: null, catalogSyncedEtag: null,
      autoUpdateAttempts: null, updateInFlight: null, pendingUpdateRecovery: null }));
  });

  test("withoutCarriedFields drops exactly the carried fields", () => {
    const full = observation({ pendingUpdateRecovery: { target: "2.100.0", since: "2026-11-11T00:00:00.000Z", until: "2026-11-11T01:00:00.000Z", desktopRequestId: "req-1" } });
    const stripped = withoutCarriedFields(full);
    expect(Object.keys(stripped).sort()).toEqual(Object.keys(full).filter(key => !(CARRIED_OBSERVATION_FIELDS as readonly string[]).includes(key)).sort());
    expect([...CARRIED_OBSERVATION_FIELDS].sort()).toEqual(["autoUpdateAttempts", "catalogPulledAt", "catalogPulledEtag", "catalogSyncedEtag", "lastOperation", "pendingUpdateRecovery", "suppressedTarget"]);
    expect(parseChildObservations(file({ [A]: full })).children[A]).toEqual(full);
  });

  test("patchChildObservation keeps carried fields and stamps observedAt", () => {
    const state = emptyChildObservations();
    state.children[A] = observation();
    patchChildObservation(state, A, { installedVersion: "2.100.0", updateRoute: "none", updateReason: "up-to-date" }, new Date("2026-11-12T00:00:00.000Z"));
    expect(state.children[A]).toEqual(observation({ installedVersion: "2.100.0", updateRoute: "none", updateReason: "up-to-date", observedAt: "2026-11-12T00:00:00.000Z" }));
    patchChildObservation(state, B, { installKind: "npm" }, new Date("2026-11-12T00:00:00.000Z"));
    expect(state.children[B]).toMatchObject({ installKind: "npm", installedVersion: null, lastOperation: null, updateInFlight: null, observedAt: "2026-11-12T00:00:00.000Z" });
  });
});

describe("writer", () => {
  test("entries for removed links are pruned on write", () => {
    const dir = configDir(); writeLinks(dir, [A]);
    const path = childObservationsPath(dir);
    writeFileSync(path, file({ [A]: observation(), [B]: observation() }));
    const written = updateChildObservations(() => {}, { path, storePath: linkStorePath(dir) });
    expect(Object.keys(written.children)).toEqual([A]);
    expect(Object.keys(readChildObservations(path).children)).toEqual([A]);
  });

  test("damaged links.json does not prune", () => {
    const dir = configDir(); writeLinks(dir, [A]);
    writeFileSync(linkStorePath(dir), "{ damaged");
    const path = childObservationsPath(dir);
    writeFileSync(path, file({ [A]: observation(), [B]: observation() }));
    expect(Object.keys(updateChildObservations(() => {}, { path, storePath: linkStorePath(dir) }).children).sort()).toEqual([A, B]);
  });

  test("maxEntries bounds the file", () => {
    const dir = configDir(); writeLinks(dir, [A, B]);
    const path = childObservationsPath(dir);
    const written = updateChildObservations(state => { state.children[A] = observation(); state.children[B] = observation(); }, { path, storePath: linkStorePath(dir), maxEntries: 1 });
    expect(Object.keys(written.children)).toHaveLength(1);
  });

  test.skipIf(process.platform === "win32")("permissions: dir 0700, file 0600", () => {
    const dir = configDir();
    const path = childObservationsPath(dir);
    updateChildObservations(state => { state.homeCatalog = { etag: "\"e\"", changedAt: 1 }; }, { path, storePath: linkStorePath(dir) });
    expect(statSync(join(dir, "link")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readChildObservations(path).homeCatalog).toEqual({ etag: "\"e\"", changedAt: 1 });
  });

  test("the real home is refused under test", () => {
    const real = protectedHomeForTests();
    const path = childObservationsPath(real);
    const existed = existsSync(path);
    expect(() => updateChildObservations(() => {}, { path, storePath: linkStorePath(real) })).toThrow(/refusing to write the real OpenCodex home/);
    expect(existsSync(path)).toBe(existed);
  });
});

