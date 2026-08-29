#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { currentExternalCodexModelProvider, restoreNativeCodex, restoreNativeCodexAsync, shouldInjectApiAuthHeader } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import {
  describeHistoryJobFailure,
  resolveCodexHistoryJobTarget,
  runCodexHistoryJob,
} from "../codex/history-job";
import { reconcileJournal } from "../codex/journal";
import {
  codexAutoStartEnabled,
  getConfigDir,
  loadConfig,
  saveConfig,
} from "../config";
import {
  readPid,
  readPidFileValue,
  readRuntimePort,
  removePid,
  removePidIfValueIs,
  removeRuntimePort,
  removeRuntimePortIfPidIs,
  writePid,
  writeRuntimePort,
} from "../config/process-state";
import { collectStatus, unusedProxyWarningLines } from "./status";
import { takeFlag } from "./runtime-api";

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
import { dispatchCommand } from "./dispatch";
import { findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { createReadinessGate } from "../server/readiness";
import { runReady, type ReadyArgs } from "./ready";
import { runCli } from "./root";
import { ProxyOwnershipRefusedError, stopProxy } from "../lib/process-control";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { assertNotAdminToken, diagnoseService, isServiceOwnershipError, serviceCommand, serviceEnvironmentOwnedHere, serviceStartableFromTray, serviceStatusSummary, stopServiceIfInstalled, uninstallServiceIfInstalled } from "../service";
import { formatStartupRoutingDetail, startupHealthSummary } from "../codex/autostart-health";
import { drainAndShutdown, isRecyclingForExit, startServer } from "../server";
import { injectSystemEnv, reconcileShellHook, revertSystemEnv, uninstallShellHook } from "../server/system-env";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { startTokenGuardian } from "../oauth/token-guardian";
import { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
import { maybeShowStarPrompt } from "./star-prompt";
import { scheduleCatalogPrewarm } from "./catalog-prewarm";
import { maybeShowUpdatePrompt } from "../update/notify";
import { syncModelsToCodex } from "../codex/sync";
import {
  shouldSyncGrokOnStart,
  syncCodexOnStartIfEnabled,
} from "../codex/desired-state";
import {
  reconcileClientStartupBeforeReady,
  syncClaudeAgentDefsAtProxyStartup,
} from "./claude-agent-startup-sync";
import {
  grokSyncFailureMessage,
  reconcileEnsureDesiredIntegrations,
} from "./ensure-desired-integrations";

/**
 * A failed shell-hook reconcile is not cosmetic: a stale hook keeps sourcing
 * `claude-env.sh` from every new interactive shell, pointing at a proxy or a CLI that may no
 * longer exist. `reconcileShellHook` already reports `state: "failed"`, but both call sites
 * discarded it, so the one outcome the user has to act on was the one they never saw.
 */
function reportShellHookFailure(result: { state: "installed" | "absent" | "failed"; reason?: string }): void {
  if (result.state !== "failed") return;
  console.warn(`   Claude shell hook not reconciled${result.reason ? `: ${result.reason}` : ""}`);
  console.warn("   Check ~/.zshrc for the '# opencodex claude-env hook' block.");
}


import { removeOwnedConfigState } from "../lib/config-ownership";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { initializeNodeLauncherContext } from "./launcher-context";
import { createLocalAttestationSecret } from "../lib/local-management-attestation";
import { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../lib/system-restart-contract";

initializeNodeLauncherContext();

// Head: version/help early exits, `ready` pre-parse (exit 64 before any
// preflight), and the bounded Codex-shim auto-restore preflight live in
// src/cli/root.ts (Phase 1 of the CLI deepening). runCli exits for
// version/help and returns the dispatchable head otherwise; the switch below
// owns command dispatch.
const head = await runCli(process.argv.slice(2));
const args = head.args;
const command = head.command;

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

/** Argv for detached `start`, optionally hard-pinning the listen port. */
function startArgv(port?: number): string[] {
  const args = ["start"];
  if (typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535) {
    args.push("--port", String(Math.trunc(port)));
  }
  return selfLaunchArgv(args);
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

async function findProxyOwnerBeforeJournalRecovery(
  options: { probeConfiguredPort?: boolean } = {},
): Promise<{ live: LiveProxy | null; pidSnapshot: number | null }> {
  const pidSnapshot = readPidFileValue();
  const hasRuntimeOwner = readRuntimePort() !== null;
  const shouldProbe = pidSnapshot !== null || hasRuntimeOwner || options.probeConfiguredPort === true;
  const live = shouldProbe ? await findLiveProxy() : null;
  if (live) return { live, pidSnapshot };

  // The probe established that the snapshotted owner is stale. Compare before
  // deleting so a concurrent start that rewrote the PID file keeps its state.
  removePidIfValueIs(pidSnapshot);
  if (!currentExternalCodexModelProvider()) reconcileJournal();
  return { live: null, pidSnapshot };
}

async function handleStart(options: { block?: boolean } = {}) {
  // Native (WinSW) service mode has no batch wrapper to read the service token file
  // into the environment, so the app loads it here before the server binds. The server
  // auth path reads OPENCODEX_API_AUTH_TOKEN from the environment.
  const serviceToken = loadServiceTokenFromFile(process.env);
  if (serviceToken) process.env.OPENCODEX_API_AUTH_TOKEN = serviceToken;
  // The service wrapper (and WinSW via OCX_API_TOKEN_FILE) can still export a colliding
  // token that install now refuses to write. Refuse it here too, before bind, so an
  // already-broken file cannot fence /api/* closed at boot (#2696).
  const present = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (present) assertNotAdminToken(present);
  const requestedPort = parsePortOption();
  const owner = await findProxyOwnerBeforeJournalRecovery();
  if (owner.live) {
    // Service-wrapper context (opencodex-service.cmd `:loop`): a healthy proxy from
    // ANY source means the requested port is already served. Exit 0 so the wrapper's
    // `if %ERRORLEVEL% NEQ 0` retry loop terminates instead of respawning every 5s
    // against a listener it can never claim (observed as an endless
    // "Proxy already running" service.log loop).
    // Only the exact "1" sentinel takes this path — the same check syncCleanup
    // uses — so an env value like "0" or "false" cannot bypass the conflict error.
    if (process.env.OCX_SERVICE === "1") {
      console.log(`Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}); service wrapper staying out of the way.`);
      process.exit(0);
    }
    console.error(`⚠️  Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}). Use 'ocx stop' first.`);
    process.exit(1);
  }

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
  const systemEnv = await injectSystemEnv(port, config).catch(() => ({ injected: false }));
  // The hook is useful only for an installed Claude Code CLI. Reconcile instead of
  // appending unconditionally so stale OpenCodex-owned hooks are removed as well.
  reportShellHookFailure(reconcileShellHook(systemEnv.injected));
  await maybeShowStarPrompt(); // once-only Yes/No GitHub-star prompt on first interactive start
  // Codex sync owns the ready/failed verdict, but its successful transition is
  // deferred until the best-effort Claude roster reconciliation settles. This
  // keeps /readyz closed across both startup writes without making an optional
  // Claude integration failure prevent the proxy from starting.
  const startupSync = await reconcileClientStartupBeforeReady(
    readinessGate,
    gate => syncCodexOnStartIfEnabled(port, config, undefined, gate),
    () => systemEnv.injected
      ? Promise.resolve(null)
      : syncClaudeAgentDefsAtProxyStartup(config, port),
  );
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
  const owner = await findProxyOwnerBeforeJournalRecovery({ probeConfiguredPort: true });
  const config = loadConfig();
  if (!codexAutoStartEnabled(config)) {
    console.log("Codex autostart is disabled.");
    return false;
  }
  const live = owner.live;
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
      const systemEnv = await injectSystemEnv(live.port, config).catch(() => ({ injected: false }));
      reportShellHookFailure(reconcileShellHook(systemEnv.injected));
      if (!systemEnv.injected) await syncClaudeAgentDefsAtProxyStartup(config, live.port);
      // Refresh the Grok Build fence too (same contract as start). live.hostname is the
      // hostname the running proxy actually bound — config.hostname may have drifted.
      // The reconciler re-reads immediately before each client-file mutation; only
      // the live proxy's observed bind host is safe to carry across this boundary.
      await reconcileEnsureDesiredIntegrations(
        live.port,
        { kind: "live", hostname: live.hostname },
      );
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
  // Deterministic fence guarantee when the durable switch is ON: the spawned child
  // injects late in its own startup, but this parent returns as soon as /healthz
  // responds — align here too so `ocx ensure` never returns with a stale ON/OFF mismatch.
  // Persisted state is loaded inside each mutation after waitForProxy, so a
  // toggle while the child starts wins over the pre-spawn snapshot.
  await reconcileEnsureDesiredIntegrations(port, { kind: "spawned" });
  // Always sync the LIVE port: after a fallback-port start, config.port still names the
  // busy preferred port — syncing that would point Codex at a dead listener.
  const synced = await syncModelsToCodex(port).catch(e => {
    console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  });
  if (synced?.status === "skipped") console.log("   Codex integration OFF; startup left Codex native.");
  // The child opens /healthz before its best-effort roster reconcile. Await the same idempotent
  // operation in the parent so `ocx ensure` cannot report success while stale ocx-*.md files are
  // still observable. Always use the live port, including fallback-port starts.
  await syncClaudeAgentDefsAtProxyStartup(config, port);
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
      if (err instanceof ProxyOwnershipRefusedError) {
        ownershipBlocked = true;
        console.error("   Skipping shared teardown (native Codex restore, Grok config): the foreign proxy is still running.");
      }
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
        if (err instanceof ProxyOwnershipRefusedError) {
          ownershipBlocked = true;
          console.error("   Skipping shared teardown (native Codex restore, Grok config): the foreign proxy is still running.");
        }
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
  // Order-independent: the previous form only honoured `--json` as the LONE argument, so
  // `ocx status --json --anything` silently printed human output to a caller that asked
  // for JSON. Take the flag out of argv, then reject whatever is left over -- which keeps
  // the strict unknown-argument behaviour rather than trading one defect for another.
  const wantsJson = takeFlag(statusArgs, "--json");
  if (statusArgs.length > 0) {
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
  if (status.json.claudeDesktop.desiredEnabled && !status.json.claudeDesktop.policy.ok) {
    console.log(`   ⚠️  Claude Desktop 3P health: ${status.json.claudeDesktop.policy.status}`);
    console.log(`      ${status.json.claudeDesktop.policy.message}`);
    console.log(`      Action: ${status.json.claudeDesktop.policy.action}`);
  }
  // Printed here, not only in --json: a stale ocx on PATH is exactly the situation where
  // the operator is reading human output and wondering why the CLI disagrees with the
  // dashboard. Adding the JSON field alone would satisfy a test and help nobody (#2701).
  if (status.json.versionSkew.warning) {
    console.log(`   ⚠️  ${status.json.versionSkew.warning}`);
  }
  for (const line of unusedProxyWarningLines({
    proxyUp: Boolean(status.json.proxy.pid || status.json.proxy.health.ok),
    routingKind: status.json.startup.routingKind,
  })) {
    console.log(`   ${line}`);
  }
  if (!(status.json.proxy.pid || status.json.proxy.health.ok)) {
    console.log("   ↳ Not running — Codex/Claude requests will fail with connection errors.");
    // The service summary a few lines below already tells a registered-but-not-serving
    // user to repair. Printing "install the persistent service" unconditionally
    // contradicted it in the same report, and install re-registers: UAC on Windows and a
    // possible WinSW-to-scheduler switch for someone who already has a service.
    const installed = status.json.startup.serviceInstalled && !status.json.startup.serviceConflict;
    // #1419: the records outliving the process is the only evidence the user gets that a
    // previous run ended without cleanup. Deliberately hedged and cause-neutral — cleanup
    // ignores unlink failures and the records carry no session provenance, so this cannot
    // prove a crash, only that the last run left state behind. The restart advice below is
    // not repeated here; one recommendation per report.
    if (status.json.proxy.staleProcessState) {
      console.log("     Stale process records remain, so the previous run may have exited unexpectedly.");
      if (!installed) {
        console.log("     No background service was available to restart it.");
      }
    }
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
  console.log(`   ${formatStartupRoutingDetail(status.json.startup)}`);
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
    console.error("Usage: ocx recover-history --legacy-openai --yes");
    console.error("This force-relabels every user-message opencodex row to OpenAI, including legitimate dedicated-provider history. Back up first and use it only for pre-backup legacy recovery.");
    process.exit(1);
  }
  console.error("WARNING: this force-relabels every user-message opencodex row to OpenAI, normalizes exec to cli, and includes legitimate dedicated-provider history.");
  if (args.length !== 3 || args[2] !== "--yes") {
    console.error("Re-run with explicit confirmation: ocx recover-history --legacy-openai --yes");
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
      `⚠️  Recovery SKIPPED: ${describeHistoryJobFailure(outcome, "recover-legacy")}`,
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
async function handleReady(args: ReadyArgs): Promise<number> {
  return runReady(args);
}

process.exit(await dispatchCommand(head, {
  args,
  command,
  head,
  loadConfig,
  findLiveProxy,
  probeHostname,
  waitForProxy,
  startArgv,
  spawnDetached: argv => {
    const child = spawn(process.execPath, argv, {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: withProcessRuntimeProvenance(process.env),
    });
    child.unref();
  },
  handleStart,
  handleStop,
  handleEnsure,
  handleTrayProxyStart,
  handleTrayProxyRestart,
  handleRestartStartWhenStopped,
  handleProxyRestart,
  handleUninstall,
  handleStatus,
  handleRecoverHistory,
  handleReady,
  serviceCommand,
}));
