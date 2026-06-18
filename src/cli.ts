#!/usr/bin/env bun
import { readPid, removePid, writePid } from "./config";
import { startServer } from "./server";

const args = process.argv.slice(2);
const command = args[0];

function printUsage() {
  console.log(`opencodex (ocx) — Universal provider proxy for Codex

Usage:
  ocx init                    Interactive setup (provider + Codex config injection)
  ocx start [--port <port>]   Start the proxy server
  ocx stop                    Stop the running proxy server
  ocx status                  Check proxy server status
  ocx help                    Show this help message

Examples:
  ocx init                    Set up provider and inject into Codex
  ocx start                   Start on default port (10100)
  ocx start --port 8080       Start on custom port`);
}

function handleStart() {
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
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function handleStop() {
  const pid = readPid();
  if (!pid) {
    console.log("No running proxy found.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    removePid();
    console.log(`✅ Proxy (PID ${pid}) stopped.`);
  } catch {
    removePid();
    console.log("Proxy process not found. Cleaned up PID file.");
  }
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
    handleStart();
    break;
  case "stop":
    handleStop();
    break;
  case "status":
    handleStatus();
    break;
  case "gui": {
    const { loadConfig } = await import("./config");
    const config = loadConfig();
    const guiUrl = `http://localhost:${config.port}`;
    console.log(`Opening GUI at ${guiUrl}...`);
    console.log("Note: proxy must be running (ocx start) and GUI dev server (cd gui && bun dev)");
    const { exec } = await import("node:child_process");
    exec(`open ${guiUrl}`);
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
