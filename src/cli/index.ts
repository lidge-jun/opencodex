#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { restoreNativeCodex, shouldInjectApiAuthHeader } from "../codex/inject";
import { restoreLegacyOpenaiHistory } from "../codex/history-provider";
import { writeJournal, reconcileJournal } from "../codex/journal";
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
import { installCrashGuards } from "../lib/crash-guard";
import { hasHelpFlag, printSubcommandUsage, printUsage, printVersion } from "./help";
import { findAvailablePort, isAddrInUse, PortUnavailableError, shouldPersistSelectedPort, waitForPortAvailable } from "../server/ports";
import { findLiveProxy, probeHostname, type LiveProxy } from "../server/proxy-liveness";
import { stopProxy } from "../lib/process-control";
import { loadServiceTokenFromFile } from "../lib/service-secrets";
import { serviceCommand, serviceStatusSummary, stopServiceIfInstalled, uninstallServiceIfInstalled } from "../service";
import { drainAndShutdown, startServer } from "../server";
import { injectSystemEnv, revertSystemEnv } from "../server/system-env";
import { buildDesktop3pRegistry } from "../claude/desktop-3p";
import { installShellHook, uninstallShellHook } from "../server/system-env";
import { startTokenGuardian } from "../oauth/token-guardian";
import { startHistoryMigrationGuardian } from "../codex/history-migration-guardian";
import { maybeShowStarPrompt } from "./star-prompt";
import { maybeShowUpdatePrompt } from "../update/notify";
import { syncModelsToCodex } from "../codex/sync";
import { normalizeUpdateChannel, runGuiUpdateWorker } from "../update/job";

const args = process.argv.slice(2);
const command = args[0];

if (command === "--version" || command === "-v" || command === "version") {
  printVersion();
  process.exit(0);
}

if (command === "help" && args[1]) {
  printSubcommandUsage(args[1]);
  process.exit(0);
}

if (command !== undefined && command !== "help" && hasHelpFlag(args.slice(1))) {
  printSubcommandUsage(command);
  process.exit(0);
}

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
  const args = [process.argv[1], "start"];
  if (typeof port === "number" && Number.isFinite(port) && port > 0 && port <= 65535) {
    args.push("--port", String(Math.trunc(port)));
  }
  return args;
}

async function chooseListenPort(requestedPort?: number): Promise<number> {
  const config = loadConfig();
  const preferred = requestedPort ?? config.port ?? 10100;
  const hardPin = requestedPort !== undefined;
  // Soft start: brief prefer-retry then ephemeral hop.
  // Explicit `--port` (service wrappers / update restart): longer prefer-retry, never hop.
  try {
    const selected = await findAvailablePort(preferred, config.hostname ?? "127.0.0.1", {
      preferRetryMs: hardPin ? 8_000 : 750,
      preferRetryIntervalMs: 50,
      allowEphemeralFallback: !hardPin,
    });
    if (selected !== preferred) {
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
  reconcileJournal();
  const existingPid = readPid();
  if (existingPid) {
    const live = await findLiveProxy();
    if (live) {
      console.error(`⚠️  Proxy already running (PID ${live.pid ?? existingPid}, port ${live.port}). Use 'ocx stop' first.`);
      process.exit(1);
    }
    removePid(existingPid);
  }

  // Interactive-only update prompt. Must run BEFORE we bind a port / write a
  // PID: choosing "Update now" installs globally and exits, so we never want a
  // live daemon holding resources while it overwrites its own binary.
  await maybeShowUpdatePrompt();

  // Port selection is check-then-bind: a concurrent `ocx start`/`ensure` can win the port
  // between the probe and Bun.serve. Soft starts may re-pick; hard-pinned `--port` retries
  // the same port only (never hop — that was the remaining PR #152 gap).
  let port = await chooseListenPort(requestedPort);
  let server: ReturnType<typeof startServer>;
  for (let attempt = 0; ; attempt++) {
    try {
      server = startServer(port);
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
  writeRuntimePort({ pid: process.pid, port, hostname: config.hostname });
  writeJournal();

  // Background proactive token refresh. No-op unless config.tokenGuardian.enabled; timer is unref'd
  // so it never keeps the process alive on its own. Stopped in syncCleanup so no refresh fires mid-drain.
  const guardian = startTokenGuardian();
  // Design B upgrade path: keep retrying the one-time opencodex→openai history migration in the
  // background — the first `ocx start` after an update usually races the Codex app's DB lock.
  // Loopback-only (legacy mode still forward-tags) and respects syncResumeHistory opt-out.
  const historyGuardian = !shouldInjectApiAuthHeader(config) && config.syncResumeHistory !== false
    ? startHistoryMigrationGuardian()
    : undefined;

  let cleaned = false;
  const syncCleanup = () => {
    if (cleaned) return;
    cleaned = true;
    try { guardian.stop(); } catch { /* best-effort */ }
    try { historyGuardian?.stop(); } catch { /* best-effort */ }
    try { revertSystemEnv(); } catch { /* best-effort */ }
    removePid(process.pid);
    removeRuntimePort(process.pid);
    if (!process.env.OCX_SERVICE) { try { restoreNativeCodex(); } catch { /* best-effort restore */ } }
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
        syncCleanup(); // idempotent (cleaned-guard); also re-run by process.on("exit")
        process.exit(0);
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

  await maybeShowStarPrompt(); // once-only [Y/n] GitHub-star prompt on first interactive start
  await syncModelsToCodex(port).catch(() => {});
  // Build Desktop 3P alias registry so inbound claude-opus-4-8-{code} aliases (and legacy claude-opus-4-{code}) decode correctly.
  try {
    const { fetchAllModels } = await import("../server/management-api");
    const { visibleNativeSlugs, filterCatalogVisibleModels } = await import("../codex/catalog");
    const models = filterCatalogVisibleModels(await fetchAllModels(config), config);
    buildDesktop3pRegistry(
      [...visibleNativeSlugs(config)],
      models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow })),
    );
  } catch { /* best-effort — registry rebuilds on first /v1/models call */ }
  if (options.block ?? true) {
    setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
  }
}

async function handleEnsure() {
  reconcileJournal();
  const config = loadConfig();
  if (!codexAutoStartEnabled(config)) {
    console.log("Codex autostart is disabled.");
    return;
  }
  const live = await findLiveProxy();
    if (live) {
      await syncModelsToCodex(live.port).catch(e => {
        console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
      });
      // Ensure env file exists for already-running proxy (may have been deleted or pre-dates this feature).
      await injectSystemEnv(live.port, config).catch(() => {});
      console.log(`✅ Proxy running on port ${live.port}`);
      return;
    }

  const pinPort = config.port ?? 10100;
  const child = spawn(process.execPath, startArgv(pinPort), {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();

  const port = (await waitForProxy())?.port;
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    process.exit(1);
  }
  // Always sync the LIVE port: after a fallback-port start, config.port still names the
  // busy preferred port — syncing that would point Codex at a dead listener.
  await syncModelsToCodex(port).catch(e => {
    console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
  });
  console.log(`✅ Proxy running on port ${port}`);
}

async function handleStop() {
  const stoppedService = stopServiceIfInstalled();
  if (stoppedService) console.log("🛑 Service manager stopped (won't respawn).");

  const pid = readPid();
  let stopFailed = false;
  if (pid) {
    try {
      // Graceful-first (management-API drain) — on Windows this is the only path where
      // the proxy's shutdown handlers actually run; taskkill /F is the fallback inside.
      await stopProxy(pid);
      console.log(`✅ Proxy (PID ${pid}) stopped.`);
      removePid(pid);
      removeRuntimePort(pid);
    } catch {
      stopFailed = true;
      console.error(`❌ Failed to stop proxy (PID ${pid}).`);
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
      } catch {
        stopFailed = true;
        console.error(`❌ Failed to stop proxy (PID ${live.pid}).`);
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
  const r = restoreNativeCodex();
  console.log(`↩️  ${r.message}`);
  // Safety net: revert system env vars even if the daemon's syncCleanup didn't run
  // (e.g. SIGKILL). revertSystemEnv is ownership-checked and idempotent.
  try { revertSystemEnv(); } catch { /* best-effort */ }
  if (stopFailed) process.exit(1);
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

  await runStep("native Codex restored", () => {
    const r = restoreNativeCodex();
    if (!r.success) throw new Error(r.message);
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
      rmSync(getConfigDir(), { recursive: true, force: true });
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
  console.log(`   Dashboard: ${status.json.dashboard.url}`);
  console.log(`   Config: ${status.json.paths.config}`);
  console.log(`   PID file: ${status.json.paths.pid}`);
  console.log(`   Runtime: ${status.json.paths.runtime}`);
  console.log(`   Runtime source: ${status.json.runtime.source}${status.json.runtime.overrideEnv ? ` (${status.json.runtime.overrideEnv})` : ""}`);
  console.log(`   Default provider: ${status.json.defaultProvider}`);
  console.log(`   Codex autostart: ${status.json.codexAutostart ? "enabled" : "disabled"}`);
  console.log(`   Service: ${status.json.service.summary}`);
  console.log(`   ${status.json.codexShim.summary}`);
  if (status.json.codexPlugins.applicable) {
    const icon = status.json.codexPlugins.stale ? "⚠️ " : "✅";
    console.log(`   ${icon} Codex bundled plugins: ${status.json.codexPlugins.summary}`);
    if (status.json.codexPlugins.suggestedRepair) {
      console.log(`      Suggested: ${status.json.codexPlugins.suggestedRepair}`);
    }
  }
  const { oauthLoginSummary } = await import("../oauth");
  console.log(`   OAuth logins:`);
  for (const e of oauthLoginSummary()) {
    console.log(`     ${e.provider.padEnd(10)} ${e.loggedIn ? `✓ logged in${e.email ? ` (${e.email})` : ""}` : "✗ not logged in"}`);
  }
}

function handleRecoverHistory() {
  if (args[1] !== "--legacy-openai") {
    console.error("Usage: ocx recover-history --legacy-openai");
    console.error("Only use this if an older syncResumeHistory build already remapped OpenAI Codex App history to opencodex before backup support existed.");
    process.exit(1);
  }
  const r = restoreLegacyOpenaiHistory();
  if (r.failed) {
    console.error(
      "⚠️  Recovery SKIPPED: the Codex history DB is locked (Codex app/IDE open?). Close it and rerun this command.",
    );
    process.exit(1);
  }
  console.log(`Recovered ${r.rows} legacy thread(s) to openai (${r.files} rollout file(s) updated).`);
}

switch (command) {
  case "init": {
    const { runInit } = await import("./init");
    await runInit();
    break;
  }
  case "start":
    await handleStart();
    break;
  case "stop":
    await handleStop();
    break;
  case "restore":
  case "eject": {
    if (args[1] === "back") {
      // Reverse switch: re-point plain `codex` at the RUNNING proxy without touching its
      // lifecycle — the counterpart of `ocx restore`. Start/stop triggers are unchanged;
      // this only re-runs the same inject (config + catalog + history) `ocx start` does.
      const live = await findLiveProxy();
      if (!live) {
        console.error("No running proxy found. Run 'ocx start' — it injects opencodex automatically.");
        process.exit(1);
      }
      await syncModelsToCodex(live.port);
      console.log("Plain `codex` now routes through opencodex again (undo with: ocx restore).");
      break;
    }
    const r = restoreNativeCodex();
    console.log(r.success ? `✅ ${r.message}` : `⚠️  ${r.message}`);
    console.log("Plain `codex` now runs natively (no proxy). Switch back with: ocx restore back");
    break;
  }
  case "recover-history":
    handleRecoverHistory();
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
    await runDoctor();
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
    await syncModelsToCodex((await findLiveProxy())?.port);
    break;
  }
  case "v2": {
    const { cmdV2 } = await import("./v2");
    process.exitCode = await cmdV2(args.slice(1), {}, async () => (await findLiveProxy())?.port);
    break;
  }
  case "sync-cache": {
    const { invalidateCodexModelsCache } = await import("../codex/catalog");
    invalidateCodexModelsCache();
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
      const child = spawn(process.execPath, startArgv(config.port ?? 10100), {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.unref();
      live = await waitForProxy();
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
  case "__gui-update-worker": {
    const jobId = args[1];
    if (!jobId) process.exit(1);
    const channel = normalizeUpdateChannel(args[2]);
    await runGuiUpdateWorker(jobId, channel, args[3] === "restart");
    break;
  }
  case "restart": {
    await handleStop();
    await handleEnsure();
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
    case "provider": {
    const { handleProviderCommand } = await import("./provider");
    await handleProviderCommand(args.slice(1));
    break;
  }
  case "models": {
    const { handleModels } = await import("./models");
    handleModels(args.slice(1));
    break;
  }
  case "claude": {
    const { cmdClaude } = await import("./claude");
    // "ocx claude desktop" → write Desktop 3P config
    if (args[1] === "desktop") {
      const config = loadConfig();
      const { fetchAllModels } = await import("../server/management-api");
      const { visibleNativeSlugs, filterCatalogVisibleModels } = await import("../codex/catalog");
      const { parseDesktop3pModeArgs, writeDesktop3pConfig } = await import("../claude/desktop-3p");
      // Mutually-exclusive mode flags (devlog 138): default static (deterministic; the
      // static list overrides discovery anyway — no merge).
      const parsedMode = parseDesktop3pModeArgs(args.slice(2));
      if ("error" in parsedMode) {
        console.error(`❌ ${parsedMode.error}`);
        process.exit(1);
      }
      const mode = parsedMode.mode;
      const live = await findLiveProxy();
      const port = live?.port ?? config.port ?? 10100;
      const allModels = await fetchAllModels(config);
      const models = filterCatalogVisibleModels(allModels, config);
      const nativeSlugs = [...visibleNativeSlugs(config)];
      // contextWindow rides along so supports1m derives from authoritative data (감사 R1#1).
      const routedModels = models.map(m => ({ provider: m.provider, id: m.id, contextWindow: m.contextWindow }));
      const result = writeDesktop3pConfig(port, nativeSlugs, routedModels, undefined, mode);
      if (result.written) {
        const oneM = routedModels.filter(m => typeof m.contextWindow === "number" && m.contextWindow >= 1_000_000).length;
        console.log(`✅ Claude Desktop 3P 설정 완료: ${result.path}`);
        console.log(`   Gateway: http://127.0.0.1:${port}`);
        if (mode === "discovery") {
          console.log(`   모델 목록: 자동 발견만 (프록시 /v1/models에서 ${nativeSlugs.length + models.length}개)`);
        } else {
          const suffix = mode === "hybrid" ? " + 자동 발견 병행" : "";
          console.log(`   모델 ${nativeSlugs.length + models.length}개 고정 등록${suffix} (1M 컨텍스트 별도 행 ${oneM}개)`);
          if (oneM > 0) console.log(`   1M을 쓰려면 Desktop 모델 피커에서 [1M] 붙은 행을 직접 선택하세요.`);
        }
        console.log(`   Claude Desktop을 재시작하면 적용됩니다.`);
      } else {
        console.error(`❌ 설정 실패: ${result.reason}`);
        process.exit(1);
      }
      break;
    }
    process.exit(await cmdClaude(args.slice(1)));
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
