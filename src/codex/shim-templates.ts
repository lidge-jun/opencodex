import { BUN_RUNTIME_PATH_ENV, BUN_RUNTIME_SOURCE_ENV } from "../lib/bun-runtime";
import type { BunRuntimeSource } from "../lib/bun-runtime";
import { serviceApiTokenFilePath } from "../lib/service-secrets";
import { windowsEnvIndirectBatchValue } from "../lib/win-paths";

const SHIM_MARKER = "opencodex codex autostart shim";
const UNIX_SHIM_REVISION_MARKER = "opencodex unix codex shim revision 2";

const CODEX_SHIM_REENTRY_EXIT_CODE = 126;
const CODEX_SHIM_REENTRY_DIAGNOSTIC = "opencodex: saved Codex launcher resolved back to the autostart shim; run ocx codex-shim uninstall and reinstall Codex before enabling codexAutoStart.";

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

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// Provenance is required rather than defaulted: a default would let a caller pass an
// override binary and silently label it something else, which is precisely the
// path/marker disagreement this feature exists to prevent.
//
// The marker is scoped to the `ensure` invocation in every flavor below and is never
// exported into the shim's own environment. A shim wraps the real `codex`, so an
// exported marker would be inherited by Codex and everything it spawns — a shell that
// then ran a *different* Bun directly would carry a provenance describing a binary it
// is not executing.

export function buildUnixCodexShim(realCodexPath: string, bunPath: string, cliPath: string, bunRuntimeSource: BunRuntimeSource, tokenFile = serviceApiTokenFilePath()): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.join("|");
  const valueOptions = CODEX_GLOBAL_OPTIONS_WITH_VALUE.join("|");
  return `#!/usr/bin/env sh
# ${SHIM_MARKER}
# ${UNIX_SHIM_REVISION_MARKER}
if [ "\${OCX_SHIM_PROBE:-}" = "1" ]; then
  if [ "\${OCX_SHIM_PROBE_ACTIVE:-}" = "1" ]; then
    if [ -n "\${OCX_SHIM_PROBE_REENTRY_PATH:-}" ]; then
      (umask 077; printf '%s\n' recursive > "$OCX_SHIM_PROBE_REENTRY_PATH") 2>/dev/null || true
    fi
    printf '%s\n' ${shQuote(CODEX_SHIM_REENTRY_DIAGNOSTIC)} >&2
    exit ${CODEX_SHIM_REENTRY_EXIT_CODE}
  fi
  OCX_SHIM_PROBE_ACTIVE=1
  export OCX_SHIM_PROBE_ACTIVE
fi
if [ "\${OCX_SHIM_ACTIVE_PID:-}" = "$$" ]; then
  printf '%s\n' ${shQuote(CODEX_SHIM_REENTRY_DIAGNOSTIC)} >&2
  exit ${CODEX_SHIM_REENTRY_EXIT_CODE}
fi
case "\${OCX_SHIM_ACTIVE_DEPTH:-0}" in
  0)
    OCX_SHIM_ACTIVE_DEPTH=1
    ;;
  1)
    OCX_SHIM_ACTIVE_DEPTH=2
    ;;
  *)
    printf '%s\n' ${shQuote(CODEX_SHIM_REENTRY_DIAGNOSTIC)} >&2
    exit ${CODEX_SHIM_REENTRY_EXIT_CODE}
    ;;
esac
# Dynamic launchers such as mise exec -- codex may resolve the command name
# back to this wrapper. An exec chain keeps the same PID. A legitimate nested
# Codex invocation may enter once with a new PID; repeated child-process
# redispatch reaches depth 2 and is rejected before it can form an infinite chain.
OCX_SHIM_ACTIVE_PID=$$
export OCX_SHIM_ACTIVE_PID OCX_SHIM_ACTIVE_DEPTH
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
      ${BUN_RUNTIME_SOURCE_ENV}=${shQuote(bunRuntimeSource)} ${BUN_RUNTIME_PATH_ENV}=${shQuote(bunPath)} ${shQuote(bunPath)} ${shQuote(cliPath)} ensure >/dev/null 2>&1 || true
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

export function buildWindowsCodexShim(realCodexPath: string, bunPath: string, cliPath: string, bunRuntimeSource: BunRuntimeSource): string {
  const internalCommandChecks = CODEX_INTERNAL_COMMANDS.map(command => `if /I "%~1"=="${command}" goto run_codex`).join("\r\n");
  const valueOptionChecks = CODEX_GLOBAL_OPTIONS_WITH_VALUE.map(option => `if /I "%~1"=="${option}" goto skip_option_value`).join("\r\n");
  return `@echo off\r
rem ${SHIM_MARKER}\r
setlocal\r
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
setlocal\r
${windowsBatchSet(BUN_RUNTIME_SOURCE_ENV, bunRuntimeSource)}\r
${windowsBatchSet(BUN_RUNTIME_PATH_ENV, bunPath)}\r
"%OCX_BUN%" "%OCX_CLI%" ensure >nul 2>nul\r
endlocal\r
:run_codex\r
"%OCX_REAL_CODEX%" %*\r
`;
}

function psString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

export function buildWindowsPowerShellCodexShim(realCodexPath: string, bunPath: string, cliPath: string, bunRuntimeSource: BunRuntimeSource): string {
  const internalCommands = CODEX_INTERNAL_COMMANDS.map(command => psString(command)).join(", ");
  const valueOptions = CODEX_GLOBAL_OPTIONS_WITH_VALUE.map(option => psString(option)).join(", ");
  const tokenFile = serviceApiTokenFilePath();
  return `#!/usr/bin/env pwsh
# ${SHIM_MARKER}
$hadApiAuthToken = Test-Path Env:\\OPENCODEX_API_AUTH_TOKEN
$priorApiAuthToken = $env:OPENCODEX_API_AUTH_TOKEN
try {
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
  $priorRuntimeSource = $env:${BUN_RUNTIME_SOURCE_ENV}
  $priorRuntimePath = $env:${BUN_RUNTIME_PATH_ENV}
  $env:${BUN_RUNTIME_SOURCE_ENV} = ${psString(bunRuntimeSource)}
  $env:${BUN_RUNTIME_PATH_ENV} = ${psString(bunPath)}
  try { & ${psString(bunPath)} ${psString(cliPath)} ensure *> $null }
  finally {
    if ($null -eq $priorRuntimeSource) { Remove-Item Env:\\${BUN_RUNTIME_SOURCE_ENV} -ErrorAction SilentlyContinue }
    else { $env:${BUN_RUNTIME_SOURCE_ENV} = $priorRuntimeSource }
    if ($null -eq $priorRuntimePath) { Remove-Item Env:\\${BUN_RUNTIME_PATH_ENV} -ErrorAction SilentlyContinue }
    else { $env:${BUN_RUNTIME_PATH_ENV} = $priorRuntimePath }
  }
}
& ${psString(realCodexPath)} @args
$codexExitCode = $LASTEXITCODE
} finally {
  if ($hadApiAuthToken) { $env:OPENCODEX_API_AUTH_TOKEN = $priorApiAuthToken }
  else { Remove-Item Env:\\OPENCODEX_API_AUTH_TOKEN -ErrorAction SilentlyContinue }
}
exit $codexExitCode
`;
}

/** Git-Bash accepts `C:/...` but not backslashed paths inside sh scripts. */
function gitBashPath(path: string): string {
  return path.replace(/\\/g, "/");
}

export { SHIM_MARKER, UNIX_SHIM_REVISION_MARKER, CODEX_SHIM_REENTRY_EXIT_CODE, CODEX_SHIM_REENTRY_DIAGNOSTIC, shQuote, windowsBatchSet, psString, gitBashPath };
