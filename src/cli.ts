#!/usr/bin/env bun
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { restoreNativeCodex } from "./codex-inject";
import { restoreLegacyOpenaiHistory } from "./codex-history-provider";
import { writeJournal, reconcileJournal } from "./codex-journal";
import {
  codexAutoStartEnabled,
  getConfigDir,
  loadConfig,
  readPid,
  readRuntimePort,
  removePid,
  removeRuntimePort,
  saveConfig,
  writePid,
  writeRuntimePort,
} from "./config";
import { collectStatus } from "./cli-status";
import { installCrashGuards } from "./crash-guard";
import { hasHelpFlag, printSubcommandUsage, printUsage, printVersion } from "./cli-help";
import { findAvailablePort, shouldPersistSelectedPort } from "./ports";
import { killProxy } from "./process-control";
import { serviceCommand, serviceStatusSummary, stopServiceIfInstalled, uninstallServiceIfInstalled } from "./service";
import { drainAndShutdown, startServer } from "./server";
import { maybeShowStarPrompt } from "./star-prompt";

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

async function syncModelsToCodex(port?: number) {
  const config = loadConfig();
  const p = port ?? config.port ?? 10100;
  let catalogPath: string | null | undefined;
  try {
    const { refreshCodexModelCatalog } = await import("./codex-refresh");
    const cat = await refreshCodexModelCatalog(config);
    catalogPath = cat.catalogExists ? cat.path : null;
    if (cat.added > 0) {
      console.log(`   + ${cat.added} models appended to Codex catalog (${cat.path})`);
    } else if (catalogPath === null) {
      console.error("catalog sync skipped: no Codex catalog source found; keeping Codex's native catalog.");
    }
  } catch (e) {
    console.error("catalog sync skipped:", e instanceof Error ? e.message : String(e));
  }
  const { injectCodexConfig } = await import("./codex-inject");
  const result = await injectCodexConfig(p, config, { catalogPath });
  console.log(result.message);
  return result;
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

async function proxyHealthy(port?: number): Promise<boolean> {
  const config = loadConfig();
  const p = port ?? config.port ?? 10100;
  try {
    const hostname = !config.hostname || config.hostname === "0.0.0.0" || config.hostname === "::" ? "127.0.0.1" : config.hostname;
    const res = await fetch(`http://${hostname}:${p}/healthz`, {
      signal: AbortSignal.timeout(750),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForProxy(timeoutMs = 8_000): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const config = loadConfig();
    const port = config.port ?? 10100;
    if (await proxyHealthy(port)) return port;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return null;
}

async function chooseListenPort(requestedPort?: number): Promise<number> {
  const config = loadConfig();
  const preferred = requestedPort ?? config.port ?? 10100;
  const selected = await findAvailablePort(preferred, config.hostname ?? "127.0.0.1");
  if (selected !== preferred) {
    console.log(`⚠️  Port ${preferred} is busy; starting opencodex on ${selected}.`);
  }
  if (shouldPersistSelectedPort(config.port, selected, preferred)) {
    config.port = selected;
    saveConfig(config);
  }
  return selected;
}

async function handleStart(options: { block?: boolean } = {}) {
  const requestedPort = parsePortOption();
  reconcileJournal();
  const existingPid = readPid();
  if (existingPid) {
    const config = loadConfig();
    if (await proxyHealthy(config.port)) {
      console.error(`⚠️  Proxy already running (PID ${existingPid}). Use 'ocx stop' first.`);
      process.exit(1);
    }
    removePid(existingPid);
  }

  const port = await chooseListenPort(requestedPort);

  const server = startServer(port);
  // A single request's streaming error must never crash the daemon serving every
  // other Codex session — capture the full stack to crash.log and stay up.
  installCrashGuards();
  writePid(process.pid);

  const config = loadConfig();
  writeRuntimePort({ pid: process.pid, port, hostname: config.hostname });
  writeJournal();

  let cleaned = false;
  const syncCleanup = () => {
    if (cleaned) return;
    cleaned = true;
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

  await maybeShowStarPrompt(); // once-only [Y/n] GitHub-star prompt on first interactive start
  await syncModelsToCodex(port).catch(() => {});
  if (options.block ?? true) {
    setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
  }
}

async function handleEnsure() {
  reconcileJournal();
  let config = loadConfig();
  if (!codexAutoStartEnabled(config)) {
    console.log("Codex autostart is disabled.");
    return;
  }
  if (await proxyHealthy(config.port)) {
    await syncModelsToCodex(config.port).catch(e => {
      console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
    });
    console.log(`✅ Proxy running on port ${config.port}`);
    return;
  }

  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();

  const port = await waitForProxy();
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    process.exit(1);
  }
  config = loadConfig();
  await syncModelsToCodex(config.port ?? port).catch(e => {
    console.error(`⚠️  Model sync skipped: ${e instanceof Error ? e.message : String(e)}`);
  });
  console.log(`✅ Proxy running on port ${config.port ?? port}`);
}

function handleStop() {
  const stoppedService = stopServiceIfInstalled();
  if (stoppedService) console.log("🛑 Service manager stopped (won't respawn).");

  const pid = readPid();
  let stopFailed = false;
  if (pid) {
    try {
      killProxy(pid);
      console.log(`✅ Proxy (PID ${pid}) stopped.`);
      removePid(pid);
      removeRuntimePort(pid);
    } catch {
      stopFailed = true;
      console.error(`❌ Failed to stop proxy (PID ${pid}).`);
    }
  } else if (!stoppedService) {
    console.log("No running proxy found.");
  }
  const r = restoreNativeCodex();
  console.log(`↩️  ${r.message}`);
  if (stopFailed) process.exit(1);
}

async function handleUninstall() {
  const failures: string[] = [];

  const runStep = (label: string, step: () => void | boolean) => {
    try {
      const changed = step();
      if (changed === false) console.log(`- ${label}: not installed`);
      else console.log(`✅ ${label}`);
    } catch (err) {
      failures.push(label);
      console.error(`⚠️  ${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  runStep("service stopped", () => stopServiceIfInstalled());

  runStep("proxy stopped", () => {
    const pid = readPid();
    if (!pid) return false;
    killProxy(pid);
    removePid(pid);
    removeRuntimePort(pid);
    return true;
  });

  runStep("service removed", () => uninstallServiceIfInstalled());

  runStep("native Codex restored", () => {
    const r = restoreNativeCodex();
    if (!r.success) throw new Error(r.message);
  });

  try {
    const { uninstallCodexShim } = await import("./codex-shim");
    const r = uninstallCodexShim();
    console.log(r.removed ? "✅ Codex autostart shim removed" : "- Codex autostart shim removed: not installed");
  } catch (err) {
    failures.push("Codex autostart shim removed");
    console.error(`⚠️  Codex autostart shim removed failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (failures.length === 0) {
    runStep("opencodex config removed", () => {
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
  const { oauthLoginSummary } = await import("./oauth/index");
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
    handleStop();
    break;
  case "restore":
  case "eject": {
    const r = restoreNativeCodex();
    console.log(r.success ? `✅ ${r.message}` : `⚠️  ${r.message}`);
    console.log("Plain `codex` now runs natively (no proxy).");
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
  case "ensure":
    await handleEnsure();
    break;
  case "login": {
    const { handleLogin } = await import("./oauth/login-cli");
    await handleLogin(args[1]);
    break;
  }
  case "logout": {
    const { removeCredential } = await import("./oauth/store");
    const name = (args[1] ?? "").trim().toLowerCase();
    removeCredential(name);
    console.log(`Logged out of ${name || "(none)"}.`);
    break;
  }
  case "sync": {
    await syncModelsToCodex();
    break;
  }
  case "sync-cache": {
    const { invalidateCodexModelsCache } = await import("./codex-catalog");
    invalidateCodexModelsCache();
    break;
  }
  case "gui": {
    const cfg = await import("./config");
    const config = cfg.loadConfig();
    let pid = cfg.readPid();
    if (!pid) {
      console.log("Proxy not running. Starting...");
      const child = spawn(process.execPath, [process.argv[1], "start"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
        env: process.env,
      });
      child.unref();
      await new Promise(r => setTimeout(r, 1000));
      pid = cfg.readPid();
    }
    const runtimePort = pid ? cfg.readRuntimePort(pid) : null;
    const guiPort = runtimePort?.port ?? config.port;
    const guiUrl = `http://localhost:${guiPort}`;
    console.log(`Opening ${guiUrl}`);
    const { openUrl } = await import("./open-url");
    openUrl(guiUrl);
    break;
  }
  case "service":
    serviceCommand(args[1]);
    break;
  case "codex-shim": {
    const { codexShimStatus, installCodexShim, uninstallCodexShim } = await import("./codex-shim");
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
    const { runUpdate } = await import("./update");
    await runUpdate();
    break;
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
