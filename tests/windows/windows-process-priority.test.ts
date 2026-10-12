import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { constants as osConstants } from "node:os";

import { raiseWindowsProxyPriority, type ProcessPriorityDeps } from "../../src/service/windows-process-priority";
import { repoPath } from "../helpers/repo-root";

function deps(overrides: Partial<ProcessPriorityDeps> = {}) {
  const calls: Array<[number, number]> = [];
  const base: ProcessPriorityDeps = {
    platform: "win32",
    disabled: () => false,
    setPriority: (pid, priority) => { calls.push([pid, priority]); },
    ...overrides,
  };
  return { deps: base, calls };
}

describe("Windows proxy scheduling priority", () => {
  test("raises the current process to ABOVE_NORMAL on win32", () => {
    const { deps: d, calls } = deps();
    expect(raiseWindowsProxyPriority(d)).toBe("raised");
    expect(calls).toEqual([[0, osConstants.priority.PRIORITY_ABOVE_NORMAL]]);
  });

  test("leaves other platforms untouched", () => {
    for (const platform of ["linux", "darwin"] as const) {
      const { deps: d, calls } = deps({ platform });
      expect(raiseWindowsProxyPriority(d)).toBe("skipped");
      expect(calls).toEqual([]);
    }
  });

  test("OCX_DISABLE_PRIORITY_BOOST opts out", () => {
    const { deps: d, calls } = deps({ disabled: () => true });
    expect(raiseWindowsProxyPriority(d)).toBe("skipped");
    expect(calls).toEqual([]);
  });

  test("a refused priority change is never fatal", () => {
    const { deps: d } = deps({ setPriority: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
    expect(raiseWindowsProxyPriority(d)).toBe("failed");
  });

  test("the start path raises priority before it binds the server", () => {
    const source = readFileSync(repoPath("src", "cli", "index.ts"), "utf8");
    const raise = source.indexOf("raiseWindowsProxyPriority();");
    const bind = source.indexOf("serverModule.startServer(port,");
    expect(raise).toBeGreaterThan(-1);
    expect(bind).toBeGreaterThan(raise);
  });

  test.skipIf(process.platform !== "win32")("the real Windows process reports ABOVE_NORMAL afterwards", () => {
    const moduleUrl = Bun.pathToFileURL(repoPath("src", "service", "windows-process-priority.ts")).href;
    const source = [
      `import { getPriority } from "node:os";`,
      `const { raiseWindowsProxyPriority } = await import(${JSON.stringify(moduleUrl)});`,
      `console.log(JSON.stringify({ result: raiseWindowsProxyPriority(), priority: getPriority(0) }));`,
    ].join("\n");
    const env = { ...process.env };
    delete env.OCX_DISABLE_PRIORITY_BOOST;
    const run = Bun.spawnSync([process.execPath, "-e", source], { env, stdout: "pipe", stderr: "pipe" });
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout.toString().trim())).toEqual({
      result: "raised",
      priority: osConstants.priority.PRIORITY_ABOVE_NORMAL,
    });
  });
});
