import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUpdateMarker, inspectUpdateSyncMutex, isUpdateInFlight, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import { withSyncUpdateGuard } from "../../src/cli/sync-update-guard";
import { observeOrchestratedPlan } from "../../src/update/orchestrated-entry";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() { const root = mkdtempSync(join(tmpdir(), "ocx-update-sync-")); roots.push(root); return root; }

test("a fresh home is free in plans and sync can acquire its guard", async () => {
  const root = home(), fresh = join(root, "missing"), previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = fresh;
  try {
    expect(inspectUpdateSyncMutex(fresh)).toBe("free");
    expect(isUpdateInFlight(fresh)).toBe(false);
    const plan = await observeOrchestratedPlan({ ok: true, mode: "plan" }, {
      install: () => ({ installer: "npm", cliRoot: root, desktopPath: false }), currentVersion: () => "2.0.0",
      identity: async () => ({ kind: "absent" }), ownership: () => ({ runtimeOwner: "none", permits: true }),
      target: () => "2.1.0", inFlight: () => isUpdateInFlight(fresh),
    });
    expect(plan.updateInFlight).toBe(false);
    let ran = false;
    expect(await withSyncUpdateGuard(async () => { ran = true; return 0; })).toBe(0);
    expect(ran).toBe(true);
    if (process.platform !== "win32") expect(statSync(fresh).mode & 0o777).toBe(0o700);
    expect(inspectUpdateSyncMutex(fresh)).toBe("free");
  } finally { if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; }
});

test.skipIf(process.platform === "win32")("a dangling home symlink remains uncertain", () => {
  const root = home(), link = join(root, "link");
  symlinkSync(join(root, "absent"), link);
  expect(inspectUpdateSyncMutex(link)).toBe("unknown");
  expect(tryAcquireUpdateSyncMutex(link, "sync")).toEqual({ kind: "busy", holder: "unknown" });
});

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

test("an occupied mutex authority path is uncertain and cannot acquire a lease", () => {
  const root = home();
  const target = join(root, "other-name");
  mkdirSync(target);
  symlinkSync(target, join(root, "sync-update"), process.platform === "win32" ? "junction" : "dir");
  expect(inspectUpdateSyncMutex(root)).toBe("unknown");
  expect(isUpdateInFlight(root)).toBe(true);
  expect(tryAcquireUpdateSyncMutex(root, "update")).toEqual({ kind: "busy", holder: "unknown" });
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

test("sync refuses a live update marker even if its mutex is unexpectedly absent", async () => {
  const root = home(), previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = root;
  writeFileSync(join(root, "update-orchestrated.json"), JSON.stringify({ pid: process.pid, phase: "mutating", startedAt: 1 }));
  const err = spyOn(console, "error").mockImplementation(() => {});
  const shim = spyOn(await import("../../src/cli/codex-shim-autorestore"), "runCodexShimAutoRestoreAsync").mockResolvedValue(undefined);
  try {
    const args = ["sync"];
    const deps = { args, findLiveProxy: async () => { throw new Error("sync work reached"); } } as unknown as CliDispatchDeps;
    expect(await dispatchCommand({ kind: "command", command: "sync", args }, deps)).toBe(7);
    expect(shim).not.toHaveBeenCalled();
  } finally {
    shim.mockRestore(); err.mockRestore();
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
