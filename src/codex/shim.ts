import { delimiter, dirname, extname, join, posix } from "node:path";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { getConfigDir } from "../config";
import { durableBunPath } from "../lib/bun-runtime";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { windowsEnvIndirectBatchValue } from "../lib/win-paths";
import { isWslRuntime, wslAutomountRoot } from "./home";

const SHIM_MARKER = "opencodex codex autostart shim";
let lastShimDiscoveryError: string | null = null;
/** Last human-readable reason discovery returned null (exposed for doctor/tests). */
export function lastCodexDiscoveryError(): string | null {
  return lastShimDiscoveryError;
}
const CODEX_INTERNAL_COMMANDS = [
  "app-server",
  "archive",
  "apply",
  "cloud",
  "completion",
  "debug",
  "delete",
  "doctor",
  "exec-server",
  "features",
  "fork",
  "help",
  "login",
  "logout",
  "mcp",
  "plugin",
  "sandbox",
  "unarchive",
  "update",
];

// Codex accepts global options before a subcommand. The shim must skip the value belonging to
// these options before it decides which first positional token is the real subcommand. Keep this
// list aligned with `codex --help`; `--option=value` and attached short forms stay one token.
const CODEX_GLOBAL_OPTIONS_WITH_VALUE = [
  "-c", "--config",
  "--enable", "--disable",
  "--remote", "--remote-auth-token-env",
  "-i", "--image",
  "-m", "--model",
  "--local-provider",
  "-p", "--profile",
  "-s", "--sandbox",
  "-C", "--cd",
  "--add-dir",
  "-a", "--ask-for-approval",
];

interface ShimState {
  platform: NodeJS.Platform;
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  wrappers?: ShimFileState[];
}

interface ShimFileState {
  wrapperPath: string;
  originalPath: string;
  backupPath: string;
  realPath?: string;
  preserveOnly?: boolean;
}

function cliEntry(): { bun: string; cli: string } {
  // Bundled Bun path (survives `ocx update`); all three shim builders
  // (Unix / Windows cmd / Windows PowerShell) receive it via this entry.
  // This module lives in src/codex/, the CLI entry in src/cli/index.ts.
  return { bun: durableBunPath(), cli: join(import.meta.dir, "..", "cli", "index.ts") };
}

function commandNames(name: string): string[] {
  if (process.platform !== "win32") return [name];
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD;.PS1").split(";").filter(Boolean);
  return [name, ...exts.flatMap(ext => [`${name}${ext.toLowerCase()}`, `${name}${ext.toUpperCase()}`])];
}

function isShim(path: string): boolean {
  try {
    return readFileSync(path, "utf8").includes(SHIM_MARKER);
  } catch {
    return false;
  }
}

/**
 * A PATH entry that reaches Windows through WSL drive interop
 * (`<automount-root>/<drive>/...`; root defaults to /mnt, configurable via
 * /etc/wsl.conf [automount] root).
 */
export function isWindowsInteropDir(dir: string, automountRoot = "/mnt"): boolean {
  const root = automountRoot.replace(/\/+$/, "");
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}/[a-z](/|$)`, "i").test(dir);
}

export type CodexPathScanDeps = {
  pathValue?: string;
  wsl?: boolean;
  /** Treat PATH entries as POSIX paths (WSL context). Defaults to wsl || non-win32. */
  posixPaths?: boolean;
  automountRoot?: string;
  exists?: (path: string) => boolean;
  isShimFile?: (path: string) => boolean;
  isDirectory?: (path: string) => boolean;
};

function realIsDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return true; // unreadable -> treat as unusable
  }
}

export function findCodexOnPath(deps: CodexPathScanDeps = {}): string | null {
  lastShimDiscoveryError = null;
  const exists = deps.exists ?? existsSync;
  const shimFile = deps.isShimFile ?? isShim;
  const isDir = deps.isDirectory ?? realIsDirectory;
  const wsl = deps.wsl ?? (process.platform === "linux" && isWslRuntime());
  const usePosix = deps.posixPaths ?? (wsl || process.platform !== "win32");
  const joinPath = usePosix ? posix.join : join;
  const pathSep = usePosix ? ":" : delimiter;
  const automountRoot = deps.automountRoot ?? (wsl ? wslAutomountRoot() : "/mnt");
  // Windows npm prefixes ship codex.exe/codex.cmd next to the extensionless sh launcher.
  const interopNames = ["codex", "codex.exe", "codex.cmd", "codex.ps1"];
  let skippedInterop: string | null = null;

  for (const dir of (deps.pathValue ?? process.env.PATH ?? "").split(pathSep).filter(Boolean)) {
    if (wsl && isWindowsInteropDir(dir, automountRoot)) {
      // A Windows-side codex reached through WSL PATH interop: a Unix shim written
      // here would embed WSL-only paths and break every Windows-side invocation.
      if (!skippedInterop) {
        for (const name of interopNames) {
          const path = joinPath(dir, name);
          if (exists(path) && !shimFile(path) && !isDir(path)) { skippedInterop = path; break; }
        }
      }
      continue;
    }
    // Interop dirs carry Windows launcher names even when the scan is not skipping them.
    const names = isWindowsInteropDir(dir, automountRoot) ? interopNames : commandNames("codex");
    for (const name of names) {
      const path = joinPath(dir, name);
      if (!exists(path) || shimFile(path)) continue;
      if (!isDir(path)) return path;
    }
  }

  if (skippedInterop) {
    lastShimDiscoveryError =
      `Found a Windows codex at ${skippedInterop} via WSL PATH interop, but no Linux-side codex. ` +
      "Refusing to shim a Windows launcher from WSL (a WSL shim breaks Windows invocations). " +
      "Install codex inside WSL (npm i -g @openai/codex), or run 'ocx ensure' from Windows to shim the Windows side.";
  }
  return null;
}

function findWindowsCodexTargets(): ShimFileState[] | null {
  lastShimDiscoveryError = null;
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const exe = join(dir, "codex.exe");
    if (existsSync(exe) && !isShim(exe)) {
      try {
        if (!lstatSync(exe).isDirectory()) {
          lastShimDiscoveryError =
            `Found codex.exe at ${exe}. Refusing to rename a real .exe because exact codex.exe invocations would break; ` +
            "install a codex.cmd/codex.ps1 launcher or use `ocx service install` for autostart.";
          return null;
        }
      } catch { /* keep scanning */ }
    }

    const cmd = join(dir, "codex.cmd");
    const ps1 = join(dir, "codex.ps1");
    // npm also installs an extensionless `codex` sh launcher for Git-Bash/MSYS shells;
    // leaving it unshimmed means Git-Bash users silently get no autostart.
    const gitBashLauncher = join(dir, "codex");
    const targets: ShimFileState[] = [];
    for (const path of [cmd, ps1, gitBashLauncher]) {
      if (!existsSync(path) || isShim(path)) continue;
      try {
        if (!lstatSync(path).isDirectory()) {
          targets.push({ wrapperPath: path, originalPath: path, backupPath: backupPathFor(path) });
        }
      } catch { /* keep scanning */ }
    }
    if (targets.length > 0) return targets;
  }
  return null;
}

function backupPathFor(path: string): string {
  const ext = extname(path);
  return ext ? `${path.slice(0, -ext.length)}.opencodex-real${ext}` : `${path}.opencodex-real`;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildUnixCodexShim(realCodexPath: string, bunPath: string, cliPath: string, tokenFile = serviceApiTokenFilePath()): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.join("|");
  const valueOptions = CODEX_GLOBAL_OPTIONS_WITH_VALUE.join("|");
  return `#!/usr/bin/env sh
# ${SHIM_MARKER}
if [ -z "$OPENCODEX_API_AUTH_TOKEN" ] && [ -f ${shQuote(tokenFile)} ]; then
  OPENCODEX_API_AUTH_TOKEN="$(cat ${shQuote(tokenFile)})"
  export OPENCODEX_API_AUTH_TOKEN
fi
ocx_subcommand=""
ocx_skip_next=0
for ocx_arg in "$@"; do
  if [ "$ocx_skip_next" -eq 1 ]; then
    ocx_skip_next=0
    continue
  fi
  case "$ocx_arg" in
    --)
      break
      ;;
    ${valueOptions})
      ocx_skip_next=1
      ;;
    --help|-h|--version|-V)
      ocx_subcommand="$ocx_arg"
      break
      ;;
    -*)
      ;;
    *)
      ocx_subcommand="$ocx_arg"
      break
      ;;
  esac
done
case "$ocx_subcommand" in
  ${internalCommands}|--help|-h|--version|-V)
    ;;
  *)
    if [ -z "$OCX_SHIM_BYPASS" ]; then
      ${shQuote(bunPath)} ${shQuote(cliPath)} ensure >/dev/null 2>&1 || true
    fi
    ;;
esac
exec ${shQuote(realCodexPath)} "$@"
`;
}

function windowsBatchValue(value: string): string {
  return value
    .replace(/%/g, "%%")
    .replace(/\^/g, "^^")
    .replace(/"/g, "")
    .replace(/[\r\n]/g, "");
}

function windowsBatchSet(name: string, value: string): string {
  // Paths are rewritten to %USERPROFILE%-style env indirection: cmd.exe parses .cmd
  // files in the OEM codepage, so a literal non-ASCII profile prefix (Korean/Chinese
  // usernames) written as UTF-8 turns to mojibake. The env token expands natively in
  // the right codepage at parse time; no `chcp` here — this shim runs in the USER's
  // console and must not leak a codepage change into it.
  return `set "${name}=${windowsEnvIndirectBatchValue(value, windowsBatchValue)}"`;
}

export function buildWindowsCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  const internalCommandChecks = CODEX_INTERNAL_COMMANDS.map(command => `if /I "%~1"=="${command}" goto run_codex`).join("\r\n");
  const valueOptionChecks = CODEX_GLOBAL_OPTIONS_WITH_VALUE.map(option => `if /I "%~1"=="${option}" goto skip_option_value`).join("\r\n");
  return `@echo off\r
rem ${SHIM_MARKER}\r
${windowsBatchSet("OCX_REAL_CODEX", realCodexPath)}\r
${windowsBatchSet("OCX_BUN", bunPath)}\r
${windowsBatchSet("OCX_CLI", cliPath)}\r
${windowsBatchSet("OCX_API_TOKEN_FILE", serviceApiTokenFilePath())}\r
if "%OPENCODEX_API_AUTH_TOKEN%"=="" if exist "%OCX_API_TOKEN_FILE%" set /p OPENCODEX_API_AUTH_TOKEN=<"%OCX_API_TOKEN_FILE%"\r
if not "%OCX_SHIM_BYPASS%"=="" goto run_codex\r
goto scan_codex_args\r
:scan_codex_args\r
if "%~1"=="" goto ensure_ocx\r
if "%~1"=="--" goto ensure_ocx\r
${valueOptionChecks}\r
${internalCommandChecks}\r
if /I "%~1"=="--help" goto run_codex\r
if /I "%~1"=="-h" goto run_codex\r
if /I "%~1"=="--version" goto run_codex\r
if /I "%~1"=="-V" goto run_codex\r
set "OCX_SCAN_ARG=%~1"\r
if "%OCX_SCAN_ARG:~0,1%"=="-" goto shift_codex_arg\r
goto ensure_ocx\r
:skip_option_value\r
shift\r
if "%~1"=="" goto ensure_ocx\r
:shift_codex_arg\r
shift\r
goto scan_codex_args\r
:ensure_ocx\r
"%OCX_BUN%" "%OCX_CLI%" ensure >nul 2>nul\r
:run_codex\r
"%OCX_REAL_CODEX%" %*\r
`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsPowerShellCodexShim(realCodexPath: string, bunPath: string, cliPath: string): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.map(command => psString(command)).join(", ");
  const valueOptions = CODEX_GLOBAL_OPTIONS_WITH_VALUE.map(option => psString(option)).join(", ");
  const tokenFile = serviceApiTokenFilePath();
  return `#!/usr/bin/env pwsh
# ${SHIM_MARKER}
if (-not $env:OPENCODEX_API_AUTH_TOKEN -and (Test-Path -LiteralPath ${psString(tokenFile)})) {
  $env:OPENCODEX_API_AUTH_TOKEN = (Get-Content -Raw -LiteralPath ${psString(tokenFile)}).Trim()
}
$internalCommands = @(${internalCommands})
$valueOptions = @(${valueOptions})
$subcommand = ""
$skipNext = $false
foreach ($argValue in $args) {
  $argText = [string]$argValue
  if ($skipNext) { $skipNext = $false; continue }
  if ($argText -eq "--") { break }
  if ($valueOptions -contains $argText) { $skipNext = $true; continue }
  if (@("--help", "-h", "--version", "-V") -contains $argText) { $subcommand = $argText; break }
  if ($argText.StartsWith("-")) { continue }
  $subcommand = $argText
  break
}
$skipEnsure = $env:OCX_SHIM_BYPASS -or $internalCommands -contains $subcommand -or @("--help", "-h", "--version", "-V") -contains $subcommand
if (-not $skipEnsure) {
  & ${psString(bunPath)} ${psString(cliPath)} ensure *> $null
}
& ${psString(realCodexPath)} @args
exit $LASTEXITCODE
`;
}

function readState(): ShimState | null {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as ShimState;
  } catch {
    return null;
  }
}

function statePath(): string {
  return join(getConfigDir(), "codex-shim.json");
}

function writeState(state: ShimState): void {
  if (!existsSync(getConfigDir())) mkdirSync(getConfigDir(), { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state, null, 2) + "\n", "utf8");
}

/** Git-Bash accepts `C:/...` but not backslashed paths inside sh scripts. */
function gitBashPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function writeShim(wrapperPath: string, realCodexPath: string): void {
  const { bun, cli } = cliEntry();
  if (process.platform === "win32") {
    const lower = wrapperPath.toLowerCase();
    if (lower.endsWith(".ps1")) {
      // UTF-8 BOM: Windows PowerShell 5.1 decodes BOM-less .ps1 files in the ANSI
      // codepage, which mangles non-ASCII paths embedded in the shim.
      writeFileSync(wrapperPath, `\uFEFF${buildWindowsPowerShellCodexShim(realCodexPath, bun, cli)}`, "utf8");
    } else if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
      writeFileSync(wrapperPath, buildWindowsCodexShim(realCodexPath, bun, cli), "utf8");
    } else {
      // Extensionless Git-Bash sh launcher: sh shim with forward-slash paths.
      writeFileSync(
        wrapperPath,
        buildUnixCodexShim(gitBashPath(realCodexPath), gitBashPath(bun), gitBashPath(cli), gitBashPath(serviceApiTokenFilePath())),
        "utf8",
      );
    }
  } else {
    writeFileSync(wrapperPath, buildUnixCodexShim(realCodexPath, bun, cli), "utf8");
    chmodSync(wrapperPath, 0o755);
  }
}

function stateFiles(state: ShimState): ShimFileState[] {
  return state.wrappers?.length
    ? state.wrappers
    : [{ wrapperPath: state.wrapperPath, originalPath: state.originalPath, backupPath: state.backupPath }];
}

function primaryState(files: ShimFileState[]): ShimState {
  const first = files[0];
  return { platform: process.platform, ...first, wrappers: files };
}

function replaceOwnedBackup(sourcePath: string, backupPath: string): void {
  const oldBackupPath = `${backupPath}.old-${process.pid}`;
  if (existsSync(oldBackupPath)) unlinkSync(oldBackupPath);
  if (existsSync(backupPath)) renameSync(backupPath, oldBackupPath);
  try {
    renameSync(sourcePath, backupPath);
    if (existsSync(oldBackupPath)) unlinkSync(oldBackupPath);
  } catch (error) {
    if (!existsSync(backupPath) && existsSync(oldBackupPath)) renameSync(oldBackupPath, backupPath);
    throw error;
  }
}

function refreshShimFile(file: ShimFileState): boolean {
  if (file.preserveOnly) {
    if (existsSync(file.originalPath) && !isShim(file.originalPath)) {
      replaceOwnedBackup(file.originalPath, file.backupPath);
      return true;
    }
    return false;
  }
  if (existsSync(file.wrapperPath) && !isShim(file.wrapperPath)) {
    if (file.wrapperPath !== file.originalPath) return false;
    replaceOwnedBackup(file.wrapperPath, file.backupPath);
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath);
    return true;
  }
  if (!existsSync(file.wrapperPath) && existsSync(file.backupPath)) {
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath);
    return true;
  }
  if (file.originalPath !== file.wrapperPath && existsSync(file.originalPath) && existsSync(file.wrapperPath) && isShim(file.wrapperPath)) {
    replaceOwnedBackup(file.originalPath, file.backupPath);
    writeShim(file.wrapperPath, file.realPath ?? file.backupPath);
    return true;
  }
  return false;
}

export function installCodexShim(): { installed: boolean; message: string } {
  const existing = readState();
  if (existing) {
    const files = stateFiles(existing);
    let refreshed = false;
    for (const file of files) refreshed = refreshShimFile(file) || refreshed;
    const allInstalled = files.every(file => file.preserveOnly
      ? existsSync(file.backupPath) && !existsSync(file.originalPath)
      : existsSync(file.wrapperPath)
        && (existsSync(file.backupPath) || (file.realPath ? existsSync(file.realPath) : false))
        && isShim(file.wrapperPath));
    if (refreshed || allInstalled) {
      writeState(primaryState(files));
      if (refreshed) {
        return {
          installed: true,
          message: `Codex update detected. Backed up new launcher and refreshed shim at ${files.map(f => f.wrapperPath).join(", ")}.`,
        };
      }
      return {
        installed: false,
        message: `Codex autostart shim already installed at ${files.map(f => f.wrapperPath).join(", ")}.`,
      };
    }
  }

  const targets: ShimFileState[] | null = process.platform === "win32"
    ? findWindowsCodexTargets()
    : (() => {
      const originalPath = findCodexOnPath();
      return originalPath ? [{ wrapperPath: originalPath, originalPath, backupPath: backupPathFor(originalPath) }] : null;
    })();
  if (!targets) return { installed: false, message: lastShimDiscoveryError ?? "Could not find a codex executable on PATH." };

  for (const target of targets) {
    if (existsSync(target.backupPath)) return { installed: false, message: `Refusing to overwrite existing backup: ${target.backupPath}` };
  }
  for (const target of targets) {
    if (existsSync(target.originalPath)) renameSync(target.originalPath, target.backupPath);
    if (!target.preserveOnly) writeShim(target.wrapperPath, target.realPath ?? target.backupPath);
  }
  writeState(primaryState(targets));
  return {
    installed: true,
    message: `Codex autostart shim installed at ${targets.map(t => t.wrapperPath).join(", ")}. Original saved at ${targets.map(t => t.backupPath).join(", ")}.`,
  };
}

export function uninstallCodexShim(): { removed: boolean; message: string } {
  const state = readState();
  if (!state) return { removed: false, message: "Codex autostart shim is not installed." };
  const files = stateFiles(state);
  for (const file of files) {
    if (file.preserveOnly) continue;
    if (existsSync(file.wrapperPath) && isShim(file.wrapperPath)) unlinkSync(file.wrapperPath);
  }
  for (const file of files) {
    if (existsSync(file.backupPath) && !existsSync(file.originalPath)) renameSync(file.backupPath, file.originalPath);
  }
  if (existsSync(statePath())) unlinkSync(statePath());
  return { removed: true, message: `Codex autostart shim removed. Restored ${files.map(f => f.originalPath).join(", ")}.` };
}

/** True if a Codex autostart shim is currently installed (state file present). */
export function isCodexShimInstalled(): boolean {
  return readState() !== null;
}

export function codexShimStatus(): string {
  const state = readState();
  if (!state) return "Codex autostart shim is not installed.";
  return stateFiles(state).map(file => {
    const wrapper = existsSync(file.wrapperPath)
      ? isShim(file.wrapperPath)
        ? "shim present"
        : "present but not an opencodex shim"
      : "missing";
    const backup = existsSync(file.backupPath) ? "present" : "missing";
    return `Codex autostart shim: wrapper ${wrapper} at ${file.wrapperPath}; original backup ${backup} at ${file.backupPath}.`;
  }).join("\n");
}
