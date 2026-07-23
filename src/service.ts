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
import { defaultWinswEntry, installWinswService, startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswStatusSummary, WINSW_SERVICE_ID, WINSW_SHA256, WINSW_VERSION } from "./lib/winsw";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "./lib/win-paths";

const LABEL = "com.opencodex.proxy";
const TASK = "opencodex-proxy";

export type ServiceBackend = "scheduler" | "native";

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

function windowsLauncherVbsPath(): string {
  return join(getConfigDir(), "opencodex-service-launcher.vbs");
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

export interface ServiceInstallState {
  version: 1 | 2;
  codexHome: string;
  opencodexHome: string;
  /** Baked at install; lets status flag paths gone stale after npm prefix/nvm moves. */
  bunPath?: string;
  cliPath?: string;
  /** v2: which Windows backend was chosen at install; absent (v1/legacy) means scheduler. */
  backend?: ServiceBackend;
  winswVersion?: string;
  winswSha256?: string;
}

export function parseServiceInstallState(value: unknown): ServiceInstallState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const state = value as Record<string, unknown>;
  if (state.version !== 1 && state.version !== 2) return null;
  if (typeof state.codexHome !== "string" || state.codexHome.length === 0) return null;
  if (typeof state.opencodexHome !== "string" || state.opencodexHome.length === 0) return null;
  for (const key of ["bunPath", "cliPath", "winswVersion", "winswSha256"] as const) {
    if (state[key] !== undefined && (typeof state[key] !== "string" || state[key].length === 0)) return null;
  }
  if (state.version === 1) {
    if (state.backend !== undefined) return null;
  } else if (state.backend !== "scheduler" && state.backend !== "native") {
    return null;
  }
  return state as unknown as ServiceInstallState;
}

function writeServiceInstallState(backend: ServiceBackend = "scheduler"): void {
  const { bun, cli } = cliEntry();
  const state: ServiceInstallState = {
    version: 2,
    codexHome: currentCodexHome(),
    opencodexHome: currentOpenCodexHome(),
    bunPath: bun,
    cliPath: cli,
    backend,
    ...(backend === "native" ? { winswVersion: WINSW_VERSION, winswSha256: WINSW_SHA256 } : {}),
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
      const parsed = parseServiceInstallState(JSON.parse(readFileSync(path, "utf8")));
      if (parsed) return parsed;
    } catch {
      /* try the next known state path */
    }
  }
  return null;
}

/** Single accessor for update/reinstall code — v1/legacy state maps to scheduler. */
export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/** The `ocx` argv that reinstalls the currently-chosen service backend (update paths). */
export function serviceReinstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
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

/**
 * Listen port baked into service wrappers / WinSW XML.
 * Priority: explicit override → OCX_BAKE_PORT (update restart) → config.port → 10100.
 * `config.port === 0` means ephemeral for interactive start; services need a stable pin,
 * so treat 0 / invalid like unset (default 10100) instead of baking `--port 0`.
 */
export function resolveServiceListenPort(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override > 0 && override <= 65535) {
    return Math.trunc(override);
  }
  const baked = process.env.OCX_BAKE_PORT?.trim();
  if (baked && /^\d+$/.test(baked)) {
    const n = Number(baked);
    if (n > 0 && n <= 65535) return n;
  }
  const configured = loadConfig().port;
  if (typeof configured === "number" && configured > 0 && configured <= 65535) return configured;
  return 10100;
}

function buildServiceShellCommand(bun: string, cli: string, port = resolveServiceListenPort()): string {
  const tokenFile = serviceApiTokenFilePath();
  return `if [ -f ${shellQuote(tokenFile)} ]; then OPENCODEX_API_AUTH_TOKEN="$(cat ${shellQuote(tokenFile)})"; export OPENCODEX_API_AUTH_TOKEN; fi; exec ${shellQuote(bun)} ${shellQuote(cli)} start --port ${port}`;
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

function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
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

export function buildWindowsServiceScript(entry = cliEntry(), port = resolveServiceListenPort()): string {
  const { bun, cli } = entry;
  const bunRuntime = durableBunRuntime();
  const path = process.env.PATH ?? "";
  const lines = [
    "@echo off",
    "setlocal",
    // The wrapper console is hidden by the wscript launcher (window style 0), so switching
    // it to UTF-8 is safe (no leak into user shells) and lets cmd parse UTF-8 remnants.
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
    `"%OCX_BUN%" "%OCX_CLI%" start --port ${port} >>"%OCX_SERVICE_LOG%" 2>&1`,
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
 * VBS launcher that starts the batch wrapper with a hidden window (style 0).
 * bWaitOnReturn=True keeps wscript.exe resident for the wrapper's lifetime so the
 * scheduled task stays "running": MultipleInstancesPolicy=IgnoreNew keeps preventing
 * duplicates and `schtasks /end` still has a live task instance to stop. Without the
 * launcher, the console batch action shows a closable cmd window in the interactive
 * session (issue #165). VBS string literals escape `"` as `""`.
 */
export function buildWindowsLauncherVbs(script = windowsServiceScriptPath()): string {
  const escaped = script.replace(/"/g, '""');
  const lines = [
    "' OpenCodex service launcher — runs the batch wrapper with a hidden window.",
    "' Generated by `ocx service install`; do not edit.",
    'Set shell = CreateObject("WScript.Shell")',
    // WshShell.Run(command, windowStyle 0 = hidden, bWaitOnReturn True = stay resident).
    `shell.Run """${escaped}""", 0, True`,
  ];
  return `${lines.join("\r\n")}\r\n`;
}

export function buildWindowsTaskXml(script = windowsServiceScriptPath(), launcher = windowsLauncherVbsPath()): string {
  const escapedWscript = taskXmlString(windowsWscript());
  // Escape the launcher path independently for the <Arguments> element; quoting it
  // keeps spaces intact, and /b (batch mode) suppresses script error popups.
  const escapedLauncherArgs = taskXmlString(`/b /nologo "${launcher}"`);
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
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapedWscript}</Command>
      <Arguments>${escapedLauncherArgs}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

function taskXmlSection(xml: string, tag: string): string {
  return new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i").exec(xml)?.[1] ?? "";
}

/** Validate the security/lifecycle-critical fields of the registered scheduler task. */
export function windowsTaskRegistrationHealthy(
  xml: string,
  wscript = windowsWscript(),
  launcher = windowsLauncherVbsPath(),
): boolean {
  const trigger = taskXmlSection(xml, "LogonTrigger");
  const principal = taskXmlSection(xml, "Principal");
  const settings = taskXmlSection(xml, "Settings");
  const action = taskXmlSection(xml, "Exec");
  return /<Enabled>\s*true\s*<\/Enabled>/i.test(trigger)
    && /<LogonType>\s*InteractiveToken\s*<\/LogonType>/i.test(principal)
    && /<RunLevel>\s*LeastPrivilege\s*<\/RunLevel>/i.test(principal)
    && /<Enabled>\s*true\s*<\/Enabled>/i.test(settings)
    && /<MultipleInstancesPolicy>\s*IgnoreNew\s*<\/MultipleInstancesPolicy>/i.test(settings)
    && /<ExecutionTimeLimit>\s*PT0S\s*<\/ExecutionTimeLimit>/i.test(settings)
    && action.includes(`<Command>${taskXmlString(wscript)}</Command>`)
    && action.includes(`<Arguments>${taskXmlString(`/b /nologo "${launcher}"`)}</Arguments>`);
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
  // Transactional backend switch: installing the scheduler backend removes a native
  // service first — two live managers would both respawn the proxy (conflict).
  if (statusWinswRaw() !== "nonexistent") {
    console.log("🔁 Removing the native (WinSW) service before installing the Task Scheduler backend...");
    try {
      uninstallWinswService();
    } catch (err) {
      throw new Error(`Cannot remove the native service before switching to Task Scheduler: ${err instanceof Error ? err.message : String(err)}. Remove it manually with 'sc delete ${WINSW_SERVICE_ID}' or retry.`);
    }
    if (statusWinswRaw() !== "nonexistent") {
      throw new Error(`Native service registration could not be re-verified after the removal attempt — aborting switch. Check 'sc.exe query ${WINSW_SERVICE_ID}' and remove it manually if present.`);
    }
  }
  // End a running task BEFORE rewriting the assets it is executing — cmd.exe reading the
  // script mid-rewrite runs a torn batch file, and its open handle can fail the write.
  try { stopWindows(); } catch { /* not running */ }
  const script = windowsServiceScriptPath();
  writeServiceAssetWithRetry(script, buildWindowsServiceScript(), "utf8");
  // UTF-16LE + BOM: a BOM-less UTF-8 VBS mis-decodes non-ASCII (e.g. Korean) profile
  // paths on some WSH/codepage combinations — same contract as the task XML below.
  writeServiceAssetWithRetry(windowsLauncherVbsPath(), `\uFEFF${buildWindowsLauncherVbs(script)}`, "utf16le");
  writeServiceAssetWithRetry(windowsTaskXmlPath(), `\uFEFF${buildWindowsTaskXml(script)}`, "utf16le");
  schtasks(buildWindowsSchtasksCreateArgs(script));
  schtasks(["/run", "/tn", TASK]);
  writeServiceInstallState("scheduler");
}

/**
 * Opt-in native backend (`ocx service install --native`). Transactional: removes the
 * scheduler backend first; on failure the machine is left with NO service (explicitly
 * reported) — never a silent fallback to the scheduler.
 */
async function installWindowsNative(): Promise<void> {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeServiceApiTokenFile();
  let hadScheduler = false;
  try {
    hadScheduler = schtasks(["/query", "/tn", TASK]).includes(TASK);
  } catch { /* task absent */ }
  if (hadScheduler) {
    console.log("🔁 Removing the Task Scheduler backend before installing the native (WinSW) service...");
    try { stopWindows(); } catch { /* not running */ }
    try {
      uninstallWindows();
    } catch (err) {
      throw new Error(`Cannot remove the Task Scheduler backend before switching to native: ${err instanceof Error ? err.message : String(err)}`);
    }
    // Verify removal — schtasks /delete can silently fail if UAC or policy blocks it.
    try {
      if (schtasks(["/query", "/tn", TASK]).includes(TASK)) {
        throw new Error("Task Scheduler backend still present after removal — aborting switch.");
      }
    } catch (e) {
      if (e instanceof Error && e.message.includes("still present")) throw e;
      /* query failure = task absent, which is what we want */
    }
  }
  try {
    await installWinswService(defaultWinswEntry(import.meta.dir));
  } catch (err) {
    if (hadScheduler) console.error("⚠️  Native install failed AFTER removing the Task Scheduler backend — no service is installed now. Run `ocx service install` to restore the scheduler backend, or retry `--native`.");
    throw err;
  }
  writeServiceInstallState("native");
}
function startWindows(): void { schtasks(["/run", "/tn", TASK]); }
function stopWindows(): void { try { schtasks(["/end", "/tn", TASK]); } catch { /* not running */ } }
function statusWindows(): string { try { return schtasks(["/query", "/tn", TASK]); } catch { return ""; } }
function statusWindowsXml(): string { try { return schtasks(["/query", "/tn", TASK, "/xml"]); } catch { return ""; } }
function uninstallWindows(): void {
  try { schtasks(["/delete", "/tn", TASK, "/f"]); } catch { /* absent */ }
  if (existsSync(windowsServiceScriptPath())) unlinkSync(windowsServiceScriptPath());
  if (existsSync(windowsLauncherVbsPath())) unlinkSync(windowsLauncherVbsPath());
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
  install: () => void | Promise<void>; start: () => void; stop: () => void;
  status: () => string; uninstall: () => void;
};

function platformOps(backend: ServiceBackend = "scheduler"): ServiceOps | null {
  if (process.platform === "darwin")
    return { install: installLaunchd, start: startLaunchd, stop: stopLaunchd, status: statusLaunchd, uninstall: uninstallLaunchd };
  if (process.platform === "win32") {
    if (backend === "native")
      return { install: installWindowsNative, start: startWinswService, stop: stopWinswService, status: winswStatusSummary, uninstall: uninstallWinswService };
    return { install: installWindows, start: startWindows, stop: stopWindows, status: statusWindows, uninstall: uninstallWindows };
  }
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
    // Query BOTH backends regardless of state: a failed switch or stale state can leave
    // two managers installed, and either one would respawn the proxy after `ocx stop`.
    let stopped = false;
    try {
      const q = schtasks(["/query", "/tn", TASK]);
      if (q.includes(TASK)) { stopWindows(); stopped = true; }
    } catch { /* task not found */ }
    if (statusWinswRaw() !== "nonexistent") {
      try { stopWinswService(); stopped = true; } catch { /* best-effort */ }
    }
    if (stopped) return true;
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
    let removed = false;
    try {
      const q = schtasks(["/query", "/tn", TASK]);
      if (q.includes(TASK)) { uninstallWindows(); removed = true; }
    } catch { /* task not found */ }
    if (statusWinswRaw() !== "nonexistent") {
      try {
        uninstallWinswService();
        removed = true;
      } catch (err) {
        console.warn(`⚠️  Failed to remove native service: ${err instanceof Error ? err.message : String(err)}. Check 'sc.exe query ${WINSW_SERVICE_ID}'.`);
      }
    }
    if (removed) { removeServiceInstallState(); return true; }
  } else if (process.platform === "linux" && existsSync(unitPath())) {
    try { uninstallSystemd(); removeServiceInstallState(); return true; } catch {
      try { unlinkSync(unitPath()); removeServiceInstallState(); return true; } catch { return false; }
    }
  }
  return false;
}

/** True if a background service (launchd/systemd/Task Scheduler) is installed. */
export function isServiceInstalled(): boolean {
  return diagnoseService().installed;
}

export interface ServiceDiagnostic {
  supported: boolean;
  installed: boolean;
  enabled: boolean;
  running: boolean;
  viable: boolean;
  startable: boolean;
  stale: boolean;
  conflict: boolean;
  backend: ServiceBackend | "launchd" | "systemd" | null;
  summary: string;
}

/** Windows tray may restart a healthy-but-stopped native service; stale/conflicting installs remain blocked. */
export function serviceStartableFromTray(service: ServiceDiagnostic): boolean {
  return service.startable && !service.stale && !service.conflict;
}

export interface WindowsServiceDiagnosticInputs {
  schedulerInstalled: boolean;
  schedulerEnabled: boolean;
  schedulerAssetsHealthy: boolean;
  nativeStatus: "started" | "stopped" | "nonexistent" | "unknown";
  recordedBackend: ServiceBackend | null;
  staleBakedPaths: boolean;
  nativeRepairAssetsOnly: boolean;
  diagnostics: string;
}

export function deriveWindowsServiceDiagnostic(inputs: WindowsServiceDiagnosticInputs): ServiceDiagnostic {
  const nativeInstalled = inputs.nativeStatus !== "nonexistent";
  const conflict = inputs.schedulerInstalled && nativeInstalled;
  const backendStateMismatch = inputs.schedulerInstalled
    ? inputs.recordedBackend !== "scheduler"
    : nativeInstalled && inputs.recordedBackend !== "native";
  const stale = inputs.staleBakedPaths
    || (inputs.schedulerInstalled && !inputs.schedulerAssetsHealthy)
    || backendStateMismatch
    || (inputs.nativeStatus === "nonexistent" && inputs.nativeRepairAssetsOnly);
  const backend = inputs.schedulerInstalled ? "scheduler" : nativeInstalled ? "native" : null;
  const enabled = inputs.schedulerInstalled ? inputs.schedulerEnabled : inputs.nativeStatus === "started";
  const running = nativeInstalled ? inputs.nativeStatus === "started" : inputs.schedulerInstalled && inputs.schedulerEnabled;
  const viable = !conflict && !stale
    && (inputs.schedulerInstalled ? inputs.schedulerEnabled && inputs.schedulerAssetsHealthy : inputs.nativeStatus === "started");
  const startable = !conflict && !stale
    && (inputs.schedulerInstalled
      ? inputs.schedulerEnabled && inputs.schedulerAssetsHealthy
      : inputs.nativeStatus === "started" || inputs.nativeStatus === "stopped");
  const detail = conflict
    ? "CONFLICT: Task Scheduler and native WinSW are both present — run 'ocx service uninstall' then reinstall one"
    : stale
      ? "stale or missing service assets — run 'ocx service install' to repair"
      : inputs.schedulerInstalled
        ? inputs.schedulerEnabled ? "Task Scheduler enabled" : "Task Scheduler disabled"
        : nativeInstalled
          ? `native (WinSW ${WINSW_VERSION}): ${inputs.nativeStatus}`
          : "not installed";
  const summary = backend ? `installed, ${detail} (${inputs.diagnostics})` : `not installed (${inputs.diagnostics})`;
  return {
    supported: true,
    installed: inputs.schedulerInstalled || nativeInstalled,
    enabled,
    running,
    viable,
    startable,
    stale,
    conflict,
    backend,
    summary,
  };
}

/**
 * Fail-closed restart diagnostic. Presence alone is never enough: conflicting
 * managers, stale baked paths, disabled registrations, and unknown/stopped
 * native managers cannot claim that Codex will reconnect after a reboot.
 */
export function diagnoseService(): ServiceDiagnostic {
  const diagnostics = serviceDiagnosticsSummary();
  if (process.platform === "darwin") {
    const installed = existsSync(plistPath());
    const running = installed && Boolean(statusLaunchd());
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (launchd; ${diagnostics})`
        : running ? `installed and loaded (launchd; ${diagnostics})`
          : `installed, not loaded (launchd; ${diagnostics})`;
    return { supported: true, installed, enabled: running, running, viable, startable: installed && !stale, stale, conflict: false, backend: "launchd", summary };
  }
  if (process.platform === "win32") {
    const schedulerXml = statusWindowsXml();
    const schedulerInstalled = schedulerXml.length > 0;
    const schedulerSettings = taskXmlSection(schedulerXml, "Settings");
    const schedulerEnabled = schedulerInstalled && /<Enabled>\s*true\s*<\/Enabled>/i.test(schedulerSettings);
    const schedulerAssets = [windowsServiceScriptPath(), windowsLauncherVbsPath(), windowsTaskXmlPath()].every(existsSync)
      && windowsTaskRegistrationHealthy(schedulerXml);
    const nativeStatus = statusWinswRaw();
    const installState = readServiceInstallState();
    const recordedBackend: ServiceBackend | null = !installState
      ? null
      : installState.backend === "native" ? "native" : "scheduler";
    return deriveWindowsServiceDiagnostic({
      schedulerInstalled,
      schedulerEnabled,
      schedulerAssetsHealthy: schedulerAssets,
      nativeStatus,
      recordedBackend,
      staleBakedPaths: bakedServicePathsDiagnostic() !== null,
      nativeRepairAssetsOnly: Boolean(winswStatusSummary()),
      diagnostics,
    });
  }
  if (process.platform === "linux") {
    if (existsSync("/.dockerenv")) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported in Docker" };
    if (!isSystemd()) return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: "unsupported: systemd not found" };
    const installed = existsSync(unitPath());
    const enabled = installed && (() => { try { return sh(`systemctl --user is-enabled ${TASK}`) === "enabled"; } catch { return false; } })();
    const running = installed && (() => { try { return sh(`systemctl --user is-active ${TASK}`) === "active"; } catch { return false; } })();
    const stale = installed && bakedServicePathsDiagnostic() !== null;
    const viable = installed && enabled && running && !stale;
    const summary = !installed ? `not installed (${diagnostics})`
      : stale ? `installed, but stale (systemd user; ${diagnostics})`
        : viable ? `installed, enabled and running (systemd user; ${diagnostics})`
          : `installed, but ${!enabled ? "disabled" : "not running"} (systemd user; ${diagnostics})`;
    return { supported: true, installed, enabled, running, viable, startable: installed && !stale, stale, conflict: false, backend: "systemd", summary };
  }
  return { supported: false, installed: false, enabled: false, running: false, viable: false, startable: false, stale: false, conflict: false, backend: null, summary: `unsupported on ${process.platform}` };
}

export function serviceStatusSummary(): string {
  return diagnoseService().summary;
}

export function normalizeServiceSubcommand(sub?: string): string {
  return sub ?? "install";
}

export interface ParsedServiceArgs {
  sub: string;
  backend: ServiceBackend | null;
  invalid: string[];
}

/**
 * `ocx service [sub] [--native|--scheduler]`. The first non-flag token is the
 * subcommand; backend flags are only meaningful for `install` (validated by the caller).
 */
export function parseServiceArgs(args: string[]): ParsedServiceArgs {
  let sub: string | undefined;
  let backend: ServiceBackend | null = null;
  const invalid: string[] = [];
  for (const arg of args) {
    if (arg === "--native") {
      if (backend === "scheduler") { invalid.push("--native (conflicts with --scheduler)"); continue; }
      backend = "native";
    }
    else if (arg === "--scheduler") {
      if (backend === "native") { invalid.push("--scheduler (conflicts with --native)"); continue; }
      backend = "scheduler";
    }
    else if (arg.startsWith("--")) invalid.push(arg);
    else if (sub === undefined) sub = arg;
    else invalid.push(arg);
  }
  return { sub: normalizeServiceSubcommand(sub), backend, invalid };
}

export async function serviceCommand(...args: (string | undefined)[]): Promise<void> {
  const parsed = parseServiceArgs(args.filter((a): a is string => Boolean(a)));
  const command = parsed.sub;
  if (parsed.invalid.length > 0) {
    console.error(`Unknown service option: ${parsed.invalid.join(" ")}`);
    process.exit(1);
  }
  if (parsed.backend && command !== "install") {
    console.error("--native/--scheduler apply to `ocx service install` only; other subcommands use the installed backend.");
    process.exit(1);
  }
  if (parsed.backend === "native" && process.platform !== "win32") {
    console.error("--native (WinSW) is Windows-only.");
    process.exit(1);
  }
  // Non-install subcommands follow the backend recorded at install time (state v2).
  const backend: ServiceBackend = parsed.backend ?? (process.platform === "win32" ? readServiceBackend() : "scheduler");
  const ops = platformOps(backend);
  if (!ops) {
    console.error("ocx service supports macOS (launchd), Windows (Task Scheduler), and Linux (systemd).");
    process.exit(1);
  }
  switch (command) {
    case "install":
      assertServiceEnvironmentMatchesInstall();
      assertServiceAuthEnvironment();
      await ops.install();
      console.log(backend === "native"
        ? "✅ opencodex native service installed + started (windowless, starts at boot, auto-restarts on crash)."
        : "✅ opencodex service installed + started (auto-starts on login, auto-restarts on crash).");
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
      try { ops.stop(); } catch (err) {
        console.warn(`⚠️  Service stop failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      await stopTrackedProxyForServiceCommand();
      try {
        ops.uninstall();
      } catch (err) {
        console.error(`❌ Service uninstall failed: ${err instanceof Error ? err.message : String(err)}`);
        console.error("The service may still be installed. Check with 'ocx service status' or remove manually.");
        process.exit(1);
      }
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
      console.error("Usage: ocx service [install|start|stop|status|uninstall|remove] [--native|--scheduler]");
      console.error("       With no subcommand, installs/updates and starts the background service.");
      console.error("       --native (Windows only): register a real SCM service via WinSW instead of Task Scheduler.");
      process.exit(1);
  }
}
