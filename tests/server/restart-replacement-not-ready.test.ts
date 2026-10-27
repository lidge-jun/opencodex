/**
 * OCX-6: a parent that keeps serving when its replacement fails (the client runtime) asks
 * `spawnReplacementStart` to stop a replacement that never answered, and is told only once the
 * replacement's exit was observed, so nothing left behind can still take the port.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { spawnReplacementStart, type ReplacementSpawn } from "../../src/server/restart-replacement";

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

function scripted(script: string): { spawnChild: ReplacementSpawn; spawned: ChildProcess[] } {
  const spawned: ChildProcess[] = [];
  return {
    spawned,
    spawnChild: (_command, _args, options) => {
      const child = spawn(process.execPath, ["-e", script], { ...options, stdio: "ignore" });
      children.push(child);
      spawned.push(child);
      return child;
    },
  };
}

const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;

describe("spawnReplacementStart notReady", () => {
  test("terminate stops a replacement that never answers and rejects with not_ready", async () => {
    const { spawnChild, spawned } = scripted("setInterval(() => {}, 1000)");
    const error = await spawnReplacementStart(
      { port: 10_123, waitForHealth: true, env: { PATH: process.env.PATH }, notReady: "terminate" },
      { spawnChild, findLive: async () => null, deadlineAt: Date.now() + 300, logPath: null, termWaitMs: 2_000, killWaitMs: 2_000 },
    ).catch((caught: unknown) => caught);
    expect((error as NodeJS.ErrnoException).code).toBe("not_ready");
    expect(spawned).toHaveLength(1);
    expect(exited(spawned[0]!)).toBe(true);
  });

  test("a replacement that ignores SIGTERM is killed, and only its observed exit counts", async () => {
    const { spawnChild, spawned } = scripted("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)");
    const error = await spawnReplacementStart(
      { port: 10_124, waitForHealth: true, env: { PATH: process.env.PATH }, notReady: "terminate" },
      { spawnChild, findLive: async () => null, deadlineAt: Date.now() + 300, logPath: null, termWaitMs: 300, killWaitMs: 2_000 },
    ).catch((caught: unknown) => caught);
    expect((error as NodeJS.ErrnoException).code).toBe("not_ready");
    expect(exited(spawned[0]!)).toBe(true);
    // POSIX delivers SIGTERM, the child ignores it, and the SIGKILL escalation stops it. On
    // Windows, Node's kill("SIGTERM") is TerminateProcess, so a handler cannot ignore it and the
    // first signal is already the observed exit; there is nothing left to escalate.
    expect(spawned[0]!.signalCode).toBe(process.platform === "win32" ? "SIGTERM" : "SIGKILL");
  });

  test("the default still hands off to a slow replacement and leaves it running", async () => {
    const { spawnChild, spawned } = scripted("setInterval(() => {}, 1000)");
    await spawnReplacementStart(
      { port: 10_125, waitForHealth: true, env: { PATH: process.env.PATH } },
      { spawnChild, findLive: async () => null, deadlineAt: Date.now() + 300, logPath: null },
    );
    expect(exited(spawned[0]!)).toBe(false);
  });
});
