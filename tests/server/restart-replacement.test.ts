/**
 * The parent side of a restart handoff (`src/server/restart-replacement.ts`).
 *
 * The replacement `ocx start` used to be spawned once with its output discarded: a replacement that
 * exited early (its port still draining, its parent still answering) ended the handoff with no
 * proxy and no trace of why. These tests drive real child processes through the injectable spawn
 * so the retry, the restart-parent marker and the log are observed: the parent's own lines carry
 * no environment value, and the file stays bounded on both the parent and the replacement side.
 * The scripted children print fixed lines, so what a real `ocx start` prints is not covered here.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants, lstatSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  armRestartHandoffLogCap,
  emptyRestartHandoffLogIfFull,
  openRestartHandoffLog,
  REPLACEMENT_EARLY_EXIT_RETRIES,
  RESTART_HANDOFF_LOG_ENV,
  RESTART_HANDOFF_LOG_MAX_BYTES,
  spawnReplacementStart,
  type ReplacementSpawn,
} from "../../src/server/restart-replacement";
import { RESTART_PARENT_PID_ENV } from "../../src/lib/system-restart-contract";

const SECRET = `ocx_data_${"s".repeat(40)}`;
const dirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ocx-restart-replacement-"));
  dirs.push(dir);
  return dir;
}

/** Spawns `scripts[n]` for the n-th attempt with the options the handoff chose. */
function scriptedSpawn(scripts: string[], seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }>): ReplacementSpawn {
  return (_command, args, options) => {
    const script = scripts[Math.min(seen.length, scripts.length - 1)]!;
    seen.push({ args, env: { ...(options.env ?? {}) } });
    const child = spawn(process.execPath, ["-e", script], options);
    children.push(child);
    return child;
  };
}

describe("spawnReplacementStart", () => {
  test("retries a replacement that exits before it answers, and the parent's lines carry no env value", async () => {
    const dir = tempDir();
    const logPath = join(dir, "restart-handoff.log");
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const pids: number[] = [];
    const spawnChild = scriptedSpawn([
      "console.error('Proxy already running (PID 1, port 10123).'); process.exit(1)",
      "console.log('replacement listening'); setInterval(() => {}, 1000)",
    ], seen);

    await spawnReplacementStart({
      port: 10123,
      waitForHealth: true,
      env: { PATH: process.env.PATH, OPENCODEX_API_AUTH_TOKEN: SECRET },
    }, {
      spawnChild: (command, args, options) => {
        const child = spawnChild(command, args, options);
        if (child.pid !== undefined) pids.push(child.pid);
        return child;
      },
      logPath,
      parentPid: 777,
      retryDelayMs: 0,
      findLive: async () => (seen.length === 2 && pids[1] !== undefined ? { pid: pids[1], port: 10123, source: "runtime" } : null),
    });

    expect(seen.length).toBe(2);
    for (const call of seen) {
      expect(call.args.slice(-3)).toEqual(["start", "--port", "10123"]);
      expect(call.env[RESTART_PARENT_PID_ENV]).toBe("777");
      // It writes into the log, so it is told to keep the file bounded once this parent is gone.
      expect(call.env[RESTART_HANDOFF_LOG_ENV]).toBe("1");
    }
    const log = readFileSync(logPath, "utf8");
    expect(log).toContain("attempt 1/3");
    expect(log).toContain("attempt 2/3");
    expect(log).toContain(`replacement pid ${pids[0]} exited before it answered (code 1`);
    expect(log).toContain("Proxy already running (PID 1, port 10123).");
    expect(log).toContain(`replacement pid ${pids[1]} is serving port 10123`);
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain(process.env.PATH ?? "unset-path");
    if (process.platform !== "win32") expect(statSync(logPath).mode & 0o777).toBe(0o600);
  });

  test("gives up with child_exit after the bounded retries", async () => {
    const dir = tempDir();
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const attempt = spawnReplacementStart({ port: 10123, waitForHealth: true, env: {} }, {
      spawnChild: scriptedSpawn(["process.exit(1)"], seen),
      logPath: join(dir, "restart-handoff.log"),
      retryDelayMs: 0,
      findLive: async () => null,
    });

    await expect(attempt).rejects.toMatchObject({ code: "child_exit" });
    expect(seen.length).toBe(1 + REPLACEMENT_EARLY_EXIT_RETRIES);
  });

  test("a parent-exit handoff resolves on spawn and never retries", async () => {
    const dir = tempDir();
    const logPath = join(dir, "restart-handoff.log");
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    await spawnReplacementStart({ port: 10123, waitForHealth: false, env: {} }, {
      spawnChild: scriptedSpawn(["setTimeout(() => process.exit(1), 200)"], seen),
      logPath,
      findLive: async () => { throw new Error("a parent-exit handoff must not wait for health"); },
    });
    expect(seen.length).toBe(1);
    expect(readFileSync(logPath, "utf8")).toContain("attempt 1/1");
  });

  test("a replacement whose output is discarded is never told to bound the log, even by an inherited flag", async () => {
    const seen: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    await spawnReplacementStart({ port: 10123, waitForHealth: false, env: { [RESTART_HANDOFF_LOG_ENV]: "1" } }, {
      spawnChild: scriptedSpawn(["process.exit(0)"], seen),
      logPath: null,
    });
    expect(seen.length).toBe(1);
    expect(seen[0]!.env[RESTART_HANDOFF_LOG_ENV]).toBeUndefined();
  });
});

describe("restart handoff log", () => {
  test("is emptied once it reaches the cap", () => {
    const dir = tempDir();
    const path = join(dir, "restart-handoff.log");
    writeFileSync(path, "x".repeat(RESTART_HANDOFF_LOG_MAX_BYTES + 10));
    const log = openRestartHandoffLog(path);
    expect(log).not.toBeNull();
    log!.note("next handoff");
    log!.close();
    const text = readFileSync(path, "utf8");
    expect(text.length).toBeLessThan(200);
    expect(text).toContain("log emptied at the 256 KiB cap");
    expect(text).toContain("next handoff");
  });

  test("keeps appending below the cap", () => {
    const dir = tempDir();
    const path = join(dir, "restart-handoff.log");
    writeFileSync(path, "earlier handoff\n");
    const log = openRestartHandoffLog(path);
    log!.note("later handoff");
    log!.close();
    const text = readFileSync(path, "utf8");
    expect(text.startsWith("earlier handoff\n")).toBe(true);
    expect(text).toContain("later handoff");
  });

  test.skipIf(process.platform === "win32")("never writes through a planted symlink", () => {
    const dir = tempDir();
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "untouched");
    const path = join(dir, "restart-handoff.log");
    symlinkSync(target, path);
    expect(openRestartHandoffLog(path)).toBeNull();
    expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  test.skipIf(process.platform === "win32")("never empties a file through a planted symlink", () => {
    const dir = tempDir();
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "y".repeat(RESTART_HANDOFF_LOG_MAX_BYTES + 10));
    const path = join(dir, "restart-handoff.log");
    symlinkSync(target, path);
    expect(emptyRestartHandoffLogIfFull(path)).toBe(false);
    expect(statSync(target).size).toBe(RESTART_HANDOFF_LOG_MAX_BYTES + 10);
  });

  test("a running replacement keeps the log bounded after its parent is gone", async () => {
    const dir = tempDir();
    const path = join(dir, "restart-handoff.log");
    const env: Record<string, string | undefined> = { [RESTART_HANDOFF_LOG_ENV]: "1", PATH: "/bin" };
    // The descriptor the replacement inherited as stdout and stderr: append-only, like the parent's.
    const stdout = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
    const stop = armRestartHandoffLogCap(env, { path, intervalMs: 10 });
    try {
      expect(stop).not.toBeNull();
      expect(env[RESTART_HANDOFF_LOG_ENV]).toBeUndefined();
      expect(env.PATH).toBe("/bin");
      writeSync(stdout, "z".repeat(RESTART_HANDOFF_LOG_MAX_BYTES + 1));
      const deadline = Date.now() + 5_000;
      while (lstatSync(path).size >= RESTART_HANDOFF_LOG_MAX_BYTES && Date.now() < deadline) await Bun.sleep(10);
      writeSync(stdout, "after the cap\n");
    } finally {
      stop?.();
      closeSync(stdout);
    }
    const text = readFileSync(path, "utf8");
    expect(text.length).toBeLessThan(200);
    expect(text).toContain("log emptied at the 256 KiB cap");
    // The append descriptor carries on at the new end: no hole of NUL bytes before the next line.
    expect(text).toContain("after the cap");
    expect(text.includes(String.fromCharCode(0))).toBe(false);
  });

  test("an ordinary start arms no log timer", () => {
    const plain: Record<string, string | undefined> = {};
    expect(armRestartHandoffLogCap(plain, { path: "/nonexistent/restart-handoff.log" })).toBeNull();
    const junk: Record<string, string | undefined> = { [RESTART_HANDOFF_LOG_ENV]: "yes" };
    expect(armRestartHandoffLogCap(junk, { path: "/nonexistent/restart-handoff.log" })).toBeNull();
    expect(junk[RESTART_HANDOFF_LOG_ENV]).toBeUndefined();
  });

  test("leaves a log below the cap alone", () => {
    const dir = tempDir();
    const path = join(dir, "restart-handoff.log");
    writeFileSync(path, "short\n");
    expect(emptyRestartHandoffLogIfFull(path)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("short\n");
  });
});
