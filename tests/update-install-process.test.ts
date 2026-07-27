import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessTreeCommand } from "../src/update/install-process.mjs";

const cleanupPids = new Set<number>();
const cleanupDirs = new Set<string>();

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    if (process.platform !== "win32") {
      const state = spawnSync("/bin/ps", ["-o", "state=", "-p", String(pid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (state.status === 0 && /^[ZX]/.test(state.stdout.trim())) return false;
    }
    return true;
  } catch {
    return false;
  }
}

afterEach(() => {
  for (const pid of cleanupPids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  cleanupPids.clear();
  for (const dir of cleanupDirs) rmSync(dir, { recursive: true, force: true });
  cleanupDirs.clear();
});

describe("update installer process isolation", () => {
  test("spawn failures report their cause without inventing a live process tree", async () => {
    const result = await runProcessTreeCommand(join(tmpdir(), "ocx-command-that-does-not-exist"), [], {
      stdio: "ignore",
      timeoutMs: 1_000,
    });

    expect(result.status).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.treeExited).toBe(true);
  });

  test("timeout kills and awaits the installer descendant tree", async () => {
    const dir = join(tmpdir(), `ocx-installer-tree-${process.pid}-${Date.now()}`);
    const fixture = join(dir, "installer-parent.mjs");
    const descendantPidPath = join(dir, "descendant.pid");
    mkdirSync(dir, { recursive: true });
    cleanupDirs.add(dir);
    writeFileSync(fixture, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.argv[2], String(child.pid));',
      'setInterval(() => {}, 1000);',
      "",
    ].join("\n"));

    const result = await runProcessTreeCommand(process.execPath, [fixture, descendantPidPath], {
      forceWaitMs: 2_000,
      stdio: "ignore",
      terminationGraceMs: 500,
      timeoutMs: 3_000,
    });

    expect(existsSync(descendantPidPath)).toBe(true);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantRunning = isRunning(descendantPid);
    if (descendantRunning) cleanupPids.add(descendantPid);
    expect(result.timedOut).toBe(true);
    expect(result.treeExited).toBe(true);
    expect(descendantRunning).toBe(false);
  }, 15_000);

  test("a failed root exit cleans POSIX descendants and fails closed on Windows", async () => {
    const dir = join(tmpdir(), `ocx-installer-exit-tree-${process.pid}-${Date.now()}`);
    const fixture = join(dir, "installer-parent.mjs");
    const descendantPidPath = join(dir, "descendant.pid");
    mkdirSync(dir, { recursive: true });
    cleanupDirs.add(dir);
    writeFileSync(fixture, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
      'writeFileSync(process.argv[2], String(child.pid));',
      'setTimeout(() => process.exit(1), 50);',
      "",
    ].join("\n"));

    const result = await runProcessTreeCommand(process.execPath, [fixture, descendantPidPath], {
      forceWaitMs: 2_000,
      stdio: "ignore",
      terminationGraceMs: 500,
      timeoutMs: 5_000,
    });

    expect(result.status).toBe(1);
    expect(result.timedOut).toBe(false);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantRunning = isRunning(descendantPid);
    if (descendantRunning) cleanupPids.add(descendantPid);
    if (process.platform === "win32") {
      expect(result.treeExited).toBe(false);
    } else {
      expect(result.treeExited).toBe(true);
      expect(descendantRunning).toBe(false);
    }
  }, 15_000);
});
