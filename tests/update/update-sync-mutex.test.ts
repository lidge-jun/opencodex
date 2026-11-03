import { afterEach, expect, spyOn, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { repoPath } from "../helpers/repo-root";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectUpdateMarker, inspectUpdateSyncMutex, isUpdateInFlight, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex";
import { dispatchCommand, type CliDispatchDeps } from "../../src/cli/dispatch";
import { withSyncUpdateGuard } from "../../src/cli/sync-update-guard";
import { observeOrchestratedPlan } from "../../src/update/orchestrated-entry";
import { classifySyncResult, fanoutExitCode } from "../../src/cli/sync-fanout";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function home() { const root = mkdtempSync(join(tmpdir(), "ocx-update-sync-")); roots.push(root); return root; }

test.each(["malformed", "absent", "different-sync"] as const)("delegated sync refuses %s lease in plain and JSON mode", kind => {
  const root = home(), ran = join(root, "ran");
  const lock = kind === "different-sync" ? tryAcquireUpdateSyncMutex(root, "sync") : null;
  if (lock && lock.kind !== "acquired") throw Error("fixture lock");
  if (kind === "malformed") {
    const path = join(root, "sync-update.mutation.lock"); mkdirSync(path);
    writeFileSync(join(path, "malformed.json"), "{");
  }
  const exit = kind === "different-sync" ? 1 : 7;
  const reason = exit === 1 ? "sync-in-progress" : "update-in-flight";
  const script = `import {writeFileSync} from 'node:fs'; import {withSyncUpdateGuard} from ${JSON.stringify(repoPath("src/cli/sync-update-guard.ts"))}; process.exit(await withSyncUpdateGuard(async () => { writeFileSync(${JSON.stringify(ran)}, 'ran'); return 0; }, ${JSON.stringify(["--json"])}));`;
  try {
    for (const json of [false, true]) {
      const source = json ? script : script.replace('["--json"]', '[]');
      const result = spawnSync(process.execPath, ["--no-env-file", "-e", source], { env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, "codex"), OPENCODEX_HOME: root, OCX_TEST_HOME_GUARD: "1", OCX_SYNC_MUTEX_HELD_BY: String(process.pid + 1) }, encoding: "utf8", timeout: 12000 });
      expect(result.status).toBe(exit);
      expect(result.stderr.trim()).toBe(reason);
      if (json) expect(JSON.parse(result.stdout)).toEqual({ schema: "ocx.sync.fanout/1", home: { state: "skipped", exit }, fanout: { state: "not-applicable", reason }, children: [] });
      else expect(result.stdout).toBe("");
      expect(() => statSync(ran)).toThrow();
    }
  } finally { if (lock?.kind === "acquired") lock.release(); }
}, 30000);

test("a sync child refuses a parent lease without its delegate pid", () => {
  const root = home(), lock = tryAcquireUpdateSyncMutex(root, "sync");
  if (lock.kind !== "acquired") throw Error("fixture lock");
  try {
    const script = `import {withSyncUpdateGuard} from ${JSON.stringify(repoPath("src/cli/sync-update-guard.ts"))}; process.exit(await withSyncUpdateGuard(async () => 0));`;
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", script], { env: { ...process.env, OPENCODEX_HOME: root, OCX_TEST_HOME_GUARD: "1", OCX_SYNC_MUTEX_HELD_BY: String(process.pid), npm_config_registry: "http://127.0.0.1:9", NPM_CONFIG_REGISTRY: "http://127.0.0.1:9" }, encoding: "utf8", timeout: 12000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 1, stderr: expect.stringContaining("sync-in-progress") });
  } finally { lock.release(); }
}, 15000);

test("a stale sync lease remains held by its live delegate", () => {
  const root = home(), lock = join(root, "sync-update.mutation.lock");
  const instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  mkdirSync(lock);
  const owner = join(lock, `v1-2147483647-${instance}-${token}.json`);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: 2147483647, delegatePid: process.pid, processInstance: instance, token, createdAt: 1000, holderKind: "sync" }));
  utimesSync(owner, 1, 1);
  const lease = tryAcquireUpdateSyncMutex(root, "update", { now: () => 100_000, processAlive: pid => pid === process.pid });
  expect(lease).toEqual({ kind: "busy", holder: "sync" });
  if (lease.kind === "acquired") lease.release();
});

test("an invalid delegate pid prevents stale lease reclamation", () => {
  const root = home(), lock = join(root, "sync-update.mutation.lock");
  const instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  mkdirSync(lock);
  const owner = join(lock, `v1-2147483647-${instance}-${token}.json`);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: 2147483647, delegatePid: "unreadable", processInstance: instance, token, createdAt: 1000, holderKind: "sync" }));
  utimesSync(owner, 1, 1);
  expect(tryAcquireUpdateSyncMutex(root, "update", { now: () => 100_000, processAlive: () => false })).toEqual({ kind: "busy", holder: "unknown" });
});

test("sync child accepts only a matching parent-held mutex", async () => {
  const root = home(), lock = tryAcquireUpdateSyncMutex(root, "sync");
  if (lock.kind !== "acquired") throw Error("fixture lock");
  try {
    const script = `import {withSyncUpdateGuard} from ${JSON.stringify(repoPath("src/cli/sync-update-guard.ts"))}; process.exit(await withSyncUpdateGuard(async () => 0));`;
    for (const [heldBy, expected] of [[String(process.pid), 0], [String(process.pid + 1), 1], ["", 1]] as const) {
      const child = spawn(process.execPath, ["--no-env-file", "-e", script], { env: { ...process.env, OPENCODEX_HOME: root, OCX_TEST_HOME_GUARD: "1", OCX_SYNC_MUTEX_HELD_BY: heldBy, npm_config_registry: "http://127.0.0.1:9", NPM_CONFIG_REGISTRY: "http://127.0.0.1:9" }, stdio: "ignore" });
      if (!child.pid) throw Error("child did not start");
      if (expected === 0) lock.addDelegate(child.pid);
      const status = await new Promise<number | null>((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
      expect(status).toBe(expected);
    }
  } finally { lock.release(); }
}, 45000);

test("a matching parent pid cannot turn an update lease into a sync lease", () => {
  const root = home(), lock = tryAcquireUpdateSyncMutex(root, "update");
  if (lock.kind !== "acquired") throw Error("fixture lock");
  try {
    const script = `import {withSyncUpdateGuard} from ${JSON.stringify(repoPath("src/cli/sync-update-guard.ts"))}; process.exit(await withSyncUpdateGuard(async () => 0));`;
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", script], { env: { ...process.env, OPENCODEX_HOME: root, OCX_TEST_HOME_GUARD: "1", OCX_SYNC_MUTEX_HELD_BY: String(process.pid), npm_config_registry: "http://127.0.0.1:9", NPM_CONFIG_REGISTRY: "http://127.0.0.1:9" }, encoding: "utf8", timeout: 12000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 7, stderr: expect.stringContaining("update-in-flight") });
  } finally { lock.release(); }
}, 15000);

test.skipIf(process.platform === "win32")("legacy Node and Bun update refuse a sync holder before their work", () => {
  const root = home(), config = join(root, "config"), packageRoot = join(root, "node_modules", "@bitkyc08", "opencodex");
  mkdirSync(join(packageRoot, "bin"), { recursive: true }); mkdirSync(config);
  copyFileSync(repoPath("bin/ocx.mjs"), join(packageRoot, "bin", "ocx.mjs"));
  symlinkSync(repoPath("src"), join(packageRoot, "src"), "dir");
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@bitkyc08/opencodex", version: "1.0.0", type: "module" }));
  const env = { ...process.env, HOME: root, CODEX_HOME: join(root, "codex"), OPENCODEX_HOME: config,
    OCX_TEST_HOME_GUARD: "1", OCX_NO_DESKTOP_HANDOFF: "1", npm_config_registry: "http://127.0.0.1:9", NPM_CONFIG_REGISTRY: "http://127.0.0.1:9" };
  const lock = tryAcquireUpdateSyncMutex(config, "sync"); if (lock.kind !== "acquired") throw Error("fixture lock");
  try {
    const before = readFileSync(join(packageRoot, "package.json"), "utf8");
    const node = spawnSync("node", [join(packageRoot, "bin", "ocx.mjs"), "update"], { env, encoding: "utf8", timeout: 12000 });
    expect({ status: node.status, stderr: node.stderr }).toMatchObject({ status: 1, stderr: expect.stringContaining("sync-in-progress") });
    const script = `import {runUpdate} from ${JSON.stringify(repoPath("src/update/index.ts"))}; await runUpdate();`;
    const bun = spawnSync(process.execPath, ["--no-env-file", "-e", script], { env, encoding: "utf8", timeout: 12000 });
    expect({ status: bun.status, stderr: bun.stderr }).toMatchObject({ status: 1, stderr: expect.stringContaining("sync-in-progress") });
    expect(readFileSync(join(packageRoot, "package.json"), "utf8")).toBe(before);
  } finally { lock.release(); }
}, 20000);

test("sync refuses while a legacy update session holds its marker and mutex", async () => {
  const root = home(), previous = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = root;
  const { createLegacyUpdateSession } = await import("../../src/update/orchestrated-session.mjs");
  const session = createLegacyUpdateSession({ home: root });
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(session.start()).toEqual({ ok: true });
    expect(await withSyncUpdateGuard(async () => { throw Error("sync work reached"); })).toBe(7);
  } finally {
    session.finishPreflight(); err.mockRestore();
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  }
});

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

test.each(["sync", "update", "unknown"] as const)("sync guard classifies a %s mutex holder", async holder => {
  const root = home(), previous = process.env.OPENCODEX_HOME;
  process.env.OPENCODEX_HOME = root;
  const lock = holder === "unknown" ? null : tryAcquireUpdateSyncMutex(root, holder);
  if (lock && lock.kind !== "acquired") throw new Error("fixture lease not acquired");
  if (!lock) mkdirSync(join(root, "sync-update"));
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const code = await withSyncUpdateGuard(async () => { throw new Error("sync work reached"); });
    const reason = holder === "sync" ? "sync-in-progress" : "update-in-flight";
    expect(code).toBe(holder === "sync" ? 1 : 7);
    expect(err).toHaveBeenCalledWith(reason);
    const child = classifySyncResult({ code, stdout: "ocx-fanout:stdout-begin\n", stderr: `ocx-fanout:selected:2.93.0\n${reason}\n` });
    if (holder === "sync") {
      expect(child).toEqual({ state: "failed", reason: "child-sync-failed" });
      expect(fanoutExitCode({ schema: "ocx.sync.fanout/1", home: { state: "synced", exit: 0 }, fanout: { state: "ran", reason: null }, children: [{ linkId: "child", alias: "host", ...child, exit: code }] })).toBe(6);
    } else expect(child).toEqual({ state: "skipped", reason: "child-updating" });
  } finally {
    err.mockRestore(); if (lock?.kind === "acquired") lock.release();
    if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  }
});

test.each(["sync", "update", "unknown", "marker"] as const)("sync --json emits one fan-out refusal for %s", async holder => {
  const root = home(), previous = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = root;
  const lock = holder === "sync" || holder === "update" ? tryAcquireUpdateSyncMutex(root, holder) : null;
  if (lock && lock.kind !== "acquired") throw new Error("fixture lease not acquired");
  if (holder === "unknown") mkdirSync(join(root, "sync-update"));
  if (holder === "marker") writeFileSync(join(root, "update-orchestrated.json"), JSON.stringify({ pid: process.pid, phase: "mutating", startedAt: 1 }));
  const out = spyOn(console, "log").mockImplementation(() => {});
  const err = spyOn(console, "error").mockImplementation(() => {});
  try {
    const args = ["sync", "--json", "--local-only"];
    const deps = { args, findLiveProxy: async () => { throw new Error("sync work reached"); } } as unknown as CliDispatchDeps;
    const code = await dispatchCommand({ kind: "command", command: "sync", args }, deps);
    const reason = holder === "sync" ? "sync-in-progress" : "update-in-flight";
    expect(code).toBe(holder === "sync" ? 1 : 7);
    expect(err).toHaveBeenCalledWith(reason);
    expect(out).toHaveBeenCalledTimes(1);
    const output = out.mock.calls[0]![0] as string;
    expect(JSON.parse(output)).toEqual({ schema: "ocx.sync.fanout/1", home: { state: "skipped", exit: code }, fanout: { state: "not-applicable", reason }, children: [] });
    expect(classifySyncResult({ code, stdout: `ocx-fanout:stdout-begin\n${output}\n`, stderr: `ocx-fanout:selected:2.93.0\n${reason}\n` })).toEqual(holder === "sync" ? { state: "failed", reason: "child-sync-failed" } : { state: "skipped", reason: "child-updating" });
  } finally {
    out.mockRestore(); err.mockRestore(); if (lock?.kind === "acquired") lock.release();
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

test("a failed marker retains the update fence while its installer remains alive", () => {
  const root = home(), path = join(root, "update-orchestrated.json");
  writeFileSync(path, JSON.stringify({ pid: 2147483647, installerPid: process.pid, phase: "failed", startedAt: 1 }));
  expect(inspectUpdateMarker(root)).toBe("active");
  expect(isUpdateInFlight(root)).toBe(true);
});

test("unconfirmed installer termination without a recorded pid remains uncertain", () => {
  const root = home(), path = join(root, "update-orchestrated.json");
  writeFileSync(path, JSON.stringify({ pid: process.pid, phase: "failed", startedAt: 1, terminationUnconfirmed: true }));
  expect(inspectUpdateMarker(root)).toBe("unknown");
  expect(isUpdateInFlight(root)).toBe(true);
});

test.each([undefined, 2147483646])("dead worker with installer pid %s remains fenced until deadline", installerPid => {
  const root = home(), path = join(root, "update-orchestrated.json"), now = { value: 199 };
  writeFileSync(path, JSON.stringify({ pid: 2147483647, phase: "mutating", startedAt: 100, fenceUntil: 200,
    ...(installerPid === undefined ? {} : { installerPid }) }));
  expect(inspectUpdateMarker(root, { now: () => now.value })).toBe("active");
  now.value = 200;
  expect(inspectUpdateMarker(root, { now: () => now.value })).toBe("free");
});

test("a timed-out final marker remains fenced only until the bound when recorded processes are gone", () => {
  const root = home(), path = join(root, "update-orchestrated.json");
  writeFileSync(path, JSON.stringify({ pid: 2147483647, phase: "failed", startedAt: 100, fenceUntil: 200 }));
  expect(inspectUpdateMarker(root, { now: () => 199 })).toBe("active");
  expect(inspectUpdateMarker(root, { now: () => 200 })).toBe("free");
});

test("sync refuses a fenced dead worker before the deadline", async () => {
  const root = home(), previous = process.env.OPENCODEX_HOME; process.env.OPENCODEX_HOME = root;
  writeFileSync(join(root, "update-orchestrated.json"), JSON.stringify({ pid: 2147483647, phase: "mutating", startedAt: Date.now(), fenceUntil: Date.now() + 900000 }));
  const err = spyOn(console, "error").mockImplementation(() => {});
  try { expect(await withSyncUpdateGuard(async () => { throw Error("sync reached"); })).toBe(7); }
  finally { err.mockRestore(); if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous; }
});
