import { expect, test } from "bun:test";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { StepSessionPool } from "../../src/adapters/step-cli/session-pool";
import type { StepSessionDeps, StepSessionOptions } from "../../src/adapters/step-cli/session";
import { fixturePath } from "../helpers/repo-root";
import { INTERNAL_DEADLINE_MS, SPAWN_BUDGET_MS } from "../helpers/test-budget";

function options(cwd: string): StepSessionOptions {
  return { binary: process.execPath, args: [], env: { PATH: process.env.PATH ?? "",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, cwd,
    handshakeTimeoutMs: 500, requestTimeoutMs: 500, reverseRequestHoldMs: 500,
    idleTimeoutMs: 60_000, killGraceMs: 30 };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

function reap(pid: number): void {
  if (!alive(pid)) return;
  if (process.platform === "win32") {
    execFileSync(`${process.env.SystemRoot}\\System32\\taskkill.exe`, ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: 5_000, stdio: "pipe" });
  } else process.kill(pid, "SIGKILL");
}

async function nativePool(recover: boolean) {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-cleanup-owned-"));
  const worker = join(cwd, "worker.ts"), parent = join(cwd, "parent.ts");
  const pidFile = join(cwd, "pids.json"), dispatcher = join(cwd, "step.cmd");
  await writeFile(worker, "setInterval(() => {}, 1000);\n");
  await writeFile(parent, 'import {spawn} from "node:child_process"; import {writeFileSync,renameSync} from "node:fs"; const p=spawn(process.execPath,[process.argv[2]],{stdio:"ignore",windowsHide:true}); writeFileSync(process.argv[3]+".tmp",JSON.stringify({parent:process.pid,worker:p.pid})); renameSync(process.argv[3]+".tmp",process.argv[3]); setInterval(()=>{},1000);\n');
  await writeFile(dispatcher, `@echo off\r\n"${process.execPath}" "${parent}" "${worker}" "${pidFile}"\r\n`);
  const roots: number[] = [];
  const children: ChildProcess[] = [];
  let pids: { parent: number; worker: number } | undefined;
  let attempts = 0;
  const pool = new StepSessionPool({ openCodexHome: cwd, idleTimeoutMs: 60_000,
    buildOptions: () => ({ ...options(cwd), binary: process.platform === "win32" ? dispatcher : process.execPath,
      args: process.platform === "win32" ? [] : [parent, worker, pidFile] }) }, { onEvent: () => {} }, {
    platform: "win32",
    spawn: (file, args, opts) => {
      const child = spawn(file, args, opts); children.push(child); roots.push(child.pid!); return child;
    },
    killWindowsProcessTree: pid => {
      attempts++;
      if (!recover || attempts === 1) throw Object.assign(new Error("injected tree termination ETIMEDOUT"), { code: "ETIMEDOUT" });
      if (process.platform !== "win32" && pids) { reap(pids.worker); reap(pids.parent); }
      reap(pid);
    },
  });
  const ref = { handle: "same-owned-caller", sessionId: "" };
  const session = await pool.open(ref);
  const dispose = async () => {
    for (const pid of [...roots, ...(pids ? [pids.parent, pids.worker] : [])]) reap(pid);
    // A failed cleanup intentionally retains its child. The fixture's independent OS reap must
    // also release Bun's retained stdio handles before the sandbox teardown removes its files.
    for (const child of children) {
      child.stdin?.destroy(); child.stdout?.destroy(); child.stderr?.destroy(); child.unref();
    }
    await new Promise<void>(resolve => setImmediate(resolve));
    await pool.closeAll().catch(() => {});
    for (const pid of [...roots, ...(pids ? [pids.parent, pids.worker] : [])]) expect(alive(pid)).toBe(false);
  };
  try {
    const deadline = Date.now() + 10_000;
    while (!pids && Date.now() < deadline) {
      try { pids = JSON.parse(await readFile(pidFile, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!pids) await Bun.sleep(10);
    }
    if (!pids) throw new Error("native fixture did not publish its descendant PIDs");
    expect(alive(pids.parent)).toBe(true);
    expect(alive(pids.worker)).toBe(true);
    return { pool, session, ref, roots, pids, attempts: () => attempts, dispose };
  } catch (error) { await dispose(); throw error; }
}

test("failed native tree cleanup quarantines the handle after bounded retries", async () => {
  const fixture = await nativePool(false);
  try {
    const closing = fixture.session.close();
    await expect(closing).rejects.toThrow(/quarantined/i);
    expect(fixture.attempts()).toBe(2);
    expect(fixture.pool.size).toBe(1);
    expect(alive(fixture.roots[0]!)).toBe(true);
    expect(alive(fixture.pids.worker)).toBe(true);
    await expect(fixture.pool.open(fixture.ref)).rejects.toThrow(/cleanup|quarantined/i);
    expect(fixture.roots).toHaveLength(1);
    expect(fixture.session.close()).toBe(closing);
    await expect(fixture.pool.closeAll()).rejects.toThrow(/quarantined/i);
    expect(fixture.attempts()).toBe(2);
  } finally { await fixture.dispose(); }
}, 30_000);

test("a transient native tree timeout recovers before releasing the handle", async () => {
  const fixture = await nativePool(true);
  try {
    await fixture.session.close();
    expect(fixture.attempts()).toBe(2);
    expect(fixture.pool.size).toBe(0);
    for (const pid of [fixture.roots[0]!, fixture.pids.parent, fixture.pids.worker]) expect(alive(pid)).toBe(false);
  } finally { await fixture.dispose(); }
}, 30_000);

async function controlledPool(idle = false) {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-cleanup-drain-"));
  let signal!: () => void, idleCallback: (() => void) | undefined, now = 0;
  const killing = new Promise<void>(resolve => { signal = resolve; });
  const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(),
    stderr: new PassThrough(), exitCode: null, signalCode: null, kill: () => { signal(); return true; } });
  const deps: StepSessionDeps = { spawn: () => child as unknown as ChildProcess };
  if (idle) Object.assign(deps, { now: () => now,
    setTimeout: ((callback: () => void) => { idleCallback = callback; return 1; }) as unknown as typeof setTimeout,
    clearTimeout: (() => {}) as unknown as typeof clearTimeout });
  const pool = new StepSessionPool({ openCodexHome: cwd, idleTimeoutMs: 60_000,
    buildOptions: () => options(cwd) }, { onEvent: () => {} }, deps);
  const ref = { handle: "previous-close", sessionId: "" };
  const session = await pool.open(ref);
  return { pool, ref, session, child, killing, expire: () => { now = 60_001; idleCallback!(); } };
}

for (const idle of [false, true]) {
  test(`shutdown drains cleanup already started by ${idle ? "the idle timer" : "the adapter"}`, async () => {
    const fixture = await controlledPool(idle);
    if (idle) fixture.expire();
    const cleanup = fixture.session.close();
    await fixture.killing;
    let settled = false;
    const drain = fixture.pool.closeAll().then(() => { settled = true; });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(fixture.pool.size).toBe(1);
      await expect(fixture.pool.open(fixture.ref)).rejects.toThrow(/closing/);
    } finally { fixture.child.emit("close", 0, "SIGTERM"); await Promise.all([cleanup, drain]); }
    expect(settled).toBe(true);
    expect(fixture.pool.size).toBe(0);
  });
}

test("shutdown propagates a cleanup failure that started before the drain", async () => {
  const fixture = await controlledPool();
  fixture.child.kill = () => { throw new Error("injected cleanup failure"); };
  const cleanup = fixture.session.close();
  await expect(cleanup).rejects.toThrow();
  try {
    await expect(fixture.pool.closeAll()).rejects.toThrow(/cleanup|quarantined/i);
    expect(fixture.pool.size).toBe(1);
  } finally { fixture.child.emit("close", 0, "SIGTERM"); }
});

test("a closing handle refuses replacement until cleanup is confirmed", async () => {
  const fixture = await controlledPool();
  const cleanup = fixture.session.close();
  await fixture.killing;
  let released = false;
  fixture.session.onExit(() => { released = true; });
  try {
    expect(fixture.pool.size).toBe(1);
    expect(released).toBe(false);
    await expect(fixture.pool.open(fixture.ref)).rejects.toThrow(/cleanup|closing/i);
  } finally { fixture.child.emit("close", 0, "SIGTERM"); await cleanup; await fixture.pool.closeAll(); }
  expect(released).toBe(true);
});

test("clearing the registry preserves quarantined pool ownership", async () => {
  // The process isolates a deliberately retained registry; its deadline must precede the test's.
  const { stdout } = await promisify(execFile)(process.execPath, [fixturePath("step-cli-cleanup-registry.ts")],
    { env: process.env, encoding: "utf8", windowsHide: true, timeout: INTERNAL_DEADLINE_MS });
  expect(JSON.parse(stdout)).toEqual({ clearRejected: true, samePool: true, replacementRejected: true });
}, SPAWN_BUDGET_MS);
