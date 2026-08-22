import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isServiceOwnershipError, ServiceOwnershipError } from "../src/service";

const CLI_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "index.ts"), "utf8");
const ENSURE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "ensure-desired-integrations.ts"), "utf8");
const DISPATCH_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "cli", "dispatch.ts"), "utf8");
const SERVICE_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "service.ts"), "utf8");
const MANAGEMENT_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "server", "management-api.ts"), "utf8");
const PROCESS_CONTROL_SOURCE = readFileSync(join(import.meta.dir, "..", "src", "lib", "process-control.ts"), "utf8");

function sliceFn(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  expect(from).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

// `src/cli/index.ts` runs its command switch on import, so the handlers cannot be called from a
// test. Wiring assertions therefore read the source — the house pattern established by
// tests/stale-state-purge.test.ts and tests/uninstall.test.ts.
describe("Grok fence lifecycle wiring", () => {
  test("handleStart syncs the Grok fence outside the Desktop-3P try", () => {
    const startFn = sliceFn(CLI_SOURCE, "async function handleStart(", "async function handleEnsure(");
    const registryAt = startFn.indexOf("buildDesktop3pRegistry(");
    const registryCatchAt = startFn.indexOf("/* best-effort — registry rebuilds on first /v1/models call */", registryAt);
    const grokSyncAt = startFn.indexOf('await import("../grok/sync")');

    expect(registryCatchAt).toBeGreaterThan(registryAt);
    // Nested inside the registry try, a catalog throw skipped the fence entirely.
    expect(grokSyncAt).toBeGreaterThan(registryCatchAt);
  });

  test("ensure passes only the observed live bind host across the mutation boundary", () => {
    const ensureFn = sliceFn(CLI_SOURCE, "async function handleEnsure(", "async function handleTrayProxyStart(");
    const liveBranch = ensureFn.slice(0, ensureFn.indexOf("const pinPort"));
    const spawnBranch = ensureFn.slice(ensureFn.indexOf("const pinPort"));

    // live.hostname is what the proxy ACTUALLY bound; config.hostname may have drifted.
    expect(liveBranch).toContain('{ kind: "live", hostname: live.hostname }');
    // Spawn passes no config-derived input; the reconciler loads the current hostname.
    expect(spawnBranch).toContain('{ kind: "spawned" }');
    expect(spawnBranch).not.toContain("current.hostname");
    expect(spawnBranch).not.toContain("config.hostname ? { hostname: config.hostname }");
  });

  test("ensure gates Grok fence writes on the durable switch like start", () => {
    const helper = sliceFn(
      ENSURE_SOURCE,
      "export async function ensureGrokFenceMatchesDesired(",
      "export function ensureClaudeDesktopMatchesDesired(",
    );
    const ensureFn = sliceFn(CLI_SOURCE, "async function handleEnsure(", "async function handleTrayProxyStart(");

    // The defect: ensure called syncGrokConfig unconditionally, so OFF lasted until
    // the next dashboard update/restart path that landed in ensure.
    expect(helper).toContain("shouldSyncGrokOnStart(config)");
    expect(helper).toContain("deps.stripGrokConfig()");
    expect(helper).toContain("deps.syncGrokConfig(");
    expect(ENSURE_SOURCE).toContain('await import("../grok/sync")');
    expect(helper.indexOf("deps.loadConfig()")).toBeLessThan(helper.indexOf("shouldSyncGrokOnStart(config)"));
    expect(ensureFn).toContain("reconcileEnsureDesiredIntegrations(");
    expect(ensureFn).not.toMatch(/await import\("\.\.\/grok\/sync"\)/);
  });

  test("ensure clears Claude Desktop residue when the durable switch is OFF", () => {
    const helper = sliceFn(
      ENSURE_SOURCE,
      "export function ensureClaudeDesktopMatchesDesired(",
      "Claude Desktop cleanup failed",
    );
    const ensureFn = sliceFn(CLI_SOURCE, "async function handleEnsure(", "async function handleTrayProxyStart(");
    expect(helper).toContain("claudeDesktopIntegrationEnabled(config)");
    expect(helper).toContain("deps.removeDesktop3pStandardPivot(");
    expect(helper.indexOf("deps.loadConfig()")).toBeLessThan(helper.indexOf("claudeDesktopIntegrationEnabled(config)"));
    expect(ENSURE_SOURCE).toContain("ensureClaudeDesktopMatchesDesired(deps)");
  });

  test("both ensure branches re-read persisted config after the in-flight await window", () => {
    const ensureFn = sliceFn(CLI_SOURCE, "async function handleEnsure(", "async function handleTrayProxyStart(");
    const liveBranch = ensureFn.slice(0, ensureFn.indexOf("const pinPort"));
    const spawnBranch = ensureFn.slice(ensureFn.indexOf("const pinPort"));
    const liveAfterAwait = liveBranch.slice(liveBranch.indexOf("injectSystemEnv"));
    const spawnAfterAwait = spawnBranch.slice(spawnBranch.indexOf("waitForProxy"));
    expect(liveAfterAwait).toContain("reconcileEnsureDesiredIntegrations(");
    expect(spawnAfterAwait).toContain("reconcileEnsureDesiredIntegrations(");
    expect(ENSURE_SOURCE.match(/const config = deps\.loadConfig\(\)/g)).toHaveLength(2);
  });

  test("handleStop gates shared teardown on ownership but still reverts system env", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    const restoreFn = sliceFn(CLI_SOURCE, "async function restoreSharedClientStateAfterStop(", "async function handleStop(");

    expect(stopFn).toContain("isServiceOwnershipError(err)");
    expect(stopFn).toContain("ownershipBlocked = true");
    expect(stopFn).toContain("if (!ownershipBlocked)");
    expect(stopFn).toContain("await restoreSharedClientStateAfterStop()");
    expect(restoreFn).toContain("restoreNativeCodexAsync()");
    expect(restoreFn).not.toContain("revertSystemEnv()");
    expect(restoreFn).toContain("stripGrokConfig()");
    expect(stopFn.indexOf("revertSystemEnv()")).toBeLessThan(stopFn.indexOf("if (!ownershipBlocked)"));
  });

  test("a refused Grok strip makes ocx stop fail instead of reporting success", () => {
    const restoreFn = sliceFn(CLI_SOURCE, "async function restoreSharedClientStateAfterStop(", "async function handleStop(");
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    expect(restoreFn).toContain("else if (!grok.ok) { restored = false;");
    expect(restoreFn).toContain("Grok config restore failed");
    expect(stopFn).toContain("if (!await restoreSharedClientStateAfterStop()) stopFailed = true");
  });

  test("a refused proxy stop reports WHY, not just that it failed", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    // stopProxy throws the ownership refusal ("run the stop from that home"). A bare
    // `catch {}` on these call sites strands the operator on a generic failure line, whose
    // natural next move is a manual kill — the teardown the 409 guard exists to prevent.
    const bareCatchAfterStopProxy = /await stopProxy\([^)]*\);[\s\S]{0,400}?\}\s*catch\s*\{/;
    expect(stopFn).not.toMatch(bareCatchAfterStopProxy);

    // Both proxy-stop call sites (tracked pid, and the orphan-recovery pid) bind the error
    // and echo its message.
    const detailEchoes = stopFn.match(/const detail = err instanceof Error \? err\.message : String\(err\);/g);
    expect(detailEchoes).toHaveLength(2);
    expect(stopFn.match(/if \(detail\) console\.error\(`   \$\{detail\}`\);/g)).toHaveLength(2);

    // A proxy ownership refusal means a foreign service still owns the running proxy, so the
    // shared teardown must be skipped at both call sites, exactly like the service-manager path.
    const ownershipRefusals = stopFn.match(/err instanceof ProxyOwnershipRefusedError[\s\S]{0,200}?ownershipBlocked = true;/g);
    expect(ownershipRefusals).toHaveLength(2);
    expect(stopFn.match(/Skipping shared teardown \(native Codex restore, Grok config\): the foreign proxy is still running\./g)).toHaveLength(2);
    expect(PROCESS_CONTROL_SOURCE).toContain("throw new ProxyOwnershipRefusedError(");
  });

  test("handleStop returns its outcome while both restart surfaces share the in-place lifecycle", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    // process.exit() inside handleStop would strand runTrayProxyRestart's start() half.
    expect(stopFn).toContain("process.exitCode = 1");
    expect(stopFn).toContain("return !stopFailed");
    expect(stopFn).not.toContain("process.exit(1)");

    const restartCase = sliceFn(DISPATCH_SOURCE, "restart: async", "health: async");
    expect(restartCase).toContain("await deps.handleProxyRestart(deps.handleRestartStartWhenStopped)");
    const trayRestart = sliceFn(CLI_SOURCE, "async function handleTrayProxyRestart(", "async function restoreSharedClientStateAfterStop(");
    const restartHelper = sliceFn(CLI_SOURCE, "async function handleProxyRestart(", "async function handleTrayProxyRestart(");
    expect(trayRestart).toContain("await handleProxyRestart(() => handleTrayProxyStart(false))");
    expect(restartHelper).toContain("requestBoundSystemRestart(previous, deadlineAt)");
  });

  test("handleStop treats an incomplete native Codex restore as a stop failure", () => {
    const restoreFn = sliceFn(CLI_SOURCE, "async function restoreSharedClientStateAfterStop(", "async function handleStop(");
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    expect(restoreFn).toContain("if (result.success) console.log");
    expect(restoreFn).toContain("restored = false");
    expect(restoreFn).toContain("console.error(`⚠️  ${result.message}`)");
    expect(stopFn).toContain("if (!await restoreSharedClientStateAfterStop()) stopFailed = true");
  });

  test("the daemon's exit cleanup keeps the OCX_SERVICE exclusion and adds the ownership check", () => {
    const startFn = sliceFn(CLI_SOURCE, "const syncCleanup = () => {", "let shuttingDown = false;");
    // Crash/respawn under a service manager must still keep the fence.
    expect(startFn).toContain('process.env.OCX_SERVICE === "1"');
    expect(startFn).not.toContain("OCX_KEEP_ROUTING");
    expect(startFn).toContain("!preserveRouting && serviceEnvironmentOwnedHere()");
  });

  test("signal shutdown reports and exits nonzero when native Codex restore is incomplete", () => {
    const startFn = sliceFn(CLI_SOURCE, "async function handleStart(", "async function handleStop(");
    expect(startFn).toContain("if (!restored.success)");
    expect(startFn).toContain("cleanupSucceeded = false");
    expect(startFn).toContain("Native Codex restore failed during shutdown");
    expect(startFn).toContain("process.exit(restored ? 0 : 1)");
  });
});

describe("service teardown owns both managed configs", () => {
  test("service stop strips the Grok fence and guards the platform stop on installation", () => {
    const stopCase = sliceFn(SERVICE_SOURCE, 'case "stop":', 'case "status":');
    expect(stopCase).toContain("assertServiceEnvironmentMatchesInstall()");
    // An unguarded ops.stop() ran a real launchctl unload even with nothing installed.
    expect(stopCase).toContain("isServiceInstalled()");
    expect(stopCase).toContain("stripGrokConfig()");
  });

  test("service uninstall strips the Grok fence too", () => {
    const uninstallCase = sliceFn(SERVICE_SOURCE, 'case "uninstall":', "    default:");
    expect(uninstallCase).toContain("stripGrokConfig()");
    expect(uninstallCase).toContain("removeServiceInstallState()");
  });
});

describe("ownership errors are distinguishable", () => {
  test("ownership mismatch is its own error type, plain failures are not", () => {
    expect(isServiceOwnershipError(new ServiceOwnershipError("mismatch"))).toBe(true);
    // Misclassifying an ordinary stop failure would block teardown that is safe to run.
    expect(isServiceOwnershipError(new Error("launchctl exited 1"))).toBe(false);
    expect(isServiceOwnershipError("not an error")).toBe(false);
  });

  test("the guard still throws the documented message", () => {
    expect(new ServiceOwnershipError("Service was installed with CODEX_HOME=/a").message)
      .toContain("Service was installed with CODEX_HOME");
  });
});

describe("POST /api/stop teardown", () => {
  test("refuses with 409 on ownership mismatch instead of throwing a 500", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");

    expect(handler).toContain("isServiceOwnershipError(err)");
    expect(handler).toContain("}, 409, req, config)");
    // The refusal must return BEFORE the shutdown is scheduled: a refused stop keeps running.
    const refusalAt = handler.indexOf("409");
    const shutdownAt = handler.indexOf("drainAndShutdown");
    expect(refusalAt).toBeLessThan(shutdownAt);
  });

  test("strips the Grok fence on an accepted stop", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    expect(handler).toContain('await import("../grok/inject")');
    expect(handler).toContain("stripGrokConfig()");
  });

  test("a 409 does not escalate to a forced kill", () => {
    // Escalating would run the daemon's cleanup and strip shared config while the foreign
    // service keeps the proxy alive — the exact hole the ownership gate exists to close.
    expect(PROCESS_CONTROL_SOURCE).toContain('if (res.status === 409) return "refused"');

    const stopProxyFn = sliceFn(PROCESS_CONTROL_SOURCE, "export async function stopProxy(", "export function killProxy(");
    const refusedAt = stopProxyFn.indexOf('graceful === "refused"');
    const killAt = stopProxyFn.indexOf("killProxy(pid)");
    expect(refusedAt).toBeGreaterThan(-1);
    expect(refusedAt).toBeLessThan(killAt);
    expect(stopProxyFn).toContain("throw new ProxyOwnershipRefusedError(");
  });
});
