/**
 * `ocx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets OCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "./config";
import { restoreNativeCodex } from "./codex-inject";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

function cliEntry(): { bun: string; cli: string } {
  // process.execPath = the bun binary; cli.ts sits next to this module.
  return { bun: process.execPath, cli: join(import.meta.dir, "cli.ts") };
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function logPath(): string {
  return join(getConfigDir(), "service.log");
}

function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "opencodex-service.cmd");
}

function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildPlist(): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = process.env.CODEX_HOME?.trim();
  const codexHomeXml = codexHome ? `    <key>CODEX_HOME</key><string>${plistString(codexHome)}</string>` : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${plistString(bun)}</string>
    <string>${plistString(cli)}</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>OCX_SERVICE</key><string>1</string>
    <key>PATH</key><string>${plistString(path)}</string>
${codexHomeXml ? `${codexHomeXml}\n` : ""}  </dict>
  <key>StandardOutPath</key><string>${plistString(log)}</string>
  <key>StandardErrorPath</key><string>${plistString(log)}</string>
</dict>
</plist>
`;
}

function systemdQuote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/%/g, "%%")
    .replace(/\n/g, "\\n")}"`;
}

function systemdEnvironmentAssignment(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `Environment=${systemdQuote(`${name}=${value}`)}`;
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function windowsBatchValue(value: string): string {
  return value.replace(/%/g, "%%").replace(/[\r\n]/g, "");
}

function windowsBatchSet(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `set "${name}=${windowsBatchValue(value)}"`;
}

export function buildWindowsServiceScript(): string {
  const { bun, cli } = cliEntry();
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "setlocal",
    windowsBatchSet("OCX_SERVICE", "1"),
    windowsBatchSet("PATH", path),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim()),
    ":loop",
    `"${bun}" "${cli}" start`,
    "if %ERRORLEVEL% NEQ 0 (",
    "  timeout /t 5 /nobreak >nul",
    "  goto loop",
    ")",
    "endlocal",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

// ── macOS (launchd) ──
function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  const p = plistPath();
  writeFileSync(p, buildPlist(), "utf8");
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  sh(`launchctl load -w "${p}"`);
}
function startLaunchd(): void { sh(`launchctl load -w "${plistPath()}"`); }
function stopLaunchd(): void { try { sh(`launchctl unload "${plistPath()}"`); } catch { /* not loaded */ } }
function statusLaunchd(): string { try { return sh(`launchctl list | grep ${LABEL} || true`); } catch { return ""; } }
function uninstallLaunchd(): void {
  const p = plistPath();
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  if (existsSync(p)) unlinkSync(p);
}

// ── Windows (Task Scheduler) ──
function installWindows(): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  const script = windowsServiceScriptPath();
  writeFileSync(script, buildWindowsServiceScript(), "utf8");
  sh(`schtasks /create /tn ${TASK} /tr "\\"${script}\\"" /sc onlogon /rl highest /f`);
  sh(`schtasks /run /tn ${TASK}`);
}
function startWindows(): void { sh(`schtasks /run /tn ${TASK}`); }
function stopWindows(): void { try { sh(`schtasks /end /tn ${TASK}`); } catch { /* not running */ } }
function statusWindows(): string { try { return sh(`schtasks /query /tn ${TASK}`); } catch { return ""; } }
function uninstallWindows(): void {
  try { sh(`schtasks /delete /tn ${TASK} /f`); } catch { /* absent */ }
  if (existsSync(windowsServiceScriptPath())) unlinkSync(windowsServiceScriptPath());
}

// ── Linux (systemd user unit) ──
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function unitPath(): string {
  return join(unitDir(), `${TASK}.service`);
}

export function buildUnit(): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = systemdEnvironmentAssignment("CODEX_HOME", process.env.CODEX_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("OCX_SERVICE", "1"),
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote(bun)} ${systemdQuote(cli)} start
Restart=on-failure
RestartSec=5
${envLines}
StandardOutput=${systemdQuote(`append:${log}`)}
StandardError=${systemdQuote(`append:${log}`)}

[Install]
WantedBy=default.target
`;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); return true; } catch { return false; }
}

function installSystemd(): void {
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(unitPath(), buildUnit(), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable --now ${TASK}`);
}
function startSystemd(): void { sh(`systemctl --user start ${TASK}`); }
function stopSystemd(): void { try { sh(`systemctl --user stop ${TASK}`); } catch { /* not running */ } }
function statusSystemd(): string { try { return sh(`systemctl --user status ${TASK}`); } catch { return ""; } }
function uninstallSystemd(): void {
  try { sh(`systemctl --user disable --now ${TASK}`); } catch { /* absent */ }
  if (existsSync(unitPath())) unlinkSync(unitPath());
  try { sh("systemctl --user daemon-reload"); } catch { /* best-effort */ }
}

type ServiceOps = {
  install: () => void; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
};

function platformOps(): ServiceOps | null {
  if (process.platform === "darwin")
    return { install: installLaunchd, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (process.platform === "win32")
    return { install: installWindows, start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) {
      console.error("Docker detected. Run 'ocx start' directly instead of using the service manager.");
      process.exit(1);
    }
    if (!isSystemd()) {
      console.error("systemd not found. Run 'ocx start' under your process supervisor.");
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

/**
 * If a service is installed, stop it so the process manager doesn't respawn after `ocx stop`.
 * Returns true if a service was found and stopped.
 */
export function stopServiceIfInstalled(): boolean {
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      try { stopLaunchd(); return true; } catch { return false; }
    }
  } else if (process.platform === "win32") {
    try {
      const q = sh(`schtasks /query /tn ${TASK} 2>nul`);
      if (q.includes(TASK)) { stopWindows(); return true; }
    } catch { /* task not found */ }
  } else if (process.platform === "linux" && isSystemd() && existsSync(unitPath())) {
    try { stopSystemd(); return true; } catch { return false; }
  }
  return false;
}

/**
 * Best-effort service removal for full uninstall. Unlike `ocx service uninstall`, this is quiet
 * when no service exists and never exits the process just because the platform has no service
 * manager.
 */
export function uninstallServiceIfInstalled(): boolean {
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      try { uninstallLaunchd(); return true; } catch { return false; }
    }
  } else if (process.platform === "win32") {
    try {
      const q = sh(`schtasks /query /tn ${TASK} 2>nul`);
      if (q.includes(TASK)) { uninstallWindows(); return true; }
    } catch { /* task not found */ }
  } else if (process.platform === "linux" && isSystemd() && existsSync(unitPath())) {
    try { uninstallSystemd(); return true; } catch { return false; }
  }
  return false;
}

export function serviceCommand(sub?: string): void {
  const ops = platformOps();
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (sub) {
    case "install":
      ops.install();
      console.log("✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
      if (process.platform === "linux") console.log("   For auto-start on boot: loginctl enable-linger $USER");
      break;
    case "start":
      ops.start();
      console.log("✅ service started.");
      break;
    case "stop":
      ops.stop();
      restoreNativeCodex();
      console.log("✅ service stopped + native Codex restored.");
      break;
    case "status": {
      const s = ops.status();
      console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
      break;
    }
    case "uninstall":
    case "remove":
      ops.uninstall();
      restoreNativeCodex();
      console.log("✅ service uninstalled + native Codex restored.");
      break;
    default:
      console.error("Usage: ocx service <install|start|stop|status|uninstall>");
      process.exit(1);
  }
}
