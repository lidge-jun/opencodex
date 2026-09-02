#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { currentExternalCodexModelProvider, restoreNativeCodex, restoreNativeCodexAsync, shouldInjectApiAuthHeader } from "../codex/inject";
import { stripGrokConfig } from "../grok/inject";
import { STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../update/stop-contract.mjs";
import {
  describeHistoryJobFailure,
  resolveCodexHistoryJobTarget,
  runCodexHistoryJob,
} from "../codex/history-job";
import { reconcileJournal } from "../codex/journal";
import { inspectClientRotationRecoveryGate, readClientConnectionState } from "../client/state";
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
import {
  claimPendingTeardown,
  clearPendingTeardown,
  isPendingTeardownAbandoned,
  listPendingTeardowns,
  pendingTeardownPathFor,
  quarantinePendingTeardown,
} from "../config/pending-teardown";
import { collectStatus, unusedProxyWarningLines } from "./status";
import { endpointsToProve, everyEndpointProvenDown, sharedTeardownAuthorized, type UninstallObservation } from "./uninstall-plan";
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
import { dispatchCommand , decideStartWithLiveOwner } from "./dispatch";
import { findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { createReadinessGate } from "../server/readiness";
import { runReady, type ReadyArgs } from "./ready";
import { runCli } from "./root";
import { isProcessAlive, ProxyOwnershipRefusedError, stopProxy } from "../lib/process-control";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { assertNotAdminToken, diagnoseService, isServiceOwnershipError, proxyStillLiveAfterStop, serviceCommand, serviceEnvironmentOwnedHere, serviceStartableFromTray, serviceStatusSummary, stopServiceIfInstalledDetailed, uninstallServiceIfInstalled, uninstallServiceDetailed } from "../service";
import { formatStartupRoutingDetail, startupHealthSummary } from "../codex/autostart-health";
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

async function chooseListenPort(
  requestedPort?: number,
  options: { sibling?: boolean } = {},
): Promise<number> {
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
    if (shouldPersistSelectedPort(config.port, selected, preferred, options)) {
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
  if (!currentExternalCodexModelProvider()) {
    const clientState = readClientConnectionState();
    reconcileJournal(clientState.kind === "connected"
      ? { activeClientApiKeyId: clientState.value.apiKeyId }
      : undefined);
  }
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
  // Always probe the configured port, even when both state files are absent. A
  // fallback-port sibling overwrites the pid/runtime records when it starts and
  // removes them on its own shutdown, so their absence proves nothing about the
  // configured port. Without the probe, `start` shadowed a healthy proxy with an
  // ephemeral-port copy and re-pointed client config at the copy; the next sibling
  // shutdown then left no runtime record for discovery at all. `handleEnsure`
  // already passes this; `handleStart` is the path that did not.
  const owner = await findProxyOwnerBeforeJournalRecovery({ probeConfiguredPort: true });
  let siblingStart = false;
  if (owner.live) {
    // Rationale and the full decision table live on `decideStartWithLiveOwner`.
    const decision = decideStartWithLiveOwner({
      livePort: owner.live.port,
      requestedPort,
      ocxService: process.env.OCX_SERVICE,
    });
    if (decision === "service-stay-out") {
      // Service-wrapper context (opencodex-service.cmd `:loop`): a healthy proxy from
      // ANY source means the requested port is already served. Exit 0 so the wrapper's
      // `if %ERRORLEVEL% NEQ 0` retry loop terminates instead of respawning every 5s
      // against a listener it can never claim (observed as an endless
      // "Proxy already running" service.log loop).
      console.log(`Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}); service wrapper staying out of the way.`);
      process.exit(0);
    }
    if (decision === "refuse") {
      console.error(`⚠️  Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}). Use 'ocx stop' first.`);
      process.exit(1);
    }
    // Sibling path. Honest about the side effects it shares with any start in this home:
    // the new instance takes over this home's ocx.pid / runtime-port.json while it runs,
    // and re-points this home's Codex config at the new port when injection applies.
    // What it must NOT do is persist its port into config.port: the configured-port
    // proxy is still the owner of this home, and a later `ocx service` reads config.port
    // to bake the service (observed: a probe on 10198 left the service pinned there).
    siblingStart = true;
    console.warn(
      `Proxy already running on port ${owner.live.port}; starting a second instance on requested port ${requestedPort}. `
      + `The new instance takes over this home's pid/runtime records and Codex config while it runs.`,
    );
  }

  const clientState = readClientConnectionState();
  if (clientState.kind === "invalid" || clientState.kind === "mismatched") {
    throw new Error(`client startup refused: ${clientState.reason}`);
  }
  const rotationGate = inspectClientRotationRecoveryGate(clientState);
  if (clientState.kind === "connected") {
    if (rotationGate.kind === "recovery-required" || rotationGate.kind === "unsafe") {
      throw new Error(`client startup refused: ${rotationGate.reason}`);
    }
    const { startClientRuntime } = await import("../client/runtime");
    await startClientRuntime({ port: requestedPort, block: options.block });
    return;
  }

  // Interactive-only update prompt. Must run BEFORE we bind a port / write a
  // PID: choosing "Update now" installs globally and exits, so we never want a
  // live daemon holding resources while it overwrites its own binary.
  await maybeShowUpdatePrompt();

  // Port selection is check-then-bind: a concurrent `ocx start`/`ensure` can win the port
  // between the probe and Bun.serve. Soft starts may re-pick; hard-pinned `--port` retries
  // the same port only (never hop — that was the remaining PR #152 gap).
  let port = await chooseListenPort(requestedPort, { sibling: siblingStart });
  const { drainAndShutdown, isRecyclingForExit, startServer } = await import("../server");
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
      port = await chooseListenPort(requestedPort, { sibling: siblingStart });
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
      let shutdownSucceeded = false;
      try {
        shutdownSucceeded = await drainAndShutdown(server, config.shutdownTimeoutMs ?? 5000);
      } finally {
        const restored = syncCleanup(); // idempotent (cleaned-guard); also re-run by process.on("exit")
        process.exit(restored && shutdownSucceeded ? 0 : 1);
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

/**
 * Restore shared client state after a stop.
 *
 * Returns the two failure kinds separately. `historyOnly` means teardown succeeded and
 * only Codex history metadata could not be finalized: the proxy is down, the service is
 * stopped, and a manifest is waiting for review. `other` means something that actually
 * removes state a client depends on.
 *
 * The distinction exists because `ocx update` must proceed for the first and abort for the
 * second, and it can only see an exit code (#3008).
 */
async function restoreSharedClientStateAfterStop(): Promise<{ historyOnly: boolean; other: boolean }> {
  let historyOnly = false;
  let other = false;
  try {
    const result = await restoreNativeCodexAsync();
    if (result.success) console.log(`↩️  ${result.message}`);
    else {
      // Codex history is the one restore whose failure leaves the runtime consistent: the
      // manifest is retained and the routed metadata is untouched. Config and catalog are
      // not — a client reads those, so their failure is a real teardown failure.
      const artifacts = result.artifacts;
      const configOrCatalogFailed = artifacts.config.state === "failed" || artifacts.catalog.state === "failed";
      if (!configOrCatalogFailed && artifacts.history.state === "failed") historyOnly = true;
      else other = true;
      console.error(`⚠️  ${result.message}`);
    }
  } catch (error) {
    other = true;
    console.error(`⚠️  Native Codex restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A refused or thrown Grok strip is actionable because it would point Grok at a dead proxy.
  try {
    const grok = stripGrokConfig();
    if (grok.changed) console.log(`↩️  ${grok.message}`);
    else if (!grok.ok) { other = true; console.error(`⚠️  ${grok.message}`); }
  } catch (error) {
    other = true;
    console.error(`⚠️  Grok config restore failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { historyOnly, other };
}

async function handleStop() {
  // The receipt must name the endpoint the owner was stopping — an obligation nobody can
  // locate cannot be proven discharged. Only the runtime record knows it; a proxy started
  // with an explicit --port is not on the configured one.
  const endpointOf = (runtime: { port: number; hostname?: string } | null): { hostname: string; port: number } | null =>
    runtime?.port ? { hostname: runtime.hostname ?? "127.0.0.1", port: runtime.port } : null;
  // Last-resort endpoint for a receipt: the address this home is configured to serve on,
  // which is what a later recovery probe would ask about anyway.
  const configuredEndpoint = (): { hostname: string; port: number } => {
    try {
      const config = loadConfig();
      return {
        hostname: config.hostname ?? "127.0.0.1",
        port: typeof config.port === "number" && config.port > 0 ? config.port : 10100,
      };
    } catch {
      return { hostname: "127.0.0.1", port: 10100 };
    }
  };
  // Only a definitive "nothing is answering" authorizes finishing somebody else's
  // abandoned teardown. The tri-state probe distinguishes that from "we could not tell"
  // (timeout, a listener that withholds /healthz), which `findLiveProxy` collapses into
  // the same null (#3008).
  const abandonedTeardownIsSafeToFinish = async (
    endpoint: { hostname: string; port: number } | null,
  ): Promise<boolean> => {
    // The endpoint has to come from the receipt. A crashed owner usually leaves no
    // runtime-port record, and the configured port is the wrong question for a proxy
    // started with an explicit --port: it refuses while the live one keeps serving.
    // An obligation that cannot name its endpoint cannot be proven discharged.
    if (!endpoint) return false;
    try {
      const { probeProxyLiveness } = await import("../update/proxy-liveness-probe.mjs");
      return probeProxyLiveness(endpoint.port, endpoint.hostname) === "dead";
    } catch {
      // A probe that could not run is not evidence of absence.
      return false;
    }
  };
  let stopFailed = false;
  let historyOnlyFailure = false;
  // Only Task Scheduler respawns after a successful stop (#764), so only it earns the
  // restart-window wait; launchd, systemd and WinSW are down when they say so.
  let schedulerCanRespawn = false;
  let stoppedService = false;
  let nativeRestoreHandledByProxy = false;
  // An ownership mismatch means the service manager was never even contacted: the installed
  // service is still live and will respawn the proxy. Tearing down SHARED state in that
  // situation (native Codex config, the Grok fence) removes config out from under a running
  // service — the exact failure this flag prevents. A plain stop failure is different: we
  // tried, so local teardown still proceeds.
  let ownershipBlocked = false;
  // Deferring shared teardown to this process is an obligation, so record it on disk
  // before asking for it (#3008). A parent that dies mid-stop would otherwise leave the
  // client config routed at a proxy that is already gone, with nothing to find later.
  //
  // `inheritedTeardowns` is the inverse case: PREVIOUS stops that left obligations
  // unfinished. Snapshot them BEFORE this run claims anything, so this run's own receipt
  // is never mistaken for one it inherited.
  const inheritedTeardowns = listPendingTeardowns()
    .filter(read => isPendingTeardownAbandoned(read, isProcessAlive));
  let teardownNonce: string | undefined;
  const claimTeardown = (endpoint: { hostname: string; port: number }, endpointSource: "exact" | "guessed") => {
    if (teardownNonce) return;
    try {
      teardownNonce = claimPendingTeardown(endpoint, endpointSource).nonce;
    } catch (err) {
      // Without a receipt the proxy performs its own teardown, which is the pre-#3008
      // behaviour: correct for every backend that cannot respawn, and merely early for
      // Task Scheduler. Losing the deferral is far better than losing the stop.
      console.warn(`⚠️  Could not record the deferred-teardown receipt: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  /**
   * One stop target, used for BOTH the receipt and the request.
   *
   * Deriving them separately meant the receipt could name a different endpoint than the
   * one actually contacted, and a proxy with no runtime record got no receipt at all —
   * silently reopening the parent-crash window on the path where the stop is a hard kill
   * and no child teardown runs at all.
   *
   * So the caller supplies whatever endpoint it already discovered: the orphan path knows
   * one from `findLiveProxy` even when the runtime record is gone.
   *
   * When nothing resolves, the graceful request cannot be made at all — `stopProxy` goes
   * straight to the kill ladder, no child teardown runs, and there is no receipt to leave
   * behind. A warning does not make that durable, so the receipt is claimed FIRST against
   * the endpoint this process would restore anyway. It is the configured listen address,
   * which is the same address every recovery probe would ask about, and an obligation
   * recorded against it is strictly better than none: at worst the probe cannot confirm
   * A guessed endpoint is NOT evidence, so the receipt records which kind it holds: a
   * guessed one fails closed into manual recovery rather than letting a later probe read
   * "the configured port refuses" as proof that the right proxy is down.
   */
  const stopWithDeferral = async (pid: number, discovered?: { hostname: string; port: number } | null): Promise<boolean> => {
    // Resolve ONCE. Reading the runtime record twice let the receipt name the configured
    // guess while the request went to a runtime endpoint that appeared in between.
    const exact = discovered ?? endpointOf(readRuntimePort(pid));
    claimTeardown(exact ?? configuredEndpoint(), exact ? "exact" : "guessed");
    const graceful = await stopProxy(pid, {
      deferSharedTeardownNonce: teardownNonce,
      // Only an exact endpoint may direct the request; the configured fallback is a guess
      // good enough to record an obligation against, not to POST a stop to.
      runtimeEndpoint: exact ?? undefined,
    });
    // A valid receipt means the proxy deferred shared teardown to this process. If the
    // receipt could not be written, the proxy restores it itself and the caller must not
    // attempt a second restore after a graceful stop. A hard-kill always leaves restore
    // to this process.
    return graceful && !teardownNonce;
  };
  try {
    const serviceStop = stopServiceIfInstalledDetailed();
    stoppedService = serviceStop === "stopped" || serviceStop === "stopped-respawnable";
    schedulerCanRespawn = serviceStop === "stopped-respawnable";
    // No "won't respawn" claim here: a stopped Task Scheduler can still respawn through
    // its wrapper, which the verification below is what actually settles.
    if (stoppedService) console.log("🛑 Service manager stopped.");
    if (serviceStop === "failed") {
      // A manager that would not stop can respawn the proxy. That is a real stop failure,
      // not a history-only one, and an update must not replace files over it (#3008).
      stopFailed = true;
      console.error("❌ The installed service manager did not stop; it may respawn the proxy.");
    }
    if (serviceStop === "state-unknown") {
      // Nothing refused to stop — the scheduler state could not be READ. Saying "did not
      // stop" sends the operator looking for the wrong problem, and `/api/stop` answers
      // the same case with service_state_unknown.
      stopFailed = true;
      console.error("❌ The Windows Task Scheduler state could not be read, so this stop cannot tell whether a wrapper would respawn the proxy.");
      console.error("   Run 'ocx service status' to see the query error, repair Task Scheduler access, then retry.");
    }
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
      // Shared teardown is deferred to this process: it happens after the respawn
      // verification below, so a survivor does not get its client config pulled first.
      // The receipt goes down first — the proxy honours the deferral only when it can
      // see one, so an unrecordable claim degrades to the child doing its own teardown.
      nativeRestoreHandledByProxy = await stopWithDeferral(pid);
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
        // The probe already found where it answers, and on this path the runtime record is
        // typically what went missing in the first place.
        nativeRestoreHandledByProxy = await stopWithDeferral(
          live.pid,
          { hostname: live.hostname ?? "127.0.0.1", port: live.port },
        );
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
    } else if (live) {
      // Identity-confirmed live, but no PID this process can kill: a legacy /healthz that
      // reports no pid, or a pid that failed verification. Treating that as "nothing is
      // running" purges the state records and then restores shared client config out from
      // under a proxy that is still serving — the exact failure the deferral exists to
      // prevent, arrived at from the other direction.
      stopFailed = true;
      ownershipBlocked = true;
      console.error(`❌ A proxy is answering on port ${live.port}, but no process id could be resolved for it, so it cannot be stopped from here.`);
      console.error("   Skipping shared teardown: restoring client config while it serves would leave both pointing at each other.");
      console.error("   Stop it from the home that started it, or end the process manually, then rerun 'ocx stop'.");
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
  // A stopped Windows scheduler is not a proven-down proxy. `killWindowsSchedulerWrappers`
  // is explicitly best-effort and the `:loop` wrapper respawns its child after ~5s, so an
  // immediate probe can see a dead interval and an update can start replacing files right
  // before the proxy comes back. Poll across the restart window before this stop is allowed
  // to report anything but failure (#3008) — and ONLY for that backend, since making every
  // launchd and systemd stop wait seven seconds would be a regression in ordinary use.
  if (schedulerCanRespawn && !ownershipBlocked) {
    const survivor = await proxyStillLiveAfterStop({ canRespawn: true });
    if (survivor) {
      stopFailed = true;
      console.error(`❌ A proxy is still listening on port ${survivor.port} after the service stop; it is being respawned.`);
      console.error("   Skipping shared teardown: restoring client config while the proxy runs leaves both pointing at each other.");
      ownershipBlocked = true;
    }
  }
  // Recovering somebody else's abandoned obligation is not the same act as finishing this
  // run's own. This run stopped a proxy and verified the result; the inherited case has no
  // such evidence, and `findLiveProxy` returning null covers a timeout and a malformed
  // answer as well as a genuinely dead port. Restoring client config under a proxy that is
  // merely unresponsive is exactly the failure the deferral exists to prevent.
  //
  // So an inherited obligation this run did not claim GATES the restore itself, rather
  // than only labelling it: without a definitive "dead" from the tri-state probe, the
  // restore does not run, the receipt stays for the next stop, and the stop fails. A
  // warning that lets the restore happen anyway is not a gate.
  //
  // An UNREADABLE obligation is a third case. It names no endpoint, so nothing can ever
  // prove its proxy down. It is NOT waved through: it fails this stop and is set aside
  // only afterwards, so the operator gets an explicit manual step instead of a silent
  // restore backed by no evidence. Setting it aside is still necessary — left in place it
  // makes both updater gates run a stop that fails on it every time, which is an update
  // that can never proceed.
  //
  // Inherited obligations are evaluated whether or not this run claimed its own. A stop
  // that finds a live proxy used to skip them entirely, so older abandoned receipts
  // accumulated forever while each run cleared only its own nonce.
  const recoveredNonces: string[] = [];
  const unreadable: { nonce: string }[] = [];
  let inheritedBlocks = false;
  if (inheritedTeardowns.length > 0 && !ownershipBlocked) {
    for (const read of inheritedTeardowns) {
      if (read.state === "unscannable") {
        // No file, no nonce: nothing to quarantine and nothing to remove. The home itself
        // may be hiding an obligation, so block and ask for the directory to be fixed.
        inheritedBlocks = true;
        stopFailed = true;
        console.error(`❌ ${read.detail}, so this stop cannot tell whether a shared teardown is still owed.`);
        console.error("   Skipping shared teardown. Fix access to the opencodex home, then rerun 'ocx stop'.");
        continue;
      }
      if (read.state === "invalid") {
        unreadable.push(read);
        inheritedBlocks = true;
        stopFailed = true;
        console.error(`❌ A pending-teardown receipt could not be read (${read.detail}).`);
        console.error("   It names no endpoint, so this stop cannot prove the proxy it belonged to is down.");
        console.error("   Confirm no proxy is running, then rerun 'ocx stop' to complete the teardown.");
        continue;
      }
      if (read.receipt.endpointSource === "guessed") {
        // The recorded address is the configured one, not the one that stop contacted. A
        // proxy on an explicit --port can be respawned there while this address refuses,
        // so "dead" here proves nothing and must not authorize a restore.
        inheritedBlocks = true;
        stopFailed = true;
        console.error("❌ A shared teardown from an earlier stop is outstanding, but that stop could not record the address it was stopping.");
        console.error(`   Only the configured address (${read.receipt.endpoint.hostname}:${read.receipt.endpoint.port}) was recorded, which cannot prove the right proxy is down.`);
        console.error(`   Confirm no proxy is running, then run 'ocx restore' and remove ${pendingTeardownPathFor(read.receipt.nonce)}.`);
        continue;
      }
      if (await abandonedTeardownIsSafeToFinish(read.receipt.endpoint)) {
        recoveredNonces.push(read.receipt.nonce);
        continue;
      }
      inheritedBlocks = true;
      stopFailed = true;
      console.error(`❌ A shared teardown from an earlier stop is still outstanding, and the proxy on ${read.receipt.endpoint.hostname}:${read.receipt.endpoint.port} could not be confirmed down.`);
      console.error("   Skipping shared teardown: restoring client config under a proxy that may still be running is what the deferral exists to prevent.");
      console.error("   The obligation is preserved; retry once the proxy is confirmed stopped.");
    }
  }
  const restoreBlocked = ownershipBlocked || inheritedBlocks || nativeRestoreHandledByProxy;
  if (!restoreBlocked) {
    if (recoveredNonces.length > 0) {
      // A previous deferred stop died before restoring, and the probe says its endpoint is
      // not answering. That is the whole point of leaving the receipt behind.
      console.log("↩️  Finishing a shared teardown left unfinished by an earlier stop.");
    }
    const restore = await restoreSharedClientStateAfterStop();
    if (restore.other) stopFailed = true;
    else if (restore.historyOnly) historyOnlyFailure = true;
    // The obligation is discharged whether or not history metadata finalized: config and
    // catalog are what a client reads, and `restore.other` already fails the stop.
    //
    // Each nonce names its own file, so a clear can only ever remove the obligation it
    // names — never one a concurrent stop wrote. Both this run's claim and every inherited
    // receipt it proved discharged are released together.
    if (!restore.other) {
      const discharged = teardownNonce ? [teardownNonce, ...recoveredNonces] : recoveredNonces;
      for (const nonce of discharged) {
        // A receipt that survives its discharge re-triggers recovery forever, so a failed
        // removal is surfaced rather than swallowed.
        if (!clearPendingTeardown(nonce)) {
          stopFailed = true;
          console.error(`❌ The shared teardown finished, but its receipt could not be removed: ${pendingTeardownPathFor(nonce)}`);
          console.error("   Remove it manually; otherwise every later stop and update will try to recover it again.");
        }
      }
    }
  }
  // Set an unreadable receipt aside only AFTER the outcome is known. Renaming it earlier
  // would take it out of the recovery loop while the restore it stood for had not run.
  //
  // Setting aside is NOT discharging. The renamed file still counts as an outstanding
  // obligation (`isAnyTeardownObligationFileName`), so both updaters keep refusing to
  // install until an operator removes it — the rename only stops every later stop from
  // re-reading the same garbage. Skipped under `ownershipBlocked` because a foreign
  // service still owns this state and none of it is ours to move.
  if (unreadable.length > 0 && !ownershipBlocked) {
    for (const read of unreadable) {
      const moved = quarantinePendingTeardown(read.nonce);
      if (moved) {
        console.error(`⚠️  That unreadable receipt was set aside at ${moved}. It still blocks 'ocx update', and 'ocx stop' has NOT restored on its behalf.`);
        console.error("   To clear it: confirm no proxy is running, run 'ocx restore', then delete that file.");
      } else {
        console.error(`❌ It could not be set aside either: ${pendingTeardownPathFor(read.nonce)}. Remove it manually after running 'ocx restore'.`);
      }
    }
  }
  // Set the code rather than exiting inline: this function returns a value its dispatcher
  // reads, so exiting here would take that decision away from the caller.
  //
  // A history-only failure gets its own code so `ocx update` can tell "the proxy is down
  // and a manifest needs review" from "the proxy would not stop" (#3008). Ordinary failure
  // still wins: it is the stronger signal.
  if (stopFailed) process.exitCode = 1;
  else if (historyOnlyFailure) process.exitCode = STOP_HISTORY_INCOMPLETE_EXIT_CODE;
  return !stopFailed;
}

async function handleUninstall() {
  /** Definitive "nothing is answering" on the endpoint this home would serve. */
  const proxyEndpointProvenDown = async (): Promise<boolean> => {
    try {
      const { probeProxyLiveness } = await import("../update/proxy-liveness-probe.mjs");
      // Every candidate, not just the preferred one: a stale runtime record pointing at a
      // closed port would otherwise "prove" a live proxy on the configured port is gone.
      const endpoints = endpointsToProve(readRuntimePort(), loadConfig());
      return everyEndpointProvenDown(endpoints, e => probeProxyLiveness(e.port, e.hostname));
    } catch {
      return false;
    }
  };
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

  // Consume the DETAILED outcome. The boolean helper returns false for "not installed",
  // "refused to stop" and "state could not be read" alike, so this step used to print
  // "not installed" for a manager that might still be running and then tear down shared
  // config underneath it (#3008).
  // The authorization rule lives in `uninstall-plan` so it can be exercised for every
  // failure permutation by calling it, rather than by reading this function's source.
  const observed: UninstallObservation = {
    serviceStop: null,
    proxyProvenDown: false,
    serviceRemoval: null,
    respawnWindowVerified: false,
  };
  await runStep("service stopped", () => {
    const outcome = stopServiceIfInstalledDetailed();
    observed.serviceStop = outcome;
    if (outcome === "absent") return false;
    if (outcome === "failed") {
      throw new Error("the installed service manager did not stop; it may respawn the proxy");
    }
    if (outcome === "state-unknown") {
      throw new Error("the Windows Task Scheduler state could not be read, so this uninstall cannot tell whether a manager is still running. Run 'ocx service status' to see the query error");
    }
    return true;
  });

  await runStep("proxy stopped", async () => {
    const pid = readPid();
    if (!pid) {
      // A missing pid file is not proof that nothing is serving: a proxy can outlive its
      // record (crash, manual delete, corrupt file), which is exactly why `ocx stop` falls
      // back to identity-checked discovery. Without this, uninstall restored shared config
      // and reported success while that proxy kept running (#3008).
      const live = await findLiveProxy();
      if (!live) {
        // A miss is not proof: `findLiveProxy` collapses a timeout and a transport failure
        // into the same null as a dead endpoint. Ask the tri-state probe, which only says
        // "dead" for a refused connection or a definitive non-OpenCodex answer (#3008).
        observed.proxyProvenDown = await proxyEndpointProvenDown();
        if (!observed.proxyProvenDown) {
          throw new Error("no proxy could be found, but its endpoint could not be confirmed down either; confirm nothing is serving, then rerun");
        }
        return false;
      }
      if (!live.pid) {
        throw new Error(`a proxy is answering on port ${live.port} but no process id could be resolved for it; stop it from the home that started it, then rerun`);
      }
      await stopProxy(live.pid);
      observed.proxyProvenDown = true;
      return true;
    }
    await stopProxy(pid);
    removePid(pid);
    removeRuntimePort(pid);
    observed.proxyProvenDown = true;
    return true;
  });

  await runStep("service removed", () => {
    const outcome = uninstallServiceDetailed();
    observed.serviceRemoval = outcome;
    // "absent" and "removed" are both fine; a failure is not, and it used to look like
    // absence on darwin and linux.
    if (outcome === "failed") throw new Error("the installed service could not be removed");
    return outcome === "removed";
  });

  // Only Task Scheduler can respawn through a surviving wrapper, and removing the
  // registration does not prove the running one died. Poll the same window `ocx stop` does
  // before shared config is allowed down (#764, #3008).
  if (observed.serviceStop === "stopped-respawnable") {
    await runStep("respawn window verified", async () => {
      const survivor = await proxyStillLiveAfterStop({ canRespawn: true });
      if (survivor) throw new Error(`a proxy is still listening on port ${survivor.port} after the service was removed; it is being respawned`);
      // A null from that poll is not proof either: its identity probe returns null on a
      // timeout, so a respawned-but-unresponsive proxy looks the same as none. Require the
      // tri-state probe to say dead on every candidate before calling the window verified.
      if (!await proxyEndpointProvenDown()) {
        throw new Error("no survivor answered after the service was removed, but the endpoint could not be confirmed down either; confirm nothing is serving, then rerun");
      }
      observed.respawnWindowVerified = true;
      return true;
    });
  }

  if (process.platform === "win32") {
    await runStep("Windows tray removed", async () => {
      const { getWindowsTrayStatus, uninstallWindowsTray } = await import("../tray/windows");
      const tray = getWindowsTrayStatus();
      if (!tray.installed && !tray.stale && !tray.running) return false;
      uninstallWindowsTray();
    });
  }

  // Shared client config comes down only once nothing that could still be serving is
  // unaccounted for. Restoring it under a live, still-managed proxy leaves both pointing
  // at each other — the same failure `ocx stop` refuses (#3008).
  if (sharedTeardownAuthorized(observed)) {
    await runStep("native Codex restored", async () => {
      const r = await restoreNativeCodexAsync();
      if (!r.success) throw new Error(r.message);
    });

    await runStep("Grok Build config restored", () => {
      const r = stripGrokConfig();
      if (!r.ok) throw new Error(r.message);
      return r.changed;
    });
  } else {
    failures.push("native Codex restored", "Grok Build config restored");
    console.error("⚠️  Skipping shared teardown (native Codex restore, Grok config): a service or proxy could not be proven stopped.");
    console.error("   Resolve the failures above and rerun 'ocx uninstall' — service removal and local state cleanup are also unfinished.");
    console.error("   'ocx restore' is an interim step if you need native routing back before then.");
  }

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
  console.log(`   Remote hub: ${status.json.connection.state}${status.json.connection.serverUrl ? ` (${status.json.connection.serverUrl})` : ""}`);
  if (status.json.connection.state === "invalid" || status.json.connection.state === "mismatched") {
    console.log(`   ⚠️  ${status.json.connection.reason}`);
  }
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
