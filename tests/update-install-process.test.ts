import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcessTreeCommand } from "../src/update/install-process.mjs";

const cleanupPids = new Set<number>();
const cleanupDirs = new Set<string>();

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
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
      timeoutMs: 1_000,
    });

    expect(existsSync(descendantPidPath)).toBe(true);
    const descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    const descendantAlive = isAlive(descendantPid);
    if (descendantAlive) cleanupPids.add(descendantPid);
    expect(result.timedOut).toBe(true);
    expect(result.treeExited).toBe(true);
    expect(descendantAlive).toBe(false);
  });
});
