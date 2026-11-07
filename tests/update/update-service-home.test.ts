import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { inspectUpdateServiceHome, updateServiceHomeRefusal } from "../../src/update/service-home-authority";
import { restartServiceManagerAfterUpdate } from "../../src/update/job-supervised-restart";
import { readUpdateJob, restartAfterUpdateForTests, updateJobPath, type RestartIo, type UpdateJobState } from "../../src/update/job";
import type { OwnershipDeps } from "../../src/integrations/native/ownership-preflight";
import { createTempHome, type TempHome } from "../helpers/temp-home";

let box: TempHome;
let priorHome: string | undefined;
let priorSqlite: string | undefined;
let a: string;
let b: string;
let statePath: string;
let deps: OwnershipDeps;
beforeEach(() => {
  priorHome = process.env.HOME;
  priorSqlite = process.env.CODEX_SQLITE_HOME;
  box = createTempHome("ocx-update-service-home-");
  process.env.HOME = box.root;
  delete process.env.CODEX_SQLITE_HOME;
  a = box.path("registered-a"); b = box.path("foreground-b");
  for (const home of [a, b]) mkdirSync(join(home, ".codex"), { recursive: true });
  process.env.OPENCODEX_HOME = b;
  process.env.CODEX_HOME = join(b, ".codex");
  statePath = join(a, "service-state.json");
  deps = { statePaths: [statePath], currentHomes: { codexHome: join(b, ".codex"), opencodexHome: b },
    platform: "linux", home: box.root, configDir: b,
    run: () => ({ status: 0, stdout: "LoadState=not-found\nActiveState=inactive\nFragmentPath=\nNeedDaemonReload=no\n", stderr: "", timedOut: false, spawnFailed: false }),
    runRaw: () => { throw new Error("unexpected manager query"); },
  };
});
afterEach(() => {
  if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
  if (priorSqlite === undefined) delete process.env.CODEX_SQLITE_HOME; else process.env.CODEX_SQLITE_HOME = priorSqlite;
  box.remove();
});

function record(home: string, extra: Record<string, unknown> = {}, path = statePath): void {
  writeFileSync(path, JSON.stringify({ version: 1, codexHome: join(home, ".codex"), opencodexHome: home, ...extra }));
}
function inspect() { return inspectUpdateServiceHome(deps); }
function fixtureJob(): UpdateJobState {
  const job: UpdateJobState = { id: "home-guard", status: "restarting", startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    currentVersion: "1.0.0", latestVersion: "1.0.1", channel: "latest", installer: "bun", restart: true,
    command: "", releaseNotesUrl: "", log: [] };
  writeFileSync(updateJobPath(), JSON.stringify(job));
  return job;
}
function workerIo() {
  const calls = { repair: 0, manager: 0, reclaim: 0, kill: 0, spawn: 0, wrappers: 0 };
  const io: RestartIo = {
    platform: "linux", serviceInstalledFn: () => true, serviceHomeAuthorityFn: inspect,
    stopServiceWrappersFn: () => { calls.wrappers++; },
    readPidFn: () => 4242,
    killProxyFn: () => { calls.kill++; },
    waitForPort: async () => { calls.reclaim++; return true; },
    listListenPidsFn: () => [],
    isAliveFn: () => true,
    runService: () => { calls.repair++; return { status: 1 }; },
    restartServiceManagerFn: async () => { calls.manager++; return "supervised"; },
    reacquireForDirectStartFn: () => null,
    spawnStart: () => { calls.spawn++; },
  };
  return { calls, io };
}

test.each(["same", "foreign", "absent"] as const)("real two-home state distinguishes %s", kind => {
  if (kind !== "absent") record(kind === "same" ? b : a);
  expect(inspect()).toMatchObject({ kind });
});

test.each(["malformed", "unreadable", "conflicting"])("%s state refuses automatic home authority", kind => {
  if (kind === "malformed") writeFileSync(statePath, "{invalid");
  else if (kind === "unreadable") mkdirSync(statePath);
  else {
    record(a); const other = join(b, "service-state.json"); record(b, {}, other);
    deps = { ...deps, statePaths: [other, statePath] };
  }
  expect(inspect()).toEqual({ kind: "unknown" });
});

test("home authority preserves physical directory aliases", () => {
  record(a);
  deps = { ...deps, realpathSync: path => path === a ? b : path === join(a, ".codex") ? join(b, ".codex") : path };
  expect(inspect()).toEqual({ kind: "same" });
});

test("a manager query timeout remains unknown despite a matching state record", () => {
  record(b);
  deps = { ...deps, run: () => ({ status: null, stdout: "", stderr: "fixture", timedOut: true, spawnFailed: false }) };
  expect(inspect()).toEqual({ kind: "unknown" });
});

test.each(["same", "foreign", "unknown", "alias"] as const)("SQLite home %s uses the lifecycle's physical comparison", kind => {
  const installed = join(a, "sqlite"); const actual = join(b, "sqlite");
  mkdirSync(installed); mkdirSync(actual);
  process.env.CODEX_SQLITE_HOME = actual;
  record(b, { codexSqliteHome: kind === "same" ? actual : installed });
  if (kind === "alias") deps = { ...deps, realpathSync: path => path === installed ? actual : path };
  if (kind === "unknown") deps = { ...deps, realpathSync: () => { throw Object.assign(new Error("fixture"), { code: "EACCES" }); } };
  expect(inspect()).toMatchObject({ kind: kind === "alias" ? "same" : kind });
});

test("a state change during the unattended inspection is unknown", () => {
  record(b, { codexSqliteHome: join(a, ".codex") });
  deps = { ...deps, realpathSync: path => { record(a); return path === join(a, ".codex") ? join(b, ".codex") : path; } };
  expect(inspect()).toEqual({ kind: "unknown" });
});

test.each(["foreign", "unknown"])("standalone manager refuses %s before any manager or probe side effect", async kind => {
  if (kind === "foreign") record(a); else writeFileSync(statePath, "{invalid");
  let manager = 0; let probes = 0; let released = false;
  const lines: string[] = [];
  const result = await restartServiceManagerAfterUpdate({ port: 19001, hostname: "127.0.0.1", release: () => { released = true; } }, line => lines.push(line), {
    hasManager: () => true, serviceHomeAuthorityFn: () => { expect(released).toBe(true); return inspect(); },
    restartJob: () => { manager++; return { ok: false, reason: "fixture" }; },
    readRecord: () => { probes++; return null; },
  });
  expect(result).toBe("refused"); expect(manager).toBe(0); expect(probes).toBe(0);
  expect(lines.join("\n")).not.toContain(a); expect(lines.join("\n")).not.toContain(b);
});

test("the manager rechecks after release, not before it", async () => {
  record(b); let manager = 0;
  const result = await restartServiceManagerAfterUpdate({ port: 19001, hostname: "127.0.0.1", release: () => record(a) }, () => {}, {
    hasManager: () => true, serviceHomeAuthorityFn: inspect,
    restartJob: () => { manager++; return { ok: false, reason: "fixture" }; },
  });
  expect(result).toBe("refused"); expect(manager).toBe(0);
});

test("unknown service home blocks the unmarked dashboard worker before every mutation", async () => {
  writeFileSync(statePath, "{invalid");
  const { calls, io } = workerIo(); const job = fixtureJob();
  expect(await restartAfterUpdateForTests(job, { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 0, kill: 0, spawn: 0, wrappers: 0 });
  const saved = readUpdateJob(job.id);
  expect(saved).toMatchObject({ status: "failed", restarted: false });
  expect(JSON.stringify(saved)).not.toContain(a); expect(JSON.stringify(saved)).not.toContain(b);
});

test("a stable foreign service is untouched while B's captured foreground runtime recovers directly", async () => {
  record(a); const { calls, io } = workerIo();
  io.serviceInstalledFn = () => { throw new Error("foreign service must not be queried as B's manager"); };
  io.spawnStart = (_job, _installer, port) => { expect(port).toBe(19001); calls.spawn++; };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1", oldPid: 4242 }, io)).toBeUndefined();
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 1, kill: 1, spawn: 1, wrappers: 0 });
});

test("foreign direct pinned-start preparation receives no global service-stop authority", async () => {
  record(a); const { calls, io } = workerIo();
  delete io.spawnStart;
  io.probeProxyIdentity = async () => null;
  io.probeProxy = async () => true;
  io.preparePortForPinnedStartFn = (_job, _port, _list, _alive, _verify, stop) => { stop?.(); };
  io.waitForGhostListenClearFn = async () => ({ ok: true, accessDenied: false });
  io.spawnDetachedStartFn = () => { calls.spawn++; return Object.assign(new EventEmitter(), { pid: 5555, exitCode: null, signalCode: null }) as ChildProcess; };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1", oldPid: 4242 }, io)).toBeUndefined();
  expect(calls.wrappers).toBe(0); expect(calls.manager).toBe(0); expect(calls.repair).toBe(0); expect(calls.spawn).toBe(1);
});

test("a changed foreign registration is not treated as stable B recovery authority", async () => {
  record(a); const { calls, io } = workerIo();
  io.reacquireForDirectStartFn = () => { record(a, { bunPath: "/fixture/replaced-runtime" }); return null; };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 0, kill: 0, spawn: 0, wrappers: 0 });
});

test("same-home ordinary repair failure still recovers through the manager", async () => {
  record(b); const { calls, io } = workerIo();
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBeUndefined();
  expect(calls).toEqual({ repair: 1, manager: 1, reclaim: 1, kill: 0, spawn: 0, wrappers: 1 });
});

test("confirmed absent service keeps the normal direct start without touching a manager", async () => {
  const { calls, io } = workerIo();
  io.serviceInstalledFn = () => { throw new Error("absence needs no global installed probe"); };
  io.readPidFn = () => null;
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBeUndefined();
  expect(calls.manager).toBe(0); expect(calls.repair).toBe(0); expect(calls.wrappers).toBe(0); expect(calls.spawn).toBe(1);
});

test.each([
  ["release", "foreign"], ["repair", "foreign"], ["reacquire", "foreign"],
  ["release", "unknown"], ["repair", "unknown"], ["reacquire", "unknown"],
])("a home change during %s to %s refuses all remaining recovery", async (boundary, kind) => {
  record(b); const { calls, io } = workerIo();
  const change = () => kind === "foreign" ? record(a) : writeFileSync(statePath, "{invalid");
  if (boundary === "release") io.releaseForServiceManagerFn = change;
  else if (boundary === "repair") io.runService = () => { calls.repair++; change(); return { status: 1 }; };
  else {
    io.restartServiceManagerFn = async () => { calls.manager++; return "failed"; };
    io.reacquireForDirectStartFn = () => { change(); return null; };
  }
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(calls.reclaim).toBe(1); expect(calls.kill).toBe(0); expect(calls.spawn).toBe(0);
  expect(calls.repair).toBe(boundary === "release" ? 0 : 1);
  expect(calls.manager).toBe(boundary === "reacquire" ? 1 : 0);
  const persisted = readUpdateJob("home-guard");
  expect(persisted?.error).toContain("ocx service status");
  expect(persisted?.error).not.toContain("withheld");
  expect(JSON.stringify(persisted)).not.toContain(statePath);
});

test("a home change during the service-args import refuses before wrapper stop or port reclaim", async () => {
  record(b); const { calls, io } = workerIo();
  // The launcher read runs immediately after `await import("../service")`: staging the
  // flip there models authority changing while that import was in flight, before the
  // wrapper stop and port reclaim that must not run under foreign authority.
  io.packageLauncherPathFn = () => { record(a); return "/fixture/launcher"; };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 0, kill: 0, spawn: 0, wrappers: 0 });
  const persisted = readUpdateJob("home-guard");
  expect(persisted).toMatchObject({ status: "failed", restarted: false });
  expect(persisted?.error).toContain("ocx service status");
});

test("a home change during the port reclaim wait refuses the repair and every later side effect", async () => {
  record(b); const { calls, io } = workerIo();
  // The reclaim itself started under the entry authority and cannot be preempted
  // mid-wait; the check after the wait must refuse the repair and the manager.
  io.waitForPort = async () => { calls.reclaim++; record(a); return true; };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 1, kill: 0, spawn: 0, wrappers: 1 });
  expect(readUpdateJob("home-guard")).toMatchObject({ status: "failed", restarted: false });
});

test("the reclaim wait hands the real reclaimer a live home-authority gate", async () => {
  record(b); const { calls, io } = workerIo();
  // The real reclaimer consults this gate immediately before every kill and
  // TCP-row drop; the injected wait flips the registration mid-wait and exercises
  // the gate itself, the same way an in-flight availability await would.
  let gateDenied = false;
  io.waitForPort = async (_port, _hostname, opts) => {
    calls.reclaim++;
    record(a);
    gateDenied = opts?.mayMutateFn?.() === false;
    return false;
  };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(gateDenied).toBe(true);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 1, kill: 0, spawn: 0, wrappers: 1 });
  const persisted = readUpdateJob("home-guard");
  expect(persisted).toMatchObject({ status: "failed", restarted: false });
  expect(persisted?.error).toContain("ocx service status");
  // A denied reclaim must not be misclassified as a busy-port timeout.
  expect(JSON.stringify(persisted)).not.toContain("still busy");
});

test("a latched reclaim denial outranks a transient re-match before the wait ends", async () => {
  record(b); const { calls, io } = workerIo();
  // The mid-wait denial latches; restoring B's record before the wait returns must
  // not re-arm the busy-port repair path — the recorded refusal stands.
  let deniedInWait = false;
  io.waitForPort = async (_port, _hostname, opts) => {
    calls.reclaim++;
    record(a);
    deniedInWait = opts?.mayMutateFn?.() === false;
    record(b); // transient re-match before the wait returns
    return false;
  };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(deniedInWait).toBe(true);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 1, kill: 0, spawn: 0, wrappers: 1 });
  const persisted = readUpdateJob("home-guard");
  expect(persisted).toMatchObject({ status: "failed", restarted: false });
  expect(persisted?.error).toContain("ocx service status");
  expect(JSON.stringify(persisted)).not.toContain("still busy");
});

test("the direct recovery reclaim also keeps a transient authority denial latched", async () => {
  record(a); const { calls, io } = workerIo();
  let deniedInWait = false;
  io.waitForPort = async (_port, _hostname, opts) => {
    calls.reclaim++;
    record(b);
    deniedInWait = opts?.mayMutateFn?.() === false;
    record(a);
    return false;
  };
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(deniedInWait).toBe(true);
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 1, kill: 1, spawn: 0, wrappers: 0 });
  const persisted = readUpdateJob("home-guard");
  expect(persisted).toMatchObject({ status: "failed", restarted: false });
  expect(JSON.stringify(persisted)).not.toContain("still busy");
});

test("confirmed absence after lease release skips repair and every later global service operation", async () => {
  record(b); const { calls, io } = workerIo();
  io.releaseForServiceManagerFn = () => unlinkSync(statePath);
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe("unsupervised");
  expect(calls).toEqual({ repair: 0, manager: 0, reclaim: 2, kill: 1, spawn: 1, wrappers: 1 });
});

test("a manager's explicit refusal cannot turn into an ordinary fallback", async () => {
  record(b); const { calls, io } = workerIo();
  io.restartServiceManagerFn = async () => "refused";
  expect(await restartAfterUpdateForTests(fixtureJob(), { port: 19001, hostname: "127.0.0.1" }, io)).toBe(false);
  expect(calls.kill).toBe(0); expect(calls.spawn).toBe(0);
  expect(readUpdateJob("home-guard")).toMatchObject({ status: "failed", restarted: false });
});

test("refusal guidance is static and points to manual service status", () => {
  for (const kind of ["foreign", "unknown"] as const) expect(updateServiceHomeRefusal({ kind })).toContain("ocx service status");
  for (const kind of ["same", "absent"] as const) expect(updateServiceHomeRefusal({ kind })).toBeNull();
});
