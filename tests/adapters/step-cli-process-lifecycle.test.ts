import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepCliSession, type StepSessionOptions } from "../../src/adapters/step-cli/session";
import { StepSessionPool } from "../../src/adapters/step-cli/session-pool";

function options(cwd: string): StepSessionOptions {
  return { binary: process.execPath, args: [], env: {}, cwd, handshakeTimeoutMs: 500,
    requestTimeoutMs: 500, reverseRequestHoldMs: 500, idleTimeoutMs: 60_000, killGraceMs: 30 };
}

test("closing a pool also closes an in-flight open before shutdown settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-pool-"));
  let killed!: () => void;
  const killing = new Promise<void>(resolve => { killed = resolve; });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: () => { killed(); return true; },
  });
  const pool = new StepSessionPool(
    { openCodexHome: cwd, idleTimeoutMs: 60_000, buildOptions: () => options(cwd) },
    { onEvent: () => {} }, { spawn: () => child as unknown as ChildProcess },
  );
  const opening = pool.open({ handle: "opening", sessionId: "" });
  let settled = false;
  const closing = pool.closeAll().then(() => { settled = true; });
  try {
    await Promise.race([killing, closing]);
    expect(settled).toBe(false);
    expect(pool.size).toBe(0);
    await expect(pool.open({ handle: "new", sessionId: "" })).rejects.toThrow(/closing/);
    child.emit("close", 0, "SIGTERM");
    await closing;
    const late = await opening;
    expect(late.closed).toBe(true);
    expect(pool.size).toBe(0);
  } finally {
    child.emit("close", 0, "SIGTERM");
    const late = await opening;
    if (!late.closed) { const closingLate = late.close(); child.emit("close", 0, "SIGTERM"); await closingLate; }
    await pool.closeAll();
  }
});

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

test("closing a native session terminates its grandchild through a Windows cmd dispatcher", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-tree-"));
  const pidFile = join(cwd, "worker.pid");
  const worker = join(cwd, "worker.ts"), parent = join(cwd, "parent.ts");
  await writeFile(worker, "setInterval(() => {}, 1000);\n");
  await writeFile(parent, 'import {spawn} from "node:child_process"; import {writeFileSync} from "node:fs"; const p=spawn(process.execPath,[process.argv[2]],{stdio:"ignore",windowsHide:true}); writeFileSync(process.argv[3],JSON.stringify({parent:process.pid,worker:p.pid})); setInterval(()=>{},1000);\n');
  const dispatcher = join(cwd, "step.cmd");
  await writeFile(dispatcher, `@echo off\r\n"${process.execPath}" "${parent}" "${worker}" "${pidFile}"\r\n`);
  let rootPid = 0, parentPid = 0, workerPid = 0;
  const session = await StepCliSession.open({
    ...options(cwd),
    binary: process.platform === "win32" ? dispatcher : process.execPath,
    args: process.platform === "win32" ? [] : [parent, worker, pidFile],
    env: { PATH: process.env.PATH ?? "", ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) },
  }, { onEvent: () => {} }, { spawn: (file, args, opts) => {
    const child = spawn(file, args, opts); rootPid = child.pid ?? 0; return child;
  } });
  try {
    const deadline = Date.now() + 10_000;
    while (!workerPid && Date.now() < deadline) {
      try { const pids = JSON.parse(await readFile(pidFile, "utf8")); workerPid = pids.worker; parentPid = pids.parent; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (!workerPid) await Bun.sleep(10);
    }
    expect(workerPid).toBeGreaterThan(0);
    expect(alive(workerPid)).toBe(true);
    const closing = session.close();
    await closing;
    expect(alive(rootPid)).toBe(false);
    expect(alive(parentPid)).toBe(false);
    expect(alive(workerPid)).toBe(false);
    expect(session.close()).toBe(closing);
  } finally {
    try { await session.close(); }
    finally { for (const pid of [workerPid, parentPid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL"); }
  }
}, 30_000);
