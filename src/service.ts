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
import { expandUserPath, getConfigDir, readPid, removePid, removeRuntimePort } from "./config";
import { loadConfig } from "./config";
import { restoreNativeCodex } from "./codex/inject";
import { isWslRuntime } from "./codex/home";
import { durableBunPath, durableBunRuntime } from "./lib/bun-runtime";
import { isProcessAlive, stopProxy } from "./lib/process-control";
import { serviceApiTokenFilePath } from "./lib/service-secrets";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "./lib/win-paths";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

function cliEntry(): { bun: string; cli: string } {
  // Bake the bundled Bun (npm global prefix, survives `ocx update`) rather than
  // a transient system Bun, so launchd/systemd/schtasks keep resolving even if a
  // standalone Bun is later removed. The CLI entry lives at src/cli/index.ts.
  return { bun: durableBunPath(), cli: join(import.meta.dir, "cli", "index.ts") };
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

function windowsServiceVbsPath(): string {
  return join(getConfigDir(), "opencodex-service.vbs");
}

function windowsTaskXmlPath(): string {
  return join(getConfigDir(), "opencodex-service-task.xml");
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
  const raw = process.env.CODEX_HOME?.trim();
  return raw ? resolve(expandUserPath(raw)) : join(homedir(), ".codex");
}

function currentOpenCodexHome(): string {
  // getConfigDir() already resolves OPENCODEX_HOME with ~ expansion; keep the
  // install-state comparison on the same normalization or `~/...` values falsely
  // fail the environment-match check depending on cwd.
  return getConfigDir();
}

function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

interface ServiceInstallState {
  version: 1;
  codexHome: string;
  opencodexHome: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath?: string;
  cliPath?: string;
}

function writeServiceInstallState(): void {
  const { bun, cli } = cliEntry();
  const state: ServiceInstallState = {
    version: 1,
    codexHome: currentCodexHome(),
    opencodexHome: currentOpenCodexHome(),
    bunPath: bun,
    cliPath: cli,
  };
  for (const path of serviceStatePaths()) {
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(path, JSON.stringify(state, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
    try { chmodSync(path, 0o600); } catch { /* best-effort */ }
    if (process.platform === "win32") hardenSecretPath(path, { required: true });
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
  if (process.platform === "win32") hardenSecretDir(dir, { required: true });
  writeFileSync(path, `${token}\n`, { encoding: "utf8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort */ }
  if (process.platform === "win32") hardenSecretPath(path, { required: true });
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

type WindowsBatchValueKind = "raw" | "path" | "pathList";

function windowsBatchSet(name: string, value: string | undefined, kind: WindowsBatchValueKind = "raw"): string | null {
  if (!value) return null;
  const rendered =
    kind === "path" ? windowsEnvIndirectBatchValue(value, windowsBatchValue)
    : kind === "pathList" ? windowsEnvIndirectBatchPathList(value, windowsBatchValue)
    : windowsBatchValue(value);
  return `set "${name}=${rendered}"`;
}

function taskXmlString(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function buildWindowsServiceScript(entry = cliEntry()): string {
  const { bun, cli } = entry;
  const bunRuntime = durableBunRuntime();
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "setlocal",
    // The wrapper is launched via a hidden WScript helper, so switching that console to UTF-8 is
    // safe (no leak into user shells) and lets cmd parse any UTF-8 remnants correctly.
    "chcp 65001 >nul",
    windowsBatchSet("OCX_SERVICE", "1"),
    windowsBatchSet("PATH", path, "pathList"),
    windowsBatchSet("CODEX_HOME", process.env.CODEX_HOME?.trim(), "path"),
    windowsBatchSet("OPENCODEX_HOME", process.env.OPENCODEX_HOME?.trim(), "path"),
    windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath(), "path"),
    windowsBatchSet("OCX_SERVICE_LOG", serviceLogPath(), "path"),
    windowsBatchSet("OCX_BUN", bun, "path"),
    windowsBatchSet("OCX_CLI", cli, "path"),
    'if exist "%OCX_API_TOKEN_FILE%" (',
    '  set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"',
    ")",
    ":loop",
    '>>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] opencodex service wrapper start',
    '>>"%OCX_SERVICE_LOG%" echo bun="%OCX_BUN%"',
    `>>"%OCX_SERVICE_LOG%" echo bun_source="${bunRuntime.source}"`,
    '>>"%OCX_SERVICE_LOG%" echo cli="%OCX_CLI%"',
    '>>"%OCX_SERVICE_LOG%" echo opencodex_home="%OPENCODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo codex_home="%CODEX_HOME%"',
    '>>"%OCX_SERVICE_LOG%" echo token_file="%OCX_API_TOKEN_FILE%"',
    '"%OCX_BUN%" "%OCX_CLI%" start >>"%OCX_SERVICE_LOG%" 2>&1',
    "if %ERRORLEVEL% NEQ 0 (",
    '  >>"%OCX_SERVICE_LOG%" echo [%DATE% %TIME%] child exited with code %ERRORLEVEL%; restarting in 5s',
    // `timeout` needs console stdin and dies with "Input redirection is not supported"
    // under Task Scheduler, turning the 5s cooldown into a hot restart loop; ping doesn't.
    "  ping -n 6 127.0.0.1 >nul",
    "  goto loop",
    ")",
    "endlocal",
  ].filter((line): line is string => Boolean(line));
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsSchtasksCreateArgs(script = windowsServiceScriptPath()): string[] {
  const xml = script === windowsServiceScriptPath() ? windowsTaskXmlPath() : `${script}.xml`;
  return ["/create", "/tn", TASK, "/xml", xml, "/f"];
}

/**
 * Hidden launcher for the service `.cmd`. Task Scheduler Exec of a console-subsystem
 * batch paints a visible window; WScript Run with window style 0 does not.
 * WaitOnReturn must be True so the scheduled task stays Running while the wrapper
 * (and proxy) are alive — False returns immediately and Task Scheduler flips to Ready.
 */
export function buildWindowsServiceVbs(script = windowsServiceScriptPath()): string {
  const escaped = script.replace(/"/g, '""');
  return `CreateObject("WScript.Shell").Run """${escaped}""", 0, True\r\n`;
}

export function buildWindowsTaskXml(vbs = windowsServiceVbsPath()): string {
  const escapedArgs = taskXmlString(`//B //Nologo "${vbs}"`);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>OpenCodex proxy service wrapper</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>${escapedArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
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
/**
 * In-place service-asset write that tolerates the transient EBUSY/EPERM/EACCES Windows
 * throws while the just-ended task's cmd.exe (or an AV scanner) still holds the file.
 */
function writeServiceAssetWithRetry(path: string, content: string, encoding: "utf8" | "utf16le"): void {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(path, content, encoding);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= 2 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw err;
      Bun.sleepSync(150);
    }
  }
}

function installWindows(): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  // End a running task BEFORE rewriting the assets it is executing — cmd.exe reading the
  // script mid-rewrite runs a torn batch file, and its open handle can fail the write.
  try { stopWindows(); } catch { /* not running */ }
  const script = windowsServiceScriptPath();
  const vbs = windowsServiceVbsPath();
  writeServiceAssetWithRetry(script, buildWindowsServiceScript(), "utf8");
  writeServiceAssetWithRetry(vbs, buildWindowsServiceVbs(script), "utf8");
  writeServiceAssetWithRetry(windowsTaskXmlPath(), `\uFEFF${buildWindowsTaskXml(vbs)}`, "utf16le");
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
  if (existsSync(windowsServiceVbsPath())) unlinkSync(windowsServiceVbsPath());
  if (existsSync(windowsTaskXmlPath())) unlinkSync(windowsTaskXmlPath());
}

/**
 * Warn when the paths baked into installed service assets no longer exist (npm prefix
 * moved, nvm switch, reinstall) — the service manager would restart-loop on a dead path
 * while `schtasks`/`launchctl` still report "installed".
 */
export function bakedServicePathsDiagnostic(): string | null {
  const state = readServiceInstallState();
  if (!state?.bunPath || !state?.cliPath) return null;
  const missing = [state.bunPath, state.cliPath].filter(path => !existsSync(path));
  if (missing.length === 0) return null;
  return `STALE baked paths (missing: ${missing.join(", ")}) — run 'ocx service install' to re-bake`;
}

function serviceDiagnosticsSummary(): string {
  const stale = bakedServicePathsDiagnostic();
  return stale ? `${stale}; logs: ${serviceLogPath()}` : `logs: ${serviceLogPath()}`;
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

/** The per-user runtime dir systemd creates (holds the user-bus socket), or null. */
function userRuntimeDir(): string | null {
  const fromEnv = process.env.XDG_RUNTIME_DIR;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (typeof process.getuid === "function") {
    const candidate = `/run/user/${process.getuid()}`;
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * SSH sessions frequently start without `XDG_RUNTIME_DIR`/`DBUS_SESSION_BUS_ADDRESS`, so
 * `systemctl --user` can't find the user bus even when systemd is running. Point `XDG_RUNTIME_DIR`
 * at the per-user runtime dir when it exists so the `--user` probe and install commands reach the
 * bus. No-op when already set or when no runtime dir exists (e.g. genuinely non-systemd hosts).
 */
function ensureUserBusEnv(): void {
  if (process.env.XDG_RUNTIME_DIR) return;
  const dir = userRuntimeDir();
  if (dir) process.env.XDG_RUNTIME_DIR = dir;
}

function isSystemd(): boolean {
  try { execSync("systemctl --version", { stdio: "pipe" }); } catch { return false; }
  ensureUserBusEnv();
  // Prefer the user-bus probe; but an SSH session without a user D-Bus fails it even when systemd
  // is present (F9). Fall back to the per-user runtime dir existing — a strong signal the user
  // systemd instance is available — so a first-time `ocx service install` isn't wrongly refused.
  try { execSync("systemctl --user show-environment", { stdio: "pipe" }); return true; } catch { /* no user bus in this session */ }
  return userRuntimeDir() !== null;
}

function installSystemd(): void {
  ensureUserBusEnv(); // reach the user bus over a bare SSH session (F9)
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
function startSystemd(): void {
  ensureUserBusEnv();
  if (!existsSync(unitPath())) {
    console.error(`opencodex service is not installed: ${unitPath()}`);
    console.error("Run `ocx service install` first to create and enable the systemd user unit.");
    process.exit(1);
  }
  sh(`systemctl --user start ${TASK}`);
}
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
      if (isWslRuntime()) {
        console.error("WSL detected: enable systemd by adding [boot] systemd=true to /etc/wsl.conf, then run 'wsl --shutdown' from Windows and reopen the distro (WSL 0.67.6+).");
      }
      process.exit(1);
    }
    return { install: installSystemd, start: startSystemd, stop: stopSystemd, status: statusSystemd, uninstall: uninstallSystemd };
  }
  return null;
}

type TrackedProxyCleanupResult = "none" | "stale" | "stopped";

async function stopTrackedProxyIfRunning(): Promise<TrackedProxyCleanupResult> {
  const pid = readPid();
  if (!pid) return "none";
  if (!isProcessAlive(pid)) {
    removePid(pid);
    removeRuntimePort(pid);
    return "stale";
  }
  await stopProxy(pid);
  removePid(pid);
  removeRuntimePort(pid);
  return "stopped";
}

async function stopTrackedProxyForServiceCommand(): Promise<TrackedProxyCleanupResult> {
  try {
    return await stopTrackedProxyIfRunning();
  } catch (err) {
    console.error(`⚠️  Failed to stop proxy: ${err instanceof Error ? err.message : String(err)}`);
    return "none";
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

/** Delete install-state files; stale state would make `ocx update` "reinstall" a service that no longer exists. */
function removeServiceInstallState(): void {
  for (const path of serviceStatePaths()) {
    try { if (existsSync(path)) unlinkSync(path); } catch { /* best-effort */ }
  }
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
      try { uninstallLaunchd(); removeServiceInstallState(); return true; } catch { return false; }
    }
  } else if (process.platform === "win32") {
    try {
      const q = schtasks(["/query", "/tn", TASK]);
      if (q.includes(TASK)) { uninstallWindows(); removeServiceInstallState(); return true; }
    } catch { /* task not found */ }
  } else if (process.platform === "linux" && existsSync(unitPath())) {
    try { uninstallSystemd(); removeServiceInstallState(); return true; } catch {
      try { unlinkSync(unitPath()); removeServiceInstallState(); return true; } catch { return false; }
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

export function normalizeServiceSubcommand(sub?: string): string {
  return sub ?? "install";
}

export async function serviceCommand(sub?: string): Promise<void> {
  const ops = platformOps();
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  const command = normalizeServiceSubcommand(sub);
  switch (command) {
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
      await stopTrackedProxyForServiceCommand();
      {
        const restore = restoreNativeCodex();
        if (restore.success) console.log("✅ service stopped + native Codex restored.");
        else console.error(`⚠️ service stopped, but native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` (or check $CODEX_HOME/config.toml) before using native Codex.`);
      }
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
      await stopTrackedProxyForServiceCommand();
      ops.uninstall();
      {
        const restore = restoreNativeCodex();
        if (!restore.success) {
          console.error(`⚠️ native Codex restore FAILED: ${restore.message}\nRun \`ocx restore\` before using native Codex.`);
        }
      }
      removeServiceInstallState();
      try { if (existsSync(serviceApiTokenFilePath())) unlinkSync(serviceApiTokenFilePath()); } catch { /* best-effort */ }
      console.log("✅ service uninstalled.");
      break;
    default:
      console.error("Usage: ocx service [install|start|stop|status|uninstall|remove]");
      console.error("       With no subcommand, installs/updates and starts the background service.");
      process.exit(1);
  }
}
