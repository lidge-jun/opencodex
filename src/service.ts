/**
 * `ocx service` — run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS → launchd; Windows → Task Scheduler; Linux → systemd user unit.
 * The service sets OCX_SERVICE=1 so the proxy's shutdown handler does NOT restore native
 * Codex on a service-managed restart (the restarted instance re-injects); explicit stop/uninstall
 * restore it via the command.
 */
import { execFileSync, execSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { getConfigDir, readPid, removePid } from "./config";
import { loadConfig } from "./config";
import { restoreNativeCodex } from "./codex-inject";
import { durableBunPath } from "./bun-runtime";
import { killProxy } from "./process-control";
import { serviceApiTokenFilePath } from "./service-secrets";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

function cliEntry(): { bun: string; cli: string } {
  // Bake the bundled Bun (npm global prefix, survives `ocx update`) rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. cli.ts sits next to this module.
  return { bun: durableBunPath(), cli: join(import.meta.dir, "cli.ts") };
}

function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
}

function logPath(): string {
  return join(getConfigDir(), "service.log");
}

export function serviceLogPath(): string {
  return logPath();
}

function windowsServiceScriptPath(): string {
  return join(getConfigDir(), "opencodex-service.cmd");
}

function serviceStatePath(): string {
  return join(getConfigDir(), "service-state.json");
}

function defaultOpenCodexHome(): string {
  return resolve(join(homedir(), ".opencodex"));
}

function serviceStatePaths(): string[] {
  const paths = [serviceStatePath()];
  const defaultPath = join(defaultOpenCodexHome(), "service-state.json");
  if (normalizePathForCompare(defaultPath) !== normalizePathForCompare(paths[0])) paths.push(defaultPath);
  return paths;
}

function currentCodexHome(): string {
  return resolve(process.env.CODEX_HOME?.trim() || join(homedir(), ".codex"));
}

function currentOpenCodexHome(): string {
  return resolve(process.env.OPENCODEX_HOME?.trim() || getConfigDir());
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface ServiceInstallState {
  version: 1;
  codexHome: string;
  opencodexHome: string;
}

function writeServiceInstallState(): void {
  const state: ServiceInstallState = {
    version: 1,
    codexHome: currentCodexHome(),
    opencodexHome: currentOpenCodexHome(),
  };
  for (const path of serviceStatePaths()) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  }
}

function readServiceInstallState(): ServiceInstallState | null {
  for (const path of serviceStatePaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ServiceInstallState;
      if (parsed.version === 1) return parsed;
    } catch {
      /* try the next known state path */
    }
  }
  return null;
}

export function assertServiceEnvironmentMatchesInstall(): void {
  const state = readServiceInstallState();
  if (!state) return;
  const expected = normalizePathForCompare(state.codexHome);
  const actual = normalizePathForCompare(currentCodexHome());
  if (expected !== actual) {
    throw new Error(
      `Service was installed with CODEX_HOME=${state.codexHome}, but current CODEX_HOME=${currentCodexHome()}. ` +
        "Run the service command from the same Codex home so native Codex restore updates the correct config.",
    );
  }
  const expectedOpenCodexHome = normalizePathForCompare(state.opencodexHome);
  const actualOpenCodexHome = normalizePathForCompare(currentOpenCodexHome());
  if (expectedOpenCodexHome !== actualOpenCodexHome) {
    throw new Error(
      `Service was installed with OPENCODEX_HOME=${state.opencodexHome}, but current OPENCODEX_HOME=${currentOpenCodexHome()}. ` +
        "Run the service command from the same OpenCodex home so service state and secrets match.",
    );
  }
}

function plistString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return normalized === "" || normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function assertServiceAuthEnvironment(): void {
  const config = loadConfig();
  if (isLoopbackHostname(config.hostname)) return;
  if (process.env.OPENCODEX_API_AUTH_TOKEN?.trim()) return;
  throw new Error(
    "OPENCODEX_API_AUTH_TOKEN is required before installing a service for non-loopback hostname. " +
      "Set it in the same shell, then rerun `ocx service install`.",
  );
}

function writeServiceApiTokenFile(): string | null {
  const token = process.env.OPENCODEX_API_AUTH_TOKEN?.trim();
  if (!token) return null;
  const path = serviceApiTokenFilePath();
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  return path;
}

export function buildPlist(): string {
  const { bun, cli } = cliEntry();
  const log = logPath();
  const path = process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const codexHome = process.env.CODEX_HOME?.trim();
  const opencodexHome = process.env.OPENCODEX_HOME?.trim();
  const envLines = [
    `    <key>OCX_SERVICE</key><string>1</string>`,
    `    <key>PATH</key><string>${plistString(path)}</string>`,
    codexHome ? `    <key>CODEX_HOME</key><string>${plistString(codexHome)}</string>` : null,
    opencodexHome ? `    <key>OPENCODEX_HOME</key><string>${plistString(opencodexHome)}</string>` : null,
  ].filter((line): line is string => Boolean(line)).join("\n");
  const command = buildServiceShellCommand(bun, cli);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-lc</string>
    <string>${plistString(command)}</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${envLines}
  </dict>
  <key>StandardOutPath</key><string>${plistString(log)}</string>
  <key>StandardErrorPath</key><string>${plistString(log)}</string>
</dict>
</plist>
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function buildServiceShellCommand(bun: string, cli: string): string {
  const tokenFile = serviceApiTokenFilePath();
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${shellQuote(cli)} start`;
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

function systemdOutputTarget(value: string): string {
  // StandardOutput/StandardError use output specifiers such as append:/path.
  // Quoting the full specifier makes systemd reject it as an invalid output target.
  return value.replace(/%/g, "%%").replace(/\n/g, "\\n");
}

function sh(cmd: string): string {
  return execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
}

function runFile(file: string, args: string[]): string {
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
}

function windowsSchtasks(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "schtasks.exe");
  return existsSync(candidate) ? candidate : "schtasks.exe";
}

function schtasks(args: string[]): string {
  return runFile(windowsSchtasks(), args);
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function windowsBatchSet(name: string, value: string | undefined): string | null {
  if (!value) return null;
  return `set "${name}=${windowsBatchValue(value)}"`;
}

export function buildWindowsServiceScript(entry = cliEntry()): string {
  const { bun, cli } = entry;
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "setlocal",
    windowsBatchSet("OCX_SERVICE", "1"),
    windowsBatchSet("PATH", path),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim()),
    windowsBatchSet("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim()),
    windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath()),
    windowsBatchSet("OCX_SERVICE_LOG", serviceLogPath()),
    windowsBatchSet("OCX_BUN", bun),
    windowsBatchSet("OCX_CLI", cli),
    'if exist "%OCX_API_TOKEN_FILE%" (',
    '  set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"',
    ")",
    ":loop",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] opencodex service wrapper start',
    '>>"%OCX_SERVICE_LOG%" echo bun="%OCX_BUN%"',
    '>>"%OCX_SERVICE_LOG%" echo cli="%OCX_CLI%"',
    '>>"%OCX_SERVICE_LOG%" echo opencodex_home="%OPENCODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo token_file="%OCX_API_TOKEN_FILE%"',
    '"%OCX_BUN%" "%OCX_CLI%" start >>"%OCX_SERVICE_LOG%" 2>&1',
    "if %ERRORLEVEL% NEQ 0 (",
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s',
    "  timeout /t 5 /nobreak >nul",
    "  goto loop",
    ")",
    "endlocal",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsSchtasksCreateArgs(script = windowsServiceScriptPath()): string[] {
  return ["/create", "/tn", TASK, "/tr", `"${script}"`, "/sc", "onlogon", "/rl", "LIMITED", "/f"];
}

// ── macOS (launchd) ──
function installLaunchd(): void {
  const dir = join(homedir(), "Library", "LaunchAgents");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  const p = plistPath();
  writeFileSync(p, buildPlist(), "utf8");
  try { sh(`launchctl unload "${p}" 2>/dev/null`); } catch { /* not loaded */ }
  sh(`launchctl load -w "${p}"`);
  writeServiceInstallState();
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
  writeServiceApiTokenFile();
  const script = windowsServiceScriptPath();
  writeFileSync(script, buildWindowsServiceScript(), "utf8");
  try { stopWindows(); } catch { /* not running */ }
  schtasks(buildWindowsSchtasksCreateArgs(script));
  schtasks(["/run", "/tn", TASK]);
  writeServiceInstallState();
}
function startWindows(): void { schtasks(["/run", "/tn", TASK]); }
function stopWindows(): void { try { schtasks(["/end", "/tn", TASK]); } catch { /* not running */ } }
function statusWindows(): string { try { return schtasks(["/query", "/tn", TASK]); } catch { return ""; } }
function uninstallWindows(): void {
  try { schtasks(["/delete", "/tn", TASK, "/f"]); } catch { /* absent */ }
  if (existsSync(windowsServiceScriptPath())) unlinkSync(windowsServiceScriptPath());
}

function serviceDiagnosticsSummary(): string {
  return `logs: ${serviceLogPath()}`;
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
  const opencodexHome = systemdEnvironmentAssignment("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim());
  const envLines = [
    systemdEnvironmentAssignment("OCX_SERVICE", "1"),
    systemdEnvironmentAssignment("PATH", path),
    codexHome,
    opencodexHome,
  ].filter((line): line is string => Boolean(line)).join("\n");
  return `[Unit]
Description=OpenCodex Proxy Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${systemdQuote("/bin/sh")} -lc ${systemdQuote(buildServiceShellCommand(bun, cli))}
Restart=on-failure
RestartSec=5
${envLines}
StandardOutput=${systemdOutputTarget(`append:${log}`)}
StandardError=${systemdOutputTarget(`append:${log}`)}

[Install]
WantedBy=default.target
`;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { return false; }
}

function installSystemd(): void {
  const dir = unitDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  writeFileSync(unitPath(), buildUnit(), "utf8");
  sh("systemctl --user daemon-reload");
  sh(`systemctl --user enable ${TASK}`);
  sh(`systemctl --user restart ${TASK}`);
  writeServiceInstallState();
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
    if (!isSystemd() && !existsSync(unitPath())) {
      console.error("systemd not found. Run 'ocx start' under your process supervisor.");
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

function stopTrackedProxyIfRunning(): boolean {
  const pid = readPid();
  if (!pid) return false;
  killProxy(pid);
  removePid(pid);
  return true;
}

function stopTrackedProxyForServiceCommand(): boolean {
  try {
    return stopTrackedProxyIfRunning();
  } catch (err) {
    console.error(`⚠️  Failed to stop proxy: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * If a service is installed, stop it so the process manager doesn't respawn after `ocx stop`.
 * Returns true if a service was found and stopped.
 */
export function stopServiceIfInstalled(): boolean {
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      try { stopLaunchd(); return true; } catch { return false; }
    }
  } else if (process.platform === "win32") {
    try {
      const q = schtasks(["/query", "/tn", TASK]);
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
  assertServiceEnvironmentMatchesInstall();
  if (process.platform === "darwin") {
    if (existsSync(plistPath())) {
      try { uninstallLaunchd(); return true; } catch { return false; }
    }
  } else if (process.platform === "win32") {
    try {
      const q = schtasks(["/query", "/tn", TASK]);
      if (q.includes(TASK)) { uninstallWindows(); return true; }
    } catch { /* task not found */ }
  } else if (process.platform === "linux" && existsSync(unitPath())) {
    try { uninstallSystemd(); return true; } catch {
      try { unlinkSync(unitPath()); return true; } catch { return false; }
    }
  }
  return false;
}

/** True if a background service (launchd/systemd/Task Scheduler) is installed. */
export function isServiceInstalled(): boolean {
  return serviceStatusSummary().startsWith("installed");
}

export function serviceStatusSummary(): string {
  const diagnostics = serviceDiagnosticsSummary();
  if (process.platform === "darwin") {
    if (!existsSync(plistPath())) return `not installed (${diagnostics})`;
    const status = statusLaunchd();
    return status ? `installed (launchd; ${diagnostics})` : `installed, not loaded (${diagnostics})`;
  }
  if (process.platform === "win32") {
    const status = statusWindows();
    return status ? `installed (Task Scheduler; ${diagnostics})` : `not installed (${diagnostics})`;
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) return "unsupported in Docker";
    if (!isSystemd()) return "unsupported: systemd not found";
    if (!existsSync(unitPath())) return `not installed (${diagnostics})`;
    const status = statusSystemd();
    return status ? `installed (systemd user; ${diagnostics})` : `installed, not running (${diagnostics})`;
  }
  return `unsupported on ${process.platform}`;
}

export function serviceCommand(sub?: string): void {
  const ops = platformOps();
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (sub) {
    case "install":
      assertServiceEnvironmentMatchesInstall();
      assertServiceAuthEnvironment();
      ops.install();
      console.log("✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
      if (process.platform === "linux") console.log("   For auto-start on boot: loginctl enable-linger $USER");
      break;
    case "start":
      ops.start();
      console.log("✅ service started.");
      break;
    case "stop":
      assertServiceEnvironmentMatchesInstall();
      ops.stop();
      stopTrackedProxyForServiceCommand();
      restoreNativeCodex();
      console.log("✅ service stopped + native Codex restored.");
      break;
    case "status": {
      const s = ops.status();
      console.log(s ? `✅ running:\n${s}` : "❌ service not installed/running.");
      console.log(`Diagnostics: ${serviceDiagnosticsSummary()}`);
      break;
    }
    case "uninstall":
    case "remove":
      assertServiceEnvironmentMatchesInstall();
      ops.stop();
      stopTrackedProxyForServiceCommand();
      ops.uninstall();
      restoreNativeCodex();
      for (const path of serviceStatePaths()) {
        try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
      }
      try { if (existsSync(serviceApiTokenFilePath())) unlinkSync(serviceApiTokenFilePath()); } catch { /* best-effort */ }
      console.log("✅ service uninstalled + native Codex restored.");
      break;
    default:
      console.error("Usage: ocx service <install|start|stop|status|uninstall>");
      process.exit(1);
  }
}
