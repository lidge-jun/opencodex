import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";

describe("WinSW lifecycle stop hardening", () => {
  test("re-verifies native service state after stopwait before returning", () => {
    const source = readFileSync(repoPath("src/lib/winsw.ts"), "utf8");
    const start = source.indexOf("export function stopWinswService");
    const end = source.indexOf("export function uninstallWinswService", start);
    const stop = source.slice(start, end);

    expect(stop).toContain('runWinsw(["stopwait"])');
    expect(stop).toContain("const status = statusWinswRaw();");
    expect(stop).toContain('status === "stopped" || status === "nonexistent"');
    expect(stop).toContain('status === "unknown"');
    expect(stop).toContain("Native service stop could not be verified.");
    expect(stop).toContain("Native service is still running after stop.");
  });

  test("every non-interactive SCM/WinSW execFileSync is bounded", () => {
    // A wedged Service Control Manager or Task Scheduler service used to hang
    // the CLI forever inside a guarded stop. Every execFileSync in winsw.ts must
    // pass an explicit timeout except the interactive `install /p` call, which
    // waits on the user's password input by design.
    const source = readFileSync(repoPath("src/lib/winsw.ts"), "utf8");
    const execs = source.match(/execFileSync\(/g) ?? [];
    const timeouts = source.match(/\btimeout:/g) ?? [];
    const interactive = source.match(/stdio: "inherit"/g) ?? [];
    expect(execs.length).toBe(6);
    expect(interactive.length).toBe(1);
    // Every execFileSync is bounded except the one inherited-stdio call.
    expect(timeouts.length).toBe(execs.length - interactive.length);
    // stopwait must outlast the SCM <stoptimeout> (20s) instead of the command bound.
    expect(source).toContain('args[0] === "stopwait"');
    expect(source).toContain("SERVICE_STOPWAIT_TIMEOUT_MS");
  });
});
