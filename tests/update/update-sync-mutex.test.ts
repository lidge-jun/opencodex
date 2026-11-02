import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUpdateMarker, inspectUpdateSyncMutex, isUpdateInFlight, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() { const root = mkdtempSync(join(tmpdir(), "ocx-update-sync-")); roots.push(root); return root; }

test("sync and update holders exclude one another and identify their kind", () => {
  const root = home();
  const sync = tryAcquireUpdateSyncMutex(root, "sync");
  expect(sync.kind).toBe("acquired");
  if (sync.kind !== "acquired") throw new Error("fixture lease not acquired");
  try {
    expect(inspectUpdateSyncMutex(root)).toBe("sync");
    expect(tryAcquireUpdateSyncMutex(root, "update")).toEqual({ kind: "busy", holder: "sync" });
  } finally { sync.release(); }
  const update = tryAcquireUpdateSyncMutex(root, "update");
  expect(update.kind).toBe("acquired");
  if (update.kind !== "acquired") throw new Error("fixture lease not acquired");
  try {
    expect(inspectUpdateSyncMutex(root)).toBe("update");
    expect(tryAcquireUpdateSyncMutex(root, "sync")).toEqual({ kind: "busy", holder: "update" });
  } finally { update.release(); }
  expect(inspectUpdateSyncMutex(root)).toBe("free");
});

test("sync refuses before its work while an update holds the mutex", async () => {
  const root = home();
  const previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = root;
  const update = tryAcquireUpdateSyncMutex(root, "update");
  if (update.kind !== "acquired") throw new Error("fixture lease not acquired");
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const args = ["sync"];
    const deps = { args, findLiveProxy: async () => { throw new Error("sync work reached"); } } as unknown as CliDispatchDeps;
    expect(await dispatchCommand({ kind: "command", command: "sync", args }, deps)).toBe(7);
    expect(err).toHaveBeenCalledWith("update-in-flight");
  } finally {
    err.mockRestore(); update.release();
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  }
});

test("a stale, proven-dead holder is recovered without waiting", () => {
  const root = home();
  const lock = join(root, "sync-update.mutation.lock");
  const instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  mkdirSync(lock);
  const owner = join(lock, `v1-${process.pid}-${instance}-${token}.json`);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: process.pid, processInstance: instance, token, createdAt: 1000, holderKind: "sync" }));
  utimesSync(owner, 1, 1);
  const lease = tryAcquireUpdateSyncMutex(root, "update", { now: () => 100_000, processAlive: () => false });
  expect(lease.kind).toBe("acquired");
  if (lease.kind === "acquired") lease.release();
});

test("in-flight observation is fail-closed and distinguishes a sync-only holder", () => {
  const root = home();
  const deps = { ownershipLease: () => "free" as const, mutex: () => "free" as const, marker: () => "free" as const };
  expect(isUpdateInFlight(root, deps)).toBe(false);
  expect(isUpdateInFlight(root, { ...deps, mutex: () => "sync" })).toBe(false);
  expect(isUpdateInFlight(root, { ...deps, mutex: () => "update" })).toBe(true);
  expect(isUpdateInFlight(root, { ...deps, mutex: () => "unknown" })).toBe(true);
  expect(isUpdateInFlight(root, { ...deps, ownershipLease: () => "unknown" })).toBe(true);
  expect(isUpdateInFlight(root, { ...deps, marker: () => "active" })).toBe(true);
  expect(isUpdateInFlight(root, { ...deps, marker: () => "unknown" })).toBe(true);
});

test("a live overrun marker remains in flight and malformed markers are uncertain", () => {
  const root = home();
  const path = join(root, "update-orchestrated.json");
  const deps = { ownershipLease: () => "free" as const, mutex: () => "free" as const, marker: inspectUpdateMarker };
  expect(isUpdateInFlight(root, deps)).toBe(false);
  writeFileSync(path, JSON.stringify({ pid: process.pid, phase: "overrun", startedAt: 1 }));
  expect(isUpdateInFlight(root, deps)).toBe(true);
  writeFileSync(path, JSON.stringify({ pid: process.pid, phase: "installed" }));
  expect(isUpdateInFlight(root, deps)).toBe(true);
  writeFileSync(path, "{");
  expect(isUpdateInFlight(root, deps)).toBe(true);
});
