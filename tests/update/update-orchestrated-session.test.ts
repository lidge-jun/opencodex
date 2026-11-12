import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { repoPath } from "../helpers/repo-root";
import { inspectUpdateMarker, isUpdateInFlight, tryAcquireUpdateSyncMutex } from "../../src/update/sync-update-mutex";
import { createOrchestratedChildSession, createOrchestratedResultChannel, encodeOrchestratedExpect, decodeOrchestratedExpect, issueOrchestratedResultCapability } from "../../src/update/orchestrated-session.mjs";
import { classifyOrchestratedOutcome } from "../../src/update/orchestrated-outcome.mjs";
import { runOwnedPnpm } from "../../src/update/index";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
// The result destination must be a canonical owner-only path holding a freshly issued capability file.
function fixture() {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-session-"))); roots.push(home);
  const resultPath = join(home, "result.json"), { capability: resultCapability } = issueOrchestratedResultCapability(resultPath);
  return { home, resultPath, resultCapability, expect: { home, cliRoot: join(home, "cli"), servingRoot: null, runtimePid: null, planToken: "a".repeat(43) } };
}
function read(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

test.skipIf(process.platform === "win32")("Bun pnpm supervises a mutation's remaining process group", async () => {
  for (const timed of [true, false]) {
    const f = fixture(), descendant = join(f.home, "descendant"), pnpm = join(f.home, "pnpm");
    writeFileSync(pnpm, `#!/bin/sh\n${timed ? `sleep 10 </dev/null >/dev/null 2>&1 &\necho $! > '${descendant}'` : "exit 0"}\n`, { mode: 0o700 });
    const owner = { commandPath: pnpm, packagePath: f.home, globalDir: f.home, globalRoot: f.home, globalBinDir: f.home };
    const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
    try {
      expect(session.start()).toEqual({ ok: true }); await session.enterMutation();
      const spawnShort = ((file, args, options) => spawnSync(file, args, { ...options, timeout: 2000 })) as typeof spawnSync;
      const result = runOwnedPnpm(owner, ["add", "-g", "fixture@1"], false, "pipe", spawnShort, () => true, session, join(f.home, "update-orchestrated.json"));
      session.finish({ phase: "failed" });
      const marker = read(join(f.home, "update-orchestrated.json"));
      if (timed) {
        expect({ exists: existsSync(descendant), stderr: result.stderr }).toMatchObject({ exists: true });
        expect(() => process.kill(Number(readFileSync(descendant, "utf8")), 0)).toThrow();
        expect(marker.fenceUntil).toBeGreaterThan(Date.now());
        expect(isUpdateInFlight(f.home)).toBe(true);
      } else expect(marker.fenceUntil).toBeUndefined();
    } finally {
      if (existsSync(descendant)) {
        try { process.kill(Number(readFileSync(descendant, "utf8")), "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      }
    }
  }
}, 10000);

test.each([
  // A live recorded installer refuses as in flight.
  [{ pid: 2147483647, phase: "mutating", startedAt: 1, installerPid: process.pid }, {}],
  // An unconfirmed installer with no witness refuses too, flagged so the launcher can name the marker (#8524).
  [{ pid: 2147483647, phase: "failed", startedAt: 1, terminationUnconfirmed: true }, { staleMarker: true }],
] as const)("prior installer marker refuses and remains untouched: %j", (marker, flag) => {
  const f = fixture(), path = join(f.home, "update-orchestrated.json");
  const original = JSON.stringify(marker); writeFileSync(path, original);
  const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  expect(session.start()).toEqual({ ok: false, error: "update-in-flight", ...flag });
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
  rmSync(f.resultPath);
  expect(() => createOrchestratedChildSession({ ...f, verifyIdentity: () => true })).toThrow("invalid orchestrated result destination");
  expect(isUpdateInFlight(f.home)).toBe(false);
  expect(existsSync(f.resultPath)).toBe(false);
});

test("a result destination is accepted only when it is exactly an issued capability file", () => {
  const f = fixture(), other = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-session-other-"))); roots.push(other);
  const create = (resultPath: string, resultCapability = f.resultCapability) =>
    () => createOrchestratedChildSession({ ...f, resultPath, resultCapability, verifyIdentity: () => true });
  const refused = (path: string, resultCapability?: string) => {
    const before = readFileSync(path);
    expect(create(path, resultCapability)).toThrow("invalid orchestrated result destination");
    expect(readFileSync(path).equals(before)).toBe(true);
  };
  const victim = join(other, "result.json"); writeFileSync(victim, "user data\n", { mode: 0o600 });
  refused(victim);
  const named = join(f.home, "notes.txt"); writeFileSync(named, readFileSync(f.resultPath), { mode: 0o600 });
  refused(named);
  const padded = join(mkdtempSync(join(other, "padded-")), "result.json");
  writeFileSync(padded, readFileSync(f.resultPath, "utf8") + " ", { mode: 0o600 });
  refused(padded);
  const large = join(mkdtempSync(join(other, "large-")), "result.json");
  writeFileSync(large, readFileSync(f.resultPath, "utf8").padEnd(4 * 1024 * 1024, " "), { mode: 0o600 });
  refused(large);
  refused(f.resultPath, "b".repeat(43));
  for (const resultCapability of [undefined, "", "short", "!".repeat(43)]) {
    expect(() => createOrchestratedChildSession({ ...f, resultCapability: resultCapability as string, verifyIdentity: () => true })).toThrow("invalid orchestrated result destination");
  }
  expect(create(join(f.home, "missing", "result.json"))).toThrow("invalid orchestrated result destination");
  const linked = join(mkdtempSync(join(other, "linked-")), "result.json"); linkSync(f.resultPath, linked);
  refused(linked); refused(f.resultPath);
  rmSync(linked);
  if (process.platform !== "win32") {
    const fileLink = join(mkdtempSync(join(other, "file-link-")), "result.json"); symlinkSync(f.resultPath, fileLink);
    refused(fileLink);
    const directoryLink = join(other, "directory-link"); symlinkSync(f.home, directoryLink);
    refused(join(directoryLink, "result.json"));
    chmodSync(f.resultPath, 0o644); refused(f.resultPath); chmodSync(f.resultPath, 0o600);
    chmodSync(f.home, 0o755); refused(f.resultPath); chmodSync(f.home, 0o700);
  }
  // The rule binds content, not location: a caller-authored capability file elsewhere is the only other writable target.
  const crafted = join(mkdtempSync(join(other, "crafted-")), "result.json"), issued = issueOrchestratedResultCapability(crafted);
  const session = createOrchestratedChildSession({ ...f, resultPath: crafted, resultCapability: issued.capability, verifyIdentity: () => true });
  expect(session.start()).toEqual({ ok: true });
  expect(read(crafted)).toEqual({ phase: "preflight" });
  expect(readFileSync(victim, "utf8")).toBe("user data\n");
  session.finishPreflight();
});

test.skipIf(process.platform === "win32")("writes follow the validated file, not a path swapped in afterwards", () => {
  const f = fixture(), moved = join(f.home, "moved.json");
  const session = createOrchestratedChildSession({ ...f, verifyIdentity: () => true });
  renameSync(f.resultPath, moved); writeFileSync(f.resultPath, "decoy", { mode: 0o600 });
  expect(session.start()).toEqual({ ok: true });
  expect(readFileSync(f.resultPath, "utf8")).toBe("decoy");
  expect(read(moved)).toEqual({ phase: "preflight" });
  session.finishPreflight();
});

test("the parent reads only its recorded result and removes only what it created", () => {
  const channel = createOrchestratedResultChannel(); roots.push(channel.directory);
  const outcome = (text: string) => { writeFileSync(channel.resultPath, text); return channel.read(); };
  expect(channel.read()).toBeNull();
  const record = JSON.stringify({ phase: "installed", activeRoot: channel.directory });
  for (const interrupted of ["", record.slice(0, -1), record.slice(0, 12)]) {
    expect(outcome(interrupted)).toBeNull();
    expect(classifyOrchestratedOutcome({ fromVersion: "1.0.0", toVersion: "1.0.1", installer: "npm", childExited: true, childExitCode: 0,
      outcome: channel.read(), previousVerified: true, targetVerified: true, runtimeHealthy: true, restarted: false }).exitCode).toBe(12);
  }
  expect(outcome(record)).toEqual({ phase: "installed", activeRoot: channel.directory });
  expect(outcome(JSON.stringify({ phase: "installed", activeRoot: channel.directory, pad: "x".repeat(70_000) }))).toBeNull();
  const moved = join(channel.directory, "moved.json");
  renameSync(channel.resultPath, moved); writeFileSync(channel.resultPath, record, { mode: 0o600 });
  expect(channel.read()).toBeNull();
  channel.dispose();
  expect(readFileSync(channel.resultPath, "utf8")).toBe(record);
  expect(readdirSync(channel.directory).sort()).toEqual(["moved.json", "result.json"]);
  rmSync(channel.resultPath); rmSync(moved);
  const clean = createOrchestratedResultChannel();
  clean.dispose();
  // Windows never removes by path; POSIX removes only under a non-replaceable ancestor chain.
  expect(existsSync(clean.directory)).toBe(process.platform === "win32");
  if (process.platform === "win32") rmSync(clean.directory, { recursive: true, force: true });
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

test.each(["bun", "node"] as const)("a %s child publishes through the channel a parent created under a non-default temp root", runtime => {
  const node = Bun.which("node");
  if (runtime === "node" && !node) return;
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-session-temp-"))); roots.push(base);
  const real = join(base, "real"); mkdirSync(real, { mode: 0o700 });
  const tempRoot = process.platform === "win32" ? real : join(base, "linked");
  if (tempRoot !== real) symlinkSync(real, tempRoot);
  const home = join(base, "home"); mkdirSync(home, { mode: 0o700 });
  const session = pathToFileURL(repoPath("src/update/orchestrated-session.mjs")).href;
  const args = pathToFileURL(repoPath("src/update/orchestrated-arguments.mjs")).href;
  const child = `const { createOrchestratedChildSession } = await import(${JSON.stringify(session)});
    const { parseOrchestratedChildArgs } = await import(${JSON.stringify(args)});
    const parsed = parseOrchestratedChildArgs(process.argv.slice(process.argv.indexOf("--version")), process.env); if (!parsed.ok) process.exit(64);
    const s = createOrchestratedChildSession({ home: ${JSON.stringify(home)}, resultPath: parsed.resultPath, resultCapability: parsed.resultCapability, verifyIdentity: () => true });
    if (!s.start().ok || !(await s.enterMutation()).ok) process.exit(2);
    s.finish({ phase: "installed", activeRoot: ${JSON.stringify(home)} });`;
  const childArgv = [...(runtime === "node" ? ["--input-type=module"] : []), "-e", child, "--",
    "--version", "2.1.0", "--orchestrated-expect", "fixture", "--orchestrated-result"];
  const parent = `const { createOrchestratedResultChannel } = await import(${JSON.stringify(session)});
    const { spawnSync } = await import("node:child_process");
    const channel = createOrchestratedResultChannel();
    const run = spawnSync(${JSON.stringify(runtime === "node" ? node : process.execPath)}, [...${JSON.stringify(childArgv)}, channel.resultPath],
      { env: { ...process.env, OCX_UPDATE_ORCHESTRATED_CHILD: "1", OCX_UPDATE_RESULT_CAPABILITY: channel.capability }, encoding: "utf8" });
    const outcome = channel.read(); channel.dispose();
    console.log(JSON.stringify({ status: run.status, stderr: run.stderr, outcome, directory: channel.directory }));`;
  const result = spawnSync(process.execPath, ["-e", parent], { env: { ...process.env, TMPDIR: tempRoot, TEMP: tempRoot, TMP: tempRoot }, encoding: "utf8", timeout: 30000 });
  expect(result.stderr).toBe("");
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({ status: 0, stderr: "", outcome: { phase: "installed", activeRoot: home } });
  expect(report.directory.startsWith(realpathSync.native(real))).toBe(true);
  expect(existsSync(report.directory)).toBe(process.platform === "win32");
}, 30000);

test("dispose leaves the channel in place when an ancestor could be replaced or the platform is Windows", () => {
  const previous = process.env.TMPDIR;
  const shared = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-session-shared-"))); roots.push(shared);
  try {
    if (process.platform !== "win32") {
      chmodSync(shared, 0o777);
      process.env.TMPDIR = shared;
      const exposed = createOrchestratedResultChannel();
      process.env.TMPDIR = previous;
      expect(exposed.directory.startsWith(shared)).toBe(true);
      exposed.dispose();
      expect(existsSync(exposed.resultPath)).toBe(true);
      expect(existsSync(exposed.directory)).toBe(true);
    }
    const channel = createOrchestratedResultChannel(); roots.push(channel.directory);
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try { channel.dispose(); } finally { Object.defineProperty(process, "platform", platform); }
    expect(existsSync(channel.resultPath)).toBe(true);
  } finally { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; }
});

test.each(["bun", "node"] as const)("a %s child refuses a destination reached through a directory link", runtime => {
  const node = Bun.which("node");
  if (runtime === "node" && !node) return;
  const f = fixture(), base = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-session-link-"))); roots.push(base);
  const link = join(base, "linked");
  symlinkSync(f.home, link, process.platform === "win32" ? "junction" : "dir");
  const before = readFileSync(f.resultPath);
  const session = pathToFileURL(repoPath("src/update/orchestrated-session.mjs")).href;
  const script = `const { createOrchestratedChildSession } = await import(${JSON.stringify(session)});
    try { createOrchestratedChildSession({ home: ${JSON.stringify(f.home)}, resultPath: ${JSON.stringify(join(link, "result.json"))},
      resultCapability: ${JSON.stringify(f.resultCapability)}, verifyIdentity: () => true }); console.log("accepted"); }
    catch (error) { console.log(error.message); }`;
  const argv = runtime === "node" ? [node!, "--input-type=module", "-e", script] : [process.execPath, "-e", script];
  const result = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 30000 });
  expect({ stdout: result.stdout.trim(), stderr: result.stderr }).toEqual({ stdout: "invalid orchestrated result destination", stderr: "" });
  expect(readFileSync(f.resultPath).equals(before)).toBe(true);
}, 30000);

// The compiled CLI bundles this library and gives every module the same entry URL, so the
// library itself must never act as an entry point (a top-level main once failed every packaged start).
test("POSIX supervisor library has no entry-point side effects when it shares the entry URL", () => {
  const node = Bun.which("node"); if (!node) throw new Error("node unavailable");
  const library = repoPath("src/update/posix-install-supervisor.mjs");
  const script = `process.argv[1] = ${JSON.stringify(library)}; await import(${JSON.stringify(pathToFileURL(library).href)}); console.log("loaded");`;
  const result = spawnSync(node, ["--input-type=module", "-e", script], { encoding: "utf8", input: "", timeout: 10000 });
  expect({ status: result.status, stdout: result.stdout.trim(), stderr: result.stderr }).toEqual({ status: 0, stdout: "loaded", stderr: "" });
});
