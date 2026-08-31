import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyWindowsServiceStop, installedServiceRespawnRisk, isServiceOwnershipError, ServiceOwnershipError } from "../src/service";

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
    // Ownership is now one of two reasons to skip the restore; the other is an inherited
    // obligation whose proxy could not be confirmed down (#3008).
    expect(stopFn).toContain("const restoreBlocked = ownershipBlocked ||");
    expect(stopFn).toContain("if (!restoreBlocked) {");
    expect(stopFn).toContain("await restoreSharedClientStateAfterStop()");
    expect(restoreFn).toContain("restoreNativeCodexAsync()");
    expect(restoreFn).not.toContain("revertSystemEnv()");
    expect(restoreFn).toContain("stripGrokConfig()");
    expect(stopFn.indexOf("revertSystemEnv()")).toBeLessThan(stopFn.indexOf("if (!restoreBlocked) {"));
  });

  test("a refused Grok strip makes ocx stop fail instead of reporting success", () => {
    const restoreFn = sliceFn(CLI_SOURCE, "async function restoreSharedClientStateAfterStop(", "async function handleStop(");
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    // A Grok strip failure is "other", never history-only: it points Grok at a dead proxy,
    // so an update must abort rather than proceed (#3008).
    expect(restoreFn).toContain("else if (!grok.ok) { other = true;");
    expect(restoreFn).toContain("Grok config restore failed");
    expect(stopFn).toContain("if (restore.other) stopFailed = true");
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

  test("a stopped scheduler is verified across the respawn window before stop succeeds", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    // killWindowsSchedulerWrappers is best-effort and the `:loop` wrapper respawns after
    // ~5s, so "stopped" alone is not a proven-down proxy. An update that trusts it can
    // start replacing files during the dead interval (#3008).
    expect(stopFn).toContain("proxyStillLiveAfterStop({ canRespawn: true })");
    // A survivor is an ordinary failure AND blocks shared teardown: restoring client
    // config while the proxy runs leaves both pointing at each other.
    expect(stopFn).toContain("stopFailed = true;");
    expect(stopFn).toContain("ownershipBlocked = true;");
  });

  test("only Task Scheduler earns the respawn wait", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    const serviceSource = readFileSync(join(import.meta.dir, "..", "src", "service.ts"), "utf8");
    // schtasks /end leaves the `cmd :loop` wrapper alive to respawn its child (#764).
    // launchd, systemd and WinSW are down when they report stopped, so charging them a
    // seven-second poll on every ocx stop would be a regression in ordinary use.
    expect(serviceSource).toContain('"absent" | "stopped" | "stopped-respawnable" | "failed"');
    expect(serviceSource).toContain('schedulerStopped ? "stopped-respawnable" : "stopped"');
    expect(stopFn).toContain("if (schedulerCanRespawn && !ownershipBlocked)");
    // The wait is gated on the scheduler flag, not on "a service stopped".
    expect(stopFn).not.toContain("if (stoppedService && !ownershipBlocked)");
  });

  test("ocx stop defers shared teardown so a respawn survivor keeps its config", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    const apiSource = readFileSync(join(import.meta.dir, "..", "src", "server", "management-api.ts"), "utf8");
    const controlSource = readFileSync(join(import.meta.dir, "..", "src", "lib", "process-control.ts"), "utf8");
    // POST /api/stop normally restores native Codex and strips the Grok fence itself. If
    // ocx stop let it, a scheduler wrapper that respawns seconds later would already have
    // lost its client config, and the parent ownershipBlocked guard could only prevent a
    // second redundant teardown (#3008).
    expect(stopFn).toContain("deferSharedTeardownNonce: teardownNonce");
    expect(controlSource).toContain("deferSharedTeardown");
    expect(apiSource).toContain("performStopTeardown(url, { ownsReceipt: deferralMatchesReceipt })");
    // The deferral is an obligation, so it is claimed on disk BEFORE it is requested and
    // released only after THIS process has restored the shared config itself. A bare
    // query flag could not survive the parent dying mid-stop.
    const claimAt = stopFn.indexOf("claimTeardown(exact ?? configuredEndpoint()");
    expect(claimAt).toBeGreaterThan(-1);
    expect(claimAt).toBeLessThan(stopFn.indexOf("deferSharedTeardownNonce: teardownNonce"));
    // One resolved stop target feeds BOTH the receipt and the request, so the endpoint
    // recorded is the endpoint contacted — recovery probes exactly that one.
    // The endpoint is resolved ONCE: reading the runtime record twice let the receipt name
    // the configured guess while the request went to one that appeared in between.
    expect(stopFn).toContain("const exact = discovered ?? endpointOf(readRuntimePort(pid));");
    // Every stop claims a receipt, including the one that resolves no endpoint at all —
    // that path goes straight to the kill ladder with no child teardown, so a warning
    // instead of a receipt is exactly the parent-crash window this exists to close.
    expect(stopFn).toContain('claimTeardown(exact ?? configuredEndpoint(), exact ? "exact" : "guessed");');
    // A guessed endpoint records an obligation but must not direct the stop request.
    expect(stopFn).toContain("runtimeEndpoint: exact ?? undefined");
    // Nor may it authorize a later recovery: "the configured port refuses" is not proof
    // that a proxy on an explicit --port is down.
    expect(stopFn).toContain('if (read.receipt.endpointSource === "guessed")');
    const guessedBranch = stopFn.slice(stopFn.indexOf('if (read.receipt.endpointSource === "guessed")'), stopFn.indexOf("if (await abandonedTeardownIsSafeToFinish("));
    expect(guessedBranch).toContain("inheritedBlocks = true;");
    expect(guessedBranch).toContain("stopFailed = true;");
    expect(controlSource).toContain("io.runtimeEndpoint ?? readRuntime(pid)");
    // Inherited obligations are snapshotted BEFORE this run claims anything, so its own
    // receipt is never mistaken for one it inherited.
    expect(stopFn).toContain("isPendingTeardownAbandoned(read, isProcessAlive)");
    expect(stopFn.indexOf("listPendingTeardowns()")).toBeLessThan(claimAt);
    expect(stopFn).toContain("clearPendingTeardown(nonce)");
    expect(stopFn.indexOf("await restoreSharedClientStateAfterStop()"))
      .toBeLessThan(stopFn.indexOf("clearPendingTeardown(nonce)"));
    // A receipt that survives its discharge would re-trigger recovery forever.
    expect(stopFn).toContain("if (!clearPendingTeardown(nonce)) {");
  });

  test("an unconfirmed inherited obligation blocks the restore, it does not merely warn", () => {
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    // Finishing SOMEBODY ELSE's obligation needs a definitive "dead", not findLiveProxy's
    // null, which also covers a timeout and a listener that withholds /healthz. The first
    // attempt at this only logged a warning and then restored anyway, which is not a gate.
    expect(stopFn).toContain("await abandonedTeardownIsSafeToFinish(read.receipt.endpoint)");
    expect(stopFn).toContain("const restoreBlocked = ownershipBlocked || inheritedBlocks");
    expect(stopFn).toContain("if (!restoreBlocked) {");
    // The restore is reached only through that gate — no other call site may bypass it.
    const restoreCalls = stopFn.split("await restoreSharedClientStateAfterStop()").length - 1;
    expect(restoreCalls).toBe(1);
    expect(stopFn.indexOf("const restoreBlocked")).toBeLessThan(stopFn.indexOf("await restoreSharedClientStateAfterStop()"));
    // An obligation that cannot be discharged fails the stop and is preserved.
    const gateBlock = stopFn.slice(stopFn.indexOf("const recoveredNonces"), stopFn.indexOf("const restoreBlocked"));
    expect(gateBlock).toContain("inheritedBlocks = true;");
    expect(gateBlock).toContain("stopFailed = true;");
    expect(gateBlock).not.toContain("clearPendingTeardown");
    // An unreadable obligation names no endpoint, so it can never probe dead. It fails the
    // stop rather than being waved through, and is set aside only AFTER the outcome is
    // known — moving it earlier would erase it from every future scan while the restore it
    // stood for had not run.
    expect(gateBlock).not.toContain("quarantinePendingTeardown");
    // Setting aside is not discharging, and the message must not claim otherwise: the
    // renamed file still blocks an update until an operator removes it.
    const quarantineBlock = stopFn.slice(stopFn.indexOf("if (unreadable.length > 0"), stopFn.indexOf("// Set the code rather than exiting inline"));
    expect(quarantineBlock).toContain("It still blocks 'ocx update'");
    expect(quarantineBlock).toContain("has NOT restored on its behalf");
    expect(quarantineBlock).not.toContain("no longer blocks an update");
    expect(stopFn.indexOf("await restoreSharedClientStateAfterStop()"))
      .toBeLessThan(stopFn.indexOf("quarantinePendingTeardown(read.nonce)"));
    // Inherited receipts are evaluated whether or not this run claimed one of its own, and
    // every discharged nonce is released together — otherwise a stop that finds a live
    // proxy clears only its own and older obligations accumulate forever.
    expect(stopFn).toContain("if (inheritedTeardowns.length > 0 && !ownershipBlocked)");
    expect(stopFn).toContain("teardownNonce ? [teardownNonce, ...recoveredNonces] : recoveredNonces");
    // The orphan path hands over the endpoint the probe already found; its runtime record
    // is typically what went missing in the first place.
    expect(stopFn).toContain('stopWithDeferral(live.pid, { hostname: live.hostname ?? "127.0.0.1", port: live.port })');
    // A live proxy with no killable pid is not "no proxy found": purging state and
    // restoring over it is the same failure arrived at from the other direction.
    expect(stopFn).toContain("} else if (live) {");
    const noPidBranch = stopFn.slice(stopFn.indexOf("} else if (live) {"), stopFn.indexOf('} else if (!stoppedService) {'));
    expect(noPidBranch).toContain("stopFailed = true;");
    expect(noPidBranch).toContain("ownershipBlocked = true;");
    const gateFn = sliceFn(CLI_SOURCE, "const abandonedTeardownIsSafeToFinish", "let stopFailed = false;");
    expect(gateFn).toContain('probeProxyLiveness(endpoint.port, endpoint.hostname) === "dead"');
    expect(gateFn).toContain("return false;");
  });

  test("an outstanding teardown receipt makes both updaters run the stop", () => {
    // After a parent crashed mid-deferral the service, pid and runtime records can all be
    // absent while shared client config still points at a proxy that is gone. Installing
    // over that skips the recovery the receipt exists to trigger (#3008).
    const updateSource = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
    expect(updateSource).toContain("readPid() || readRuntimePort() || pendingTeardownOutstanding()");
    const launcherSource = readFileSync(join(import.meta.dir, "..", "bin", "ocx.mjs"), "utf8");
    // The launcher runs under plain Node, so it shares the naming rule as ESM rather than
    // spelling it out — which is how it ended up watching the retired singleton filename
    // after receipts moved to one file per claim, silently seeing none of them.
    expect(launcherSource).toContain("hasPendingTeardownIn(readdirSync, configDir())");
    expect(launcherSource).not.toContain('"pending-teardown.json"');
    expect(launcherSource).toContain("serviceWasInstalled || hasRuntimeState || hasPendingTeardown");
    // Checked AFTER the stop too: a quarantined receipt lets the stop succeed, so a
    // pre-stop check alone let the retry install over a teardown that never ran.
    expect(launcherSource).toContain("teardownOutstanding: hasPendingTeardownIn(readdirSync, configDir())");
    const updateSource2 = readFileSync(join(import.meta.dir, "..", "src", "update", "index.ts"), "utf8");
    expect(updateSource2).toContain("teardownOutstanding: pendingTeardownOutstanding()");
    const decisionSource = readFileSync(join(import.meta.dir, "..", "src", "update", "stop-decision.mjs"), "utf8");
    expect(decisionSource).toContain('if (teardownOutstanding) return { proceed: false, reason: "teardown-outstanding" };');
    const receiptSource = readFileSync(join(import.meta.dir, "..", "src", "config", "pending-teardown.ts"), "utf8");
    expect(receiptSource).toContain('from "./pending-teardown-names.mjs"');
    expect(receiptSource).toContain("isPendingTeardownFileName(name)");
  });

  test("handleStop treats an incomplete native Codex restore as a stop failure", () => {
    const restoreFn = sliceFn(CLI_SOURCE, "async function restoreSharedClientStateAfterStop(", "async function handleStop(");
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    expect(restoreFn).toContain("if (result.success) console.log");
    // Config or catalog failure is a real teardown failure - a client reads those. Only a
    // history-only failure is separable, and it still surfaces (#3008).
    expect(restoreFn).toContain('artifacts.config.state === "failed" || artifacts.catalog.state === "failed"');
    expect(restoreFn).toContain("else other = true");
    expect(restoreFn).toContain("console.error(`⚠️  ${result.message}`)");
    expect(stopFn).toContain("if (restore.other) stopFailed = true");
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
    expect(startFn).toContain("process.exit(restored && shutdownSucceeded ? 0 : 1)");
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
    // The teardown moved to src/server/stop-teardown.ts so a test can call it: the route
    // schedules process.exit 200ms after answering, which made the inline version
    // unreachable. tests/stop-deferred-teardown.test.ts proves the behaviour; this proves
    // the route still delegates to it rather than growing a second copy.
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    expect(handler).toContain("performStopTeardown(url, { ownsReceipt: deferralMatchesReceipt })");
    const teardownSource = readFileSync(join(import.meta.dir, "..", "src", "server", "stop-teardown.ts"), "utf8");
    expect(teardownSource).toContain('await import("../grok/inject")');
    expect(teardownSource).toContain("stripGrokConfig()");
  });

  test("an unreadable scheduler state gets the same diagnosis from the CLI and the API", () => {
    const serviceSource = readFileSync(join(import.meta.dir, "..", "src", "service.ts"), "utf8");
    // A manager that refused to stop and a query that could not answer are different
    // problems: reporting the second as "did not stop" sends the operator looking for the
    // wrong thing, and `ocx stop` was the command the API told them to run (#3008).
    expect(serviceSource).toContain('"absent" | "stopped" | "stopped-respawnable" | "failed" | "state-unknown"');
    // Behavioural, because a source-text assertion cannot tell whether an unreadable probe
    // is still being folded into the generic failure.
    expect(classifyWindowsServiceStop({ stopped: false, failed: false, schedulerStopped: false, stateUnknown: true }))
      .toBe("state-unknown");
    // A readable failure outranks it — something actually refused to stop.
    expect(classifyWindowsServiceStop({ stopped: false, failed: true, schedulerStopped: false, stateUnknown: true }))
      .toBe("failed");
    // And an unreadable state outranks success: a scheduler we cannot see may respawn.
    expect(classifyWindowsServiceStop({ stopped: true, failed: false, schedulerStopped: true, stateUnknown: true }))
      .toBe("state-unknown");
    expect(classifyWindowsServiceStop({ stopped: true, failed: false, schedulerStopped: true, stateUnknown: false }))
      .toBe("stopped-respawnable");
    expect(classifyWindowsServiceStop({ stopped: true, failed: false, schedulerStopped: false, stateUnknown: false }))
      .toBe("stopped");
    expect(classifyWindowsServiceStop({ stopped: false, failed: false, schedulerStopped: false, stateUnknown: false }))
      .toBe("absent");
    const stopFn = sliceFn(CLI_SOURCE, "async function handleStop(", "async function handleUninstall(");
    expect(stopFn).toContain('if (serviceStop === "state-unknown")');
    const unknownBranch = stopFn.slice(stopFn.indexOf('if (serviceStop === "state-unknown")'), stopFn.indexOf('if (serviceStop === "state-unknown")') + 700);
    expect(unknownBranch).toContain("stopFailed = true;");
    expect(unknownBranch).toContain("ocx service status");
    expect(unknownBranch).not.toContain("did not stop");
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    expect(handler).toContain('if (serviceStop === "state-unknown")');
    // The route answers the post-stop case with the same code as the pre-check.
    expect((handler.match(/service_state_unknown/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  test("maps a failed shutdown drain to a nonzero process exit", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    expect(handler).toContain("shutdownSucceeded = await drainAndShutdown");
    expect(handler).toContain("process.exit(shutdownSucceeded && teardown.success ? 0 : 1)");
  });

  test("the route consumes the detailed service outcome instead of the boolean", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    // stopServiceIfInstalled collapses "failed" into the same false as "not installed", so
    // this route used to tear down shared config while a manager that refused to stop was
    // still there to respawn the proxy (#3008).
    expect(handler).toContain("stopServiceIfInstalledDetailed()");
    expect(handler).not.toContain("stopServiceIfInstalled();");
    expect(handler).toContain('if (serviceStop === "failed")');
    expect(handler.indexOf('if (serviceStop === "failed")')).toBeLessThan(handler.indexOf("await performStopTeardown"));
  });

  test("a respawnable backend is refused BEFORE the manager is touched", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    // Stopping the Task Scheduler task and then returning 409 left the proxy running with
    // its manager stopped — worse than either outcome, and the dashboard's Stop button
    // sends a bare request on every backend.
    expect(handler).toContain('const respawnRisk = holdsReceipt ? "none" : installedServiceRespawnRisk();');
    expect(handler).toContain('code: "respawnable_service"');
    expect(handler.indexOf("installedServiceRespawnRisk()")).toBeLessThan(handler.indexOf("stopServiceIfInstalledDetailed()"));
    // The refusal must say nothing was changed, because nothing was.
    expect(handler).toContain("Nothing was changed.");
    // An unreadable scheduler state is its own answer: sending that operator to `ocx stop`
    // would be a loop, because it maps the same unknown probe to a stop failure.
    expect(handler).toContain('code: "service_state_unknown"');
    const unknownBranch = handler.slice(handler.indexOf('code: "service_state_unknown"'), handler.indexOf('code: "service_state_unknown"') + 500);
    expect(unknownBranch).toContain("ocx service status");
    expect(unknownBranch).not.toContain("run `ocx stop`");
  });

  test("only a proven absence is safe to stop inline", () => {
    // Behavioural, not source-shaped: the previous assertion matched an unrelated
    // `return true` in the catch and therefore passed while "unknown" was let through.
    expect(installedServiceRespawnRisk(() => ({ status: "present" }) as never, "win32")).toBe("respawnable");
    // "unknown" is an ordinary return value from the probe, not a throw. Treating it as
    // absence let the route kill scheduler wrappers before refusing.
    // It is also kept distinct from "respawnable", because the remedy differs: `ocx stop`
    // maps the same unknown to a stop failure, so telling that operator to run it loops.
    expect(installedServiceRespawnRisk(() => ({ status: "unknown" }) as never, "win32")).toBe("unknown");
    expect(installedServiceRespawnRisk(() => { throw new Error("schtasks unavailable"); }, "win32")).toBe("unknown");
    // A proven absence is the only case that proceeds.
    expect(installedServiceRespawnRisk(() => ({ status: "absent" }) as never, "win32")).toBe("none");
    // Every other platform is down when it says so; no wrapper can respawn.
    expect(installedServiceRespawnRisk(() => ({ status: "present" }) as never, "darwin")).toBe("none");
    expect(installedServiceRespawnRisk(() => ({ status: "present" }) as never, "linux")).toBe("none");
  });

  test("the daemon's exit status reflects the shared teardown, not just the drain", () => {
    const handler = sliceFn(MANAGEMENT_SOURCE, '"/api/stop"', "/api/codex-auth/");
    // A drained proxy whose restore failed did not finish the job; exiting 0 told a
    // supervisor the stop was clean while client config still pointed at this process.
    expect(handler).toContain("process.exit(shutdownSucceeded && teardown.success ? 0 : 1)");
  });

  test("direct service stop and uninstall fail when a shared teardown half fails", () => {
    const serviceSource = readFileSync(join(import.meta.dir, "..", "src", "service.ts"), "utf8");
    // These paths logged the failure and exited 0, so a script could not tell a complete
    // teardown from one that left Grok aimed at a stopped proxy.
    const stopCase = serviceSource.slice(
      serviceSource.indexOf("service stopped + native Codex restored"),
      serviceSource.indexOf('case "status": {'),
    );
    expect(stopCase).toContain("if (!restore.success) process.exitCode = 1;");
    expect((stopCase.match(/process\.exitCode = 1;/g) ?? []).length).toBeGreaterThanOrEqual(2);
    const uninstallStart = serviceSource.indexOf("`⚠️ native Codex restore FAILED:");
    expect(uninstallStart).toBeGreaterThan(-1);
    const uninstallCase = serviceSource.slice(uninstallStart, uninstallStart + 700);
    expect((uninstallCase.match(/process\.exitCode = 1;/g) ?? []).length).toBeGreaterThanOrEqual(2);
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
