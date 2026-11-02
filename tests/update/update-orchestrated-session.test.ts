import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { inspectUpdateMarker, isUpdateInFlight, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex";
import { createOrchestratedChildSession, encodeOrchestratedExpect, decodeOrchestratedExpect } from "../../src/update/orchestrated-session.mjs";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "ocx-session-")); roots.push(home);
  return { home, resultPath: join(home, "result.json"), expect: { home, cliRoot: join(home, "cli"), servingRoot: null, runtimePid: null, planToken: "a".repeat(43) } };
}
function read(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test.each([
  { pid: 2147483647, phase: "mutating", startedAt: 1, installerPid: process.pid },
  { pid: 2147483647, phase: "failed", startedAt: 1, terminationUnconfirmed: true },
])("prior installer marker refuses and remains untouched: %j", marker => {
  const f = fixture(), path = join(f.home, "update-orchestrated.json");
  const original = JSON.stringify(marker); writeFileSync(path, original);
  const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  expect(session.start()).toEqual({ ok: false, error: "update-in-flight" });
  expect(readFileSync(path, "utf8")).toBe(original);
});

test.skipIf(process.platform === "win32")("POSIX installer timeout terminates its descendant group before returning", () => {
  const f = fixture(), marker = join(f.home, "update-orchestrated.json"), descendant = join(f.home, "descendant");
  writeFileSync(marker, JSON.stringify({ pid: process.pid, phase: "mutating", startedAt: Date.now() }));
  const installer = join(f.home, "installer.cjs");
  writeFileSync(installer, `const {spawn}=require('node:child_process'),fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(process.argv[2],String(c.pid));setInterval(()=>{},1000);`);
  const node = Bun.which("node"); if (!node) throw new Error("node unavailable");
  const entry = pathToFileURL(repoPath("src/update/posix-install-supervisor.mjs")).href;
  const script = `import {runPosixInstallerSync} from ${JSON.stringify(entry)}; const result=runPosixInstallerSync({file:${JSON.stringify(node)},args:[${JSON.stringify(installer)},${JSON.stringify(descendant)}],markerPath:${JSON.stringify(marker)},timeoutMs:1000,env:process.env});console.log(JSON.stringify(result));`;
  const result = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
  expect(JSON.parse(result.stdout)).toMatchObject({ groupExited: true, processTreeExited: false, status: null });
  const pid = Number(readFileSync(descendant, "utf8"));
  expect(() => process.kill(pid, 0)).toThrow();
}, 20000);

test.skipIf(process.platform === "win32")("POSIX supervisor distinguishes a signalled installer from a normal exit", () => {
  const f = fixture(), marker = join(f.home, "update-orchestrated.json");
  const node = Bun.which("node"); if (!node) throw new Error("node unavailable");
  const entry = pathToFileURL(repoPath("src/update/posix-install-supervisor.mjs")).href;
  for (const [code, expected] of [["process.exit(0)", { status: 0, signal: null, groupExited: true, groupKilled: false }],
    ["process.kill(process.pid, 'SIGTERM')", { status: null, signal: "SIGTERM", groupExited: true, groupKilled: false }]] as const) {
    writeFileSync(marker, JSON.stringify({ pid: process.pid, phase: "mutating", startedAt: Date.now() }));
    const script = `import {runPosixInstallerSync} from ${JSON.stringify(entry)};console.log(JSON.stringify(runPosixInstallerSync({file:${JSON.stringify(node)},args:['-e',${JSON.stringify(code)}],markerPath:${JSON.stringify(marker)},env:process.env})));`;
    const result = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject(expected);
  }
}, 20000);

test.skipIf(process.platform === "win32")("escaped installer descendant keeps the timed-out marker fenced", () => {
  const f = fixture(), marker = join(f.home, "update-orchestrated.json"), descendant = join(f.home, "escaped");
  writeFileSync(marker, JSON.stringify({ pid: 2147483647, phase: "mutating", startedAt: 100, fenceUntil: 200 }));
  const installer = join(f.home, "escape.cjs");
  writeFileSync(installer, `const {spawn}=require('node:child_process'),fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'}); c.unref(); fs.writeFileSync(process.argv[2],String(c.pid)); setInterval(()=>{},1000);`);
  const node = Bun.which("node"); if (!node) throw Error("node unavailable");
  const entry = pathToFileURL(repoPath("src/update/posix-install-supervisor.mjs")).href;
  const script = `import {runPosixInstallerSync} from ${JSON.stringify(entry)}; console.log(JSON.stringify(runPosixInstallerSync({file:${JSON.stringify(node)},args:[${JSON.stringify(installer)},${JSON.stringify(descendant)}],markerPath:${JSON.stringify(marker)},timeoutMs:1000,env:process.env})));`;
  try {
    const result = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 15000 });
    expect({ status: result.status, stderr: result.stderr }).toMatchObject({ status: 0 });
    expect(JSON.parse(result.stdout)).toMatchObject({ groupExited: true, processTreeExited: false, status: null });
    expect(() => process.kill(Number(readFileSync(descendant, "utf8")), 0)).not.toThrow();
    expect(inspectUpdateMarker(f.home, { now: () => 199 })).toBe("active");
    expect(inspectUpdateMarker(f.home, { now: () => 200 })).toBe("free");
  } finally {
    if (existsSync(descendant)) {
      try { process.kill(Number(readFileSync(descendant, "utf8")), "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
  }
}, 20000);

test("preflight owns the update mutex and remains visible until finalized", () => {
  const f = fixture(); const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  expect(session.start()).toEqual({ ok: true });
  expect(isUpdateInFlight(f.home)).toBe(true);
  expect(tryAcquireUpdateSyncMutex(f.home, "sync")).toMatchObject({ kind: "busy", holder: "update" });
  session.finishPreflight();
  expect(isUpdateInFlight(f.home)).toBe(false);
  expect(read(f.resultPath)).toEqual({ phase: "preflight" });
});

test("finalizing a failed transaction retains the recorded installer identity", async () => {
  const f = fixture(), session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  session.start(); await session.enterMutation();
  const path = join(f.home, "update-orchestrated.json"), marker = read(path);
  writeFileSync(path, JSON.stringify({ ...marker, installerPid: process.pid }));
  session.finish({ phase: "failed", error: "installer-termination-unconfirmed" });
  expect(read(path)).toMatchObject({ phase: "failed", installerPid: process.pid });
  expect(isUpdateInFlight(f.home)).toBe(true);
});

test("an untracked installer is fenced before it can start", async () => {
  const f = fixture(), session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  session.start(); await session.enterMutation();
  session.noteUntrackedInstaller();
  expect(read(join(f.home, "update-orchestrated.json"))).toMatchObject({ phase: "mutating", terminationUnconfirmed: true });
  session.finish({ phase: "failed", error: "installer-termination-unconfirmed" });
  expect(isUpdateInFlight(f.home)).toBe(true);
});

test("mutation marker publishes the time fence before launching an installer and retains it on timeout", async () => {
  const f = fixture(), marker = join(f.home, "update-orchestrated.json");
  const session = createOrchestratedChildSession({ ...f, now: () => 1000, verifyIdentity: () => true });
  session.start(); await session.enterMutation();
  expect(read(marker)).toMatchObject({ phase: "mutating", fenceUntil: 901000 });
  session.finish({ phase: "failed", error: "installer-termination-unconfirmed" });
  expect(read(marker)).toMatchObject({ phase: "failed", fenceUntil: 901000 });
});

test("group-only supervision keeps the fence even after a successful install", async () => {
  const f = fixture(), marker = join(f.home, "update-orchestrated.json");
  const session = createOrchestratedChildSession({ ...f, now: () => 1000, verifyIdentity: () => true });
  session.start(); await session.enterMutation(); session.retainInstallerFence();
  session.finish({ phase: "installed", activeRoot: f.home });
  expect(read(marker)).toMatchObject({ phase: "installed", fenceUntil: 901000 });
});

test("a confirmed untracked installer releases its fence only after finalization", async () => {
  const f = fixture(), session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  session.start(); await session.enterMutation(); session.noteUntrackedInstaller();
  session.confirmInstallerExit();
  expect(isUpdateInFlight(f.home)).toBe(true);
  session.finish({ phase: "installed", activeRoot: f.home });
  expect(read(join(f.home, "update-orchestrated.json")).fenceUntil).toBeUndefined();
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test("preflight must be writable before proceeding", () => {
  const f = fixture();
  const session = createOrchestratedChildSession({ ...f, resultPath: join(f.home, "missing", "result"), verifyIdentity: () => true });
  expect(() => session.start()).toThrow();
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test("sync holder refuses without writing an orchestrated marker", async () => {
  const f = fixture(); const lock = tryAcquireUpdateSyncMutex(f.home, "sync");
  if (lock.kind !== "acquired") throw new Error("fixture lock");
  try {
    const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
    expect(session.start()).toEqual({ ok: false, error: "sync-in-progress" });
    expect(read(f.resultPath)).toEqual({ phase: "refused", error: "sync-in-progress" });
    expect(existsSync(join(f.home, "update-orchestrated.json"))).toBe(false);
  } finally { lock.release(); }
});

test("deadline check sees update in flight before refusing and releases the lock", async () => {
  const f = fixture(); let observed = false;
  const session = createOrchestratedChildSession({ ...f, notAfter: 10, now: () => {
    if (existsSync(join(f.home, "update-orchestrated.json"))) observed = isUpdateInFlight(f.home);
    return 11;
  }, verifyIdentity: () => { throw new Error("should not run"); } });
  session.start(); expect(await session.enterMutation()).toEqual({ ok: false, error: "deadline-passed" });
  expect(observed).toBe(true);
  expect(read(join(f.home, "update-orchestrated.json")).phase).toBe("refused");
  expect(read(f.resultPath)).toEqual({ phase: "refused", error: "deadline-passed" });
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test("deadline is rechecked after asynchronous identity verification", async () => {
  const f = fixture(); let clock = 99;
  const session = createOrchestratedChildSession({ ...f, notAfter: 100, now: () => clock,
    verifyIdentity: async () => { clock = 101; return true; } });
  expect(session.start()).toEqual({ ok: true });
  expect(await session.enterMutation()).toEqual({ ok: false, error: "deadline-passed" });
  expect(read(f.resultPath)).toEqual({ phase: "refused", error: "deadline-passed" });
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test.each([false, "throw"] as const)("identity %s refuses after publishing in-flight", async value => {
  const f = fixture(); let observed = false;
  const session = createOrchestratedChildSession({ ...f, verifyIdentity: async () => {
    observed = isUpdateInFlight(f.home); if (value === "throw") throw new Error("identity"); return value;
  } });
  session.start(); expect(await session.enterMutation()).toEqual({ ok: false, error: "plan-changed" });
  expect(observed).toBe(true); expect(isUpdateInFlight(f.home)).toBe(false);
  expect(read(join(f.home, "update-orchestrated.json")).phase).toBe("refused");
});

test("finish writes final outcome before releasing mutex; failed marker write keeps mutex", async () => {
  const f = fixture(); const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  session.start(); expect(await session.enterMutation()).toEqual({ ok: true });
  const marker = join(f.home, "update-orchestrated.json"), original = read(marker); rmSync(marker); mkdirSync(marker);
  expect(() => session.finish({ phase: "installed", activeRoot: "/active" })).toThrow();
  expect(read(f.resultPath)).toEqual({ phase: "installed", activeRoot: "/active" });
  expect(isUpdateInFlight(f.home)).toBe(true);
  rmSync(marker, { recursive: true }); writeFileSync(marker, JSON.stringify(original)); session.finish({ phase: "installed", activeRoot: "/active" });
  expect(isUpdateInFlight(f.home)).toBe(false); expect(read(marker).phase).toBe("installed");
});

test("unreadable marker fails closed and a stale dead holder is recovered", () => {
  const f = fixture(); const marker = join(f.home, "update-orchestrated.json"); mkdirSync(marker);
  expect(isUpdateInFlight(f.home)).toBe(true); rmSync(marker, { recursive: true });
  const lock = join(f.home, "sync-update.mutation.lock"); mkdirSync(lock);
  const instance = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const owner = join(lock, `v1-${process.pid}-${instance}-${token}.json`);
  writeFileSync(owner, JSON.stringify({ version: 1, pid: process.pid, processInstance: instance, token, createdAt: 1000, holderKind: "sync" })); utimesSync(owner, 1, 1);
  const acquired = tryAcquireUpdateSyncMutex(f.home, "update", { now: () => 100_000, processAlive: () => false });
  expect(acquired.kind).toBe("acquired"); if (acquired.kind === "acquired") acquired.release();
});

test("expect round trips and malformed payloads are rejected", () => {
  const f = fixture(); expect(decodeOrchestratedExpect(encodeOrchestratedExpect(f.expect))).toEqual(f.expect);
  for (const bad of ["", "!", "e30", "eyJob21lIjoxfQ", Buffer.from(JSON.stringify({ ...f.expect, runtimePid: -1 })).toString("base64url"), Buffer.from(JSON.stringify({ ...f.expect, planToken: "short" })).toString("base64url")]) {
    expect(() => decodeOrchestratedExpect(bad)).toThrow();
  }
});

test("plain Node performs the session lifecycle", () => {
  const f = fixture();
  const url = pathToFileURL(repoPath("src/update/orchestrated-session.mjs")).href;
  const script = `const { createOrchestratedChildSession } = await import(${JSON.stringify(url)});
    const f = ${JSON.stringify(f)};
    const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
    session.start(); if (!(await session.enterMutation()).ok) process.exit(2);
    session.finish({ phase: "failed", error: "test" });`;
  const result = spawnSync("node", ["--input-type=module", "-e", script], { encoding: "utf8" });
  expect(result.stderr).toBe(""); expect(result.status).toBe(0);
  expect(read(f.resultPath)).toEqual({ phase: "failed", error: "test" });
  expect(read(join(f.home, "update-orchestrated.json")).phase).toBe("failed");
  expect(isUpdateInFlight(f.home)).toBe(false);
});

test.skipIf(process.platform === "win32")("Bun worker retains its mutex through a signalled synchronous installer", async () => {
  const f = fixture();
  const childModule = pathToFileURL(repoPath("src/update/orchestrated-child.mjs")).href;
  const sessionModule = pathToFileURL(repoPath("src/update/orchestrated-session.mjs")).href;
  const ready = join(f.home, "ready"), release = join(f.home, "release");
  const installer = `const fs=require('fs'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const end=Date.now()+10000; const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}) || Date.now()>end){clearInterval(t)}},10);`;
  const script = `import { protectOrchestratedWorkerSignals } from ${JSON.stringify(childModule)};
    import { createOrchestratedChildSession } from ${JSON.stringify(sessionModule)};
    import { spawnSync } from 'node:child_process';
    const s=createOrchestratedChildSession({...${JSON.stringify(f)},verifyIdentity:()=>true});
    if(!s.start().ok || !(await s.enterMutation()).ok) process.exit(2);
    protectOrchestratedWorkerSignals();
    const r=spawnSync(process.execPath,['-e',${JSON.stringify(installer)}]);
    s.finish({phase:'installed',activeRoot:${JSON.stringify(f.home)}}); if(r.status!==0) process.exitCode=3;`;
  const worker = Bun.spawn([process.execPath, "-e", script], { stdout: "ignore", stderr: "pipe" });
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready) && Date.now() < deadline && worker.exitCode === null) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    worker.kill("SIGTERM");
    await Bun.sleep(150);
    expect(worker.exitCode).toBeNull();
    expect(tryAcquireUpdateSyncMutex(f.home, "sync")).toMatchObject({ kind: "busy", holder: "update" });
    writeFileSync(release, "release");
    expect(await worker.exited).toBe(0);
    expect(read(f.resultPath)).toEqual({ phase: "installed", activeRoot: f.home });
    expect(isUpdateInFlight(f.home)).toBe(false);
  } finally { writeFileSync(release, "release"); if (worker.exitCode === null) { worker.kill("SIGKILL"); await worker.exited; } }
}, 20000);
