import { expect, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StepCliSession, type StepSessionOptions } from "../../src/adapters/step-cli/session";
import { StepSessionPool } from "../../src/adapters/step-cli/session-pool";
import { clearStepCliSessions, poolFor } from "../../src/adapters/step-cli/registry";
import { resetOptionalShutdownHooksForTests } from "../../src/lib/optional-shutdown-hooks";
import { drainAndShutdown, resetLifecycleDrainStateForTests } from "../../src/server/lifecycle";

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

test("production drain waits for the StepCode cleanup receipt before listener stop", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-drain-"));
  const killing = Promise.withResolvers<void>();
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null as number | null, signalCode: null, kill: () => { killing.resolve(); return true; },
  });
  const pool = poolFor(cwd, { which: () => process.execPath, spawn: () => child as unknown as ChildProcess },
    { onEvent: () => {} });
  await pool.open({ handle: "shutdown", sessionId: "" });
  let cleanedAtListenerStop = false;
  const server = {
    stop() { cleanedAtListenerStop = pool.size === 0; },
  } as unknown as ReturnType<typeof Bun.serve>;
  // The child is independent of the active-turn budget, which can already be exhausted.
  const draining = drainAndShutdown(server, 0);
  try {
    await killing.promise;
    const state = await Promise.race([draining.then(() => "returned"), Bun.sleep(100).then(() => "waiting")]);
    expect(state).toBe("waiting");
  } finally {
    child.exitCode = 0;
    child.emit("close", 0, null);
    await draining;
    await clearStepCliSessions();
    resetOptionalShutdownHooksForTests();
    resetLifecycleDrainStateForTests();
  }
  expect(cleanedAtListenerStop).toBe(true);
});

test.skipIf(process.platform === "win32")("an exited wrapper retains ownership until its POSIX group returns ESRCH", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-group-"));
  const pid = 1_900_000_000;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid, exitCode: 0, signalCode: null,
  });
  const signals: Array<number | NodeJS.Signals | undefined> = [];
  let verifiedGone = false;
  const realKill = process.kill.bind(process);
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== -pid) return realKill(target, signal);
    if (signal === 0 && signals.includes("SIGKILL")) {
      verifiedGone = true;
      throw Object.assign(new Error("fixture group is gone"), { code: "ESRCH" });
    }
    signals.push(signal);
    return true;
  });
  try {
    const session = await StepCliSession.open(options(cwd), { onEvent: () => {} },
      { spawn: () => child as unknown as ChildProcess });
    let verifiedAtRelease = false;
    session.onExit(() => { verifiedAtRelease = verifiedGone; });
    await session.close();
    expect(signals).toContain("SIGTERM");
    expect(signals).toContain("SIGKILL");
    expect(verifiedAtRelease).toBe(true);
  } finally {
    kill.mockRestore();
  }
});

test("closing a native session terminates its grandchild through a Windows cmd dispatcher", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-tree-"));
  const pidFile = join(cwd, "worker.pid");
  const worker = join(cwd, "worker.ts"), parent = join(cwd, "parent.ts");
  await writeFile(worker, "setInterval(() => {}, 1000);\n");
  await writeFile(parent, [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync, renameSync } from "node:fs";',
    'const worker = spawn(process.execPath, [process.argv[2]], { stdio: "ignore", windowsHide: true });',
    'const keepAlive = setInterval(() => {}, 1000);',
    // Reap the child before exiting, including on hosts without an orphan reaper.
    'if (process.platform !== "win32") {',
    '  process.on("SIGTERM", () => {});',
    '  worker.once("exit", () => clearInterval(keepAlive));',
    '}',
    'const pidFile = process.argv[3];',
    'writeFileSync(pidFile + ".tmp", JSON.stringify({ parent: process.pid, worker: worker.pid }));',
    'renameSync(pidFile + ".tmp", pidFile);',
  ].join("\n"));
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
    if (process.platform !== "win32") expect(alive(-rootPid)).toBe(false);
    expect(alive(rootPid)).toBe(false);
    expect(alive(parentPid)).toBe(false);
    expect(alive(workerPid)).toBe(false);
    expect(session.close()).toBe(closing);
  } finally {
    try { await session.close(); }
    finally { for (const pid of [workerPid, parentPid]) if (pid && alive(pid)) process.kill(pid, "SIGKILL"); }
  }
}, 30_000);
