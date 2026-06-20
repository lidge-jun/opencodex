#!/usr/bin/env bun
import { execFileSync, spawn } from "node:child_process";
import { restoreNativeCodex } from "./codex-inject";
import { loadConfig, readPid, removePid, writePid } from "./config";
import { serviceCommand, stopServiceIfInstalled } from "./service";
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
  ocx service <sub>           Run as a background service (install|start|stop|status|uninstall)
  ocx sync                    Fetch models from providers and inject into Codex config
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

async function handleStart(options: { block?: boolean } = {}) {
  const existingPid = readPid();
  if (existingPid) {
    console.error(`⚠️  Proxy already running (PID ${existingPid}). Use 'ocx stop' first.`);
    process.exit(1);
  }

  let port: number | undefined;
  const portIdx = args.indexOf("--port");
  if (portIdx !== -1 && args[portIdx + 1]) {
    port = parseInt(args[portIdx + 1], 10);
    if (isNaN(port)) {
      console.error("Invalid port number");
      process.exit(1);
    }
  }

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
  case "status":
    handleStatus();
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
  case "update": {
    const { runUpdate } = await import("./update");
    runUpdate();
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
