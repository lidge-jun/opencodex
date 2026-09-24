import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repoPath } from "../helpers/repo-root";
import { writeRecoveryIntentIfGuardianEnabled } from "../../src/lib/recovery-intent";

const source = readFileSync(repoPath("src/tray/windows-tray.ps1"), "utf8");
const cli = readFileSync(repoPath("src/cli/index.ts"), "utf8");

/** The declared body of one `src/cli/index.ts` function, for ordering assertions. */
function cliFunction(name: string): string {
  const start = cli.indexOf(`async function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const end = cli.indexOf("\nasync function ", start + 1);
  return cli.slice(start, end < 0 ? cli.length : end);
}

describe("Windows tray restart process hardening", () => {
  test("fails a pending action when tracked process state cannot be inspected", () => {
    expect(source).toContain("pending process result inspection failed");
    expect(source).toMatch(/catch\s*\{[\s\S]*?pending process result inspection failed[\s\S]*?\$commandFailed\s*=\s*\$true[\s\S]*?\}/);
  });

  test("tracked command failure takes precedence over observed target state", () => {
  const failureIndex = source.indexOf("if ($commandFailed) { Complete-PendingAction $false }");
  const reachedIndex = source.indexOf("elseif ($reached) { Complete-PendingAction $true }");

  expect(failureIndex).toBeGreaterThan(-1);
  expect(reachedIndex).toBeGreaterThan(failureIndex);
});

  test("does not silently swallow pending-process disposal failures during live operation", () => {
    const matches = source.match(/pending process dispose failed/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const emptyCatch = ["catch", "{", "}"].join(" ");
  expect(source).not.toContain(`try { $script:pendingProcess.Dispose() } ${emptyCatch}`);
  });

  test("tracks Start Proxy and Stop Proxy exit codes like Restart Proxy", () => {
    expect(source).toContain('$startProcess = Start-OcxCommand @("__tray-start") -TrackExit');
    expect(source).toContain('$script:pendingProcess = $startProcess');
    expect(source).toContain('$stopProcess = Start-OcxCommand @("stop") -TrackExit');
    expect(source).toContain('$script:pendingProcess = $stopProcess');
  });

  test("clears the restart maintenance fence unconditionally", () => {
    // The guardian reader never compares `until` to now, so a fence left behind by a
    // failed restart keeps this home from ever recovering on its own.
    const restart = cliFunction("handleTrayProxyRestart");
    expect(restart).toContain('writeRecoveryIntentIfGuardianEnabled("maintenance"');
    expect(restart).toMatch(/finally\s*\{[\s\S]*?writeRecoveryIntentIfGuardianEnabled\("running"\)/);
    expect(restart).not.toMatch(/if \(restarted\)/);
    // The parameter that existed only to dodge this write is gone, and with it the
    // second `running` signature one tray Start used to produce.
    expect(cli).not.toContain("writeRunningIntent");
    expect(cliFunction("handleTrayProxyStart")).not.toContain("writeRecoveryIntentIfGuardianEnabled");
  });

  test("re-affirms the running intent on every path that brings a proxy up", () => {
    // Without this, a durable `stopped` from an earlier manual stop silently disables
    // crash recovery for the whole life of the process this command started.
    for (const name of ["handleStart", "handleEnsure"]) {
      expect(cliFunction(name)).toContain('writeRecoveryIntentIfGuardianEnabled("running")');
    }
  });

  test("stop takes the ownership lease before it writes the intent, and fails cleanly", () => {
    const stop = cliFunction("handleStop");
    expect(stop.indexOf("acquireOwnershipMutationLease(serviceStatePaths())"))
      .toBeLessThan(stop.indexOf('writeRecoveryIntentIfGuardianEnabled("stopped")'));
    // A malformed marker must reach the operator as a line, not as a stack out of the
    // CLI top level with the proxy still running.
    expect(stop).toMatch(/catch \(error\) \{[\s\S]*?Stop refused[\s\S]*?process\.exitCode = 1;[\s\S]*?ok: false/);
  });

  test("refuses a maintenance fence the guardian reader would reject", async () => {
    const home = mkdtempSync(join(tmpdir(), "ocx-restart-fence-"));
    try {
      writeFileSync(join(home, "recovery-guardian.json"), JSON.stringify({ version: 1, enabled: true }));
      const at = 1_760_000_000_000;
      await expect(writeRecoveryIntentIfGuardianEnabled("maintenance", { home, at, until: at + 180_001 }))
        .rejects.toThrow("Recovery intent maintenance deadline is invalid.");
      expect(existsSync(join(home, "recovery-intent.json"))).toBe(false);
      await expect(writeRecoveryIntentIfGuardianEnabled("maintenance", { home, at, until: at + 180_000 }))
        .resolves.toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test("does not re-sign a running intent the tray already wrote", async () => {
    // Every signature change restarts the guardian's stabilisation window, so a second
    // `running` write charges the fallback gateway a fresh recoveryStableMs for a proxy
    // that was already on its way. Proven against scripts/ocx-recovery-guardian/main.cjs.
    const home = mkdtempSync(join(tmpdir(), "ocx-restart-running-"));
    try {
      writeFileSync(join(home, "recovery-guardian.json"), JSON.stringify({ version: 1, enabled: true }));
      const intentPath = join(home, "recovery-intent.json");
      const at = 1_760_000_000_000;
      await expect(writeRecoveryIntentIfGuardianEnabled("stopped", { home, at })).resolves.toBe(true);
      await expect(writeRecoveryIntentIfGuardianEnabled("running", { home, at: at + 1000 })).resolves.toBe(true);
      expect(JSON.parse(readFileSync(intentPath, "utf8"))).toEqual({ version: 1, mode: "running", at: at + 1000 });
      await expect(writeRecoveryIntentIfGuardianEnabled("running", { home, at: at + 2000 })).resolves.toBe(true);
      expect(JSON.parse(readFileSync(intentPath, "utf8"))).toEqual({ version: 1, mode: "running", at: at + 1000 });
      // A fence still has to clear it.
      await expect(writeRecoveryIntentIfGuardianEnabled("maintenance", { home, at: at + 3000, until: at + 6000 }))
        .resolves.toBe(true);
      expect(JSON.parse(readFileSync(intentPath, "utf8")).mode).toBe("maintenance");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
