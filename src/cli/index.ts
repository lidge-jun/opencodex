#!/usr/bin/env bun
import { serviceStayOutExitCode } from "../service/windows-wrapper-exit";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { findGuiDist } from "../server/gui-static";
import { inspectGuiBundleFreshness, staleGuiBundleLines } from "../server/gui-freshness";

// Best-effort recovery for runtime execution and spawned children if launched
// from an unlinked/deleted working directory (runs after hoisted ESM module imports).
try {
  process.cwd();
} catch {
  try {
    process.chdir(homedir());
  } catch {
    /* best-effort */
  }
}
import {
  currentExternalCodexModelProvider,
  restoreNativeCodex,
  restoreNativeCodexAsync,
  shouldInjectApiAuthHeader,
} from "../codex/inject";
// Straight from the owning modules rather than the facade: these are teardown-reporting
// helpers, not part of the injection surface, and `inject.ts` sits under a size cap that
// exists to stop it collecting exactly this kind of passthrough.
import { readOcxProviderTableBlock } from "../codex/inject/remove";
import {
  describeRetainedCodexProviderTable,
  type RetainedCodexProviderTable,
} from "../codex/inject/restore";
import { stripGrokConfig } from "../grok/inject";
import { STOP_HISTORY_DEFERRED_EXIT_CODE, STOP_HISTORY_INCOMPLETE_EXIT_CODE } from "../update/stop-contract.mjs";
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
  isLikelyOcxProcess,
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
  pendingTeardownsAreExactly,
  quarantinePendingTeardown,
} from "../config/pending-teardown";
import { collectStatus, deadProxyRoutingAdviceLines, detectMissingCodexCatalogPath, hubStatusLines, missingCodexCatalogLines, remoteHubBannerLine, remoteHubStatusLines, unusedProxyWarningLines } from "./status";
import { endpointsToProve, everyEndpointProvenDownAsync, sharedTeardownAuthorized, type UninstallObservation } from "./uninstall-plan";
import { takeFlag } from "./runtime-api";
import { parseStartOptions, StartArgsError } from "./start-args";

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
import { SpendLedgerOwnerError } from "../lib/spend-ledger-owner";
import { redactUrlForLog } from "../lib/redact";
import { dispatchCommand, decideBusyPreferredPort, decideStartExitTeardown, decideStartWithLiveOwner, startupLeftCodexNativeLine } from "./dispatch";
import { AuxiliaryListenerBindError, findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
import {
  findLiveProxy,
  proveLiveProxyOwnedByHome,
  probeEndpointLiveness,
  probeHostname,
  probePortOwner,
  START_OWNERSHIP_LIVENESS,
  type LiveProxy,
} from "../server/proxy-liveness";
import { createReadinessGate } from "../server/readiness";
import { isApiAuthRequired } from "../server/auth-cors";
import { runReady, type ReadyArgs } from "./ready";
import { runResolve, type ResolveArgs, type ResolveJson } from "./resolve";
import {
  approvalChanged,
  guardFinalStopSummary,
  managerStillActive,
  runApprovedStop,
  runGuardedManagerStep,
  settleApprovedTarget,
  type GuardedStopSnapshot,
  type StopApproval,
} from "./stop-approval";
import { inspectGuardedManagerTarget, observeGuardedManagerStopped } from "../service/guarded-manager-target";
import { summarizeStopRun, type StopOutcome, type StopRunRecord } from "./stop-report";
import { runCli } from "./root";
import { isProcessAlive, ProxyOwnershipRefusedError, refusalNextStep, stopProxy } from "../lib/process-control";
import { startupDataPlaneToken } from "../lib/service-secrets";
import { assertNotAdminToken, diagnoseService, isServiceOwnershipError, proxyStillLiveAfterStop, serviceCommand, serviceEnvironmentOwnedHere, serviceStartableFromTray, serviceStatePaths, serviceStatusSummary, stopServiceIfInstalledDetailed, uninstallServiceIfInstalled, uninstallServiceDetailed } from "../service";
import { acquireOwnershipMutationLease } from "../service/ownership-mutation-lease.mjs";
import { formatStartupRoutingDetail, startupHealthSummary } from "../codex/autostart-health";
import { injectSystemEnv, reconcileShellHook, revertSystemEnv, uninstallShellHook } from "../server/system-env";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { startTokenGuardian } from "../oauth/token-guardian";
import { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
import { maybeShowStarPrompt } from "./star-prompt";
import { scheduleCatalogPrewarm } from "./catalog-prewarm";
import { maybeShowUpdatePrompt } from "../update/notify";
import {
  bindAndPublishStartOwnership,
  StartOwnershipRollbackUncertainError,
} from "./start-ownership-publication";
import { syncModelsToCodex } from "../codex/sync";
import { localClientSkipReason, shouldSyncGrokOnStart, syncCodexOnStartIfEnabled } from "../codex/desired-state";
import { honorSiblingMarker, markSiblingStart, siblingOfLivePort, siblingRuntimeField, siblingStopFoundOwner, withoutSiblingMarker } from "../codex/sibling-start";
import { consumeSiblingHandoff } from "../codex/sibling-handoff";
import {
  reconcileClientStartupBeforeReady,
  syncClaudeAgentDefsAtProxyStartup,
} from "./claude-agent-startup-sync";
import {
  grokSyncFailureMessage,
  reconcileEnsureDesiredIntegrations,
} from "./ensure-desired-integrations";
import { refreshOwnedCatalogIntegrations } from "../integrations/catalog-refresh";
import { loadExportModels } from "../server/management/model-rows";

import { removeOwnedConfigAfterDesktopCleanup } from "./uninstall-client-state";
import { withProcessRuntimeProvenance } from "../lib/bun-runtime";
import { selfLaunchArgv } from "../lib/self-launch-argv";
import { initializeNodeLauncherContext } from "./launcher-context";
import { createLocalAttestationSecret } from "../lib/local-management-attestation";
import { MEMORY_DRAIN_RESTART_MS, REPLACEMENT_READY_TIMEOUT_MS } from "../lib/system-restart-contract";

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

function reportRetainedCodexProviderTable(retained: RetainedCodexProviderTable): void {
  console.log(`   ${describeRetainedCodexProviderTable(retained)}`);
  console.log("   Retained config lines:");
  for (const line of retained.lines) console.log(`      ${line}`);
}

async function refreshOwnedRaycastCatalog(
  config: ReturnType<typeof loadConfig>,
  port: number,
): Promise<void> {
  try {
    const outcomes = await refreshOwnedCatalogIntegrations({
      models: () => loadExportModels(config),
      config,
      port,
    }, ["raycast"]);
    for (const outcome of outcomes) {
      if (!outcome.ok) {
        console.error(`⚠️  Raycast integration was not refreshed: ${outcome.reason}`);
      }
    }
  } catch (error) {
    console.error(`⚠️  Raycast integration was not refreshed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

initializeNodeLauncherContext();

// The compiled executable is also the capture-only MCP server's launcher.
// Handle this private entrypoint before CLI preflight or command dispatch.
if (process.argv[2] === "__codebuddy-mcp") {
  const { runCodeBuddyMcpServer } = await import("../adapters/codebuddy/mcp-server");
  await runCodeBuddyMcpServer(process.argv[3] ?? "");
  // The MCP stdio loop owns this process until stdin closes; do not fall through
  // to ordinary CLI dispatch or exit after the handshake completes.
  await new Promise<never>(() => {});
}

// Head: version/help early exits, `ready` pre-parse (exit 64 before any
// preflight), and the bounded Codex-shim auto-restore preflight live in
// src/cli/root.ts (Phase 1 of the CLI deepening). runCli exits for
// version/help and returns the dispatchable head otherwise; the switch below
// owns command dispatch.
const head = await runCli(process.argv.slice(2));
const args = head.args;
const command = head.command;

function parseStartCliOptions(): ReturnType<typeof parseStartOptions> {
  try {
    return parseStartOptions(args.slice(1));
  } catch (error) {
    console.error(error instanceof StartArgsError ? error.message : String(error));
    process.exit(1);
  }
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

class StartCommandExit extends Error {
  constructor(readonly exitCode: number) {
    super(`start command exited with code ${exitCode}`);
    this.name = "StartCommandExit";
  }
}

async function chooseListenPort(
  requestedPort?: number,
  options: { sibling?: boolean } = {},
): Promise<number> {
  const config = loadConfig();
  const preferred = requestedPort ?? config.port ?? 10100;
  const hardPin = requestedPort !== undefined && requestedPort > 0;
  // Only an EXPLICITLY ported listener reserves a port. The companion form (`{enabled:true}`
  // with no port) deliberately shares the public port on 127.0.0.1, so treating it as a
  // reservation — via `effectiveLoopbackListenerPort` — would refuse every start on a
  // one-port hub and hop the public listener onto an ephemeral port (#4236).
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
    if (selected !== preferred) {
      // The hop used to be automatic, and that is how a bare `start` beside a healthy
      // proxy produced a second one (#5004): nothing on this path ever asked who held the
      // preferred port. Ask the holder itself — not this home's pid/runtime bookkeeping,
      // which is exactly what was wrong when the duplicate happened — and give the
      // question a budget that cannot mistake one lost probe for an empty port.
      const holder = preferred > 0 && !hardPin
        ? await probePortOwner(preferred, { hostname: config.hostname }, START_OWNERSHIP_LIVENESS)
        : null;
      const decision = decideBusyPreferredPort({
        preferredPort: preferred,
        selectedPort: selected,
        hardPin,
        holderIsOpencodex: holder !== null,
        ocxService: process.env.OCX_SERVICE,
      });
      if (decision === "service-stay-out") {
        // Signal intentional stay-out to wrappers that support the exit protocol.
        console.log(`Proxy already running (PID ${holder?.pid ?? "unknown"}, port ${preferred}); service wrapper staying out of the way.`);
        throw new StartCommandExit(serviceStayOutExitCode());
      }
      if (decision === "refuse-live-proxy") {
        console.error(`⚠️  Proxy already running (PID ${holder?.pid ?? "unknown"}, port ${preferred}). Use 'ocx stop' first.`);
        throw new StartCommandExit(1);
      }
      if (decision === "refuse-unidentified-holder") {
        console.error(`❌ Port ${preferred} is busy and its holder did not identify as opencodex.`);
        console.error("   Starting on another port would leave Codex pointed at a proxy you did not ask for.");
        console.error("   Stop whatever holds that port, or start on a free one with 'ocx start --port <port>'.");
        throw new StartCommandExit(1);
      }
      if (preferred > 0) {
        console.log(`⚠️  Port ${preferred} is busy; starting opencodex on ${selected}.`);
      }
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
      throw new StartCommandExit(1);
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
  // A negative answer here is acted on twice over: the caller walks past a proxy it was
  // supposed to find, and the lines below delete this home's pid record and reconcile the
  // journal. One 750ms probe is not enough evidence for either (#5004) — a transport
  // failure is indistinguishable from an empty port, and the reported Windows duplicate
  // came from exactly that answer on a proxy the previous command had just found healthy.
  const live = shouldProbe ? await findLiveProxy(START_OWNERSHIP_LIVENESS) : null;
  if (live) return { live, pidSnapshot };

  // The probe established that the snapshotted owner is stale. Compare before
  // deleting so a concurrent start that rewrote the PID file keeps its state.
  removePidIfValueIs(pidSnapshot);
  // A marked sibling's owner can be down mid-restart; its journal is still not ours to replay.
  if (!currentExternalCodexModelProvider() && siblingOfLivePort() === null) {
    const clientState = readClientConnectionState();
    reconcileJournal(clientState.kind === "connected"
      ? { activeClientApiKeyId: clientState.value.apiKeyId }
      : undefined);
  }
  return { live: null, pidSnapshot };
}

async function handleStart(options: { block?: boolean } = {}) {
  // Native (WinSW) service mode has no batch wrapper to read the service token file into
  // the environment, and a FOREGROUND `ocx start` has no wrapper at all — so the app loads
  // the token here, before the server binds, with the same precedence the launchd plist and
  // the systemd unit use when they cat the file into the environment. Without the second
  // source, `ocx start` refused to bind a non-loopback hostname (assertServerAuthConfig)
  // that the installed service on the same machine was serving happily (#4236). The server
  // auth path reads OPENCODEX_API_AUTH_TOKEN from the environment.
  const serviceToken = startupDataPlaneToken(process.env, {
    authRequired: isApiAuthRequired(loadConfig()),
  });
  if (serviceToken) process.env.OPENCODEX_API_AUTH_TOKEN = serviceToken;
  // The service wrapper (and WinSW via OCX_API_TOKEN_FILE) can still export a colliding
  // token that install now refuses to write. Refuse it here too, before bind, so an
  // already-broken file cannot fence /api/* closed at boot (#2696).
  const present = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (present) assertNotAdminToken(present);
  const startOpts = parseStartCliOptions();
  if (startOpts.socks5 !== undefined || startOpts.socks5Off) {
    const proxyConfig = loadConfig();
    if (startOpts.socks5Off) {
      if (proxyConfig.proxy && !/^socks5h?:\/\//i.test(proxyConfig.proxy.trim())) {
        console.error("Cannot use --socks5-off: config.proxy is not a SOCKS5 URL; it was left unchanged.");
        process.exit(1);
      }
      if (proxyConfig.proxy) {
        delete proxyConfig.proxy;
        saveConfig(proxyConfig);
        console.log("Cleared config.proxy (outbound SOCKS5 proxy off).");
      }
    } else {
      proxyConfig.proxy = startOpts.socks5!;
      saveConfig(proxyConfig);
      console.log(`Outbound SOCKS5: ${redactUrlForLog(startOpts.socks5!)} (saved to config.proxy)`);
    }
  }
  const requestedPort = startOpts.port;
  // Always probe the configured port, even when both state files are absent. A
  // fallback-port sibling overwrites the pid/runtime records when it starts and
  // removes them on its own shutdown, so their absence proves nothing about the
  // configured port. Without the probe, `start` shadowed a healthy proxy with an
  // ephemeral-port copy and re-pointed client config at the copy; the next sibling
  // shutdown then left no runtime record for discovery at all. `handleEnsure`
  // already passes this; `handleStart` also consumes a sibling replacement's handoff first.
  let siblingStart = honorSiblingMarker(process.env, consumeSiblingHandoff) !== null;
  const owner = await findProxyOwnerBeforeJournalRecovery({ probeConfiguredPort: true });
  if (owner.live) {
    // Rationale and the full decision table live on `decideStartWithLiveOwner`.
    const decision = decideStartWithLiveOwner({
      livePort: owner.live.port,
      requestedPort,
      ocxService: process.env.OCX_SERVICE,
    });
    if (decision === "service-stay-out") {
      // A live owner is an intentional stay-out, not an unexpected child exit.
      console.log(`Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}); service wrapper staying out of the way.`);
      process.exit(serviceStayOutExitCode());
    }
    if (decision === "refuse") {
      console.error(`⚠️  Proxy already running (PID ${owner.live.pid ?? owner.pidSnapshot ?? "unknown"}, port ${owner.live.port}). Use 'ocx stop' first.`);
      process.exit(1);
    }
    // Sibling path. The new instance takes over this home's ocx.pid / runtime-port.json while
    // it runs, and nothing else: Codex, Grok, Claude and the system env keep pointing at the
    // live proxy for this process's whole lifetime, its exit and `ocx stop` included, so the
    // mark goes down before any client write (`src/codex/sibling-start.ts`). Nor may it persist
    // its port into config.port: the configured-port proxy still owns this home, and a later
    // `ocx service` reads config.port to bake the service (a probe on 10198 pinned it there).
    siblingStart = true;
    markSiblingStart(owner.live.port);
    console.warn(
      `Proxy already running on port ${owner.live.port}; requested a second instance on port ${requestedPort}. `
      + `Startup continues only for an independent OPENCODEX_HOME; one state directory has one spend-ledger writer.`,
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
  // live daemon holding resources while it overwrites its own binary. Never from a
  // sibling: replacing the global package makes the live proxy drain and restart.
  if (!siblingStart) await maybeShowUpdatePrompt();

  type StartServerModule = typeof import("../server");
  type BoundStart = {
    server: ReturnType<StartServerModule["startServer"]>;
    serverModule: StartServerModule;
    port: number;
    readinessGate: ReturnType<typeof createReadinessGate>;
    localAttestationSecret: string;
    config: ReturnType<typeof loadConfig>;
  };
  let boundStart: BoundStart;
  try {
    boundStart = await bindAndPublishStartOwnership({
      acquireLease: () => acquireOwnershipMutationLease(serviceStatePaths()),
      bind: async () => {
        // The earlier probe owned journal cleanup. This one owns the bind decision: an
        // updater may have stopped the old runtime and acquired this lease for replacement.
        const fencedLive = await findLiveProxy(START_OWNERSHIP_LIVENESS);
        if (fencedLive) {
          const decision = decideStartWithLiveOwner({
            livePort: fencedLive.port,
            requestedPort,
            ocxService: process.env.OCX_SERVICE,
          });
          if (decision === "service-stay-out") {
            console.log(`Proxy already running (PID ${fencedLive.pid ?? "unknown"}, port ${fencedLive.port}); service wrapper staying out of the way.`);
            throw new StartCommandExit(serviceStayOutExitCode());
          }
          if (decision === "refuse") {
            console.error(`⚠️  Proxy appeared before bind (PID ${fencedLive.pid ?? "unknown"}, port ${fencedLive.port}). Use 'ocx stop' first.`);
            throw new StartCommandExit(1);
          }
          siblingStart = true;
          markSiblingStart(fencedLive.port);
        }

        // Port selection is check-then-bind. The lease prevents every cooperating start or
        // updater from turning that check into a different ownership decision.
        let port = await chooseListenPort(requestedPort, { sibling: siblingStart });
        const serverModule = await import("../server");
        const readinessGate = createReadinessGate();
        const localAttestationSecret = createLocalAttestationSecret();
        const config = loadConfig();
        await (await import("../plugins/loader")).loadAndReportOcxPlugins();
        let server: ReturnType<typeof serverModule.startServer>;
        for (let attempt = 0; ; attempt++) {
          try {
            server = serverModule.startServer(port, { localAttestationSecret, readinessGate });
            break;
          } catch (err) {
            try { await serverModule.waitForFailedStartRollback(err); }
            catch (rollbackError) {
              throw new StartOwnershipRollbackUncertainError([err, rollbackError]);
            }
            if (err instanceof SpendLedgerOwnerError) {
              console.error(`❌ ${err.message}`);
              throw new StartCommandExit(1);
            }
            if (err instanceof AuxiliaryListenerBindError || !isAddrInUse(err) || attempt >= 2) throw err;
            if (requestedPort !== undefined) {
              console.log(`⚠️  Port ${port} was taken while starting; waiting to retry the same port...`);
              const hostname = config.hostname ?? "127.0.0.1";
              const freed = await waitForPortAvailable(port, hostname, { timeoutMs: 3_000, intervalMs: 50 });
              if (!freed) {
                console.error(`❌ Port ${port} stayed busy; refusing to hop to an ephemeral port.`);
                throw new StartCommandExit(1);
              }
              continue;
            }
            console.log(`⚠️  Port ${port} was taken while starting; picking another...`);
            port = await chooseListenPort(requestedPort, { sibling: siblingStart });
          }
        }
        return { server, serverModule, port, readinessGate, localAttestationSecret, config };
      },
      writePid: () => writePid(process.pid),
      writeRuntime: bound => writeRuntimePort({
        pid: process.pid,
        port: bound.port,
        hostname: bound.config.hostname,
        attestationSecret: bound.localAttestationSecret,
        ...siblingRuntimeField(),
      }),
      stopBound: bound => bound.server.stop(true),
      removeRuntime: () => removeRuntimePortIfPidIs(process.pid),
      removePid: () => removePidIfValueIs(process.pid),
    });
  } catch (error) {
    if (error instanceof StartCommandExit) { process.exitCode = error.exitCode; return; }
    throw error;
  }

  const { server, serverModule, port, readinessGate, config } = boundStart;
  const { drainAndShutdown, isRecyclingForExit, noteExplicitShutdownRequested } = serverModule;
  // Records are visible now; background work may observe this runtime without a gap.
  scheduleCatalogPrewarm();
  installCrashGuards();
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
    // process expects Codex/Grok/env fences to still be in place. A sibling owns none of them.
    const teardown = decideStartExitTeardown({ sibling: siblingStart, recycling: isRecyclingForExit(), ocxService: process.env.OCX_SERVICE });
    if (teardown.revertSystemEnv) {
      try { revertSystemEnv(); } catch { /* best-effort */ }
    }
    removePid(process.pid);
    removeRuntimePort(process.pid);
    if (teardown.restoreNativeCodex && !currentExternalCodexModelProvider()) {
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
    if (teardown.stripGrokConfig && serviceEnvironmentOwnedHere()) {
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
    noteExplicitShutdownRequested(); // an automatic package restart must not hand off after this
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
  // appending unconditionally so stale OpenCodex-owned hooks are removed as well. A sibling
  // skips it: reconciling to "not injected" would uninstall the live owner's ~/.zshrc hook.
  if (!siblingStart) reportShellHookFailure(reconcileShellHook(systemEnv.injected));
  await maybeShowStarPrompt(); // once-only Yes/No GitHub-star prompt on first interactive start
  // Codex sync owns the ready/failed verdict, but its successful transition is
  // deferred until the best-effort Claude roster and Desktop registry settle. This
  // keeps /readyz closed across startup initialization without making an optional
  // Claude integration failure prevent the proxy from starting.
  const startupSync = await reconcileClientStartupBeforeReady(
    readinessGate,
    gate => syncCodexOnStartIfEnabled(port, config, undefined, gate),
    () => systemEnv.injected
      ? Promise.resolve(null)
      : syncClaudeAgentDefsAtProxyStartup(config, port),
    async () => {
      try {
        const { fetchAllModels } = await import("../server/management-api");
        const { desktopVisibleNativeSlugs } = await import("../codex/catalog");
        const { resolveAdmittedCodexModelEntitlements } = await import("../codex/model-entitlement-admission");
        const { buildDesktopDiscoveryInputs } = await import("../claude/desktop-discovery-inputs");
        const [models, modelEntitlements] = await Promise.all([
          fetchAllModels(config),
          resolveAdmittedCodexModelEntitlements(config, { clientVersion: null }),
        ]);
        const inputs = buildDesktopDiscoveryInputs({
          config, models, modelEntitlements,
          desktopNativeCandidates: desktopVisibleNativeSlugs(config),
        });
        buildDesktop3pRegistry(
          inputs.nativeSlugs, inputs.routedModels,
          config.claudeCode?.desktopProfile, inputs.nativeContextCap,
        );
      } catch {
        // Best-effort; model discovery can rebuild it. Never reflect credential or provider errors.
        console.warn("[opencodex] Claude Desktop model registry could not be initialized at startup.");
      }
    },
  );
  if (!startupSync.ran) console.log(startupLeftCodexNativeLine(localClientSkipReason(config), server.port ?? port));
  await refreshOwnedRaycastCatalog(config, port);
  // #1046: one warning per startup, after BOTH writes. The server's cache
  // invalidation happens first and the catalog sync second, so the mtime is only
  // final here — and neither write site warns on its own, or a boot that hits
  // both would warn twice.
  const { consumeStartupCacheInvalidationWrite } = await import("../server");
  if (consumeStartupCacheInvalidationWrite() || startupSync.catalogWritten || startupSync.cacheSynced) {
    const { warnIfStaleCodexAppServersAfterStartupWrite } = await import("../codex/app-server-processes");
    warnIfStaleCodexAppServersAfterStartupWrite({ log: console });
  }
  if (!siblingStart && !currentExternalCodexModelProvider() && !shouldInjectApiAuthHeader(config) && config.syncResumeHistory !== false) {
    historyGuardian = startHistoryMigrationGuardian();
  }
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
  const env: NodeJS.ProcessEnv = withoutSiblingMarker(process.env);
  // Only a real service wrapper may claim supervision. A detached ensure/tray child is an
  // ordinary owner, never a sibling: while live it maintains routing, and on exit restores it.
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
      if (synced?.status === "skipped") {
        console.log(startupLeftCodexNativeLine(synced.skippedReason ?? "desired_disabled"));
      }
      // Do not refresh Raycast from saved config here: live bind/admission and
      // secondary-listener settings may differ. Explicit sync or server startup
      // owns catalog refresh; ensure must not overwrite a working destination.
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
  if (synced?.status === "skipped") {
    console.log(startupLeftCodexNativeLine(synced.skippedReason ?? "desired_disabled"));
  }
  // The child performs Raycast refresh with its actual startup config. The
  // parent's pre-spawn snapshot is not authoritative for a client-file write.
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
    } else if (code === "restart_version_skew") {
      console.error("❌ The running proxy reports a different OpenCodex version than this CLI; restarting in place would respawn the old installation.");
      console.error("   Run `ocx stop` and then `ocx start` from this installation instead.");
    } else if (code === "restart_package_tree_unsettled") {
      console.error("❌ The proxy's package files are still being replaced; wait for the install to finish, then run `ocx restart` again.");
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
      findLive: () => findLiveProxy({ deadlineAt, attempts: 2, acceptPackageTreeFenced: true }),
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
 *
 * `historyDeferred` is the third kind (#4718). The Codex history preflight refuses BEFORE
 * the config half runs, so nothing was restored at all: config, catalog, history and
 * provenance are untouched and the client is still routed at the proxy that just stopped.
 * Like `historyOnly` the proxy is genuinely down, so an update may replace package files.
 * Unlike `historyOnly` the obligation was not performed, so the receipt must survive.
 */
async function restoreSharedClientStateAfterStop(): Promise<{ historyOnly: boolean; historyDeferred: boolean; other: boolean }> {
  let historyOnly = false;
  let historyDeferred = false;
  let other = false;
  try {
    const result = await restoreNativeCodexAsync();
    if (result.success) {
      console.log(`↩️  ${result.message}`);
      if (result.retainedCodexProviderTable) {
        reportRetainedCodexProviderTable(result.retainedCodexProviderTable);
      }
    }
    else {
      // Codex history is the one restore whose failure leaves the runtime consistent: the
      // manifest is retained and the routed metadata is untouched. Config and catalog are
      // not — a client reads those, so their failure is a real teardown failure.
      const artifacts = result.artifacts;
      const configOrCatalogFailed = artifacts.config.state === "failed" || artifacts.catalog.state === "failed";
      // A preflight refusal reports every artifact as `skipped` because none of them were
      // attempted. Reading the states alone cannot tell that apart from an ownership
      // refusal, so the structured reason carries it and the states are still required to
      // agree — a refusal that somehow reports a failed artifact is not this case.
      // A degraded restore has no refusal reason and reports config as partial, so it cannot
      // enter this branch: its config obligation was discharged and the stop receipt must be
      // released rather than preserved.
      const preflightRefused = result.historyPreflightRefusal !== undefined
        && artifacts.config.state === "skipped"
        && artifacts.catalog.state === "skipped"
        && artifacts.history.state === "skipped";
      if (preflightRefused) historyDeferred = true;
      else if (!configOrCatalogFailed && artifacts.history.state === "failed") historyOnly = true;
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
  return { historyOnly, historyDeferred, other };
}

async function handleStop(approval?: StopApproval) {
  const lease = acquireOwnershipMutationLease(serviceStatePaths());
  try {
    if (!approval) return await handleStopUnlocked();
    return await runApprovedStop(
      approval,
      async () => {
        const lines: string[] = [];
        const code = await runResolve({ json: true }, {
          stdout: { log: line => { lines.push(line); } },
          stderr: { error: () => {} },
        });
        if (code !== 0 || lines.length !== 1) return null;
        try { return JSON.parse(lines[0]!) as ResolveJson; }
        catch { return null; }
      },
      () => {
        const pid = readPid();
        const runtime = pid === null ? null : readRuntimePort(pid);
        return pid && runtime?.port ? {
          pid, port: runtime.port, hostname: runtime.hostname ?? "",
        } : null;
      },
      () => inspectGuardedManagerTarget(approval.pid, approval.port),
      snapshot => handleStopUnlocked(snapshot),
    );
  }
  finally { lease.release(); }
}

async function handleStopUnlocked(snapshot?: GuardedStopSnapshot) {
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
      return await probeEndpointLiveness(endpoint) === "dead";
    } catch {
      // A probe that could not run is not evidence of absence.
      return false;
    }
  };
  let stopFailed = false;
  let historyOnlyFailure = false;
  /**
   * Obligations this run deliberately kept because the Codex history preflight refused
   * before restoring anything (#4718). Non-null selects the deferred exit code.
   */
  let historyDeferredNonces: string[] | null = null;
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
  // A sibling instance's shared teardown is not this stop's to run: the client routing belongs
  // to the live proxy it ran beside (`src/codex/sibling-start.ts`). Read before any stop removes
  // the record; a record left behind by a hard-killed sibling still says so.
  const siblingOfPort = readRuntimePort()?.siblingOfPort;
  const stoppingSibling = siblingOfPort !== undefined;
  // Structured twin of the human lines below, for `ocx stop --json`: one document the
  // desktop shell can read across the process boundary (D4). Every field is assigned
  // where the corresponding boolean already flips — the summarizer never re-decides.
  const record: StopRunRecord = {
    service: "absent",
    proxy: "unknown",
    sharedTeardown: "skipped",
    inheritedTeardownBlocks: false,
    receiptClearFailed: false,
  };
  // Deferring shared teardown to this process is an obligation, so record it on disk
  // before asking for it (#3008). A parent that dies mid-stop would otherwise leave the
  // client config routed at a proxy that is already gone, with nothing to find later.
  //
  // `inheritedTeardowns` is the inverse case: PREVIOUS stops that left obligations
  // unfinished. Snapshot them BEFORE this run claims anything, so this run's own receipt
  // is never mistaken for one it inherited.
  //
  // Ownership is decided by IDENTITY, not by bare liveness. A receipt records a number, and
  // the OS reuses numbers: once the owner exits, an unrelated process can be handed its PID,
  // and `isProcessAlive` alone then answers "that stop is still running" for as long as the
  // new process lives. The receipt is filtered out, so no run ever recovers it, quarantines
  // it or even mentions it — while both updater gates keep seeing an outstanding obligation
  // and refuse. That is the permanent fail-closed reported in #4897: no proxy running, a
  // dead owner, and `ocx update` aborting on `teardown-outstanding` every time.
  //
  // Requiring the live PID to be an opencodex process is the narrowing that costs the safety
  // intent nothing: a stop that really is in flight is still left strictly alone, because its
  // process is one of ours. Recognizing the receipt as abandoned only admits it to the
  // recovery loop below, which still has to prove the recorded endpoint is down before
  // anything is restored.
  const teardownOwnerStillRunning = (ownerPid: number): boolean =>
    isProcessAlive(ownerPid) && isLikelyOcxProcess(ownerPid);
  const inheritedTeardowns = listPendingTeardowns()
    .filter(read => isPendingTeardownAbandoned(read, teardownOwnerStillRunning));
  let teardownNonce: string | undefined;
  const claimTeardown = (endpoint: { hostname: string; port: number }, endpointSource: "exact" | "guessed") => {
    if (teardownNonce || stoppingSibling) return;
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
   * So the caller supplies the endpoint it discovered after the orphan listener proves
   * possession of this home's runtime record, even when the pid file is gone.
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
  const approvedEndpoint = snapshot
    ? { hostname: probeHostname(snapshot.approval.hostname || undefined), port: snapshot.approval.port }
    : null;
  let guardedStep: Awaited<ReturnType<typeof runGuardedManagerStep>> | null = null;
  try {
    const serviceStop = snapshot
      ? (guardedStep = await runGuardedManagerStep(snapshot, {
          revalidateManager: () => inspectGuardedManagerTarget(snapshot.approval.pid, snapshot.approval.port),
          stopManager: () => {
            if (approvedEndpoint) claimTeardown(approvedEndpoint, "exact");
            return stopServiceIfInstalledDetailed();
          },
          signalApproved: () => stopWithDeferral(snapshot.approval.pid, approvedEndpoint),
          settle: () => settleApprovedTarget(snapshot.approval),
          managerState: () => observeGuardedManagerStopped(snapshot.manager),
        })).service
      // A sibling never runs under a service manager: an installed one belongs to the live owner,
      // and its ownership check would fail this stop and skip the stale-record purge below.
      : stoppingSibling ? "absent" : stopServiceIfInstalledDetailed();
    record.service = serviceStop;
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
    record.service = "error";
    if (isServiceOwnershipError(err)) {
      ownershipBlocked = true;
      stopFailed = true;
      console.error(`❌ ${err.message}`);
      console.error("   Skipping shared teardown (native Codex restore, Grok config): the installed service is still running.");
    } else {
      console.error(`⚠️  Service manager stop failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (snapshot) {
    if (guardedStep?.effect === "approval-changed") {
      return approvalChanged();
    }
    if (guardedStep?.effect === "manager-still-active") {
      return managerStillActive(record.service, record);
    }
    if (guardedStep?.effect === "stopped") {
      record.proxy = guardedStep.proxy;
      nativeRestoreHandledByProxy = guardedStep.handledByProxy;
      removePid(snapshot.approval.pid);
      removeRuntimePort(snapshot.approval.pid);
    } else {
      stopFailed = true;
      ownershipBlocked = true;
      record.proxy = "unknown";
      console.error("The approved runtime could not be verified after the guarded stop step.");
    }
  } else {
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
      record.proxy = "stopped";
    } catch (err) {
      stopFailed = true;
      record.proxy = err instanceof ProxyOwnershipRefusedError ? "ownership-refused" : "stop-failed";
      console.error(`❌ Failed to stop proxy (PID ${pid}).`);
      // stopProxy throws with the reason — an ownership refusal (409) carries the
      // remediation ("run the stop from that home"). Swallowing it leaves the operator
      // with a bare failure and a manual `kill` as the obvious next move, which is the
      // exact teardown the refusal exists to prevent.
      const detail = err instanceof Error ? err.message : String(err);
      if (detail) console.error(`   ${detail}`);
      if (err instanceof ProxyOwnershipRefusedError) {
        ownershipBlocked = true;
        // Every refusal `POST /api/stop` produces is written for an API client, so it
        // recommends `ocx stop` — the command printing it. Following that advice returns
        // the operator to this exact message, which is the loop #4169 was filed for. The
        // service manager was already asked to stop above, so name what is actually left.
        console.error(`   ${refusalNextStep(err.code)}`);
        console.error("   Skipping shared teardown (native Codex restore, Grok config): the refusing proxy is still running.");
      }
    }
  } else {
    // Snapshot stale state before probing; purge only exact values if another start races us.
    const stalePidValue = readPidFileValue();
    const staleRuntimePid = readRuntimePort()?.pid ?? null;
    // Orphan recovery: a live proxy can outlive its pid file (crash, manual delete,
    // corrupt file). Identity-checked liveness still finds it via the runtime record.
    const live = await findLiveProxy({ acceptPackageTreeFenced: true });
    if (siblingStopFoundOwner(siblingOfPort, live)) {
      record.proxy = "not-running";
      console.log(`The sibling instance is already gone; the proxy on port ${siblingOfPort} was left running.`);
    } else if (live?.pid && !(await proveLiveProxyOwnedByHome(live))) {
      stopFailed = true;
      ownershipBlocked = true;
      record.proxy = "ownership-refused";
      console.error(`❌ A proxy answers on port ${live.port}, but it has not proved it belongs to this home; refusing to stop it.`);
      console.error("   Skipping shared teardown (native Codex restore, Grok config) while that proxy is running.");
    } else if (live?.pid) {
      try {
        // The probe already found where it answers, and on this path the runtime record is
        // typically what went missing in the first place.
        nativeRestoreHandledByProxy = await stopWithDeferral(
          live.pid,
          { hostname: live.hostname ?? "127.0.0.1", port: live.port },
        );
        console.log(`✅ Proxy (PID ${live.pid}) stopped.`);
        record.proxy = "stopped-orphan";
      } catch (err) {
        stopFailed = true;
        record.proxy = err instanceof ProxyOwnershipRefusedError ? "ownership-refused" : "stop-failed";
        console.error(`❌ Failed to stop proxy (PID ${live.pid}).`);
        const detail = err instanceof Error ? err.message : String(err);
        if (detail) console.error(`   ${detail}`);
        if (err instanceof ProxyOwnershipRefusedError) {
          ownershipBlocked = true;
          // Same loop as the tracked-pid path above: the refusal recommends this command.
          console.error(`   ${refusalNextStep(err.code)}`);
          console.error("   Skipping shared teardown (native Codex restore, Grok config): the refusing proxy is still running.");
        }
      }
    } else if (live) {
      // Identity-confirmed live, but no PID this process can kill: a legacy /healthz that
      // reports no pid, or a pid that failed verification. Treating that as "nothing is
      // running" purges the state records and then restores shared client config out from
      // under a proxy that is still serving — the exact failure the deferral exists to
      // prevent, arrived at from the other direction.
      stopFailed = true;
      record.proxy = "unresolvable-pid";
      ownershipBlocked = true;
      console.error(`❌ A proxy is answering on port ${live.port}, but no process id could be resolved for it, so it cannot be stopped from here.`);
      console.error("   Skipping shared teardown: restoring client config while it serves would leave both pointing at each other.");
      console.error("   Stop it from the home that started it, or end the process manually, then rerun 'ocx stop'.");
    } else {
      record.proxy = "not-running";
      if (!stoppedService) console.log("No running proxy found.");
    }
    if (!stopFailed) {
      // `readPid() === null` means the snapshotted pid file was absent, invalid, dead, or
      // not ours — stale by definition. Purge (guarded by the snapshot) so `ocx update`'s
      // stop gate can't wedge on it.
      removePidIfValueIs(stalePidValue);
      removeRuntimePortIfPidIs(staleRuntimePid);
    }
  }
  }
  // Environment ownership is independent from service ownership. Roll back current-home
  // variables (the helper refuses foreign markers on its own) unless a sibling never set them.
  if (!stoppingSibling) { try { revertSystemEnv(); } catch { /* best-effort */ } }
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
      record.proxy = "respawned";
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
        record.inheritedTeardownBlocks = true;
        stopFailed = true;
        console.error(`❌ ${read.detail}, so this stop cannot tell whether a shared teardown is still owed.`);
        console.error("   Skipping shared teardown. Fix access to the opencodex home, then rerun 'ocx stop'.");
        continue;
      }
      if (read.state === "invalid") {
        unreadable.push(read);
        inheritedBlocks = true;
        record.inheritedTeardownBlocks = true;
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
        record.inheritedTeardownBlocks = true;
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
      record.inheritedTeardownBlocks = true;
      stopFailed = true;
      console.error(`❌ A shared teardown from an earlier stop is still outstanding, and the proxy on ${read.receipt.endpoint.hostname}:${read.receipt.endpoint.port} could not be confirmed down.`);
      console.error("   Skipping shared teardown: restoring client config under a proxy that may still be running is what the deferral exists to prevent.");
      console.error("   The obligation is preserved; retry once the proxy is confirmed stopped.");
    }
  }
  if (nativeRestoreHandledByProxy && !stoppingSibling) record.sharedTeardown = "performed-by-proxy";
  if (stoppingSibling) console.log(`↩️  Client routing stays on the proxy at port ${siblingOfPort}; this sibling had no shared teardown to run.`);
  const restoreBlocked = ownershipBlocked || inheritedBlocks || nativeRestoreHandledByProxy || stoppingSibling;
  if (!restoreBlocked) {
    if (recoveredNonces.length > 0) {
      // A previous deferred stop died before restoring, and the probe says its endpoint is
      // not answering. That is the whole point of leaving the receipt behind.
      console.log("↩️  Finishing a shared teardown left unfinished by an earlier stop.");
    }
    const restore = await restoreSharedClientStateAfterStop();
    record.sharedTeardown = restore.historyDeferred ? "refused" : restore.other ? "failed" : "restored";
    if (restore.other) stopFailed = true;
    else if (restore.historyDeferred) historyDeferredNonces = teardownNonce ? [teardownNonce, ...recoveredNonces] : recoveredNonces;
    else if (restore.historyOnly) historyOnlyFailure = true;
    // The obligation is discharged whether or not history metadata finalized: config and
    // catalog are what a client reads, and `restore.other` already fails the stop.
    //
    // Each nonce names its own file, so a clear can only ever remove the obligation it
    // names — never one a concurrent stop wrote. Both this run's claim and every inherited
    // receipt it proved discharged are released together.
    //
    // A history-preflight refusal is the exception: it restored nothing, so there is
    // nothing to discharge. Clearing here would drop a real obligation on the floor and
    // leave the client config pointing at a proxy that is gone, with nothing on disk
    // saying so — which is the whole failure the receipt exists to prevent (#4718).
    if (restore.historyDeferred) {
      console.error("   The shared teardown was refused before it changed anything, so it is still owed.");
      console.error("   Its receipt is preserved; run 'ocx stop' again once Codex is closed to retry the restore.");
    }
    if (!restore.other && !restore.historyDeferred) {
      const discharged = teardownNonce ? [teardownNonce, ...recoveredNonces] : recoveredNonces;
      for (const nonce of discharged) {
        // A receipt that survives its discharge re-triggers recovery forever, so a failed
        // removal is surfaced rather than swallowed.
        if (!clearPendingTeardown(nonce)) {
          stopFailed = true;
          record.receiptClearFailed = true;
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
  // The deferred code says "the only obligations left are the ones I just decided to
  // keep". It is read across a process boundary by an updater that will replace package
  // files on the strength of it, so this run has to be able to prove the claim: if any
  // other obligation is sitting in the home — quarantined, or a concurrent stop's — the
  // claim is false and the ordinary failure code is the honest answer. That is also the
  // behaviour before #4718, so the fallback loses nothing that used to work.
  else if (historyDeferredNonces) {
    process.exitCode = pendingTeardownsAreExactly(historyDeferredNonces)
      ? STOP_HISTORY_DEFERRED_EXIT_CODE
      : 1;
  }
  const signals = {
    failed: stopFailed,
    historyOnly: historyOnlyFailure,
    historyDeferred: historyDeferredNonces !== null,
    exitCode: Number(process.exitCode ?? 0),
  };
  const summary = summarizeStopRun(record, signals);
  if (snapshot && !stopFailed) {
    return guardFinalStopSummary(record, () => observeGuardedManagerStopped(snapshot.manager),
      () => ({ ok: !stopFailed, summary }));
  }
  return { ok: !stopFailed, summary };
}

async function handleUninstall() {
  /** Definitive "nothing is answering" on the endpoint this home would serve. */
  const proxyEndpointProvenDown = async (): Promise<boolean> => {
    try {
      // Every candidate, not just the preferred one: a stale runtime record pointing at a
      // closed port would otherwise "prove" a live proxy on the configured port is gone.
      const endpoints = endpointsToProve(readRuntimePort(), loadConfig());
      return await everyEndpointProvenDownAsync(endpoints, probeEndpointLiveness);
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
      if (r.retainedCodexProviderTable) {
        reportRetainedCodexProviderTable(r.retainedCodexProviderTable);
      }
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
    await runStep("opencodex config removed", async () => {
      const result = await removeOwnedConfigAfterDesktopCleanup(observed);
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

  // First line of the report, above the proxy line, deliberately (#4236): on a connected client
  // the provider/login/model lines describe the HUB, and the lines that describe this machine
  // are tagged `(local)`. A reader who sees neither draws the wrong conclusion from a correct
  // report — an agent read `xai ✗ not logged in` off a client and decided the hub could not
  // serve grok.
  const remoteHubBanner = remoteHubBannerLine(status.json.remoteHub);
  if (remoteHubBanner) console.log(remoteHubBanner);
  // `(local)` only while connected: on a standalone install every line is local, and tagging
  // them all would be noise that trains the reader to skip the tag.
  const local = status.json.remoteHub.connected ? " (local)" : "";
  if (status.json.proxy.pid || status.json.proxy.health.ok) {
    console.log(`✅ Proxy: ${status.proxyLabel}${local}`);
  } else {
    console.log(`❌ Proxy: ${status.proxyLabel}${local}`);
  }
  console.log(`   Health: ${status.healthLabel}${local}`);
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
    // Restarting is only half the choice. A user who cannot sign in to Codex at all needs the
    // way out that does not require this proxy to come back (#5261).
    for (const line of deadProxyRoutingAdviceLines({
      proxyUp: false,
      routingKind: status.json.startup.routingKind,
    })) {
      console.log(`     ${line}`);
    }
  }
  console.log(`   Dashboard: ${status.json.dashboard.url}${local}`);
  // The dashboard is a build artifact, so a checkout that moved without `bun run build:gui` keeps
  // serving the previous bundle and every feature added since simply does not appear (#5196's
  // usage panel was invisible this way for five days). Reported next to the dashboard URL, which
  // is where someone looks when the page is wrong.
  for (const line of staleGuiBundleLines(inspectGuiBundleFreshness({
    bundlePath: findGuiDist(),
    sourcePath: join(import.meta.dir, "..", "..", "gui", "src"),
  }))) {
    console.log(`     ${line}`);
  }
  console.log(`   Config: ${status.json.paths.config}${local}`);
  console.log(`   PID file: ${status.json.paths.pid}${local}`);
  console.log(`   Runtime: ${status.json.paths.runtime}${local}`);
  console.log(`   Runtime source: ${status.json.runtime.source}${status.json.runtime.overrideEnv ? ` (${status.json.runtime.overrideEnv})` : ""}${local}`);
  // On a client this is the local default, which routing does not use — the hub applies its own.
  console.log(`   Default provider: ${status.json.defaultProvider}${local}`);
  // One block rather than six scattered lines, and only on a hub: `hubStatusLines` owns the
  // sentences so they are testable without spawning the CLI. It prints no token value.
  if (status.json.hub) {
    for (const line of hubStatusLines(status.json.hub)) console.log(`   ${line}`);
  }
  console.log(`   Remote hub: ${status.json.connection.state}${status.json.connection.serverUrl ? ` (${status.json.connection.serverUrl})` : ""}`);
  if (status.json.connection.state === "invalid" || status.json.connection.state === "mismatched") {
    console.log(`   ⚠️  ${status.json.connection.reason}`);
  }
  console.log(`   Codex autostart: ${status.json.codexAutostart ? "enabled" : "disabled"}${local}`);
  console.log(`   Restart safety: ${startupHealthSummary(status.json.startup)}${local}`);
  console.log(`   ${formatStartupRoutingDetail(status.json.startup)}${local}`);
  // Independent of whether the proxy is up: a catalog pointer whose file is gone stops Codex
  // loading its config at all, and presents as the same blank wall as dead routing (#5261).
  // Tagged `(local)` on its header like every other local-state line, so a connected client
  // cannot read a finding about its own Codex home as something the hub reported.
  missingCodexCatalogLines(detectMissingCodexCatalogPath())
    .forEach((line, index) => console.log(`   ${line}${index === 0 ? local : ""}`));
  if (status.json.startup.routingKind === "native") {
    let retainedProviderTable = false;
    try {
      retainedProviderTable = readOcxProviderTableBlock() !== null;
    } catch {
      // The routing snapshot owns unreadable-config reporting. A later read race must not
      // turn this diagnostic command into a teardown failure.
    }
    if (retainedProviderTable) {
      console.log(`   ⚠️  Codex provider table retained${local}: [model_providers.opencodex] remains while root routing is native. Remove with 'ocx restore --remove-codex-provider-table'; tagged conversations will stop opening.`);
    }
  }
  console.log(`   Service: ${status.json.service.summary}${local}`);
  console.log(`   ${status.json.codexShim.summary}${local}`);
  console.log(`   Codex runtime: ${status.json.codexRuntime.path}${local}`);
  console.log(`   Codex version: ${status.json.codexRuntime.version ?? "unknown"}${local}`);
  console.log(`   Codex source: ${status.json.codexRuntime.source}${local}`);
  console.log(`   Codex home: ${status.json.codexHome.effectiveCodexHome}${local}`);
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
  const { emailMaskingEnabled } = await import("../lib/privacy");
  const { formatOAuthHealthForStatus } = await import("./status-oauth");
  // On a connected client the HUB's providers and logins come first, because they are the ones
  // that decide what a request can route to. The local block still prints — an operator debugging
  // a half-migrated machine needs to see it — but under a heading that says it is not in use, and
  // below the hub's, so the hub's is what a reader (or an agent) encounters first (#4236).
  for (const line of remoteHubStatusLines(status.json.remoteHub)) console.log(`   ${line}`);
  if (status.json.remoteHub.connected) {
    console.log(status.json.remoteHub.stateSource === "unavailable"
      ? "   Local-only credential state (this is NOT the hub's; the hub's state could not be read):"
      : "   Local-only (not used for routing while connected):");
  }
  console.log(`   OAuth logins${local}:`);
  // The operator's own `privacy.maskEmails` decision applies to the CLI too: `ocx status` is not
  // the dashboard, but it reads the same stored addresses, and a flag that only moved one of the
  // two would leave the operator unable to tell which surface they had configured.
  for (const e of oauthLoginSummary(emailMaskingEnabled(loadConfig()))) {
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
  if (args[1] === "--ocx-compaction") {
    const threadId = args[2];
    if (args.length !== 4 || !threadId || args[3] !== "--yes") {
      console.error("Usage: ocx recover-history --ocx-compaction <thread-id> --yes");
      console.error("This rewrites one rollout after saving a private byte-for-byte backup. Close that Codex thread before retrying.");
      process.exit(1);
    }
    console.error("WARNING: this converts OpenCodeX-owned ocx1 compaction state into a plain summary for native Codex replay.");
    try {
      const { recoverOcxCompactionHistory } = await import("../codex/ocx-compaction-history");
      const result = recoverOcxCompactionHistory({ threadId });
      if (result.replaced === 0) {
        console.log(`Thread ${threadId} has no repairable ocx1 compaction history; no files changed.`);
        return;
      }
      console.log(`Recovered ${result.replaced} ocx1 compaction item(s) in thread ${threadId}.`);
      console.log(`Backup: ${result.backupPath}`);
      return;
    } catch (error) {
      console.error(`Recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
  if (args[1] !== "--legacy-openai") {
    console.error("Usage: ocx recover-history (--legacy-openai | --ocx-compaction <thread-id>) --yes");
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

/**
 * `ocx resolve` — argument parsing already happened in src/cli/root.ts (before any
 * preflight side effect), so this handler only runs the runner and returns its exit code.
 */
async function handleResolve(args: ResolveArgs): Promise<number> {
  return runResolve(args);
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
      env: withProcessRuntimeProvenance(withoutSiblingMarker(process.env)),
    });
    child.unref();
  },
  handleStart,
  handleStop,
  handleResolve,
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
