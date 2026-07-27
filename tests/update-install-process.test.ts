import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_CAPTURED_OUTPUT_CHARS,
  processGroupForceDecision,
  runProcessTreeCommand,
  terminateInstallerProcessTree,
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

  test("rechecks the original leader immediately before SIGTERM", async () => {
    if (process.platform === "win32") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    expect(child.pid).toBeDefined();
    cleanupPids.add(child.pid!);
    let leaderChecks = 0;

    const treeExited = await terminateInstallerProcessTree(child.pid, {
      inspectProcessGroup: () => ({ hasRunningMember: true, hasRunningLeader: true }),
      isOriginalLeader: () => {
        leaderChecks += 1;
        return leaderChecks === 1;
      },
    });

    expect(treeExited).toBe(false);
    expect(leaderChecks).toBe(2);
    expect(isRunning(child.pid!)).toBe(true);
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
    const stdoutPayload = "out-".repeat(MAX_CAPTURED_OUTPUT_CHARS);
    const stderrPayload = "err-".repeat(MAX_CAPTURED_OUTPUT_CHARS);
    const result = await runProcessTreeCommand(
      process.execPath,
      ["-e", `process.stdout.write(${JSON.stringify(stdoutPayload)}); process.stderr.write(${JSON.stringify(stderrPayload)})`],
      { stdio: "pipe", timeoutMs: 1_000 },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe(stdoutPayload.slice(-MAX_CAPTURED_OUTPUT_CHARS));
    expect(result.stderr).toBe(stderrPayload.slice(-MAX_CAPTURED_OUTPUT_CHARS));
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
    expect(result.treeExited).toBe(process.platform === "win32");
    expect(descendantRunning).toBe(false);
  }, 15_000);

  test("a failed root exit does not signal its remaining leaderless process group", async () => {
    if (process.platform === "win32") return;
    const dir = join(tmpdir(), `ocx-installer-leaderless-${process.pid}-${Date.now()}`);
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
    expect(result.treeExited).toBe(false);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantRunning = isRunning(descendantPid);
    if (descendantRunning) cleanupPids.add(descendantPid);
    expect(descendantRunning).toBe(true);
  }, 15_000);

  test("a failed root exit fails closed when a descendant leaves its process group", async () => {
    const dir = join(tmpdir(), `ocx-installer-exit-tree-${process.pid}-${Date.now()}`);
    const fixture = join(dir, "installer-parent.mjs");
    const descendantPidPath = join(dir, "descendant.pid");
    mkdirSync(dir, { recursive: true });
    cleanupDirs.add(dir);
    writeFileSync(fixture, [
      'import { spawn } from "node:child_process";',
      'import { writeFileSync } from "node:fs";',
      'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });',
      'child.unref();',
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
    expect(result.treeExited).toBe(false);
    expect(descendantRunning).toBe(true);
  }, 15_000);
});
