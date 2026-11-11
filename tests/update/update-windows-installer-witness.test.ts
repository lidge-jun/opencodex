import { afterEach, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { inspectUpdateMarker } from "../../src/update/sync-update-mutex";
import { createOrchestratedChildSession } from "../../src/update/orchestrated-session.mjs";
import { publishWindowsInstallerPid } from "../../src/update/windows-installer-marker.mjs";
import { runNpmInstall, setWindowsInstallerSupervisorForTests } from "../../src/update/npm-install.mjs";

/**
 * #8524: an interrupted Windows update left update-orchestrated.json with terminationUnconfirmed
 * and no process-tree witness, so inspectUpdateMarker answered "unknown" forever and every later
 * update and sync refused with update-in-flight. Windows now records the Job Object supervisor pid
 * (its exit closes the kill-on-close job) and the marker frees once that pid and the fence are gone.
 */
const roots: string[] = [];
afterEach(() => {
  setWindowsInstallerSupervisorForTests(null);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function home() { const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-win-witness-"))); roots.push(root); return root; }
const markerPath = (root: string) => join(root, "update-orchestrated.json");
function writeMarker(root: string, marker: Record<string, unknown>) { writeFileSync(markerPath(root), JSON.stringify(marker)); }
function readMarker(root: string) { return JSON.parse(readFileSync(markerPath(root), "utf8")); }
const LAUNCHER = 49192, SUPERVISOR = 51515;
const signalWith = (alive: Set<number>, unprobeable = new Set<number>()) => (id: number) => {
  if (alive.has(id)) return true;
  throw Object.assign(new Error("probe"), { code: unprobeable.has(id) ? "EPERM" : "ESRCH" });
};
const interrupted = { pid: LAUNCHER, phase: "mutating", startedAt: 1_000, fenceUntil: 901_000, terminationUnconfirmed: true };
const afterFence = () => 2_000_000;

test("win32: an interrupted update frees once its supervisor and fence are gone", () => {
  const root = home();
  writeMarker(root, { ...interrupted, installerPid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set()) })).toBe("free");
});

test("win32: a live supervisor, a live launcher or an unexpired fence keeps the update in flight", () => {
  const root = home();
  writeMarker(root, { ...interrupted, installerPid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set([SUPERVISOR])) })).toBe("active");
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set([LAUNCHER])) })).toBe("active");
  expect(inspectUpdateMarker(root, { now: () => 500_000, platform: "win32", signal: signalWith(new Set()) })).toBe("active");
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set(), new Set([SUPERVISOR])) })).toBe("unknown");
});

test("win32: a marker without a supervisor witness, or with a POSIX group, stays unknown", () => {
  const root = home();
  writeMarker(root, interrupted);
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set()) })).toBe("unknown");
  writeMarker(root, { ...interrupted, installerPid: SUPERVISOR, installerPgid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set()) })).toBe("unknown");
});

test("win32: a confirmed installer never probes its old supervisor pid", () => {
  // Windows reuses pids quickly; a finished update must not read as in flight because some
  // unrelated process now holds the supervisor's old number.
  const root = home();
  writeMarker(root, { pid: LAUNCHER, phase: "installed", startedAt: 1_000, installerPid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set([SUPERVISOR])) })).toBe("free");
});

test("POSIX keeps requiring the installer process group", () => {
  const root = home();
  writeMarker(root, { ...interrupted, installerPid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "linux", signal: signalWith(new Set()) })).toBe("unknown");
  writeMarker(root, { ...interrupted, installerPid: SUPERVISOR, installerPgid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "linux", signal: signalWith(new Set()) })).toBe("free");
});

test("publish records the supervisor only on a marker awaiting an installer", () => {
  const root = home();
  writeMarker(root, interrupted);
  publishWindowsInstallerPid(markerPath(root), SUPERVISOR);
  expect(readMarker(root)).toEqual({ ...interrupted, installerPid: SUPERVISOR });

  writeMarker(root, { ...interrupted, terminationUnconfirmed: undefined });
  expect(() => publishWindowsInstallerPid(markerPath(root), SUPERVISOR)).toThrow("not awaiting an installer");
  writeMarker(root, { ...interrupted, installerPgid: 7 });
  expect(() => publishWindowsInstallerPid(markerPath(root), SUPERVISOR)).toThrow("not awaiting an installer");
  writeMarker(root, { ...interrupted, phase: "failed" });
  expect(() => publishWindowsInstallerPid(markerPath(root), SUPERVISOR)).toThrow("not awaiting an installer");
});

test("publish replaces a gone supervisor but keeps a live one as the witness", () => {
  const root = home();
  writeMarker(root, { ...interrupted, installerPid: 4242 });
  publishWindowsInstallerPid(markerPath(root), SUPERVISOR, { gone: () => true });
  expect(readMarker(root).installerPid).toBe(SUPERVISOR);
  writeMarker(root, { ...interrupted, installerPid: 4242 });
  let error: unknown;
  try { publishWindowsInstallerPid(markerPath(root), SUPERVISOR, { gone: () => false }); } catch (caught) { error = caught; }
  expect((error as { code?: string }).code).toBe("EINSTALLWITNESS");
  expect(readMarker(root).installerPid).toBe(4242);
});

test("a session with an install run and a rollback run records each supervisor", async () => {
  const root = home();
  const session = createOrchestratedChildSession({ home: root, verifyIdentity: () => true });
  expect(session.start()).toEqual({ ok: true });
  expect(await session.enterMutation()).toEqual({ ok: true });
  session.noteUntrackedInstaller();
  publishWindowsInstallerPid(markerPath(root), 6001);
  session.confirmInstallerExit();
  // A confirmed Windows supervisor is no longer a witness, so the rollback's publish has nothing to replace.
  expect(readMarker(root).installerPid).toBeUndefined();
  expect(readMarker(root).terminationUnconfirmed).toBeUndefined();
  session.noteUntrackedInstaller();
  publishWindowsInstallerPid(markerPath(root), 6002, { gone: () => false });
  expect(readMarker(root).installerPid).toBe(6002);
  session.confirmInstallerExit();
  session.finish({ phase: "installed" });
});

test("a confirmed POSIX installer keeps its recorded group", async () => {
  const root = home();
  const session = createOrchestratedChildSession({ home: root, verifyIdentity: () => true });
  session.start(); await session.enterMutation();
  session.noteUntrackedInstaller();
  writeMarker(root, { ...readMarker(root), installerPid: 7001, installerPgid: 7001 });
  session.confirmInstallerExit();
  expect(readMarker(root)).toMatchObject({ installerPid: 7001, installerPgid: 7001 });
  session.finish({ phase: "installed" });
});

function fakeSupervisor(pid: number | undefined) {
  const events: string[] = [];
  const child = new EventEmitter() as EventEmitter & { pid?: number; stdin: Writable; stdout: PassThrough; stderr: PassThrough; kill: () => boolean };
  child.pid = pid;
  let request = "";
  child.stdin = new Writable({ write(chunk, _encoding, done) { request += String(chunk); done(); }, final(done) { events.push(`request:${request}`); done(); } });
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => { events.push("kill"); setImmediate(() => child.emit("close", null)); return true; };
  queueMicrotask(() => child.emit("spawn"));
  return { child, events, answer(result: unknown) { child.stdout.end(JSON.stringify(result)); setImmediate(() => child.emit("close", 0)); } };
}
const invocation = { file: "C:\\Program Files\\nodejs\\npm.cmd", args: ["install", "-g", "x"], options: {} };
const env = { SystemRoot: "C:\\Windows" };

test("win32: the supervisor pid is in the marker before the supervisor receives its request", async () => {
  const root = home();
  writeMarker(root, interrupted);
  const fake = fakeSupervisor(SUPERVISOR);
  let markerAtRequest: Record<string, unknown> | undefined;
  fake.child.stdin.on("finish", () => { markerAtRequest = readMarker(root); fake.answer({ status: 0, processTreeExited: true }); });
  setWindowsInstallerSupervisorForTests({ platform: "win32", launch: () => fake.child as unknown as ChildProcess });
  const result = await runNpmInstall(invocation, { env, authorizeMutation: () => true, markerPath: markerPath(root) });
  expect(markerAtRequest?.installerPid).toBe(SUPERVISOR);
  expect(result).toEqual({ status: 0, processTreeExited: true });
  expect(fake.events.some(event => event.startsWith("request:{"))).toBe(true);
});

test("win32: an unrecordable supervisor gets no request and reports a confirmed, unstarted installer", async () => {
  const root = home();
  writeMarker(root, { ...interrupted, phase: "failed" });
  const fake = fakeSupervisor(SUPERVISOR);
  setWindowsInstallerSupervisorForTests({ platform: "win32", launch: () => fake.child as unknown as ChildProcess });
  const result = await runNpmInstall(invocation, { env, authorizeMutation: () => true, markerPath: markerPath(root) });
  expect(fake.events).toEqual(["request:", "kill"]);
  // An integer status with a confirmed tree lets the caller confirm the exit and clear the
  // unconfirmed flag; a null status would recreate the stuck marker.
  expect(result).toMatchObject({ status: 1, processTreeExited: true, error: { code: "EINSTALLJOIN" } });
});

test("win32: a live earlier supervisor keeps its witness and the run stays unconfirmed", async () => {
  const root = home();
  writeMarker(root, { ...interrupted, installerPid: process.pid });
  const fake = fakeSupervisor(SUPERVISOR);
  setWindowsInstallerSupervisorForTests({ platform: "win32", launch: () => fake.child as unknown as ChildProcess });
  const result = await runNpmInstall(invocation, { env, authorizeMutation: () => true, markerPath: markerPath(root) });
  expect(fake.events).toEqual(["request:", "kill"]);
  expect(result).toMatchObject({ status: null, processTreeExited: false });
  expect(readMarker(root).installerPid).toBe(process.pid);
});
test("the Windows supervisor seam refuses outside a test process", () => {
  const previous = process.env.OCX_TEST_HOME_GUARD;
  process.env.OCX_TEST_HOME_GUARD = "0";
  try {
    expect(() => setWindowsInstallerSupervisorForTests({ platform: "win32" })).toThrow("test-only");
    expect(() => setWindowsInstallerSupervisorForTests(null)).not.toThrow();
  } finally {
    if (previous === undefined) delete process.env.OCX_TEST_HOME_GUARD; else process.env.OCX_TEST_HOME_GUARD = previous;
  }
});
