import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { PassThrough, Writable } from "node:stream";
import { spawnSync, type ChildProcess } from "node:child_process";
import { repoPath } from "../helpers/repo-root";
import { inspectUpdateMarker, staleUpdateMarkerHint } from "../../src/update/sync-update-mutex";
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

test("win32: a finished session leaves no supervisor pid for a reused pid to hold", async () => {
  // Windows reuses pids quickly. A finished update must not read as in flight because an
  // unrelated process now holds the supervisor's old number, so the confirmed exit drops it.
  const root = home();
  const session = createOrchestratedChildSession({ home: root, verifyIdentity: () => true });
  session.start(); await session.enterMutation();
  session.noteUntrackedInstaller();
  publishWindowsInstallerPid(markerPath(root), SUPERVISOR);
  session.confirmInstallerExit();
  session.finish({ phase: "installed" });
  expect(readMarker(root).installerPid).toBeUndefined();
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set([SUPERVISOR])) })).toBe("free");
});

test("win32: a recorded live installer keeps a marker fenced, as on POSIX", () => {
  const root = home();
  writeMarker(root, { pid: 2147483647, phase: "failed", startedAt: 1_000, installerPid: SUPERVISOR });
  expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set([SUPERVISOR])) })).toBe("active");
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

describe("legacy witnessless marker recovery hint (#8524 decision A)", () => {
  const DEAD = 2_147_483_647; // no host hands out this pid
  const legacy = { pid: DEAD, phase: "mutating", startedAt: 1_000, fenceUntil: 901_000, terminationUnconfirmed: true };

  test("the inspection that refuses reports a witnessless marker through its detail", () => {
    const root = home();
    writeMarker(root, interrupted);
    const detail: { witnessless?: boolean } = {};
    expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set()), detail })).toBe("unknown");
    expect(detail.witnessless).toBe(true);
    for (const [marker, alive, now] of [
      [{ ...interrupted, installerPid: SUPERVISOR }, new Set<number>(), afterFence],
      [interrupted, new Set([LAUNCHER]), afterFence],
      [interrupted, new Set<number>(), () => 500_000],
    ] as const) {
      writeMarker(root, marker);
      const other: { witnessless?: boolean } = {};
      inspectUpdateMarker(root, { now, platform: "win32", signal: signalWith(alive), detail: other });
      expect(other.witnessless).toBeUndefined();
    }
    const unprobeable: { witnessless?: boolean } = {};
    writeMarker(root, interrupted);
    expect(inspectUpdateMarker(root, { now: afterFence, platform: "win32", signal: signalWith(new Set(), new Set([LAUNCHER])), detail: unprobeable })).toBe("unknown");
    expect(unprobeable.witnessless).toBeUndefined();
  });

  test("the hint names the marker and a reversible rename for the platform", () => {
    const root = home();
    // The hint is formatted for the platform it names, whatever host runs the test.
    const windowsPath = win32.join(root, "update-orchestrated.json");
    const posixPath = posix.join(root, "update-orchestrated.json");
    const windows = staleUpdateMarkerHint(root, "win32").join("\n");
    expect(windows).toContain(windowsPath);
    expect(windows).toContain(`ren "${windowsPath}" update-orchestrated.json.stale`);
    expect(windows).toContain("ocx update");
    expect(staleUpdateMarkerHint("C:\\Users\\a\\.opencodex", "win32").join("\n"))
      .toContain('ren "C:\\Users\\a\\.opencodex\\update-orchestrated.json" update-orchestrated.json.stale');
    const posixHint = staleUpdateMarkerHint(root, "linux").join("\n");
    expect(posixHint).toContain(`mv -n '${posixPath}' '${posixPath}.stale'`);
    // Nothing in a pasted command may expand: POSIX quotes a quote; Windows prints no command at all.
    expect(staleUpdateMarkerHint("/home/o'neil/.opencodex", "linux").join("\n"))
      .toContain("mv -n '/home/o'\\''neil/.opencodex/update-orchestrated.json'");
    const expandable = staleUpdateMarkerHint("C:\\Users\\$(evil)\\.opencodex", "win32").join("\n");
    expect(expandable).not.toContain("ren ");
    expect(expandable).toContain("rename that file by hand");
    // PowerShell also closes a string on typographic quotes and globs brackets: no command for those either.
    for (const home of ["C:\\Users\\a\u201d; calc; \u201cb\\.opencodex", "C:\\Users\\[x]\\.opencodex", "C:\\Users\\a!b\\.opencodex", "C:\\Users\\Jos\u00e9\\.opencodex"]) {
      expect(staleUpdateMarkerHint(home, "win32").join("\n")).not.toContain("ren ");
    }
    // A control character never reaches the terminal or a command.
    const escaped = staleUpdateMarkerHint("/home/a\u001b]0;x\u0007/.opencodex", "linux").join("\n");
    expect(escaped).not.toContain("\u001b");
    expect(escaped).not.toContain("mv -n");
    // A Windows-shaped marker read on POSIX has no group witness either; it gets the POSIX command.
    writeMarker(root, { ...interrupted, installerPid: SUPERVISOR });
    const detail: { witnessless?: boolean } = {};
    inspectUpdateMarker(root, { now: afterFence, platform: "linux", signal: signalWith(new Set()), detail });
    expect(detail.witnessless).toBe(true);
  });

  test("a legacy update session refusal is flagged only when the marker refused it", () => {
    const root = home();
    writeMarker(root, legacy);
    expect(createOrchestratedChildSession({ home: root, verifyIdentity: () => true }).start())
      .toEqual({ ok: false, error: "update-in-flight", staleMarker: true });
    writeMarker(root, { ...legacy, fenceUntil: Date.now() + 600_000 });
    expect(createOrchestratedChildSession({ home: root, verifyIdentity: () => true }).start())
      .toEqual({ ok: false, error: "update-in-flight" });
  });

  test("ocx sync refused by a legacy marker prints the reason, then the hint", () => {
    const root = home();
    writeMarker(root, legacy);
    const script = `import {withSyncUpdateGuard} from ${JSON.stringify(repoPath("src/cli/sync-update-guard.ts"))}; process.exit(await withSyncUpdateGuard(async () => 0, ${JSON.stringify(["--json"])}));`;
    const result = spawnSync(process.execPath, ["--no-env-file", "-e", script], {
      env: { ...process.env, HOME: root, USERPROFILE: root, CODEX_HOME: join(root, "codex"), OPENCODEX_HOME: root, OCX_TEST_HOME_GUARD: "1" },
      encoding: "utf8", timeout: 12_000,
    });
    expect(result.status).toBe(7);
    const lines = result.stderr.trim().split("\n");
    expect(lines[0]).toBe("update-in-flight");
    expect(lines.slice(1).join("\n")).toContain(markerPath(root));
    // The JSON document is the sync wire format and stays exactly as before.
    expect(JSON.parse(result.stdout)).toEqual({ schema: "ocx.sync.fanout/1", home: { state: "skipped", exit: 7 }, fanout: { state: "not-applicable", reason: "update-in-flight" }, children: [] });
  }, 30_000);
});
