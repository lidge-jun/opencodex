import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  processGroupForceDecision,
  runProcessTreeCommand,
} from "../src/update/install-process.mjs";

const cleanupPids = new Set<number>();
const cleanupDirs = new Set<string>();

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function processGroupInspector(descendantPidPath: string) {
  return (groupId: number) => {
    const hasRunningLeader = isRunning(groupId);
    let hasRunningDescendant = false;
    try {
      const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
      hasRunningDescendant = Number.isSafeInteger(descendantPid) && isRunning(descendantPid);
    } catch {
      // The child may not have written its pid before the root exits.
    }
    return {
      hasRunningMember: hasRunningLeader || hasRunningDescendant,
      hasRunningLeader,
    };
  };
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
  test("force cleanup refuses a reused or uninspectable process group", () => {
    expect(processGroupForceDecision(null, false)).toBe("refuse");
    expect(processGroupForceDecision({ hasRunningMember: false, hasRunningLeader: false }, false)).toBe("exited");
    expect(processGroupForceDecision({ hasRunningMember: true, hasRunningLeader: false }, false)).toBe("signal");
    expect(processGroupForceDecision({ hasRunningMember: true, hasRunningLeader: true }, false)).toBe("refuse");
    expect(processGroupForceDecision({ hasRunningMember: true, hasRunningLeader: true }, true)).toBe("signal");
  });

  test("spawn failures report their cause without inventing a live process tree", async () => {
    const result = await runProcessTreeCommand(join(tmpdir(), "ocx-command-that-does-not-exist"), [], {
      stdio: "ignore",
      timeoutMs: 1_000,
    });

    expect(result.status).toBeNull();
    expect(result.error).toBeInstanceOf(Error);
    expect(result.treeExited).toBe(true);
  });

  test("drains and bounds piped installer output", async () => {
    const result = await runProcessTreeCommand(
      process.execPath,
      ["-e", "console.log('installer stdout'); console.error('installer stderr')"],
      { stdio: "pipe", timeoutMs: 1_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("installer stdout");
    expect(result.stderr).toContain("installer stderr");
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
      inspectProcessGroup: processGroupInspector(descendantPidPath),
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
      inspectProcessGroup: processGroupInspector(descendantPidPath),
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
