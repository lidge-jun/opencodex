import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  handoffLogPath,
  resolveHelperCommand,
  runDesktopRestartHandoff,
  startDesktopRestartHandoff,
  type HandoffIo,
} from "../../src/codex/desktop-app/handoff";
import { acquireDesktopRestartLock } from "../../src/codex/desktop-app/lock";

/**
 * The handoff exists because the self-ancestry refusal fires in the NORMAL case on a
 * developer machine: anything run from a Codex terminal is inside the app tree it is
 * being asked to restart.
 */

function home(): string {
  return mkdtempSync(join(tmpdir(), "ocx-handoff-"));
}

describe("resolving how to re-invoke this CLI as the helper", () => {
  test("an existing argv[1] is used, which covers both the checkout and the npm shim", () => {
    const resolved = resolveHelperCommand({ execPath: "/usr/bin/bun", argv: ["/usr/bin/bun", __filename] });
    expect(resolved).toEqual({ command: "/usr/bin/bun", args: [__filename] });
  });

  test("a packaged ocx binary needs no entry script", () => {
    expect(resolveHelperCommand({ execPath: "/usr/local/bin/ocx", argv: ["/usr/local/bin/ocx"] }))
      .toEqual({ command: "/usr/local/bin/ocx", args: [] });
  });

  test("an unresolvable invocation REFUSES rather than guessing", () => {
    // Spawning the wrong interpreter with a path that does not exist produces a helper
    // that exits immediately and an operator who was told the restart was handed off.
    expect(resolveHelperCommand({ execPath: "/usr/bin/node", argv: ["/usr/bin/node", "/nope/missing.js"] }))
      .toBeNull();
  });
});

describe("starting a handoff", () => {
  function startIo(dir: string, spawned: { command?: string; args?: string[] }, pid: number | undefined): HandoffIo {
    return {
      homeDir: dir,
      pid: 4242,
      now: () => 1_000,
      execPath: "/usr/local/bin/ocx",
      argv: ["/usr/local/bin/ocx"],
      lock: { lockPath: join(dir, "lock"), pid: 4242, isAlive: () => true, now: () => 1_000 },
      spawnHelper: (command, args) => {
        spawned.command = command;
        spawned.args = [...args];
        return { pid, unref: () => {} };
      },
    };
  }

  test("spawns the hidden command with a plan and hands the lock to the helper", () => {
    const dir = home();
    const spawned: { command?: string; args?: string[] } = {};
    const io = startIo(dir, spawned, 9001);
    acquireDesktopRestartLock(io.lock);
    const outcome = startDesktopRestartHandoff(io);
    expect(outcome).toEqual({ kind: "started", helperPid: 9001, logPath: handoffLogPath({ homeDir: dir }) });
    expect(spawned.command).toBe("/usr/local/bin/ocx");
    expect(spawned.args?.slice(0, 3)).toEqual(["internal", "desktop-restart-handoff", "--plan"]);
    // The helper must inherit ownership, not compete for it: a helper waiting on a lock
    // its own parent holds is the deadlock this design exists to avoid.
    const owner = JSON.parse(readFileSync(join(dir, "lock"), "utf-8")).ownerPid;
    expect(owner).toBe(9001);
  });

  test("a lock transfer that did not take is reported as a failure, not a handoff", () => {
    // Otherwise the caller skips its release, the lock keeps naming a process that is
    // about to exit, and it reads as stale for the whole helper wait.
    const dir = home();
    const spawned: { command?: string; args?: string[] } = {};
    const io = startIo(dir, spawned, 9001);
    // Nobody owns the lock, so the owner-check inside transfer fails.
    const outcome = startDesktopRestartHandoff(io);
    expect(outcome).toEqual({ kind: "failed", reason: "lock_transfer_failed" });
  });

  test("a spawn that produced no pid is a failure, and the plan is cleaned up", () => {
    const dir = home();
    const spawned: { command?: string; args?: string[] } = {};
    const outcome = startDesktopRestartHandoff(startIo(dir, spawned, undefined));
    expect(outcome).toEqual({ kind: "failed", reason: "spawn_failed" });
    const planArg = spawned.args?.[3];
    expect(planArg).toBeDefined();
    expect(existsSync(planArg as string)).toBe(false);
  });
});

describe("running the handoff", () => {
  function runIo(dir: string, extra: Partial<Parameters<typeof runDesktopRestartHandoff>[1]> = {}) {
    return {
      homeDir: dir,
      pid: 9001,
      // An ADVANCING clock. A constant one makes the caller-wait loop depend entirely on
      // the poll bound, which is not what these cases are checking.
      now: (() => { let t = 2_000; return () => (t += 50); })(),
      lock: { lockPath: join(dir, "lock"), pid: 9001, isAlive: () => true, now: () => 2_000 },
      isAlive: () => false,
      sleep: () => {},
      ...extra,
    };
  }

  // The name matters: the helper refuses any --plan outside the opencodex home or not
  // named like a plan this CLI writes, so a generic "plan.json" is correctly rejected.
  function writePlan(dir: string, plan: unknown): string {
    const path = join(dir, "desktop-restart-handoff-4242-abc123.json");
    writeFileSync(path, JSON.stringify(plan));
    return path;
  }

  test("waits for the caller to exit, then restarts and records the outcome", async () => {
    const dir = home();
    const path = writePlan(dir, { schemaVersion: 1, callerPid: 4242, createdAtMs: 1_900 });
    const outcome = await runDesktopRestartHandoff(path, runIo(dir, {
      readLockOwner: () => 9001,
      restart: () => ({ relaunch: "started" as const, stopped: [15901], surviving: [] }),
    }));
    expect(outcome).toBe("restarted");
    // Single-use: a plan that survived would let a crash restart the app later.
    expect(existsSync(path)).toBe(false);
    const logged = JSON.parse(readFileSync(handoffLogPath({ homeDir: dir }), "utf-8").trim());
    expect(logged.outcome).toBe("restarted");
    // Counts, never command lines or OS error text.
    expect(logged.stopped).toBe(1);
  });

  test("a caller that outlives the window is refused rather than guessed about", async () => {
    const dir = home();
    const path = writePlan(dir, { schemaVersion: 1, callerPid: 4242, createdAtMs: 1_900 });
    let restarted = false;
    const outcome = await runDesktopRestartHandoff(path, runIo(dir, {
      isAlive: () => true,
      restart: () => { restarted = true; return { relaunch: "skipped" as const, stopped: [], surviving: [] }; },
    }));
    expect(outcome).toBe("caller_still_running");
    expect(restarted).toBe(false);
  });

  test("a stale plan does not restart the app hours later", async () => {
    const dir = home();
    const path = writePlan(dir, { schemaVersion: 1, callerPid: 4242, createdAtMs: 0 });
    let restarted = false;
    const outcome = await runDesktopRestartHandoff(path, runIo(dir, {
      now: () => 10 * 60_000,
      restart: () => { restarted = true; return { relaunch: "started" as const, stopped: [], surviving: [] }; },
    }));
    expect(outcome).toBe("plan_expired");
    expect(restarted).toBe(false);
  });

  test("an unreadable plan is refused and NOT deleted", async () => {
    const dir = home();
    const path = join(dir, "desktop-restart-handoff-4242-abc123.json");
    writeFileSync(path, "{not json");
    expect(await runDesktopRestartHandoff(path, runIo(dir))).toBe("plan_unreadable");
    // Deleting on a failed parse would destroy a file that merely sits in the right
    // place under the right name.
    expect(existsSync(path)).toBe(true);
  });

  test("a --plan outside the opencodex home is refused without being deleted", async () => {
    // Unlinking whatever --plan points at would turn this hidden helper command into an
    // unlink oracle for any same-uid caller.
    const dir = home();
    const outside = join(home(), "config.json");
    writeFileSync(outside, JSON.stringify({ schemaVersion: 1, callerPid: 4242, createdAtMs: 1_900 }));
    expect(await runDesktopRestartHandoff(outside, runIo(dir))).toBe("plan_unreadable");
    expect(existsSync(outside)).toBe(true);
  });

  test("a plan whose name is not one this CLI writes is refused", async () => {
    const dir = home();
    const path = join(dir, "plan.json");
    writeFileSync(path, JSON.stringify({ schemaVersion: 1, callerPid: 4242, createdAtMs: 1_900 }));
    expect(await runDesktopRestartHandoff(path, runIo(dir))).toBe("plan_unreadable");
    expect(existsSync(path)).toBe(true);
  });

  test("the helper refuses to act unless the lock names it", async () => {
    // A failed transfer, or somebody reclaiming the lock, must not produce a second
    // unsynchronised ladder.
    const dir = home();
    const path = writePlan(dir, { schemaVersion: 1, callerPid: 4242, createdAtMs: 1_900 });
    let restarted = false;
    const outcome = await runDesktopRestartHandoff(path, runIo(dir, {
      readLockOwner: () => 12_345,
      restart: () => { restarted = true; return { relaunch: "started" as const, stopped: [], surviving: [] }; },
    }));
    expect(outcome).toBe("not_lock_owner");
    expect(restarted).toBe(false);
  });

  test("the helper never hands off again, so recursion is impossible", async () => {
    const dir = home();
    const path = writePlan(dir, { schemaVersion: 1, callerPid: 4242, createdAtMs: 1_900 });
    const seen: boolean[] = [];
    await runDesktopRestartHandoff(path, runIo(dir, {
      readLockOwner: () => 9001,
      restart: allowHandoff => {
        seen.push(allowHandoff);
        return { relaunch: "started" as const, stopped: [], surviving: [] };
      },
    }));
    expect(seen).toEqual([false]);
  });
});

