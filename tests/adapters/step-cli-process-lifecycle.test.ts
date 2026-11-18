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
import { registerDrainStartHook, resetOptionalShutdownHooksForTests, runOptionalShutdownHooks } from "../../src/lib/optional-shutdown-hooks";
import { OPTIONAL_SHUTDOWN_GRACE_MS } from "../../src/lib/shutdown-budget";
import { drainAndShutdown, registerTurn, resetLifecycleDrainStateForTests, tryAdmitTurn } from "../../src/server/lifecycle";

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
    try { await clearStepCliSessions(); }
    finally {
      resetOptionalShutdownHooksForTests();
      resetLifecycleDrainStateForTests();
    }
  }
  expect(cleanedAtListenerStop).toBe(true);
});

test.skipIf(process.platform === "win32").each([450, 180, 0])("an exhausted turn drain kills all StepCode groups before listener stop with %ims left", async remainingMs => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-deadline-"));
  const groups = new Map(Array.from({ length: 7 }, (_, i) => [
    -(1_900_001_000 + i), { signals: [] as NodeJS.Signals[], gone: false, confirmed: false },
  ]));
  const pids = [...groups.keys()].map(group => -group);
  const realKill = process.kill.bind(process);
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    const group = groups.get(target);
    if (!group) return realKill(target, signal);
    if (group.gone) {
      if (signal === 0) group.confirmed = true;
      throw Object.assign(new Error("fixture group is gone"), { code: "ESRCH" });
    }
    if (signal === "SIGTERM" || signal === "SIGKILL") group.signals.push(signal);
    if (signal === "SIGKILL") group.gone = true;
    return true;
  });
  const realNow = () => new Date().getTime();
  let offset = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const timeoutMs = 5_000;
  const detach = registerDrainStartHook("step-cli-exhaust-drain", () => {
    offset = timeoutMs + OPTIONAL_SHUTDOWN_GRACE_MS - remainingMs;
  });
  const pool = poolFor(cwd, {
    which: () => process.execPath,
    spawn: () => Object.assign(new EventEmitter(), {
      pid: pids.shift()!, stdin: new PassThrough(), stdout: new PassThrough(),
      stderr: new PassThrough(), exitCode: null, signalCode: null,
    }) as unknown as ChildProcess,
  }, { onEvent: () => {} });
  const lease = tryAdmitTurn();
  try {
    for (let i = 0; i < groups.size; i++) {
      const session = await pool.open({ handle: String(i), sessionId: "" });
      if (i < 5) void session.close(); // Four active, one already queued.
    }
    expect([...groups.values()].map(group => group.signals)).toEqual([
      ["SIGTERM"], ["SIGTERM"], ["SIGTERM"], ["SIGTERM"], [], [], [],
    ]);
    let atListenerStop: Array<{ signals: NodeJS.Signals[]; confirmed: boolean }> = [];
    const server = { stop() {
      atListenerStop = [...groups.values()].map(group => ({ signals: [...group.signals], confirmed: group.confirmed }));
    } } as unknown as ReturnType<typeof Bun.serve>;
    const turn = new AbortController();
    expect(lease).not.toBeNull();
    registerTurn(turn, lease!);
    const started = realNow();
    const stopped = await drainAndShutdown(server, timeoutMs);
    expect(turn.signal.aborted).toBe(true);
    expect(realNow() - started).toBeLessThan(1_000);
    expect(atListenerStop.map(group => group.signals)).toEqual(
      [...groups.values()].map((_, i) => i < 4 ? ["SIGTERM", "SIGKILL"] : ["SIGKILL"]),
    );
    expect(stopped).toBe(remainingMs > 0);
    if (remainingMs > 0) {
      expect(atListenerStop.every(group => group.confirmed)).toBe(true);
      expect(pool.size).toBe(0);
    }
  } finally {
    lease?.release();
    try {
      for (const group of groups.values()) group.gone = true;
      await clearStepCliSessions();
    } finally {
      detach();
      clock.mockRestore();
      kill.mockRestore();
      resetOptionalShutdownHooksForTests();
      resetLifecycleDrainStateForTests();
    }
  }
});

test("an expired shutdown starts every queued Windows tree kill without waiting for a cleanup slot", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-window-deadline-"));
  const receipt = Promise.withResolvers<void>();
  const killed: number[] = [];
  const children = new Map<number, EventEmitter>();
  const pids = Array.from({ length: 7 }, (_, i) => 1_900_002_000 + i);
  const pool = poolFor(cwd, {
    platform: "win32", which: () => process.execPath,
    spawn: () => {
      const pid = pids[children.size]!;
      const child = Object.assign(new EventEmitter(), {
        pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        exitCode: null, signalCode: null,
      });
      children.set(pid, child);
      return child as unknown as ChildProcess;
    },
    killWindowsProcessTree: async pid => {
      killed.push(pid);
      children.get(pid)!.emit("close", 0, null);
      await receipt.promise;
    },
  }, { onEvent: () => {} });
  try {
    for (const pid of pids) await pool.open({ handle: String(pid), sessionId: "" });
    expect(await runOptionalShutdownHooks({ deadlineMs: Date.now() - 1 })).toBe(false);
    expect(killed).toEqual(pids);
    expect(pool.size).toBe(pids.length);
  } finally {
    receipt.resolve();
    await clearStepCliSessions();
    resetOptionalShutdownHooksForTests();
  }
  expect(pool.size).toBe(0);
});

test("a deadline-aware close prevents an in-flight workspace setup from spawning a child", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-open-deadline-"));
  let spawns = 0;
  const pool = new StepSessionPool(
    { openCodexHome: cwd, idleTimeoutMs: 60_000, buildOptions: () => options(cwd) },
    { onEvent: () => {} },
    { spawn: () => {
      spawns++;
      return Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null }) as unknown as ChildProcess;
    } },
  );
  const opening = pool.open({ handle: "opening", sessionId: "" });
  await pool.closeAll(Date.now() - 1);
  expect((await opening).closed).toBe(true);
  expect(spawns).toBe(0);
});

test("emergency cleanup skips a reused PGID and still kills an owned group", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-group-reuse-"));
  const children = [1_900_003_001, 1_900_003_002].map(pid => Object.assign(new EventEmitter(), {
    pid, exitCode: null as number | null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }));
  const [stale, owned] = children;
  const groups = new Set(children.map(child => -child.pid));
  const signals: number[] = [];
  let probesFail = false;
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (!groups.has(target)) throw new Error("unexpected target outside the process table fixture");
    if (signal === 0 && probesFail) {
      throw Object.assign(new Error("fixture cannot verify group"), { code: "EPERM" });
    }
    if (signal === "SIGKILL") signals.push(target);
    return true;
  });
  let next = 0;
  const pool = new StepSessionPool(
    { openCodexHome: cwd, idleTimeoutMs: 60_000, buildOptions: () => options(cwd) },
    { onEvent: () => {} },
    { platform: "linux", spawn: () => children[next++] as unknown as ChildProcess },
  );
  try {
    const first = await pool.open({ handle: "stale", sessionId: "" });
    const second = await pool.open({ handle: "owned", sessionId: "" });
    stale!.exitCode = 0;
    stale!.emit("exit", 0, null);
    probesFail = true;
    await expect(first.close()).rejects.toMatchObject({ code: "step_cli_cleanup_failed" });
    await expect(second.close()).rejects.toMatchObject({ code: "step_cli_cleanup_failed" });
    await expect(pool.closeAll()).rejects.toMatchObject({ code: "step_cli_cleanup_failed" });
    // The old leader is reaped. The table can now resolve that number to an unrelated group.
    probesFail = false;
    let emergencyError: unknown;
    try { pool.forceShutdown(); }
    catch (error) { emergencyError = error; }
    expect(signals).toEqual([-owned!.pid]);
    expect(emergencyError).toMatchObject({ code: "step_cli_cleanup_failed" });
    expect(pool.size).toBe(2);
  } finally {
    await pool.closeAll().catch(() => {});
    kill.mockRestore();
  }
});

test("an ESRCH from a group signal prevents later probes or signals to that PGID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-group-gone-"));
  const child = Object.assign(new EventEmitter(), {
    pid: 1_900_003_003, exitCode: null as number | null, signalCode: null,
  });
  const afterEsrch: Array<number | NodeJS.Signals | undefined> = [];
  let disappeared = false;
  const kill = spyOn(process, "kill").mockImplementation((target, signal) => {
    if (target !== -child.pid) throw new Error("unexpected target outside the process table fixture");
    if (disappeared) {
      afterEsrch.push(signal);
      // The fixture models a reused PGID that cannot be probed by this process.
      if (signal === 0) throw Object.assign(new Error("fixture now belongs to another user"), { code: "EPERM" });
    }
    if (signal === "SIGTERM") {
      disappeared = true;
      throw Object.assign(new Error("fixture group is gone"), { code: "ESRCH" });
    }
    return true;
  });
  try {
    const session = await StepCliSession.open(options(cwd), { onEvent: () => {} },
      { platform: "linux", spawn: () => child as unknown as ChildProcess });
    const receipt = await Promise.allSettled([session.close()]);
    session.forceShutdown();
    expect(disappeared).toBe(true);
    expect(afterEsrch).toEqual([]);
    expect(receipt[0]?.status).toBe("fulfilled");
  } finally {
    kill.mockRestore();
  }
});

test.skipIf(process.platform === "win32")("an exited wrapper retains ownership until its POSIX group returns ESRCH", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ocx-step-group-"));
  const pid = 1_900_000_000;
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    pid, exitCode: null as number | null, signalCode: null,
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
    child.exitCode = 0;
    child.emit("exit", 0, null);
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
