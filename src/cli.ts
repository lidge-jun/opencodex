#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { restoreNativeCodex } from "./codex-inject";
import { codexAutoStartEnabled, getConfigDir, loadConfig, readPid, removePid, saveConfig, writePid } from "./config";
import { findAvailablePort } from "./ports";
import { serviceCommand, stopServiceIfInstalled, uninstallServiceIfInstalled } from "./service";
import { startServer } from "./server";
import { maybeShowStarPrompt } from "./star-prompt";

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx init                    Interactive setup (provider + Codex config injection)
  ocx start [--port <port>]   Start the proxy server (auto-syncs models to Codex)
  ocx stop                    Stop the proxy AND restore native Codex (plain codex works again)
  ocx restore                 Restore native Codex without stopping (alias: eject)
  ocx uninstall               Remove service/shim/config and restore native Codex
  ocx service <sub>           Run as a background service (install|start|stop|status|uninstall)
  ocx codex-shim <sub>        Auto-start proxy when \`codex\` launches (install|status|uninstall)
  ocx ensure                  Ensure the proxy is running and Codex config/cache are current
  ocx sync                    Fetch models from providers and inject into Codex config
  ocx sync-cache              Refresh Codex's model cache from the active catalog
  ocx status                  Check proxy server status
  ocx login <provider>        OAuth login (xai) — opens browser, stores token in ~/.opencodex/auth.json
  ocx logout <provider>       Remove a stored OAuth login
  ocx update                  Update opencodex to the latest published version
  ocx help                    Show this help message

Examples:
  ocx init                    Set up provider and inject into Codex
  ocx start                   Start on default port (10100)
  ocx start --port 8080       Start on custom port
  ocx sync                    Sync available models to Codex`);
}

function hasHelpFlag(values: string[]): boolean {
  return values.some(value => value === "--help" || value === "-h" || value === "help");
}

function printSubcommandUsage(name: string | undefined): void {
  switch (name) {
    case "init":
      console.log("Usage: ocx init\n\nInteractive setup for providers and Codex config injection.");
      break;
    case "start":
      console.log("Usage: ocx start [--port <port>]\n\nStart the proxy server and sync models to Codex.");
      break;
    case "stop":
      console.log("Usage: ocx stop\n\nStop the proxy and restore native Codex config.");
      break;
    case "restore":
    case "eject":
      console.log(`Usage: ocx ${name}\n\nRestore native Codex config without stopping the proxy.`);
      break;
    case "uninstall":
    case "remove":
      console.log(`Usage: ocx ${name}\n\nRemove service/shim/config and restore native Codex.`);
      break;
    case "service":
      console.log("Usage: ocx service <install|start|stop|status|uninstall>");
      break;
    case "codex-shim":
      console.log("Usage: ocx codex-shim <install|status|uninstall>");
      break;
    case "ensure":
      console.log("Usage: ocx ensure\n\nEnsure the proxy is running and Codex config/cache are current.");
      break;
    case "sync":
      console.log("Usage: ocx sync\n\nFetch provider models and inject them into Codex config.");
      break;
    case "sync-cache":
      console.log("Usage: ocx sync-cache\n\nRefresh Codex's model cache from the active catalog.");
      break;
    case "status":
      console.log("Usage: ocx status\n\nCheck proxy server status.");
      break;
    case "login":
      console.log("Usage: ocx login <provider>\n\nOAuth or API-key login for a provider.");
      break;
    case "logout":
      console.log("Usage: ocx logout <provider>\n\nRemove a stored provider login.");
      break;
    case "gui":
      console.log("Usage: ocx gui\n\nOpen the opencodex dashboard.");
      break;
    case "update":
      console.log("Usage: ocx update\n\nUpdate opencodex to the latest published version.");
      break;
    default:
      printUsage();
  }
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
  const portIdx = args.indexOf("--port");
  if (portIdx === -1) return undefined;
  const value = args[portIdx + 1];
  const port = value ? parseInt(value, 10) : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    console.error("Invalid port number");
    process.exit(1);
  }
  return port;
}

function healthHost(hostname?: string): string {
  return !hostname || hostname === "0.0.0.0" || hostname === "::" ? "127.0.0.1" : hostname;
}

async function proxyHealthy(port?: number): Promise<boolean> {
  const config = loadConfig();
  const p = port ?? config.port ?? 10100;
  try {
    const res = await fetch(`http://${healthHost(config.hostname)}:${p}/healthz`, {
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
  if (config.port !== selected) {
    config.port = selected;
    saveConfig(config);
  }
  return selected;
}

async function handleStart(options: { block?: boolean } = {}) {
  const existingPid = readPid();
  if (existingPid) {
    const config = loadConfig();
    if (await proxyHealthy(config.port)) {
      console.error(`⚠️  Proxy already running (PID ${existingPid}). Use 'ocx stop' first.`);
      process.exit(1);
    }
    removePid();
  }

  const requestedPort = parsePortOption();
  const port = await chooseListenPort(requestedPort);

  const server = startServer(port);
  writePid(process.pid);

  const shutdown = () => {
    console.log("\n🛑 Shutting down opencodex proxy...");
    server.stop(true);
    removePid();
    // Under the service (OCX_SERVICE), a restart re-injects on start — don't churn Codex config.
    // `ocx service stop/uninstall` restore explicitly.
    if (!process.env.OCX_SERVICE) { try { restoreNativeCodex(); } catch { /* best-effort restore */ } }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await maybeShowStarPrompt(); // once-only [Y/n] GitHub-star prompt on first interactive start
  await syncModelsToCodex(port).catch(() => {});
  if (options.block ?? true) {
    setInterval(() => {}, 60_000);
    await new Promise<void>(() => {});
  }
}

async function handleEnsure() {
  let config = loadConfig();
  if (!codexAutoStartEnabled(config)) {
    console.log("Codex autostart is disabled.");
    return;
  }
  if (await proxyHealthy(config.port)) {
    await syncModelsToCodex(config.port).catch(() => {});
    console.log(`✅ Proxy running on port ${config.port}`);
    return;
  }

  const child = spawn(process.execPath, [process.argv[1], "start"], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, OCX_SERVICE: "1" },
  });
  child.unref();

  const port = await waitForProxy();
  if (!port) {
    console.error("❌ Proxy did not become healthy after starting.");
    process.exit(1);
  }
  config = loadConfig();
  await syncModelsToCodex(config.port ?? port).catch(() => {});
  console.log(`✅ Proxy running on port ${config.port ?? port}`);
}

function killProxy(pid: number): void {
  if (!isProcessAlive(pid)) return;
  if (process.platform === "win32") {
    const taskkill = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\taskkill.exe`;
    try {
      execFileSync(taskkill, ["/PID", String(pid), "/T", "/F"], { stdio: "pipe" });
    } catch (err) {
      if (isProcessAlive(pid)) throw err;
    }
  } else {
    process.kill(pid, "SIGTERM");
    if (!waitForExit(pid, 5000)) process.kill(pid, "SIGKILL");
  }
  if (!waitForExit(pid, 5000)) throw new Error(`process ${pid} did not exit`);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForExit(pid: number, timeoutMs: number): boolean {
  const deadline = Date.now() + timeoutMs;
  const marker = new Int32Array(new SharedArrayBuffer(4));
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    Atomics.wait(marker, 0, 0, 50);
  }
  return !isProcessAlive(pid);
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
      removePid();
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

  runStep("service removed", () => {
    stopServiceIfInstalled();
    return uninstallServiceIfInstalled();
  });

  runStep("proxy stopped", () => {
    const pid = readPid();
    if (!pid) return false;
    killProxy(pid);
    removePid();
    return true;
  });

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

  runStep("opencodex config removed", () => {
    rmSync(getConfigDir(), { recursive: true, force: true });
  });

  if (failures.length > 0) {
    console.error(`\nUninstall finished with ${failures.length} failed step(s): ${failures.join(", ")}`);
    process.exit(1);
  }
  console.log("\n✅ opencodex local state removed. Remove the package with: npm uninstall -g @bitkyc08/opencodex");
}

function handleStatus() {
  const pid = readPid();
  if (pid) {
    console.log(`✅ Proxy running (PID ${pid})`);
  } else {
    console.log("❌ Proxy not running");
  }
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
  case "uninstall":
  case "remove":
    await handleUninstall();
    break;
  case "status":
    handleStatus();
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
    const guiUrl = `http://localhost:${config.port}`;
    if (!cfg.readPid()) {
      console.log("Proxy not running. Starting...");
      const child = spawn(process.execPath, [process.argv[1], "start"], {
        detached: true,
        stdio: "ignore",
        env: process.env,
      });
      child.unref();
      await new Promise(r => setTimeout(r, 1000));
    }
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
        console.error("Usage: ocx codex-shim <install|status|uninstall>");
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
