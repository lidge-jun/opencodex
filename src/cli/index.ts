#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { currentExternalCodexModelProvider, restoreNativeCodex, restoreNativeCodexAsync, shouldInjectApiAuthHeader } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { resolveCodexHistoryJobTarget, runCodexHistoryJob } from "../codex/history-job";
import { reconcileJournal } from "../codex/journal";
import {
  codexAutoStartEnabled,
  getConfigDir,
  loadConfig,
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
  saveConfig,
  writePid,
  writeRuntimePort,
} from "../config";
import { collectStatus } from "./status";
import { dispatchInternalCliCommand, type InternalCliCommand } from "./internal-dispatch";
import {
  discoverStableProxyForRestart,
  isProxyReplacement,
  runProxyRestart,
  runTrayProxyStart,
  type ProxyRestartLive,
  type ProxyRestartResult,
} from "./tray-proxy";
import { requestBoundSystemRestart } from "./system-restart-client";
import { installCrashGuards } from "../lib/crash-guard";
import { hasHelpFlag, printSubcommandUsage, printUsage, printVersion } from "./help";
import { findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { createReadinessGate } from "../server/readiness";
import { parseReadyArgs, runReady, type ReadyArgs } from "./ready";
import { stopProxy } from "../lib/process-control";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { diagnoseService, isServiceOwnershipError, serviceCommand, serviceEnvironmentOwnedHere, serviceStartableFromTray, serviceStatusSummary, stopServiceIfInstalled, uninstallServiceIfInstalled } from "../service";
import { startupHealthSummary } from "../codex/autostart-health";
import { drainAndShutdown, isRecyclingForExit, startServer } from "../server";
import { injectSystemEnv, revertSystemEnv } from "../server/system-env";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { installShellHook, uninstallShellHook } from "../server/system-env";
import { startTokenGuardian } from "../oauth/token-guardian";
import { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
import { maybeAutoRestoreCodexShim } from "./codex-shim-autorestore";
import { maybeShowStarPrompt } from "./star-prompt";
import { scheduleCatalogPrewarm } from "./catalog-prewarm";
import { maybeShowUpdatePrompt } from "../update/notify";
import { syncModelsToCodex } from "../codex/sync";
import { setIntegrationEnabled, shouldSyncCodexOnStart, shouldSyncGrokOnStart, syncCodexOnStartIfEnabled } from "../codex/desired-state";
import { normalizeUpdateChannel, runGuiUpdateWorker } from "../update/job";
import { collectOrcaCodexHomeDiagnostic } from "../codex/home";
import { removeOwnedConfigState } from "../lib/config-ownership";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { initializeNodeLauncherContext } from "./launcher-context";
import { createLocalAttestationSecret } from "../lib/local-management-attestation";
import { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../lib/system-restart-contract";

initializeNodeLauncherContext();
const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v" || command === "version") {
  printVersion();
  process.exit(0);
}

if (command === undefined || command === "help" || command === "--help" || command === "-h") {
  if (command === "help" && args[1]) printSubcommandUsage(args[1]);
  else printUsage();
  process.exit(0);
}

if (command !== undefined && command !== "help" && hasHelpFlag(args.slice(1))) {
  printSubcommandUsage(command);
  process.exit(0);
}

// P1: pre-parse `ocx ready` and reject invalid arguments with exit 64 BEFORE
// maybeAutoRestoreCodexShim (or any discovery/probe/filesystem-capable global
// preflight) runs. `ready --help` / `help ready` already exited above, so this
// only sees ready args without a help flag. Valid args are stashed so the
// switch dispatch can call runReady without a second parse.
let readyArgs: ReadyArgs | undefined;
if (command === "ready") {
  const parsed = parseReadyArgs(args.slice(1));
  if (!parsed.ok) {
    console.error("Usage: ocx ready [--json] [--wait [--timeout <seconds>]]");
    console.error("  --timeout requires --wait; <seconds> must be a positive integer (1..300).");
    console.error("  Default wait timeout is 45 seconds.");
    process.exit(parsed.code);
  }
  readyArgs = parsed.args;
}

maybeAutoRestoreCodexShim(command, args);

function parsePortOption(): number | undefined {
  if (args.length === 1) return undefined;
  if (args.length !== 3 || args[1] !== "--port") {
    console.error("Usage: ocx start [--port <port>]");
    process.exit(1);
  }
  const portIdx = args.indexOf("--port");
  if (portIdx === -1) return undefined;
  const value = args[portIdx + 1];
  const port = value && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("Invalid port number");
    process.exit(1);
  }
  return port;
}

async function waitForProxy(timeoutMs = 8_000): Promise<LiveProxy | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // Runtime-state-first with identity: finds the proxy even when it started on a
    // fallback port, and never mistakes a foreign 200 for our proxy.
    const live = await findLiveProxy();
    if (live) return live;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

/**
 * A Grok fence sync that throws is best-effort by design — it must never block startup.
 * Reporting nothing, however, is what lets a STALE fence survive: `~/.grok/config.toml`
 * keeps naming whatever port the last successful sync wrote, and once that listener is
 * gone every grok turn retries against a refused connection while our own log stays
 * silent (2026-07-27 field report: 8 entries pinned to a dead 127.0.0.1:4179).
 * So say what failed and name the single command that repairs it.
 */
function grokSyncFailureMessage(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `Grok Build config sync failed: ${detail}. `
    + "~/.grok/config.toml may still point at a previous proxy port — "
    + "run 'ocx ensure' (or apply from the dashboard's Grok page) to repoint it.";
}

/** Argv for detached `start`, optionally hard-pinning the listen port. */
function startArgv(port?: number): string[] {
  const args = [process.argv[1], "start"];
  if (typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535) {
    args.push("--port", String(Math.trunc(port)));
  }
  return args;
}

async function chooseListenPort(requestedPort?: number): Promise<number> {
  const config = loadConfig();
  const preferred = requestedPort ?? config.port ?? 10100;
  const hardPin = requestedPort !== undefined && requestedPort > 0;
  const reservedLoopbackPort = config.unauthenticatedLoopbackListener?.enabled
    ? config.unauthenticatedLoopbackListener.port
    : undefined;
  // Before the reclaim path, not after (#1102). Asking for the port the loopback listener is
  // configured to bind is a configuration mistake, and reclaim would spend up to 60 seconds
  // waiting for a socket to free before reporting "port is busy" — the wrong diagnosis for a
  // collision the config can state outright.
  if (reservedLoopbackPort !== undefined && preferred === reservedLoopbackPort) {
    throw new Error(
      `Port ${preferred} is reserved for unauthenticatedLoopbackListener; choose a different proxy port.`,
    );
  }
  // Soft start: brief prefer-retry then ephemeral hop.
  // Explicit `--port` (service wrappers / update restart): wait for the pinned port
  // to free without killing any listener (healthy ocx / foreign). Never hop.
  if (hardPin && preferred > 0) {
    const { reclaimListenPort } = await import("../server/port-reclaim");
    await reclaimListenPort(preferred, config.hostname ?? "127.0.0.1", {
      // Ghost LISTEN rows with a dead PID can outlive the process for a while.
      // SetTcpEntry(DELETE_TCB) needs elevation (often returns 317), so the only
      // reliable non-admin recovery is to wait for the OS to release the TCB.
      timeoutMs: 60_000,
      intervalMs: 100,
      scanIntervalMs: 500,
      killOcxHolders: false,
      dropTcpRows: true,
    });
  }
  try {
    const selected = await findAvailablePort(preferred, config.hostname ?? "127.0.0.1", {
      // After reclaim, keep probing briefly — ghost rows sometimes clear between
      // the reclaim deadline and the final listen. Still never hop off `--port`.
      preferRetryMs: hardPin ? 5_000 : 750,
      preferRetryIntervalMs: 50,
      allowEphemeralFallback: !hardPin,
      // Never hand the public listener the port the loopback listener is configured to
      // bind (#1102). Without this, `--port <loopback port>` binds the public listener
      // first and the loopback bind then fails, rolling back a startup that was only
      // ever a config collision.
      ...(reservedLoopbackPort !== undefined ? { reservedPort: reservedLoopbackPort } : {}),
    });
    if (preferred > 0 && selected !== preferred) {
      console.log(`⚠️  Port ${preferred} is busy; starting opencodex on ${selected}.`);
    }
    if (shouldPersistSelectedPort(config.port, selected, preferred)) {
      config.port = selected;
      saveConfig(config);
    }
    return selected;
  } catch (err) {
    if (err instanceof PortUnavailableError) {
      console.error(`❌ ${err.message}`);
      console.error("   Stop whatever holds that port, or change config.port, then retry.");
      process.exit(1);
    }
    throw err;
  }
}

async function handleStart(options: { block?: boolean } = {}) {
  // Native (WinSW) service mode has no batch wrapper to read the service token file
  // into the environment, so the app loads it here before the server binds. The server
  // auth path reads OPENCODEX_API_AUTH_TOKEN from the environment.
  const serviceToken = loadServiceTokenFromFile(process.env);
  if (serviceToken) process.env.OPENCODEX_API_AUTH_TOKEN = serviceToken;
  const requestedPort = parsePortOption();
  const existingPid = readPid();
  if (existingPid) {
    const live = await findLiveProxy();
    if (live) {
      console.error(`⚠️  Proxy already running (PID ${live.pid ?? existingPid}, port ${live.port}). Use 'ocx stop' first.`);
      process.exit(1);
    }
    removePid(existingPid);
  }
  // A losing concurrent start must not restore the active proxy's Codex config.
  // Establish that the PID-file owner is stale before reconciling a dead journal;
  // a healthy owner exits above without changing integration state (#1230).
  if (!currentExternalCodexModelProvider()) reconcileJournal();

  // Interactive-only update prompt. Must run BEFORE we bind a port / write a
  // PID: choosing "Update now" installs globally and exits, so we never want a
  // live daemon holding resources while it overwrites its own binary.
  await maybeShowUpdatePrompt();

  // Port selection is check-then-bind: a concurrent `ocx start`/`ensure` can win the port
  // between the probe and Bun.serve. Soft starts may re-pick; hard-pinned `--port` retries
  // the same port only (never hop — that was the remaining PR #152 gap).
  let port = await chooseListenPort(requestedPort);
  // One private readiness gate for this startServer invocation, captured by the
  // listener's closure. handleStart owns it and transitions it after the
  // post-startup sync settles. A second startServer in the same process would
  // get its own gate and could never reset/mutate this one.
  const readinessGate = createReadinessGate();
  let server: ReturnType<typeof startServer>;
  const localAttestationSecret = createLocalAttestationSecret();
  for (let attempt = 0; ; attempt++) {
    try {
      server = startServer(port, { localAttestationSecret, readinessGate });
      // Prewarm the live provider model cache as soon as the port is bound so the
      // first GUI /v1/models (and syncModelsToCodex below) share one discovery flight
      // instead of racing duplicate upstream /models fetches.
      scheduleCatalogPrewarm();
      break;
    } catch (err) {
      if (!isAddrInUse(err) || attempt >= 2) throw err;
      if (requestedPort !== undefined) {
        console.log(`⚠️  Port ${port} was taken while starting; waiting to retry the same port...`);
        const hostname = loadConfig().hostname ?? "127.0.0.1";
        const freed = await waitForPortAvailable(port, hostname, { timeoutMs: 3_000, intervalMs: 50 });
        if (!freed) {
          console.error(`❌ Port ${port} stayed busy; refusing to hop to an ephemeral port.`);
          process.exit(1);
        }
        continue;
      }
      console.log(`⚠️  Port ${port} was taken while starting; picking another...`);
      port = await chooseListenPort(requestedPort);
    }
  }
  // A single request's streaming error must never crash the daemon serving every
  // other Codex session — capture the full stack to crash.log and stay up.
  installCrashGuards();
  writePid(process.pid);

  const config = loadConfig();
  writeRuntimePort({ pid: process.pid, port, hostname: config.hostname, attestationSecret: localAttestationSecret });
  // No pre-emptive snapshot here. `injectCodexConfig` journals the exact bytes it
  // is about to transform; snapshotting earlier only captured a baseline that could
  // already be stale by the time injection ran (#477).

  // Background proactive token refresh. No-op unless config.tokenGuardian.enabled; timer is unref'd
  // so it never keeps the process alive on its own. Stopped in syncCleanup so no refresh fires mid-drain.
  const guardian = startTokenGuardian();
  // Design B upgrade path: keep retrying the one-time opencodex→openai history migration in the
  // background — the first `ocx start` after an update usually races the Codex app's DB lock.
  // Loopback-only (legacy mode still forward-tags) and respects syncResumeHistory opt-out.
  let historyGuardian: ReturnType<typeof startHistoryMigrationGuardian> | undefined;

  let cleaned = false;
  let cleanupSucceeded = true;
  const syncCleanup = () => {
    if (cleaned) return cleanupSucceeded;
    cleaned = true;
    try { guardian.stop(); } catch { /* best-effort */ }
    try { historyGuardian?.stop(); } catch { /* best-effort */ }
    // Dashboard drain-and-restart (#563) must not tear down injection: the replacement
    // process expects Codex/Grok/env fences to still be in place.
    const recycling = isRecyclingForExit();
    if (!recycling) {
      try { revertSystemEnv(); } catch { /* best-effort */ }
    }
    removePid(process.pid);
    removeRuntimePort(process.pid);
    const preserveRouting = process.env.OCX_SERVICE === "1";
    if (!recycling && !preserveRouting && !currentExternalCodexModelProvider()) {
      try {
        const restored = restoreNativeCodex();
        if (!restored.success) {
          cleanupSucceeded = false;
          console.error(`⚠️  Native Codex restore failed during shutdown: ${restored.message}`);
        }
      } catch (error) {
        cleanupSucceeded = false;
        console.error(`⚠️  Native Codex restore failed during shutdown: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    // Same ownership rule as `ocx stop`: if the installed service belongs to another home, the
    // Grok fence is shared state we must not remove — that service keeps running and would be
    // left pointing nowhere. This guard also covers signal-driven exits, which is the path that
    // would otherwise bypass handleStop's gate entirely.
    if (!recycling && !preserveRouting && serviceEnvironmentOwnedHere()) {
      try { stripGrokConfig(); } catch { /* best-effort restore */ }
    }
    return cleanupSucceeded;
  };

  let shuttingDown = false;
  let shutdownStartedAt = 0;
  // Terminal Ctrl-C delivers SIGINT to the whole foreground group AND the launcher
  // forwards its own — two signals land within milliseconds. Treat a duplicate inside
  // this window as the same Ctrl-C (one graceful drain); a deliberate later press
  // escalates to an immediate force-exit ("gradual kill").
  const FORCE_AFTER_MS = 500;
  const shutdown = () => {
    const now = Date.now();
    if (shuttingDown) {
      if (now - shutdownStartedAt < FORCE_AFTER_MS) return; // near-simultaneous duplicate — ignore
      console.log("\n⏹  Force shutdown (second signal).");
      try { syncCleanup(); } catch { /* best-effort */ }
      process.exit(130);
    }
    shuttingDown = true;
    shutdownStartedAt = now;
    console.log("\n🛑 Shutting down opencodex proxy...");
    void (async () => {
      try {
        await drainAndShutdown(server, config.shutdownTimeoutMs ?? 5000);
      } finally {
        const restored = syncCleanup(); // idempotent (cleaned-guard); also re-run by process.on("exit")
        process.exit(restored ? 0 : 1);
      }
    })();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  // The launcher (bin/ocx.mjs) forwards SIGHUP too (e.g. terminal close); handle it
  // gracefully here so it drains + cleans up instead of a default immediate kill.
  process.on("SIGHUP", shutdown);
  process.on("exit", syncCleanup);

  // System-wide env injection AFTER signal handlers are registered (crash safety:
  // syncCleanup reverts even if injection itself or subsequent startup steps fail).
  await injectSystemEnv(port, config).catch(() => {});
  // Auto-install .zshrc hook (idempotent — skips if already present).
  installShellHook();

  await maybeShowStarPrompt(); // once-only Yes/No GitHub-star prompt on first interactive start
  // Post-startup sync drives the readiness gate AND the #1046 stale app-server
  // warning. `syncCodexOnStartIfEnabled` respects the Codex integration toggle
  // (OFF → no sync) and reports whether anything was written; the readiness gate
  // observes the real sync outcome (ok/warning) so /readyz never advertises a
  // half-synced proxy as ready while /healthz stays live.
  const startupSync = await syncCodexOnStartIfEnabled(port, config, undefined, readinessGate);
  if (!startupSync.ran) console.log("   Codex integration OFF; startup left Codex native.");
  // #1046: one warning per startup, after BOTH writes. The server's cache
  // invalidation happens first and the catalog sync second, so the mtime is only
  // final here — and neither write site warns on its own, or a boot that hits
  // both would warn twice.
  const { consumeStartupCacheInvalidationWrite } = await import("../server");
  if (consumeStartupCacheInvalidationWrite() || startupSync.catalogWritten || startupSync.cacheSynced) {
    const { warnIfStaleCodexAppServersAfterStartupWrite } = await import("../codex/app-server-processes");
    warnIfStaleCodexAppServersAfterStartupWrite({ log: console });
  }
  if (!currentExternalCodexModelProvider() && !shouldInjectApiAuthHeader(config) && config.syncResumeHistory !== false) {
    historyGuardian = startHistoryMigrationGuardian();
  }
  // Build Desktop 3P alias registry so inbound claude-opus-4-8-{code} aliases (and legacy claude-opus-4-{code}) decode correctly.
  try {
    const { fetchAllModels } = await import("../server/management-api");
    const { visibleNativeSlugs, filterCatalogVisibleModels } = await import("../codex/catalog");
    const models = filterCatalogVisibleModels(await fetchAllModels(config), config);
    buildDesktop3pRegistry(
      [...visibleNativeSlugs(config)],
      models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })),
      config.claudeCode?.desktopProfile,
    );
  } catch { /* best-effort — registry rebuilds on first /v1/models call */ }
  // Grok Build auto-registration: additive fenced block in ~/.grok/config.toml so an installed
  // grok CLI can pick opencodex-routed models without manual config. No-op when ~/.grok is
  // absent or the bind is non-loopback; removed again by stop/eject/uninstall/shutdown.
  // Deliberately a SIBLING of the Desktop-3P block above: nesting it there meant a catalog
  // failure skipped the fence entirely, even though syncGrokConfig handles that case itself.
  //
  // Gated on the persisted switch: without this, turning Grok off lasted exactly
  // one restart, because the toggle removed the fence and start wrote it back.
  if (shouldSyncGrokOnStart(config)) try {
    const { syncGrokConfig } = await import("../grok/sync");
    const r = await syncGrokConfig(port, config, config.hostname ? { hostname: config.hostname } : {});
    if (r.changed) console.log("   + Grok Build config updated (~/.grok/config.toml)");
    else if (!r.ok) console.error(`⚠️  ${r.message}`);
  } catch (err) {
    // Best-effort: grok integration must never block startup. But swallowing the error
    // silently is how a stale fence survives unnoticed — ~/.grok/config.toml keeps
    // pointing at whatever port the LAST successful sync wrote, and if that listener is
    // gone every grok turn retries against a refused connection with nothing in our log
    // to explain it. Name the failure and the one command that repairs it.
    console.error(`⚠️  ${grokSyncFailureMessage(err)}`);
  }
  if (options.block ?? true) {
    setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
  }
}

function detachedStartEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Only a real service wrapper may claim supervision. A detached ensure/tray child
  // is an ordinary owner: while live it maintains routing, and on exit it restores it.
  delete env.OCX_SERVICE;
  return withProcessRuntimeProvenance(env);
}

async function handleEnsure(options: { existingIsSuccess?: boolean } = {}): Promise<boolean> {
  if (!currentExternalCodexModelProvider()) reconcileJournal();
  const config = loadConfig();
  if (!codexAutoStartEnabled(config)) {
    console.log("Codex autostart is disabled.");
    return false;
  }
  const live = await findLiveProxy();
  if (live) {
    if (options.existingIsSuccess === false) {
      console.error("Proxy appeared while restart was confirming absence; no start was attempted.");
      return false;
    }
      const synced = await syncModelsToCodex(live.port).catch(e => {
        console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      });
      if (synced?.status === "skipped") console.log("   Codex integration OFF; startup left Codex native.");
      // Ensure env file exists for already-running proxy (may have been deleted or pre-dates this feature).
      await injectSystemEnv(live.port, config).catch(() => {});
      // Refresh the Grok Build fence too (same contract as start). live.hostname is the
      // hostname the running proxy actually bound — config.hostname may have drifted.
      try {
        const { syncGrokConfig } = await import("../grok/sync");
        const g = await syncGrokConfig(live.port, config, live.hostname ? { hostname: live.hostname } : {});
        if (g.changed) console.log("   + Grok Build config updated (~/.grok/config.toml)");
        else if (!g.ok) console.error(`⚠️  ${g.message}`);
      } catch (err) { console.error(`⚠️  ${grokSyncFailureMessage(err)}`); }
      console.log(`✅ Proxy running on port ${live.port}`);
      return true;
    }

  const pinPort = config.port ?? 10100;
  const child = spawn(process.execPath, startArgv(pinPort > 0 ? pinPort : undefined), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: detachedStartEnvironment(),
  });
  child.unref();

  const port = (await waitForProxy())?.port;
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    process.exitCode = 1;
    return false;
  }
  // Deterministic fence guarantee: the spawned child injects late in its own startup, but
  // this parent returns as soon as /healthz responds — inject here too (idempotent block
  // replace) so `ocx ensure` never returns without the Grok fence in place.
  try {
    const { syncGrokConfig } = await import("../grok/sync");
    const g = await syncGrokConfig(port, config, config.hostname ? { hostname: config.hostname } : {});
    if (g.changed) console.log("   + Grok Build config updated (~/.grok/config.toml)");
    else if (!g.ok) console.error(`⚠️  ${g.message}`);
  } catch (err) { console.error(`⚠️  ${grokSyncFailureMessage(err)}`); }
  // Always sync the LIVE port: after a fallback-port start, config.port still names the
  // busy preferred port — syncing that would point Codex at a dead listener.
  const synced = await syncModelsToCodex(port).catch(e => {
    console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (synced?.status === "skipped") console.log("   Codex integration OFF; startup left Codex native.");
  console.log(`✅ Proxy running on port ${port}`);
  return true;
}

/** Fixed tray action: start the proxy without depending on codexAutoStart. */
async function handleTrayProxyStart(existingIsSuccess = true): Promise<boolean> {
  const ok = await runTrayProxyStart({
    findLive: findLiveProxy,
    existingIsSuccess,
    diagnoseService: () => {
      const service = diagnoseService();
      return { installed: service.installed, startable: serviceStartableFromTray(service), summary: service.summary };
    },
    startService: () => serviceCommand("start"),
    startDirect: () => {
      const config = loadConfig();
      const port = (config.port ?? 10100) > 0 ? (config.port ?? 10100) : 10100;
      const child = spawn(process.execPath, startArgv(port), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: detachedStartEnvironment(),
      });
      child.unref();
    },
    // serviceCommand("start") already spends up to 20s confirming the supervised
    // child. Slow Windows hosts can still be publishing native-main state after that
    // first window, so keep one shared follow-up budget instead of returning a false
    // failure while Task Scheduler is still starting the approved child.
    waitForProxy: () => waitForProxy(40_000),
    info: message => console.log(message),
    error: message => console.error(message),
  });
  // serviceCommand("start") can set exitCode=1 after its own 20s probe, while
  // the coordinator's bounded follow-up observes the same service become live.
  // The final observed state, not the earlier probe, owns this command result.
  process.exitCode = ok ? 0 : 1;
  return ok;
}

const PROXY_RESTART_OBSERVE_MS = MEMORY_DRAIN_RESTART_MS + REPLACEMENT_READY_TIMEOUT_MS + 15_000;

async function waitForProxyReplacement(
  previous: ProxyRestartLive,
  deadlineAt: number,
): Promise<ProxyRestartLive | null> {
  while (Date.now() < deadlineAt) {
    const live = await findLiveProxy({ deadlineAt });
    if (Date.now() >= deadlineAt) return null;
    // Modern /healthz publishes a PID. Require a different, identity-verified process;
    // merely seeing the old port online again is not proof that restart completed.
    if (isProxyReplacement(previous, live)) {
      return live;
    }
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs > 0) await Bun.sleep(Math.min(250, remainingMs));
  }
  return null;
}

function reportRestartFailure(result: Extract<ProxyRestartResult, { ok: false }>): void {
  if (result.phase === "identity") {
    console.error("❌ Refusing to restart because the running proxy identity could not be attested.");
  } else if (result.phase === "request") {
    const code = result.error instanceof Error ? result.error.message : "";
    if (code === "restart_capability_unsupported") {
      console.error("❌ The running proxy predates process-bound restart support; no unsafe fallback was attempted.");
      console.error("   After confirming this home owns the proxy, run `ocx stop` and then `ocx start` once.");
    } else {
      console.error("❌ Proxy restart request could not be confirmed; no fallback stop/start was attempted.");
    }
  } else if (result.phase === "replacement") {
    console.error("❌ Proxy restart was accepted, but no identity-verified replacement became healthy in time.");
  } else {
    console.error("❌ Proxy was not running and the fallback start did not become healthy.");
  }
}

async function handleProxyRestart(
  startWhenStopped: () => Promise<boolean | "skipped">,
): Promise<boolean> {
  const deadlineAt = Date.now() + PROXY_RESTART_OBSERVE_MS;
  const result = await runProxyRestart({
    findLive: () => discoverStableProxyForRestart({
      findLive: () => findLiveProxy({ deadlineAt, attempts: 2 }),
      expired: () => Date.now() >= deadlineAt,
    }),
    startWhenStopped,
    requestInPlaceRestart: previous => requestBoundSystemRestart(previous, deadlineAt),
    waitForReplacement: previous => waitForProxyReplacement(previous, deadlineAt),
  });
  if (!result.ok) reportRestartFailure(result);
  process.exitCode = result.ok ? 0 : 1;
  return result.ok;
}

async function handleTrayProxyRestart(): Promise<void> {
  await handleProxyRestart(() => handleTrayProxyStart(false));
}

async function handleRestartStartWhenStopped(): Promise<boolean | "skipped"> {
  if (!codexAutoStartEnabled(loadConfig())) {
    console.log("Codex autostart is disabled; no proxy was started.");
    return "skipped";
  }
  return handleEnsure({ existingIsSuccess: false });
}

async function restoreSharedClientStateAfterStop(): Promise<boolean> {
  let restored = true;
  try {
    const result = await restoreNativeCodexAsync();
    if (result.success) console.log(`↩️  ${result.message}`);
    else {
      restored = false;
      console.error(`⚠️  ${result.message}`);
    }
  } catch (error) {
    restored = false;
    console.error(`⚠️  Native Codex restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A refused or thrown Grok strip is actionable because it would point Grok at a dead proxy.
  try {
    const grok = stripGrokConfig();
    if (grok.changed) console.log(`↩️  ${grok.message}`);
    else if (!grok.ok) { restored = false; console.error(`⚠️  ${grok.message}`); }
  } catch (error) {
    restored = false;
    console.error(`⚠️  Grok config restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return restored;
}

async function handleStop() {
  let stopFailed = false;
  let stoppedService = false;
  // An ownership mismatch means the service manager was never even contacted: the installed
  // service is still live and will respawn the proxy. Tearing down SHARED state in that
  // situation (native Codex config, the Grok fence) removes config out from under a running
  // service — the exact failure this flag prevents. A plain stop failure is different: we
  // tried, so local teardown still proceeds.
  let ownershipBlocked = false;
  try {
    stoppedService = stopServiceIfInstalled();
    if (stoppedService) console.log("🛑 Service manager stopped (won't respawn).");
  } catch (err) {
    if (isServiceOwnershipError(err)) {
      ownershipBlocked = true;
      stopFailed = true;
      console.error(`❌ ${err.message}`);
      console.error("   Skipping shared teardown (native Codex restore, Grok config): the installed service is still running.");
    } else {
      console.error(`⚠️  Service manager stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const pid = readPid();
  if (pid) {
    try {
      // Graceful-first (management-API drain) — on Windows this is the only path where
      // the proxy's shutdown handlers actually run; taskkill /F is the fallback inside.
      await stopProxy(pid);
      console.log(`✅ Proxy (PID ${pid}) stopped.`);
      removePid(pid);
      removeRuntimePort(pid);
    } catch (err) {
      stopFailed = true;
      console.error(`❌ Failed to stop proxy (PID ${pid}).`);
      // stopProxy throws with the reason — an ownership refusal (409) carries the
      // remediation ("run the stop from that home"). Swallowing it leaves the operator
      // with a bare failure and a manual `kill` as the obvious next move, which is the
      // exact teardown the refusal exists to prevent.
      const detail = err instanceof Error ? err.message : String(err);
      if (detail) console.error(`   ${detail}`);
    }
  } else {
    // Snapshot the stale on-disk state BEFORE the async probe: a concurrent `ocx start`
    // can write fresh records mid-probe, and the purge below must never delete those.
    const stalePidValue = readPidFileValue();
    const staleRuntimePid = readRuntimePort()?.pid ?? null;
    // Orphan recovery: a live proxy can outlive its pid file (crash, manual delete,
    // corrupt file). Identity-checked liveness still finds it via the runtime record.
    const live = await findLiveProxy();
    if (live?.pid) {
      try {
        await stopProxy(live.pid);
        console.log(`✅ Proxy (PID ${live.pid}) stopped.`);
      } catch (err) {
        stopFailed = true;
        console.error(`❌ Failed to stop proxy (PID ${live.pid}).`);
        const detail = err instanceof Error ? err.message : String(err);
        if (detail) console.error(`   ${detail}`);
      }
    } else if (!stoppedService) {
      console.log("No running proxy found.");
    }
    if (!stopFailed) {
      // `readPid() === null` means the snapshotted pid file was absent, invalid, dead, or
      // not ours — stale by definition. Purge (guarded by the snapshot) so `ocx update`'s
      // stop gate can't wedge on it.
      removePidIfValueIs(stalePidValue);
      removeRuntimePortIfPidIs(staleRuntimePid);
    }
  }
  // Environment ownership is independent from service ownership. Always roll back
  // current-home variables; the helper refuses foreign markers on its own.
  try { revertSystemEnv(); } catch { /* best-effort */ }
  if (!ownershipBlocked) {
    if (!await restoreSharedClientStateAfterStop()) stopFailed = true;
  }
  // Set the code rather than exiting inline: `restart` and the tray coordinator call this
  // function and need it to RETURN so they can decide what to do next.
  if (stopFailed) process.exitCode = 1;
  return !stopFailed;
}

async function handleUninstall() {
  const failures: string[] = [];

  const runStep = async (label: string, step: () => void | boolean | Promise<void | boolean>) => {
    try {
      const changed = await step();
      if (changed === false) console.log(`- ${label}: not installed`);
      else console.log(`✅ ${label}`);
    } catch (err) {
      failures.push(label);
      console.error(`⚠️  ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  await runStep("service stopped", () => stopServiceIfInstalled());

  await runStep("proxy stopped", async () => {
    const pid = readPid();
    if (!pid) return false;
    await stopProxy(pid);
    removePid(pid);
    removeRuntimePort(pid);
    return true;
  });

  await runStep("service removed", () => uninstallServiceIfInstalled());

  if (process.platform === "win32") {
    await runStep("Windows tray removed", async () => {
      const { getWindowsTrayStatus, uninstallWindowsTray } = await import("../tray/windows");
      const tray = getWindowsTrayStatus();
      if (!tray.installed && !tray.stale && !tray.running) return false;
      uninstallWindowsTray();
    });
  }

  await runStep("native Codex restored", async () => {
    const r = await restoreNativeCodexAsync();
    if (!r.success) throw new Error(r.message);
  });

  await runStep("Grok Build config restored", () => {
    const r = stripGrokConfig();
    if (!r.ok) throw new Error(r.message);
    return r.changed;
  });

  await runStep("system env vars reverted", () => {
    const r = revertSystemEnv();
    if (!r.reverted && r.reason !== "no tracking file" && r.reason !== "not macOS") throw new Error(r.reason ?? "revert failed");
  });

  await runStep("shell hook removed", () => {
    const r = uninstallShellHook();
    if (!r.removed && r.reason !== "not installed" && r.reason !== "not macOS") throw new Error(r.reason ?? "remove failed");
  });

  try {
    const { uninstallCodexShim } = await import("../codex/shim");
    const r = uninstallCodexShim();
    console.log(r.removed ? "✅ Codex autostart shim removed" : "- Codex autostart shim removed: not installed");
  } catch (err) {
    failures.push("Codex autostart shim removed");
    console.error(`⚠️  Codex autostart shim removed failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (failures.length === 0) {
    await runStep("opencodex config removed", () => {
      const result = removeOwnedConfigState(getConfigDir());
      if (result.status === "absent") return false;
      if (result.status === "removed") return true;
      const residual = result.residualPaths.length > 0
        ? ` Residual path(s): ${result.residualPaths.join(", ")}`
        : "";
      throw new Error(`${result.status} uninstall: ${result.reason ?? "config state was not removed"}.${residual}`);
    });
  } else {
    console.error("Leaving opencodex config/backups in place so the failed restore step can be retried.");
  }

  if (failures.length > 0) {
    console.error(`\nUninstall finished with ${failures.length} failed step(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✅ opencodex local state removed. Remove the package with: npm uninstall -g @bitkyc08/opencodex");
}

async function handleStatus() {
  const statusArgs = args.slice(1);
  const wantsJson = statusArgs.length === 1 && statusArgs[0] === "--json";
  if (statusArgs.length > 1 || (statusArgs.length === 1 && !wantsJson)) {
    console.error("Usage: ocx status [--json]");
    process.exit(1);
  }

  const status = await collectStatus();
  if (wantsJson) {
    console.log(JSON.stringify(status.json, null, 2));
    return;
  }

  if (status.json.proxy.pid || status.json.proxy.health.ok) {
    console.log(`✅ Proxy: ${status.proxyLabel}`);
  } else {
    console.log(`❌ Proxy: ${status.proxyLabel}`);
  }
  console.log(`   Health: ${status.healthLabel}`);
  if (!(status.json.proxy.pid || status.json.proxy.health.ok)) {
    console.log("   ↳ Not running — Codex/Claude requests will fail with connection errors.");
    // The service summary a few lines below already tells a registered-but-not-serving
    // user to repair. Printing "install the persistent service" unconditionally
    // contradicted it in the same report, and install re-registers: UAC on Windows and a
    // possible WinSW-to-scheduler switch for someone who already has a service.
    const installed = status.json.startup.serviceInstalled && !status.json.startup.serviceConflict;
    console.log(installed
      ? "     Restart with 'ocx start', or refresh the installed service: 'ocx service repair'."
      : "     Restart with 'ocx start', or install the persistent service: 'ocx service install'.");
  }
  console.log(`   Dashboard: ${status.json.dashboard.url}`);
  console.log(`   Config: ${status.json.paths.config}`);
  console.log(`   PID file: ${status.json.paths.pid}`);
  console.log(`   Runtime: ${status.json.paths.runtime}`);
  console.log(`   Runtime source: ${status.json.runtime.source}${status.json.runtime.overrideEnv ? ` (${status.json.runtime.overrideEnv})` : ""}`);
  console.log(`   Default provider: ${status.json.defaultProvider}`);
  console.log(`   Codex autostart: ${status.json.codexAutostart ? "enabled" : "disabled"}`);
  console.log(`   Restart safety: ${startupHealthSummary(status.json.startup)}`);
  console.log(`   Service: ${status.json.service.summary}`);
  console.log(`   ${status.json.codexShim.summary}`);
  console.log(`   Codex runtime: ${status.json.codexRuntime.path}`);
  console.log(`   Codex version: ${status.json.codexRuntime.version ?? "unknown"}`);
  console.log(`   Codex source: ${status.json.codexRuntime.source}`);
  console.log(`   Codex home: ${status.json.codexHome.effectiveCodexHome}`);
  if (status.json.codexHome.warning) {
    console.log(`   ⚠️  ${status.json.codexHome.warning}`);
    console.log(`      Action: ${status.json.codexHome.action}`);
  }
  console.log(`   Catalog clamp: ${status.json.codexRuntime.catalogClamp.active ? "active" : "inactive"}`);
  if (status.json.codexRuntime.catalogClamp.removedEfforts.length > 0) {
    console.log(`   Removed efforts: ${status.json.codexRuntime.catalogClamp.removedEfforts.join(", ")}`);
  }
  if (status.json.codexRuntime.warning) {
    console.log(`   ⚠️  ${status.json.codexRuntime.warning}`);
  }
  if (status.json.codexPlugins.applicable) {
    const icon = status.json.codexPlugins.stale ? "⚠️ " : "✅";
    console.log(`   ${icon} Codex bundled plugins: ${status.json.codexPlugins.summary}`);
    if (status.json.codexPlugins.suggestedRepair) {
      console.log(`      Suggested: ${status.json.codexPlugins.suggestedRepair}`);
    }
  }
  const { collectOAuthHealthEntriesForCli, oauthLoginSummary } = await import("../oauth");
  const { formatOAuthHealthForStatus } = await import("./status-oauth");
  console.log(`   OAuth logins:`);
  for (const e of oauthLoginSummary()) {
    console.log(`     ${e.provider.padEnd(10)} ${e.loggedIn ? `✓ logged in${e.email ? ` (${e.email})` : ""}` : "✗ not logged in"}`);
  }
  const oauthHealthBlock = formatOAuthHealthForStatus(await collectOAuthHealthEntriesForCli());
  if (oauthHealthBlock) {
    for (const line of oauthHealthBlock.split("\n")) {
      console.log(`   ${line}`);
    }
  }
}

async function handleRecoverHistory() {
  if (args[1] !== "--legacy-openai") {
    console.error("Usage: ocx recover-history --legacy-openai");
    console.error("Only use this if an older syncResumeHistory build already remapped OpenAI Codex App history to opencodex before backup support existed.");
    process.exit(1);
  }
  // Manifest-independent legacy ejection, serialized like every other history
  // mutation. It is a separate operation from generic restore precisely because
  // it must not read, consume or replace the backup manifest.
  const outcome = await runCodexHistoryJob({
    ...resolveCodexHistoryJobTarget(),
    operation: "recover-legacy-openai",
  });
  const r = outcome.kind === "converged"
    ? { rows: outcome.rows, files: outcome.files, failed: undefined }
    : { rows: 0, files: 0, failed: true as const };
  if (r.failed) {
    console.error(
      "⚠️  Recovery SKIPPED: the Codex history DB is locked (Codex app/IDE open?). Close it and rerun this command.",
    );
    process.exit(1);
  }
  console.log(`Recovered ${r.rows} legacy thread(s) to openai (${r.files} rollout file(s) updated).`);
}

/**
 * `ocx ready` — arguments are pre-parsed above (before
 * maybeAutoRestoreCodexShim) so invalid usage exits 64 before any global
 * preflight. This handler only runs the dependency-injected runner in ./ready
 * and exits with the returned code; it performs no parsing and no I/O of its
 * own. The full behavior is unit-testable without spawning a subprocess.
 */
async function handleReady(args: ReadyArgs): Promise<never> {
  process.exit(await runReady(args));
}

switch (command) {
  case "init":
  case "setup": {
    const { runInit } = await import("./init");
    await runInit();
    break;
  }
  case "start":
    await handleStart();
    break;
  case "stop": {
    // Downtime warning lives HERE, not in handleStop: `restart`/tray-restart callers
    // re-start the proxy immediately, so warning there would contradict the next line.
    if (await handleStop()) {
      console.log("⚠️  Codex/Claude requests through the proxy will fail until it is restarted ('ocx start' or 'ocx service start').");
    }
    break;
  }
  case "restore":
  case "eject": {
    const restoreJson = args[1] === "--json";
    if (args[1] === "back") {
      // Reverse switch: re-point plain `codex` at the RUNNING proxy without touching its
      // lifecycle — the counterpart of `ocx restore`. Start/stop triggers are unchanged;
      // this only re-runs the same inject (config + catalog + history) `ocx start` does.
      const live = await findLiveProxy();
      if (!live) {
        console.error("No running proxy found. Run 'ocx start' — it injects opencodex automatically.");
        process.exit(1);
      }
      const desired = setIntegrationEnabled("codex", true);
      if (!desired.ok) {
        process.exitCode = desired.reason === "conflict" ? 2 : 1;
        console.error(`Codex desired state was not saved (${desired.reason}).`);
        break;
      }
      const synced = await syncModelsToCodex(live.port);
      if (synced.status === "skipped") {
        process.exitCode = 2;
        console.error("Codex integration is OFF; restore back did not change Codex. Retry after the competing integration change finishes.");
        break;
      }
      if (!synced.ok) {
        process.exitCode = 1;
        console.error("Plain `codex` was not switched back to opencodex. Fix the reported Codex config issue and retry.");
        break;
      }
      const target = collectOrcaCodexHomeDiagnostic();
      console.log(`Plain \`codex\` now routes through opencodex in ${target.effectiveCodexHome} (undo with: ocx restore).`);
      break;
    }
    const desired = setIntegrationEnabled("codex", false);
    if (!desired.ok) {
      process.exitCode = desired.reason === "conflict" ? 2 : 1;
      if (restoreJson) {
        // Machine-readable contract: every restore --json outcome emits one
        // schema-complete envelope on stdout, including pre-machinery failures.
        const { skippedRestoreEnvelope } = await import("../codex/inject");
        console.log(JSON.stringify(skippedRestoreEnvelope(false, `Codex desired state was not saved (${desired.reason}).`)));
      } else {
        console.error(`Codex desired state was not saved (${desired.reason}).`);
      }
      break;
    }
    // A repeated OFF on an already-clean home is a policy no-op. Do not enter
    // restore's native-profile machinery merely to prove there is nothing to
    // restore: those locks live in CODEX_HOME and a skip must create nothing.
    if (desired.status === "unchanged") {
      const { classifyNativeRoutedResidue } = await import("../codex/native-residue");
      if (classifyNativeRoutedResidue().kind === "clean") {
        const alreadyOff = "Codex integration is already OFF and native; no Codex files changed.";
        if (restoreJson) {
          const { skippedRestoreEnvelope } = await import("../codex/inject");
          console.log(JSON.stringify(skippedRestoreEnvelope(true, alreadyOff)));
        } else {
          console.log(alreadyOff);
        }
        break;
      }
    }
    let r: { success: boolean; message: string };
    try {
      r = await restoreNativeCodexAsync({ revalidateDesiredState: true });
    } catch (err) {
      r = { success: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (restoreJson) {
      // Spawned callers need the artifact-level result to distinguish a busy
      // history worker from a successful native restore. Keep stdout machine
      // readable; human framing remains the default command contract.
      console.log(JSON.stringify(r));
      if (!r.success) process.exitCode = 1;
      break;
    }
    if (r.success) console.log(`✅ ${r.message}`);
    else {
      console.error(`⚠️  ${r.message}`);
      process.exitCode = 1;
    }
    try {
      const g = stripGrokConfig();
      if (g.changed) console.log(`✅ ${g.message}`);
      else if (!g.ok) {
        console.error(`⚠️  ${g.message}`);
        process.exitCode = 1;
      }
    } catch { /* best-effort */ }
    if (r.success) {
      console.log("Codex integration is OFF and plain `codex` now runs natively. Switch back with: ocx restore back");
    } else {
      console.error("Plain `codex` was not fully restored. Inspect $CODEX_HOME/config.toml before using native Codex.");
    }
    break;
  }
  case "recover-history":
    await handleRecoverHistory();
    break;
  case "uninstall":
  case "remove":
    await handleUninstall();
    break;
  case "status":
    await handleStatus();
    break;
  case "doctor": {
    const { runDoctor } = await import("./doctor");
    await runDoctor(args.slice(1));
    break;
  }
  case "debug": {
    const { handleDebugCommand } = await import("./debug");
    await handleDebugCommand(args.slice(1));
    break;
  }
  case "ensure":
    await handleEnsure();
    break;
  case "login": {
    const { handleLogin } = await import("../oauth/login-cli");
    await handleLogin(args[1]);
    break;
  }
  case "logout": {
    const { removeCredential } = await import("../oauth/store");
    const name = (args[1] ?? "").trim().toLowerCase();
    await removeCredential(name);
    console.log(`Logged out of ${name || "(none)"}.`);
    break;
  }
  case "sync": {
    const restartCodex = args.slice(1).includes("--restart-codex");
    const synced = await syncModelsToCodex((await findLiveProxy())?.port);
    if (synced.status === "skipped") {
      console.log("Codex integration is OFF; sync skipped and no Codex files changed.");
    } else if (!synced.ok) {
      process.exitCode = 1;
      console.error("Codex sync did not complete. Fix the reported Codex config issue and retry.");
    }
    // Only warn/restart when a catalog or models_cache write actually happened. This is
    // deliberately not an `else`: refreshCodexModelCatalog runs before injectCodexConfig,
    // so a sync can fail (`ok: false`) after the catalog was already rewritten — which is
    // exactly when a long-lived app-server is holding the stale list.
    if (synced.catalogWritten || synced.cacheSynced) {
      const { afterCatalogWriteHandleAppServers } = await import("../codex/app-server-processes");
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
    }
    break;
  }
  case "v2": {
    const { cmdV2 } = await import("./v2");
    process.exitCode = await cmdV2(args.slice(1), {}, async () => (await findLiveProxy())?.port);
    break;
  }
  case "sync-cache": {
    const restartCodex = args.slice(1).includes("--restart-codex");
    if (!shouldSyncCodexOnStart(loadConfig())) {
      console.log("Codex integration is OFF; cache sync skipped and no Codex files changed.");
      break;
    }
    const { withCatalogWriteSerialization } = await import("../codex/catalog-write-serialization");
    const { invalidateCodexModelsCacheWithPermit } = await import("../codex/catalog/sync");
    const { getCodexHome } = await import("../codex/paths");
    const owningCodexHome = getCodexHome();
    const invalidated = withCatalogWriteSerialization(owningCodexHome, permit =>
      invalidateCodexModelsCacheWithPermit(permit, owningCodexHome));
    // Only warn/restart when models_cache was actually rewritten from a readable catalog.
    if (invalidated.kind === "completed" && invalidated.value) {
      const { afterCatalogWriteHandleAppServers } = await import("../codex/app-server-processes");
      afterCatalogWriteHandleAppServers({ restart: restartCodex, log: console });
    }
    break;
  }
  case "gui": {
    const cfg = await import("../config");
    const config = cfg.loadConfig();
    // Identity-checked liveness (not the pid file + a fixed sleep): finds a fallback-port
    // proxy and waits until the spawned one actually answers before opening the browser.
    let live = await findLiveProxy();
    if (!live) {
      console.log("Proxy not running. Starting...");
      const child = spawn(process.execPath, startArgv((config.port ?? 10100) > 0 ? (config.port ?? 10100) : undefined), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: withProcessRuntimeProvenance(process.env),
      });
      child.unref();
      live = await waitForProxy();
      if (!live) {
        console.error("❌ Proxy did not become healthy after starting. Not opening the GUI.");
        process.exit(1);
      }
    }
    // Open the host the proxy actually binds — `localhost` only answers for
    // loopback/wildcard binds, not a concrete LAN/IPv6 hostname.
    const guiHost = probeHostname(live?.hostname ?? config.hostname);
    const guiUrl = `http://${guiHost === "127.0.0.1" ? "localhost" : guiHost}:${live?.port ?? config.port}`;
    console.log(`Opening ${guiUrl}`);
    const { openUrl } = await import("../lib/open-url");
    openUrl(guiUrl);
    break;
  }
  case "service":
    await serviceCommand(...args.slice(1));
    break;
  case "tray": {
    const { windowsTrayCommand } = await import("../tray/windows");
    await windowsTrayCommand(args.slice(1));
    break;
  }
  case "codex-shim": {
    const { codexShimStatus, installCodexShim, uninstallCodexShim } = await import("../codex/shim");
    switch (args[1]) {
      case "install": {
        const r = installCodexShim();
        console.log(r.installed ? `✅ ${r.message}` : `⚠️  ${r.message}`);
        break;
      }
      case "status":
        console.log(codexShimStatus());
        break;
      case "uninstall":
      case "remove": {
        const r = uninstallCodexShim();
        console.log(r.removed ? `✅ ${r.message}` : `⚠️  ${r.message}`);
        break;
      }
      default:
        console.error("Usage: ocx codex-shim <install|status|uninstall|remove>");
        process.exit(1);
    }
    break;
  }
  case "update": {
    // `ocx update --help` must print usage and exit WITHOUT side effects — running the
    // real self-update stops the proxy and drops in-flight routed streams (issue #168).
    if (hasHelpFlag(args.slice(1))) {
      printSubcommandUsage("update");
      break;
    }
    const { runUpdate } = await import("../update");
    await runUpdate();
    break;
  }
  case "__refresh-version": {
    // Hidden, detached helper spawned by the update prompt to refresh the
    // cached latest version without blocking the foreground start. Not in help.
    const { refreshVersionCache } = await import("../update/notify");
    const channel = args[1] === "preview" ? "preview" : "latest";
    await refreshVersionCache(channel);
    break;
  }
  case "__tray-start":
  case "__tray-restart":
  case "__startup-health":
    await dispatchInternalCliCommand(command as InternalCliCommand, {
      trayStart: async () => { await handleTrayProxyStart(); },
      trayRestart: handleTrayProxyRestart,
      startupHealth: async () => {
        const { collectStartupHealth } = await import("../codex/autostart-health");
        console.log(JSON.stringify(collectStartupHealth(loadConfig())));
      },
    });
    break;
  case "__tray-host": {
    const { runWindowsTrayHost } = await import("../tray/windows");
    await runWindowsTrayHost();
    break;
  }
  case "__gui-update-worker": {
    const jobId = args[1];
    if (!jobId) process.exit(1);
    const channel = normalizeUpdateChannel(args[2]);
    await runGuiUpdateWorker(jobId, channel, args[3] === "restart");
    break;
  }
  case "restart": {
    // The running proxy owns its drain and replacement through /api/system/restart.
    // If nothing is live, restart degrades to the documented `ensure` start behavior.
    await handleProxyRestart(handleRestartStartWhenStopped);
    break;
  }
  case "health": {
    const healthArgs = args.slice(1);
    const wantsHealthJson = healthArgs.includes("--json");
    const live = await findLiveProxy();
    if (wantsHealthJson) {
      console.log(JSON.stringify({ ok: !!live, pid: live?.pid ?? null, port: live?.port ?? null }));
    } else {
      console.log(live ? `Proxy healthy (PID ${live.pid}, port ${live.port})` : "Proxy not healthy");
    }
    process.exit(live ? 0 : 1);
  }
  case "ready":
    // Fail-closed impossible-state guard: readyArgs is populated by the
    // preparse block before maybeAutoRestoreCodexShim, so reaching here
    // without it means dispatch diverged. Refuse with code 64 and perform
    // NO I/O (no discovery/probe). process.exit is `never`, narrowing below.
    if (!readyArgs) process.exit(64);
    await handleReady(readyArgs);
    break;
    case "provider": {
    const { handleProviderCommand } = await import("./provider");
    await handleProviderCommand(args.slice(1));
    break;
  }
  case "account": {
    const { cmdAccount } = await import("./account");
    process.exitCode = await cmdAccount(args.slice(1));
    break;
  }
  case "models":
  case "model": {
    const { handleModels } = await import("./models");
    await handleModels(args.slice(1));
    break;
  }
  case "combo": {
    const { handleComboCommand } = await import("./combo");
    process.exitCode = await handleComboCommand(args.slice(1));
    break;
  }
  case "route": {
    if (args[1] !== "combo" && args[1] !== "policy") {
      console.error("Usage: ocx route <combo|policy> <subcommand>");
      process.exitCode = 2;
      break;
    }
    if (args[1] === "combo") {
      const { handleComboCommand } = await import("./combo");
      process.exitCode = await handleComboCommand(args.slice(2));
    } else {
      const { handleRoutePolicyCommand } = await import("./route-policy");
      process.exitCode = await handleRoutePolicyCommand(args.slice(2));
    }
    break;
  }
  case "agent": {
    const { handleAgentCommand } = await import("./agent");
    process.exitCode = await handleAgentCommand(args.slice(1));
    break;
  }
  case "observe": {
    const { handleObserveCommand } = await import("./observe");
    process.exitCode = await handleObserveCommand(args.slice(1));
    break;
  }
  case "logs":
  case "usage":
  case "storage":
  case "memory": {
    const { handleObserveCommand } = await import("./observe");
    process.exitCode = await handleObserveCommand([command, ...args.slice(1)]);
    break;
  }
  case "access": {
    const { handleAccessCommand } = await import("./access");
    process.exitCode = await handleAccessCommand(args.slice(1));
    break;
  }
  case "api-key": {
    const { handleAccessCommand } = await import("./access");
    process.exitCode = await handleAccessCommand(["key", ...args.slice(1)]);
    break;
  }
  case "export": {
    const { handleExportCommand } = await import("./export-command");
    process.exitCode = await handleExportCommand(args.slice(1));
    break;
  }
  case "grok": {
    const { handleGrokCommand } = await import("./integrations");
    process.exitCode = await handleGrokCommand(args.slice(1));
    break;
  }
  case "integration": {
    const integration = args[1];
    if (integration === "grok") {
      const { handleGrokCommand } = await import("./integrations");
      process.exitCode = await handleGrokCommand(args.slice(2));
    } else if (integration === "claude") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      process.exitCode = await handleClaudeConfigCommand(args.slice(2));
    } else if (integration === "client") {
      const { handleClientIntegrationCommand } = await import("./integrations");
      process.exitCode = await handleClientIntegrationCommand(args.slice(2));
    } else {
      console.error("Usage: ocx integration <claude|grok|client> <subcommand>");
      process.exitCode = 2;
    }
    break;
  }
  case "system": {
    const { handleSystemCommand } = await import("./system-command");
    process.exitCode = await handleSystemCommand(args.slice(1));
    break;
  }
  case "config": {
    const { handleConfigCommand } = await import("./config-command");
    process.exitCode = await handleConfigCommand(args.slice(1));
    break;
  }
  case "claude": {
    const { cmdClaude } = await import("./claude");
    // "ocx claude desktop" → write Desktop 3P config
    if (args[1] === "desktop") {
      const { handleClaudeDesktopCommand } = await import("./claude-desktop");
      const exitCode = await handleClaudeDesktopCommand(args.slice(2));
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
    if (args[1] === "config") {
      const { handleClaudeConfigCommand } = await import("./integrations");
      process.exitCode = await handleClaudeConfigCommand(args.slice(2));
      break;
    }
    process.exit(await cmdClaude(args.slice(1)));
  }
  case "opencode": {
    const { cmdOpencode } = await import("./opencode");
    process.exit(await cmdOpencode(args.slice(1)));
  }
    case "help":
  case "--help":
  case "-h":
  case undefined:
    printUsage();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}
