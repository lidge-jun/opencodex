/**
 * `ocx service` â€” run the proxy as a background service that auto-starts on login and
 * auto-restarts on crash. macOS â†’ launchd; Windows â†’ Task Scheduler; Linux â†’ systemd user unit.
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
import { stripGrokConfig } from "./grok/inject";
import { isWslRuntime } from "./codex/home";
import { durableBunPath, durableBunRuntime } from "./lib/bun-runtime";
import { isProcessAlive, stopProxy } from "./lib/process-control";
import { serviceApiTokenFilePath } from "./lib/service-secrets";
import { randomUUID } from "node:crypto";
import {
  ELEVATION_REQUEST_TIMEOUT_MS,
  OCX_ELEVATED_PROTOCOL_FAILED,
  raceWithTimeout,
  resolveTrustedWindowsSchtasksExe,
  startElevatedSchtasksCreateAndRun,
  runWindowsElevated,
  toWindowsSchtasksError,
  WindowsElevationError,
  type ElevatedSchedulerOutcome,
  type ElevatedSchtasksCreateAndRunExecution,
  type ElevatedSchtasksCreateAndRunResult,
} from "./lib/windows-elevation";
import { defaultWinswEntry, installWinswService, startWinswService, stopWinswService, statusWinswRaw, uninstallWinswService, winswStatusSummary, WINSW_SERVICE_ID, WINSW_SHA256, WINSW_VERSION } from "./lib/winsw";
import { hardenSecretDir, hardenSecretPath } from "./lib/windows-secret-acl";
import { windowsEnvIndirectBatchPathList, windowsEnvIndirectBatchValue } from "./lib/win-paths";
import { recordOwnedConfigPath } from "./lib/config-ownership";

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
    recordOwnedConfigPath(getConfigDir(), path);
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

/** Single accessor for update/reinstall code â€” v1/legacy state maps to scheduler. */
export function readServiceBackend(): ServiceBackend {
  return readServiceInstallState()?.backend === "native" ? "native" : "scheduler";
}

/** The `ocx` argv that reinstalls the currently-chosen service backend (update paths). */
export function serviceReinstallArgs(): string[] {
  return readServiceBackend() === "native" ? ["service", "install", "--native"] : ["service", "install"];
}

/**
 * The service was installed under a different CODEX_HOME/OPENCODEX_HOME, so this process may not
 * touch it. Distinct from "stop failed": the manager was never even contacted, which means the
 * installed service is still live and shared state (native Codex config, the Grok fence) must be
 * left alone â€” tearing it down would strip config out from under a running service.
 */
export class ServiceOwnershipError extends Error {
  readonly code = "service-ownership-mismatch" as const;
}

export function isServiceOwnershipError(err: unknown): err is ServiceOwnershipError {
  return err instanceof ServiceOwnershipError;
}

/**
 * True when no installed service exists, or the installed one belongs to THIS
 * CODEX_HOME/OPENCODEX_HOME. Callers use it to decide whether they may tear down shared state
 * (native Codex config, the Grok fence) that a foreign service would still be relying on.
 */
export function serviceEnvironmentOwnedHere(): boolean {
  try {
    assertServiceEnvironmentMatchesInstall();
    return true;
  } catch (err) {
    if (isServiceOwnershipError(err)) return false;
    return true; // unrelated failure: fall back to the previous behavior rather than wedging
  }
}

export function assertServiceEnvironmentMatchesInstall(): void {
  const state = readServiceInstallState();
  if (!state) return;
  const expected = normalizePathForCompare(state.codexHome);
  const actual = normalizePathForCompare(currentCodexHome());
  if (expected !== actual) {
    throw new ServiceOwnershipError(
      `Service was installed with CODEX_HOME=${state.codexHome}, but current CODEX_HOME=${currentCodexHome()}. ` +
        "Run the service command from the same Codex home so native Codex restore updates the correct config.",
    );
  }
  const expectedOpenCodexHome = normalizePathForCompare(state.opencodexHome);
  const actualOpenCodexHome = normalizePathForCompare(currentOpenCodexHome());
  if (expectedOpenCodexHome !== actualOpenCodexHome) {
    throw new ServiceOwnershipError(
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
  recordOwnedConfigPath(dir, path);
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
 * Priority: explicit override â†’ OCX_BAKE_PORT (update restart) â†’ config.port â†’ 10100.
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
  return resolveTrustedWindowsSchtasksExe();
}

function windowsWscript(): string {
  const candidate = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "wscript.exe");
  return existsSync(candidate) ? candidate : "wscript.exe";
}

let querySchtasksForTests: ((args: string[]) => string) | null = null;

function querySchtasks(args: string[]): string {
  if (querySchtasksForTe×tîÚ$z{-®éÜj×¢–b‡7FGW5v–ç7u&r‚’ÓÒ&æöæW†—7FVçB"’°¢G'’²7F÷v–ç7u6W'f–6R‚“²7F÷VBÒG'VS²Ò6F6‚²ò¢&W7BÖVff÷'B¢òĞ¢Ğ¢–b‡7F÷VB’&WGW&âG'VS°¢ÒVÇ6R–b‡&ö6W72çÆFf÷&ÒÓÓÒ&Æ–çW‚"bb—57—7FVÖB‚’bbW†—7G57–æ2‡Væ—EF‚‚’’’°¢G'’²7F÷7—7FVÖB‚“²&WGW&âG'VS²Ò6F6‚²&WGW&âfÇ6S²Ğ¢Ğ¢&WGW&âfÇ6S°§Ğ ¢ò¢¢FVÆWFR–ç7FÆÂ×7FFRf–ÆW3²7FÆR7FFRv÷VÆBÖ¶Rö7‚WFFV'&V–ç7FÆÂ"6W'f–6RF†BæòÆöævW"W†—7G2â¢ğ¦gVæ7F–öâ&VÖ÷fU6W'f–6T–ç7FÆÅ7FFR‚“¢fö–B°¢f÷"†6öç7BF‚öb6W'f–6U7FFUF‡2‚’’°¢G'’²–b†W†—7G57–æ2‡F‚’’VæÆ–æµ7–æ2‡F‚“²Ò6F6‚²ò¢&W7BÖVff÷'B¢òĞ¢Ğ§Ğ ¢ò¢ ¢¢&W7BÖVff÷'B6W'f–6R&VÖ÷fÂf÷"gVÆÂVæ–ç7FÆÂâVæÆ–¶Rö7‚6W'f–6RVæ–ç7FÆÆÂF†—2—2V–W@¢¢v†Vâæò6W'f–6RW†—7G2æBæWfW"W†—G2F†R&ö6W72§W7B&V6W6RF†RÆFf÷&Ò†2æò6W'f–6P¢¢ÖævW"à¢¢ğ¦W‡÷'BgVæ7F–öâVæ–ç7FÆÅ6W'f–6T–d–ç7FÆÆVB‚“¢&ööÆVâ°¢76W'E6W'f–6TVçf—&öæÖVçDÖF6†W4–ç7FÆÂ‚“°¢–b‡&ö6W72çÆFf÷&ÒÓÓÒ&F'v–â"’°¢–b†W†—7G57–æ2‡Æ—7EF‚‚’’’°¢G'’²Væ–ç7FÆÄÆVæ6†B‚“²&VÖ÷fU6W'f–6T–ç7FÆÅ7FFR‚“²&WGW&âG'VS²Ò6F6‚²&WGW&âfÇ6S²Ğ¢Ğ¢ÒVÇ6R–b‡&ö6W72çÆFf÷&ÒÓÓÒ'v–ã3""’°¢ÆWB&VÖ÷fVBÒfÇ6S°¢G'’°¢6öç7BÒ66‡F6·2…²"÷VW'’"Â"÷Fâ"ÂD4µÒ“°¢–b‡æ–æ6ÇVFW2…D4²’’²Væ–ç7FÆÅv–æF÷w2‚“²&VÖ÷fVBÒG'VS²Ğ¢Ò6F6‚²ò¢F6²æ÷Bf÷VæB¢òĞ¢–b‡7FGW5v–ç7u&r‚’ÓÒ&æöæW†—7FVçB"’°¢G'’°¢Væ–ç7FÆÅv–ç7u6W'f–6R‚“°¢&VÖ÷fVBÒG'VS°¢Ò6F6‚†W'"’°¢6öç6öÆRçv&â†)ªûˆòf–ÆVBFò&VÖ÷fRæF—fR6W'f–6S¢G¶W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"—Òâ6†V6²w62æW†RVW'’Gµt”å5uõ4U%d”4Uô”GÒræ“°¢Ğ¢Ğ¢–b‡&VÖ÷fVB’²&VÖ÷fU6W'f–6T–ç7FÆÅ7FFR‚“²&WGW&âG'VS²Ğ¢ÒVÇ6R–b‡&ö6W72çÆFf÷&ÒÓÓÒ&Æ–çW‚"bbW†—7G57–æ2‡Væ—EF‚‚’’’°¢G'’²Væ–ç7FÆÅ7—7FVÖB‚“²&VÖ÷fU6W'f–6T–ç7FÆÅ7FFR‚“²&WGW&âG'VS²Ò6F6‚°¢G'’²VæÆ–æµ7–æ2‡Væ—EF‚‚’“²&VÖ÷fU6W'f–6T–ç7FÆÅ7FFR‚“²&WGW&âG'VS²Ò6F6‚²&WGW&âfÇ6S²Ğ¢Ğ¢Ğ¢&WGW&âfÇ6S°§Ğ ¢ò¢¢G'VR–b&6¶w&÷VæB6W'f–6R†ÆVæ6†B÷7—7FVÖBõF6²66†VGVÆW"’—2–ç7FÆÆVBâ¢ğ¦W‡÷'BgVæ7F–öâ—56W'f–6T–ç7FÆÆVB‚“¢&ööÆVâ°¢&WGW&âF–væ÷6U6W'f–6R‚’æ–ç7FÆÆVC°§Ğ ¦W‡÷'B–çFW&f6R6W'f–6TF–væ÷7F–2°¢7W÷'FVC¢&ööÆVã°¢–ç7FÆÆVC¢&ööÆVã°¢Væ&ÆVC¢&ööÆVã°¢'Vææ–æs¢&ööÆVã°¢f–&ÆS¢&ööÆVã°¢7F'F&ÆS¢&ööÆVã°¢7FÆS¢&ööÆVã°¢6öæfÆ–7C¢&ööÆVã°¢&6¶VæC¢6W'f–6T&6¶VæBÂ&ÆVæ6†B"Â'7—7FVÖB"ÂçVÆÃ°¢7VÖÖ'“¢7G&–æs°§Ğ ¢ò¢¢v–æF÷w2G&’Ö’&W7F'B†VÇF‡’Ö'WB×7F÷VBæF—fR6W'f–6S²7FÆRö6öæfÆ–7F–ær–ç7FÆÇ2&VÖ–â&Æö6¶VBâ¢ğ¦W‡÷'BgVæ7F–öâ6W'f–6U7F'F&ÆTg&öÕG&’‡6W'f–6S¢6W'f–6TF–væ÷7F–2“¢&ööÆVâ°¢&WGW&â6W'f–6Rç7F'F&ÆRbb6W'f–6Rç7FÆRbb6W'f–6Ræ6öæfÆ–7C°§Ğ ¦W‡÷'B–çFW&f6Rv–æF÷w56W'f–6TF–væ÷7F–4–çWG2°¢ò¢ ¢¢&r66‡F6·2÷VW'’÷†ÖÆ÷WGWC²V×G’v†VâæòF6²—2&Vv—7FW&VBâ76VB0¢¢„ÔÂ&F†W"F†â&RÖ6ö×WFVB&ööÆVç26òWfW'’6ÆÆW"&VG2F†RFö7VÖVçBF‡&÷Vv€¢¢&VEv–æF÷w566†VGVÆW%†ÖÅ7FFR‚’(	B6V6öæBÂ7G&–7FW"&VF–ærVÇ6Wv†W&Rv÷VÆ@¢¢6–ÆVçFÇ’&V–çG&öGV6RF†R7FÆR×7FGW2fÇ6R÷6—F—fR‚3C3"’à¢¢ğ¢66†VGVÆW%†ÖÃ¢7G&–æs°¢ò¢¢v†WF†W"F†RöâÖF—6²6W'f–6R76WG2W†—7Bâf–ÆW7—7FVÒ6öæ6W&âÂæ÷Bâ„ÔÂöæRâ¢ğ¢66†VGVÆW$76WG5&W6VçC¢&ööÆVã°¢æF—fU7FGW3¢'7F'FVB"Â'7F÷VB"Â&æöæW†—7FVçB"Â'Væ¶æ÷vâ#°¢&V6÷&FVD&6¶VæC¢6W'f–6T&6¶VæBÂçVÆÃ°¢7FÆT&¶VEF‡3¢&ööÆVã°¢æF—fU&W—$76WG4öæÇ“¢&ööÆVã°¢F–væ÷7F–73¢7G&–æs°§Ğ ¦W‡÷'BgVæ7F–öâFW&—fUv–æF÷w56W'f–6TF–væ÷7F–2†–çWG3¢v–æF÷w56W'f–6TF–væ÷7F–4–çWG2“¢6W'f–6TF–væ÷7F–2°¢6öç7B66†VGVÆW%7FFRÒ&VEv–æF÷w566†VGVÆW%†ÖÅ7FFR†–çWG2ç66†VGVÆW%†ÖÂ“°¢6öç7B66†VGVÆW$–ç7FÆÆVBÒ66†VGVÆW%7FFRæ–ç7FÆÆVC°¢6öç7B66†VGVÆW$Væ&ÆVBÒ66†VGVÆW%7FFRæVæ&ÆVC°¢6öç7B66†VGVÆW$76WG4†VÇF‡’Ò–çWG2ç66†VGVÆW$76WG5&W6VçBbb66†VGVÆW%7FFRç&Vv—7G&F–öä†VÇF‡“°¢6öç7BæF—fT–ç7FÆÆVBÒ–çWG2ææF—fU7FGW2ÓÒ&æöæW†—7FVçB#°¢6öç7B6öæfÆ–7BÒ66†VGVÆW$–ç7FÆÆVBbbæF—fT–ç7FÆÆVC°¢6öç7B&6¶VæE7FFTÖ—6ÖF6‚Ò66†VGVÆW$–ç7FÆÆV@¢ò–çWG2ç&V6÷&FVD&6¶VæBÓÒ'66†VGVÆW" ¢¢æF—fT–ç7FÆÆVBbb–çWG2ç&V6÷&FVD&6¶VæBÓÒ&æF—fR#°¢6öç7B7FÆRÒ–çWG2ç7FÆT&¶VEF‡0¢ÇÂ‡66†VGVÆW$–ç7FÆÆVBbb66†VGVÆW$76WG4†VÇF‡’¢ÇÂ&6¶VæE7FFTÖ—6ÖF6€¢ÇÂ†–çWG2ææF—fU7FGW2ÓÓÒ&æöæW†—7FVçB"bb–çWG2ææF—fU&W—$76WG4öæÇ’“°¢6öç7B&6¶VæBÒ66†VGVÆW$–ç7FÆÆVBò'66†VGVÆW""¢æF—fT–ç7FÆÆVBò&æF—fR"¢çVÆÃ°¢6öç7BVæ&ÆVBÒ66†VGVÆW$–ç7FÆÆVBò66†VGVÆW$Væ&ÆVB¢–çWG2ææF—fU7FGW2ÓÓÒ'7F'FVB#°¢6öç7B'Vææ–ærÒæF—fT–ç7FÆÆVBò–çWG2ææF—fU7FGW2ÓÓÒ'7F'FVB"¢66†VGVÆW$–ç7FÆÆVBbb66†VGVÆW$Væ&ÆVC°¢6öç7Bf–&ÆRÒ6öæfÆ–7Bbb7FÆP¢bb‡66†VGVÆW$–ç7FÆÆVBò66†VGVÆW$Væ&ÆVBbb66†VGVÆW$76WG4†VÇF‡’¢–çWG2ææF—fU7FGW2ÓÓÒ'7F'FVB"“°¢6öç7B7F'F&ÆRÒ6öæfÆ–7Bbb7FÆP¢bb‡66†VGVÆW$–ç7FÆÆV@¢ò66†VGVÆW$Væ&ÆVBbb66†VGVÆW$76WG4†VÇF‡¢¢–çWG2ææF—fU7FGW2ÓÓÒ'7F'FVB"ÇÂ–çWG2ææF—fU7FGW2ÓÓÒ'7F÷VB"“°¢6öç7BFWF–ÂÒ6öæfÆ–7@¢ò$4ôädÄ”5C¢F6²66†VGVÆW"æBæF—fRv–å5r&R&÷F‚&W6VçB(	B'Vâvö7‚6W'f–6RVæ–ç7FÆÂrF†Vâ&V–ç7FÆÂöæR ¢¢7FÆP¢ò'7FÆR÷"Ö—76–ær6W'f–6R76WG2(	B'Vâvö7‚6W'f–6R–ç7FÆÂrFò&W—" ¢¢66†VGVÆW$–ç7FÆÆV@¢ò66†VGVÆW$Væ&ÆVBò%F6²66†VGVÆW"Væ&ÆVB"¢%F6²66†VGVÆW"F—6&ÆVB ¢¢æF—fT–ç7FÆÆV@¢òæF—fR…v–å5rGµt”å5uõdU%4”ôçÒ“¢G¶–çWG2ææF—fU7FGW7Ö ¢¢&æ÷B–ç7FÆÆVB#°¢6öç7B7VÖÖ'’Ò&6¶VæBò–ç7FÆÆVBÂG¶FWF–ÇÒ‚G¶–çWG2æF–væ÷7F–77Ò–¢æ÷B–ç7FÆÆVB‚G¶–çWG2æF–væ÷7F–77Ò–°¢&WGW&â°¢7W÷'FVC¢G'VRÀ¢–ç7FÆÆVC¢66†VGVÆW$–ç7FÆÆVBÇÂæF—fT–ç7FÆÆVBÀ¢Væ&ÆVBÀ¢'Vææ–ærÀ¢f–&ÆRÀ¢7F'F&ÆRÀ¢7FÆRÀ¢6öæfÆ–7BÀ¢&6¶VæBÀ¢7VÖÖ'’À¢Ó°§Ğ ¢ò¢ ¢¢f–ÂÖ6Æ÷6VB&W7F'BF–væ÷7F–2â&W6Væ6RÆöæR—2æWfW"Væ÷Vvƒ¢6öæfÆ–7F–æp¢¢ÖævW'2Â7FÆR&¶VBF‡2ÂF—6&ÆVB&Vv—7G&F–öç2ÂæBVæ¶æ÷vâ÷7F÷V@¢¢æF—fRÖævW'26ææ÷B6Æ–ÒF†B6öFW‚v–ÆÂ&V6öææV7BgFW"&V&ö÷Bà¢¢ğ¦W‡÷'BgVæ7F–öâF–væ÷6U6W'f–6R‚“¢6W'f–6TF–væ÷7F–2°¢6öç7BF–væ÷7F–72Ò6W'f–6TF–væ÷7F–757VÖÖ'’‚“°¢–b‡&ö6W72çÆFf÷&ÒÓÓÒ&F'v–â"’°¢6öç7B–ç7FÆÆVBÒW†—7G57–æ2‡Æ—7EF‚‚’“°¢6öç7B'Vææ–ærÒ–ç7FÆÆVBbb&ööÆVâ‡7FGW4ÆVæ6†B‚’“°¢6öç7B7FÆRÒ–ç7FÆÆVBbb&¶VE6W'f–6UF‡4F–væ÷7F–2‚’ÓÒçVÆÃ°¢6öç7Bf–&ÆRÒ–ç7FÆÆVBbb'Vææ–ærbb7FÆS°¢6öç7B7VÖÖ'’Ò–ç7FÆÆVBòæ÷B–ç7FÆÆVB‚G¶F–væ÷7F–77Ò– ¢¢7FÆRò–ç7FÆÆVBÂ'WB7FÆR†ÆVæ6†C²G¶F–væ÷7F–77Ò– ¢¢'Vææ–ærò–ç7FÆÆVBæBÆöFVB†ÆVæ6†C²G¶F–væ÷7F–77Ò– ¢¢–ç7FÆÆVBÂæ÷BÆöFVB†ÆVæ6†C²G¶F–væ÷7F–77Ò–°¢&WGW&â²7W÷'FVC¢G'VRÂ–ç7FÆÆVBÂVæ&ÆVC¢'Vææ–ærÂ'Vææ–ærÂf–&ÆRÂ7F'F&ÆS¢–ç7FÆÆVBbb7FÆRÂ7FÆRÂ6öæfÆ–7C¢fÇ6RÂ&6¶VæC¢&ÆVæ6†B"Â7VÖÖ'’Ó°¢Ğ¢–b‡&ö6W72çÆFf÷&ÒÓÓÒ'v–ã3""’°¢6öç7B66†VGVÆW%†ÖÂÒ7FGW5v–æF÷w5†ÖÂ‚“°¢6öç7B66†VGVÆW$76WG5&W6VçBÒ·v–æF÷w56W'f–6U67&—EF‚‚’Âv–æF÷w4ÆVæ6†W%f'5F‚‚’Âv–æF÷w5F6µ†ÖÅF‚‚•Ğ¢æWfW'’†W†—7G57–æ2“°¢6öç7BæF—fU7FGW2Ò7FGW5v–ç7u&r‚“°¢6öç7B–ç7FÆÅ7FFRÒ&VE6W'f–6T–ç7FÆÅ7FFR‚“°¢6öç7B&V6÷&FVD&6¶VæC¢6W'f–6T&6¶VæBÂçVÆÂÒ–ç7FÆÅ7FFP¢òçVÆÀ¢¢–ç7FÆÅ7FFRæ&6¶VæBÓÓÒ&æF—fR"ò&æF—fR"¢'66†VGVÆW"#°¢&WGW&âFW&—fUv–æF÷w56W'f–6TF–væ÷7F–2‡°¢66†VGVÆW%†ÖÂÀ¢66†VGVÆW$76WG5&W6VçBÀ¢æF—fU7FGW2À¢&V6÷&FVD&6¶VæBÀ¢7FÆT&¶VEF‡3¢&¶VE6W'f–6UF‡4F–væ÷7F–2‚’ÓÒçVÆÂÀ¢æF—fU&W—$76WG4öæÇ“¢&ööÆVâ‡v–ç7u7FGW57VÖÖ'’‚’’À¢F–væ÷7F–72À¢Ò“°¢Ğ¢–b‡&ö6W72çÆFf÷&ÒÓÓÒ&Æ–çW‚"’°¢–b†W†—7G57–æ2‚"òæFö6¶W&Vçb"’’&WGW&â²7W÷'FVC¢fÇ6RÂ–ç7FÆÆVC¢fÇ6RÂVæ&ÆVC¢fÇ6RÂ'Vææ–æs¢fÇ6RÂf–&ÆS¢fÇ6RÂ7F'F&ÆS¢fÇ6RÂ7FÆS¢fÇ6RÂ6öæfÆ–7C¢fÇ6RÂ&6¶VæC¢çVÆÂÂ7VÖÖ'“¢'Vç7W÷'FVB–âFö6¶W""Ó°¢–b‚—57—7FVÖB‚’’&WGW&â²7W÷'FVC¢fÇ6RÂ–ç7FÆÆVC¢fÇ6RÂVæ&ÆVC¢fÇ6RÂ'Vææ–æs¢fÇ6RÂf–&ÆS¢fÇ6RÂ7F'F&ÆS¢fÇ6RÂ7FÆS¢fÇ6RÂ6öæfÆ–7C¢fÇ6RÂ&6¶VæC¢çVÆÂÂ7VÖÖ'“¢'Vç7W÷'FVC¢7—7FVÖBæ÷Bf÷VæB"Ó°¢6öç7B–ç7FÆÆVBÒW†—7G57–æ2‡Væ—EF‚‚’“°¢6öç7BVæ&ÆVBÒ–ç7FÆÆVBbb‚‚’Óâ²G'’²&WGW&â6‚†7—7FVÖ7FÂÒ×W6W"—2ÖVæ&ÆVBGµD4·Ö’ÓÓÒ&Væ&ÆVB#²Ò6F6‚²&WGW&âfÇ6S²ÒÒ’‚“°¢6öç7B'Vææ–ærÒ–ç7FÆÆVBbb‚‚’Óâ²G'’²&WGW&â6‚†7—7FVÖ7FÂÒ×W6W"—2Ö7F—fRGµD4·Ö’ÓÓÒ&7F—fR#²Ò6F6‚²&WGW&âfÇ6S²ÒÒ’‚“°¢6öç7B7FÆRÒ–ç7FÆÆVBbb&¶VE6W'f–6UF‡4F–væ÷7F–2‚’ÓÒçVÆÃ°¢6öç7Bf–&ÆRÒ–ç7FÆÆVBbbVæ&ÆVBbb'Vææ–ærbb7FÆS°¢6öç7B7VÖÖ'’Ò–ç7FÆÆVBòæ÷B–ç7FÆÆVB‚G¶F–væ÷7F–77Ò– ¢¢7FÆRò–ç7FÆÆVBÂ'WB7FÆR‡7—7FVÖBW6W#²G¶F–væ÷7F–77Ò– ¢¢f–&ÆRò–ç7FÆÆVBÂVæ&ÆVBæB'Vææ–ær‡7—7FVÖBW6W#²G¶F–væ÷7F–77Ò– ¢¢–ç7FÆÆVBÂ'WBG²Væ&ÆVBò&F—6&ÆVB"¢&æ÷B'Vææ–ær'Ò‡7—7FVÖBW6W#²G¶F–væ÷7F–77Ò–°¢&WGW&â²7W÷'FVC¢G'VRÂ–ç7FÆÆVBÂVæ&ÆVBÂ'Vææ–ærÂf–&ÆRÂ7F'F&ÆS¢–ç7FÆÆVBbb7FÆRÂ7FÆRÂ6öæfÆ–7C¢fÇ6RÂ&6¶VæC¢'7—7FVÖB"Â7VÖÖ'’Ó°¢Ğ¢&WGW&â²7W÷'FVC¢fÇ6RÂ–ç7FÆÆVC¢fÇ6RÂVæ&ÆVC¢fÇ6RÂ'Vææ–æs¢fÇ6RÂf–&ÆS¢fÇ6RÂ7F'F&ÆS¢fÇ6RÂ7FÆS¢fÇ6RÂ6öæfÆ–7C¢fÇ6RÂ&6¶VæC¢çVÆÂÂ7VÖÖ'“¢Vç7W÷'FVBöâG·&ö6W72çÆFf÷&×ÖÓ°§Ğ ¦W‡÷'BgVæ7F–öâ6W'f–6U7FGW57VÖÖ'’‚“¢7G&–ær°¢&WGW&âF–væ÷6U6W'f–6R‚’ç7VÖÖ'“°§Ğ ¦W‡÷'BgVæ7F–öâæ÷&ÖÆ—¦U6W'f–6U7V&6öÖÖæB‡7V#ó¢7G&–ær“¢7G&–ær°¢&WGW&â7V"óò&–ç7FÆÂ#°§Ğ ¦W‡÷'B–çFW&f6R'6VE6W'f–6T&w2°¢7V#¢7G&–æs°¢&6¶VæC¢6W'f–6T&6¶VæBÂçVÆÃ°¢–çfÆ–C¢7G&–æuµÓ°§Ğ ¢ò¢ ¢¢ö7‚6W'f–6R·7V%Ò²ÒÖæF—fWÂÒ×66†VGVÆW%ÖâF†Rf—'7BæöâÖfÆrFö¶Vâ—2F†P¢¢7V&6öÖÖæC²&6¶VæBfÆw2&RöæÇ’ÖVæ–ævgVÂf÷"–ç7FÆÆ‡fÆ–FFVB'’F†R6ÆÆW"’à¢¢ğ¦W‡÷'BgVæ7F–öâ'6U6W'f–6T&w2†&w3¢7G&–æuµÒ“¢'6VE6W'f–6T&w2°¢ÆWB7V#¢7G&–ærÂVæFVf–æVC°¢ÆWB&6¶VæC¢6W'f–6T&6¶VæBÂçVÆÂÒçVÆÃ°¢6öç7B–çfÆ–C¢7G&–æuµÒÒµÓ°¢f÷"†6öç7B&röb&w2’°¢–b†&rÓÓÒ"ÒÖæF—fR"’°¢–b†&6¶VæBÓÓÒ'66†VGVÆW""’²–çfÆ–BçW6‚‚"ÒÖæF—fR†6öæfÆ–7G2v—F‚Ò×66†VGVÆW"’"“²6öçF–çVS²Ğ¢&6¶VæBÒ&æF—fR#°¢Ğ¢VÇ6R–b†&rÓÓÒ"Ò×66†VGVÆW""’°¢–b†&6¶VæBÓÓÒ&æF—fR"’²–çfÆ–BçW6‚‚"Ò×66†VGVÆW"†6öæfÆ–7G2v—F‚ÒÖæF—fR’"“²6öçF–çVS²Ğ¢&6¶VæBÒ'66†VGVÆW"#°¢Ğ¢VÇ6R–b†&rç7F'G5v—F‚‚"ÒÒ"’’–çfÆ–BçW6‚†&r“°¢VÇ6R–b‡7V"ÓÓÒVæFVf–æVB’7V"Ò&s°¢VÇ6R–çfÆ–BçW6‚†&r“°¢Ğ¢&WGW&â²7V#¢æ÷&ÖÆ—¦U6W'f–6U7V&6öÖÖæB‡7V"’Â&6¶VæBÂ–çfÆ–BÓ°§Ğ ¦W‡÷'B7–æ2gVæ7F–öâ6W'f–6T6öÖÖæB‚ââæ&w3¢‡7G&–ærÂVæFVf–æVB•µÒ“¢&öÖ—6SÇfö–Câ°¢6öç7B'6VBÒ'6U6W'f–6T&w2†&w2æf–ÇFW"‚†“¢—27G&–ærÓâ&ööÆVâ†’’“°¢6öç7B6öÖÖæBÒ'6VBç7V#°¢–b‡'6VBæ–çfÆ–BæÆVæwF‚â’°¢6öç6öÆRæW'&÷"†Væ¶æ÷vâ6W'f–6R÷F–öã¢G·'6VBæ–çfÆ–Bæ¦ö–â‚""—Ö“°¢&ö6W72æW†—Bƒ“°¢Ğ¢–b‡'6VBæ&6¶VæBbb6öÖÖæBÓÒ&–ç7FÆÂ"’°¢6öç6öÆRæW'&÷"‚"ÒÖæF—fRòÒ×66†VGVÆW"Ç’Fòö7‚6W'f–6R–ç7FÆÆöæÇ“²÷F†W"7V&6öÖÖæG2W6RF†R–ç7FÆÆVB&6¶VæBâ"“°¢&ö6W72æW†—Bƒ“°¢Ğ¢–b‡'6VBæ&6¶VæBÓÓÒ&æF—fR"bb&ö6W72çÆFf÷&ÒÓÒ'v–ã3""’°¢6öç6öÆRæW'&÷"‚"ÒÖæF—fR…v–å5r’—2v–æF÷w2ÖöæÇ’â"“°¢&ö6W72æW†—Bƒ“°¢Ğ¢òòæöâÖ–ç7FÆÂ7V&6öÖÖæG2föÆÆ÷rF†R&6¶VæB&V6÷&FVBB–ç7FÆÂF–ÖR‡7FFRc"’à¢6öç7B&6¶VæC¢6W'f–6T&6¶VæBÒ'6VBæ&6¶VæBóò‡&ö6W72çÆFf÷&ÒÓÓÒ'v–ã3""ò&VE6W'f–6T&6¶VæB‚’¢'66†VGVÆW""“°¢6öç7B÷2ÒÆFf÷&Ô÷2†&6¶VæB“°¢–b‚÷2’°¢6öç6öÆRæW'&÷"‚&ö7‚6W'f–6R7W÷'G2Ö4õ2†ÆVæ6†B’Âv–æF÷w2…F6²66†VGVÆW"’ÂæBÆ–çW‚‡7—7FVÖB’â"“°¢&ö6W72æW†—Bƒ“°¢Ğ¢7v—F6‚†6öÖÖæB’°¢66R&–ç7FÆÂ# ¢76W'E6W'f–6TVçf—&öæÖVçDÖF6†W4–ç7FÆÂ‚“°¢76W'E6W'f–6TWF„Vçf—&öæÖVçB‚“°¢v—B÷2æ–ç7FÆÂ‚“°¢6öç6öÆRæÆör†&6¶VæBÓÓÒ&æF—fR ¢ò.)ÈR÷Væ6öFW‚æF—fR6W'f–6R–ç7FÆÆVB²7F'FVB‡v–æF÷vÆW72Â7F'G2B&ö÷BÂWFò×&W7F'G2öâ7&6‚’â ¢¢.)ÈR÷Væ6öFW‚6W'f–6R–ç7FÆÆVB²7F'FVB†WFò×7F'G2öâÆöv–âÂWFò×&W7F'G2öâ7&6‚’â"“°¢–b‡&ö6W72çÆFf÷&ÒÓÓÒ&Æ–çW‚"’6öç6öÆRæÆör‚"f÷"WFò×7F'Böâ&ö÷C¢Æöv–æ7FÂVæ&ÆRÖÆ–ævW"EU4U""“°¢'&V³°¢66R'7F'B# ¢÷2ç7F'B‚“°¢6öç6öÆRæÆör‚.)ÈR6W'f–6R7F'FVBâ"“°¢'&V³°¢66R'7F÷# ¢76W'E6W'f–6TVçf—&öæÖVçDÖF6†W4–ç7FÆÂ‚“°¢òòöæÇ’7F÷v†B—27GVÆÇ’–ç7FÆÆVBâF†RVæwV&FVB6ÆÂ&â&VÂÆVæ6†7FÂVæÆöF ¢òò†æB—G2v–æF÷w2ôÆ–çW‚Gv–ç2’WfVâv—F‚æ÷F†–ær–ç7FÆÆVBà¢–b†÷2ç7FGW2‚’ÓÒçVÆÂÇÂ—56W'f–6T–ç7FÆÆVB‚’’÷2ç7F÷‚“°¢v—B7F÷G&6¶VE&÷‡”f÷%6W'f–6T6öÖÖæB‚“°¢°¢6öç7B&W7F÷&RÒ&W7F÷&TæF—fT6öFW‚‚“°¢–b‡&W7F÷&Rç7V66W72’6öç6öÆRæÆör‚.)ÈR6W'f–6R7F÷VB²æF—fR6öFW‚&W7F÷&VBâ"“°¢VÇ6R6öç6öÆRæW'&÷"†)ªûˆò6W'f–6R7F÷VBÂ'WBæF—fR6öFW‚&W7F÷&Rd”ÄTC¢G·&W7F÷&RæÖW76vWÕÆå'VâÆö7‚&W7F÷&UÆ†÷"6†V6²D4ôDU…ô„ôÔRö6öæf–rçFöÖÂ’&Vf÷&RW6–æræF—fR6öFW‚æ“°¢òòF†Rw&ö²fVæ6R—2F†R÷F†W"ÖævVB6öæf–rF†—26öÖÖæB÷vç2âÆVf–ær—B&V†–æ@¢òòö–çFVBw&ö²BFVBVæGö–çBv†–ÆRæF—fR6öFW‚v2Ç&VG’&W7F÷&VBà¢6öç7Bw&ö²Ò7G&—w&ö´6öæf–r‚“°¢–b†w&ö²æ6†ævVB’6öç6öÆRæÆör†(jûˆòG¶w&ö²æÖW76vWÖ“°¢VÇ6R–b‚w&ö²æö²’6öç6öÆRæW'&÷"†)ªûˆòG¶w&ö²æÖW76vWÖ“°¢Ğ¢'&V³°¢66R'7FGW2#¢°¢6öç7B2Ò÷2ç7FGW2‚“°¢6öç6öÆRæÆör‡2ò)ÈR'Vææ–æs¥ÆâG·7Ö¢.)ØÂ6W'f–6Ræ÷B–ç7FÆÆVB÷'Vææ–ærâ"“°¢6öç6öÆRæÆör†F–væ÷7F–73¢G·6W'f–6TF–væ÷7F–757VÖÖ'’‚—Ö“°¢'&V³°¢Ğ¢66R'Væ–ç7FÆÂ# ¢66R'&VÖ÷fR# ¢76W'E6W'f–6TVçf—&öæÖVçDÖF6†W4–ç7FÆÂ‚“°¢G'’²÷2ç7F÷‚“²Ò6F6‚†W'"’°¢6öç6öÆRçv&â†)ªûˆò6W'f–6R7F÷f–ÆVC¢G¶W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"—Ö“°¢Ğ¢v—B7F÷G&6¶VE&÷‡”f÷%6W'f–6T6öÖÖæB‚“°¢G'’°¢÷2çVæ–ç7FÆÂ‚“°¢Ò6F6‚†W'"’°¢6öç6öÆRæW'&÷"†)ØÂ6W'f–6RVæ–ç7FÆÂf–ÆVC¢G¶W'"–ç7Fæ6VöbW'&÷"òW'"æÖW76vR¢7G&–ær†W'"—Ö“°¢6öç6öÆRæW'&÷"‚%F†R6W'f–6RÖ’7F–ÆÂ&R–ç7FÆÆVBâ6†V6²v—F‚vö7‚6W'f–6R7FGW2r÷"&VÖ÷fRÖçVÆÇ’â"“°¢&ö6W72æW†—Bƒ“°¢Ğ¢°¢6öç7B&W7F÷&RÒ&W7F÷&TæF—fT6öFW‚‚“°¢–b‚&W7F÷&Rç7V66W72’°¢6öç6öÆRæW'&÷"†)ªûˆòæF—fR6öFW‚&W7F÷&Rd”ÄTC¢G·&W7F÷&RæÖW76vWÕÆå'VâÆö7‚&W7F÷&UÆ&Vf÷&RW6–æræF—fR6öFW‚æ“°¢Ğ¢6öç7Bw&ö²Ò7G&—w&ö´6öæf–r‚“°¢–b†w&ö²æ6†ævVB’6öç6öÆRæÆör†(jûˆòG¶w&ö²æÖW76vWÖ“°¢VÇ6R–b‚w&ö²æö²’6öç6öÆRæW'&÷"†)ªûˆòG¶w&ö²æÖW76vWÖ“°¢Ğ¢&VÖ÷fU6W'f–6T–ç7FÆÅ7FFR‚“°¢G'’²–b†W†—7G57–æ2‡6W'f–6T•Fö¶Väf–ÆUF‚‚’’’VæÆ–æµ7–æ2‡6W'f–6T•Fö¶Väf–ÆUF‚‚’“²Ò6F6‚²ò¢&W7BÖVff÷'B¢òĞ¢6öç6öÆRæÆör‚.)ÈR6W'f–6RVæ–ç7FÆÆVBâ"“°¢'&V³°¢FVfVÇC ¢6öç6öÆRæW'&÷"‚%W6vS¢ö7‚6W'f–6R¶–ç7FÆÇÇ7F'GÇ7F÷Ç7FGW7ÇVæ–ç7FÆÇÇ&VÖ÷fUÒ²ÒÖæF—fWÂÒ×66†VGVÆW%Ò"“°¢6öç6öÆRæW'&÷"‚"v—F‚æò7V&6öÖÖæBÂ–ç7FÆÇ2÷WFFW2æB7F'G2F†R&6¶w&÷VæB6W'f–6Râ"“°¢6öç6öÆRæW'&÷"‚"ÒÖæF—fR…v–æF÷w2öæÇ’“¢&Vv—7FW"&VÂ44Ò6W'f–6Rf–v–å5r–ç7FVBöbF6²66†VGVÆW"â"“°¢&ö6W72æW†—Bƒ“°¢Ğ§Ğ