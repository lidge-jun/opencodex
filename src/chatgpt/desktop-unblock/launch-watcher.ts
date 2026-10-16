import { execFileSync, spawnSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { connect as connectSocket } from "node:net";
import { connect as connectTls } from "node:tls";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getConfigDir } from "../../config/paths";
import { claudeInterceptCaCertPath } from "../../claude/intercept/local-ca";
import { CHATGPT_INTERCEPT_HOST, CHATGPT_UNBLOCK_IDENTITY_PATH, CHATGPT_UNBLOCK_SERVICE_ID } from "./listener";
import type { PreservedSendBlock } from "./rewrite";
import { CHATGPT_UNBLOCK_PAC_ARG_PREFIX, chatgptUnblockPacArg, chatgptUnblockPacPath, chatgptUnblockReadyPath, chatgptUnblockResolverArg } from "./runtime";
import { chatgptShimLauncherPath } from "../app-server-shim/launcher";
import { selfLaunchArgv } from "../../lib/self-launch-argv";
import { chatgptWatcherBundleProblem } from "./bundle-preflight";

/**
 * Launch integration for the ChatGPT desktop send-unblock intercept.
 *
 * The launch switches only apply when the app is launched with them, so a normal
 * Dock/Spotlight start reaches the real chatgpt.com and the composer locks again. This module
 * installs a launchd agent that watches the app's Electron `SingletonLock` -- written on every
 * launch -- and, exactly once per launch, restarts the app with the switches if it was
 * started without them. It also watches a readiness marker opencodex writes once its listener is
 * up, so an app that started before opencodex (both open at login) is corrected as soon as the
 * listener answers. There is no resident polling process: launchd wakes the script on either
 * event and the script exits after one check. In watch mode it only restarts an app that started
 * within the last five minutes, so it never quits an app the user has been working in.
 *
 * The watcher only acts when the opencodex intercept listener answers its identity path, so
 * with the feature off -- or another process holding the port -- the app is left native.
 *
 * The watcher, `ocx chatgpt launch` and `ocx chatgpt restore` run the same script, so the launch
 * arguments are built in exactly one place. The mode decides the switch set:
 *
 *   resolver-rule mode (default):
 *   - always `--host-resolver-rules=MAP chatgpt.com 127.0.0.1:<port>`;
 *   - with an HTTP(S)/SOCKS system proxy (a VPN in system-proxy mode), also
 *     `--proxy-server=<proxy>` and `--proxy-bypass-list=chatgpt.com`. Chromium hands
 *     proxied hosts to the proxy unresolved, which would skip the resolver rule, so the apex host
 *     must bypass the proxy. The bypass list only takes effect beside an explicit proxy server,
 *     and a bare hostname there matches that host exactly (subdomains stay on the proxy). A
 *     failed configured proxy does not silently fall back to a direct connection;
 *   - with no proxy, or TUN mode (loopback never enters the tunnel), the resolver rule alone;
 *   - with a PAC file, the resolver rule alone: PAC cannot be combined with a bypass, so
 *     chatgpt.com may stay on the proxy and the composer may lock, but nothing else breaks.
 *
 *   PAC-fallback mode (`chatgptDesktop.pacFallback`): only `--proxy-pac-url=data:...` carrying the
 *   PAC inline (a `file://` PAC is ignored by the app). The
 *   PAC (regenerated at every opencodex start) sends chatgpt.com to the CONNECT entry listener,
 *   which splices onto the TLS origin listener; when opencodex is down the refused CONNECT makes
 *   Chromium fall through to the captured system policy (static proxy chains add no DIRECT) -- no resolver rule
 *   may be present, or it would blackhole that fallback to the dead origin port. No app restart
 *   is needed to recover.
 */

export const CHATGPT_APP_PATH = "/Applications/ChatGPT.app";
/** The desktop app is `openai-codex-electron` internally: its Electron userData dir is `Codex`. */
export const CHATGPT_SINGLETON_LOCK_PATH = "Library/Application Support/Codex/SingletonLock";

/** How recently the app must have started for watch mode to restart it. */
export const CHATGPT_WATCHER_FRESH_APP_SECONDS = 300;
export const CHATGPT_UNBLOCK_WATCHER_LABEL = "com.opencodex.chatgpt-unblock-watcher";

function expandHome(path: string): string {
  return path.startsWith("~") ? join(homedir(), path.slice(1)) : path;
}

/** A value for a single-quoted bash word: `'` becomes `'\''`. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** A value for a plist `<string>` element. */
function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

export interface ChatgptUnblockWatcherPaths {
  scriptPath: string;
  plistPath: string;
  errPath: string;
  lockPath: string;
  /** Written by opencodex once its listener is up; the agent wakes on it too. */
  readyPath: string;
}

export function chatgptUnblockWatcherPaths(configDir?: string): ChatgptUnblockWatcherPaths {
  const dir = configDir ?? getConfigDir();
  return {
    scriptPath: join(dir, "chatgpt-unblock-watcher.sh"),
    plistPath: expandHome(`~/Library/LaunchAgents/${CHATGPT_UNBLOCK_WATCHER_LABEL}.plist`),
    errPath: join(dir, "chatgpt-unblock-watcher.err"),
    lockPath: expandHome(`~/${CHATGPT_SINGLETON_LOCK_PATH}`),
    readyPath: chatgptUnblockReadyPath(dir),
  };
}

/** Where the launch script records what it did; kept beside the rest of the opencodex state. */
function chatgptUnblockWatcherLogPath(configDir?: string): string {
  return join(configDir ?? getConfigDir(), "chatgpt-unblock-watcher.log");
}

/**
 * The launch script.
 *   watch  (launchd, on every app launch) only corrects a running app that lacks the switches;
 *   launch (`ocx chatgpt launch`) also starts the app when it is not running;
 *   native (`ocx chatgpt restore`) restarts a switched app WITHOUT them, for when the
 *          listener is gone or the feature is being turned off.
 *
 * `pacMode` switches the argument set (see the module doc): the PAC switch alone when on, the
 * resolver rule [+ proxy/bypass] otherwise. The app is "flagged" by whichever switch the mode
 * uses, so a mode change makes the watcher correct an app launched under the other mode.
 */
export interface ChatgptWatcherBundle {
  appPath: string;
  /** Test seam: the shared trust-check command, without its bundle-path argument. */
  preflightArgv?: readonly string[];
}

export function buildChatgptUnblockWatcherScript(
  port: number,
  configDir?: string,
  shimMode = false,
  pac?: { entryPort: number },
  bundle: ChatgptWatcherBundle = { appPath: CHATGPT_APP_PATH },
): string {
  const preflight = bundle.preflightArgv ?? [process.execPath, ...selfLaunchArgv(["internal", "chatgpt-bundle-preflight"], { sourceEntrypoint: fileURLToPath(new URL("../../cli/index.ts", import.meta.url)) })];
  const pacFile = chatgptUnblockPacPath(configDir ?? getConfigDir());
  return `#!/bin/bash
# opencodex ChatGPT send-unblock launcher.
#   watch  (launchd, fired by the app's Electron SingletonLock on every launch and by the
#          readiness marker opencodex writes once its listener is up): if the app is running
#          WITHOUT the launch switches (a normal Dock/Spotlight launch) and started within the
#          last FRESH_APP_SECONDS, restart it once with them. A correctly launched app, an app
#          the user has been working in, or an absent intercept, is left alone.
#   launch (ocx chatgpt launch): same, and start the app if it is not running.
#   native (ocx chatgpt restore): restart an app that carries the switches without them.

PORT=${port}
MODE="\${1:-watch}"
unset CODEX_CLI_PATH
RESOLVER_ARG=${shellQuote(chatgptUnblockResolverArg(port))}
PAC_FILE=${shellQuote(pacFile)}
PAC_PREFIX=${shellQuote(CHATGPT_UNBLOCK_PAC_ARG_PREFIX)}
PAC_MODE=${pac ? "1" : "0"}
ENTRY_URL=${shellQuote(`http://127.0.0.1:${pac?.entryPort ?? 0}/`)}
SHIM_MODE=${shimMode ? "1" : "0"}
SHIM_SCRIPT=${shellQuote(chatgptShimLauncherPath(configDir ?? getConfigDir()))}
BYPASS_HOST=${shellQuote(CHATGPT_INTERCEPT_HOST)}
APP_BUNDLE=${shellQuote(bundle.appPath)}
APP_BINARY=${shellQuote(join(bundle.appPath, "Contents", "MacOS", "ChatGPT"))}
BUNDLE_PREFLIGHT=(${preflight.map(shellQuote).join(" ")})
CA_CERT=${shellQuote(claudeInterceptCaCertPath(configDir ?? getConfigDir()))}
IDENTITY_URL=${shellQuote(`https://${CHATGPT_INTERCEPT_HOST}:${port}${CHATGPT_UNBLOCK_IDENTITY_PATH}`)}
ENTRY_IDENTITY_URL=${shellQuote(`https://${CHATGPT_INTERCEPT_HOST}${CHATGPT_UNBLOCK_IDENTITY_PATH}`)}
SERVICE_ID=${shellQuote(`"service":"${CHATGPT_UNBLOCK_SERVICE_ID}"`)}
LOG=${shellQuote(chatgptUnblockWatcherLogPath(configDir))}
LOCK_DIR="\${TMPDIR:-/tmp}/opencodex-chatgpt-launch.lock"
FRESH_APP_SECONDS=${CHATGPT_WATCHER_FRESH_APP_SECONDS}

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
say() { [ "$MODE" != watch ] && echo "$*"; log "$*"; }
# The app-server shim is chosen through the app's CODEX_CLI_PATH environment variable, which 'ps eww'
# shows for the app's own process as soon as it exists (a child process would only appear later).
app_has_shim() {
  ps eww -o command= -p "$1" 2>/dev/null | grep -qF "CODEX_CLI_PATH=$SHIM_SCRIPT"
}
# The app's main process: found by exact process name, then confirmed by path. Matching the
# whole command line instead would also match any shell whose command mentions the rule.
# -a: pgrep skips its own ancestors by default, and a command run from a terminal inside the
# desktop app has the app as an ancestor.
app_pid() {
  local pid
  for pid in $(pgrep -a -x ChatGPT 2>/dev/null); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      "$APP_BINARY"|"$APP_BINARY "*) echo "$pid"; return 0 ;;
    esac
  done
  return 1
}
app_running() { app_pid >/dev/null; }
# Seconds a process has been running, from ps's [[dd-]hh:]mm:ss elapsed time. Fails when it
# cannot be read, which the caller treats as a fresh launch.
app_age() {
  local etime days=0 h=0 m s a b c
  etime=$(ps -o etime= -p "$1" 2>/dev/null | tr -d ' ')
  [ -n "$etime" ] || return 1
  case "$etime" in *-*) days=\${etime%%-*}; etime=\${etime#*-} ;; esac
  IFS=: read -r a b c <<< "$etime"
  if [ -n "$c" ]; then h=$a; m=$b; s=$c; else m=$a; s=$b; fi
  case "$days:$h:$m:$s" in *::*|:*|*:|*[!0-9:]*) return 1 ;; esac
  echo $(( 10#$days * 86400 + 10#$h * 3600 + 10#$m * 60 + 10#$s ))
}
# The PAC travels inline as a data: URL (a file:// PAC is ignored by the app), so the switch is
# rebuilt from the file opencodex regenerated at its last start. Reject unavailable/empty files
# and propagate read/encoding failures instead of returning a prefix with an incomplete payload.
pac_arg() {
  [ -f "$PAC_FILE" ] && [ -r "$PAC_FILE" ] || return 1
  local encoded
  encoded=$(set -o pipefail; base64 < "$PAC_FILE" | tr -d '\n') || return 1
  [ -n "$encoded" ] || return 1
  printf '%s%s' "$PAC_PREFIX" "$encoded"
}
# Flagged by whichever switch the configured mode uses, so a mode change corrects an app launched
# under the other mode.
app_flagged() {
  local pid cmdline pac
  pid=$(app_pid) || return 1
  cmdline=$(ps -o command= -p "$pid" 2>/dev/null)
  if [ "$PAC_MODE" = 1 ]; then
    pac=$(pac_arg) || return 1
    case "$cmdline" in *" $pac"*) return 0 ;; esac
    return 1
  fi
  case "$cmdline" in *" $RESOLVER_ARG"*) return 0 ;; esac
  return 1
}

# The shim is wanted only while its launcher exists: opencodex writes it after the bundle passes
# the OpenAI signature check. Pointing the app at a missing launcher would leave it without an
# app-server.
shim_wanted() {
  [ "$SHIM_MODE" = 1 ] && [ -x "$SHIM_SCRIPT" ]
}

# Either launch switch, whatever the configured mode: restore must also undo the switch an app was
# launched with, including any PAC (an older script, or the file:// form from before the inline
# one), and an app started through the shim counts too, so restore can hand it back native.
app_switched() {
  local pid
  pid=$(app_pid) || return 1
  local cmdline
  cmdline=$(ps -o command= -p "$pid" 2>/dev/null)
  case "$cmdline" in *" $PAC_PREFIX"*|*" --proxy-pac-url=file://$PAC_FILE"*|*" $RESOLVER_ARG"*) return 0 ;; esac
  app_has_shim "$pid" && return 0
  return 1
}
# Authenticate both the local authority and chatgpt.com before accepting the service identity.
# -q disables curlrc overrides; the explicit loopback mapping and proxy policy prevent a probe
# from leaving this machine. No user keychain trust is required or changed.
listener_ours() {
  local identity
  identity=$(curl -qfsS --noproxy '*' --max-time 3 --cacert "$CA_CERT" \\
    --resolve "$BYPASS_HOST:$PORT:127.0.0.1" "$IDENTITY_URL" 2>/dev/null) || return 1
  printf '%s' "$identity" | grep -qF "$SERVICE_ID"
}
# Prove that the PAC entry actually CONNECTs to the authenticated intercept, not just that
# something accepts TCP. Empty/failed responses (including curl exit 56) are never readiness.
entry_ours() {
  [ "$ENTRY_URL" != ${shellQuote("http://127.0.0.1:0/")} ] || return 1
  local identity
  identity=$(curl -qfsS --noproxy '' --max-time 3 --cacert "$CA_CERT" \\
    --proxy "$ENTRY_URL" "$ENTRY_IDENTITY_URL" 2>/dev/null) || return 1
  printf '%s' "$identity" | grep -qF "$SERVICE_ID"
}
# \`open\` on a running app only activates it and drops the arguments, so the old instance must
# be fully gone first. Quit is re-sent because the app can ignore it while starting up.
quit_app() {
  for attempt in 1 2 3; do
    osascript -e 'on run argv' -e 'tell application (POSIX file (item 1 of argv) as text) to quit' -e 'end run' "$APP_BUNDLE" >/dev/null 2>&1
    for _ in $(seq 1 20); do
      app_running || return 0
      sleep 0.25
    done
  done
  ! app_running
}

# Extra switches for the current system proxy, one per line (none without a proxy). Only in
# resolver-rule mode: the PAC carries the system chain itself.
proxy_args() {
  [ "$PAC_MODE" = 0 ] || return 0
  local out
  out=$(scutil --proxy 2>/dev/null) || return 1
  printf '%s\\n' "$out" | grep -q '^[[:space:]]*<dictionary>[[:space:]]*[{]' || return 1
  printf '%s\\n' "$out" | tail -n 1 | grep -q '[}][[:space:]]*$' || return 1
  val() { printf '%s\\n' "$out" | awk -v k="$1" '$1 == k { sub(/^[^:=]*[:=][[:space:]]*/, ""); sub(/[[:space:]]*$/, ""); print; exit }'; }
  local key
  for key in HTTPSEnable HTTPEnable SOCKSEnable ProxyAutoConfigEnable ProxyAutoDiscoveryEnable; do
    case "$(val "$key")" in ''|0|1) ;; *) return 1 ;; esac
  done
  if [ "$(val ProxyAutoConfigEnable)" = 1 ] || [ "$(val ProxyAutoDiscoveryEnable)" = 1 ]; then return 0; fi
  local scheme host port
  if [ "$(val HTTPSEnable)" = 1 ]; then scheme=http; host=$(val HTTPSProxy); port=$(val HTTPSPort)
  elif [ "$(val HTTPEnable)" = 1 ]; then scheme=http; host=$(val HTTPProxy); port=$(val HTTPPort)
  elif [ "$(val SOCKSEnable)" = 1 ]; then scheme=socks5; host=$(val SOCKSProxy); port=$(val SOCKSPort)
  else return 0
  fi
  [ -n "$host" ] && [ -n "$port" ] || return 1
  # Reject proxy-list delimiters and malformed addresses instead of letting Chromium discard
  # the configured proxy. IPv6 literals are validated, then bracketed in the switch.
  case "$host" in
    *:*)
      case "$host" in
        '['*']') host="\${host#[}"; host="\${host%]}" ;;
        *'['*|*']'*) return 1 ;;
      esac
      printf '%s\\n' "$host" | awk -F: '
        /[^0-9a-fA-F:]/ || /:::/ || /^:[^:]/ || /[^:]:$/ { exit 1 }
        { n = split($0, parts, "::"); if (n > 2) exit 1;
          groups = 0; for (i = 1; i <= NF; i++) { if (length($i) > 4) exit 1; if (length($i)) groups++; }
          if (n == 2) { if (groups >= 8) exit 1; }
          else if (groups != 8) exit 1;
        }' || return 1
      host="[$host]" ;;
    *)
      printf '%s\\n' "$host" | awk -F. '
        length($0) > 253 { exit 1 }
        { numeric = ($0 ~ /^[0-9.]+$/); if ($NF == "") NF--;
          if (numeric && NF != 4) exit 1;
          for (i = 1; i <= NF; i++) {
            if (length($i) < 1 || length($i) > 63 || $i !~ /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/) exit 1;
            if (numeric && ($i > 255 || (length($i) > 1 && substr($i, 1, 1) == "0"))) exit 1;
          }
        }' || return 1 ;;
  esac
  case "$port" in *[!0-9]*|'') return 1 ;; esac
  [ "$port" -ge 1 ] && [ "$port" -le 65535 ] || return 1
  printf '%s\\n' "--proxy-server=$scheme://$host:$port" "--proxy-bypass-list=$BYPASS_HOST"
}

if [ "$MODE" != native ] && ! listener_ours; then
  [ "$MODE" = launch ] && { echo "opencodex's ChatGPT listener is not answering on port $PORT; start opencodex first" >&2; exit 1; }
  exit 0
fi
if [ "$MODE" != native ] && [ "$PAC_MODE" = 1 ] && ! entry_ours; then
  [ "$MODE" = launch ] && { echo "the ChatGPT PAC entry listener is not answering; start opencodex first" >&2; exit 1; }
  exit 0
fi
# One run at a time: quitting the app deletes the SingletonLock, which fires launchd again.
# A lock left by a killed run expires after two minutes.
find "$LOCK_DIR" -maxdepth 0 -mmin +2 -exec rmdir {} \\; 2>/dev/null
mkdir "$LOCK_DIR" 2>/dev/null || {
  [ "$MODE" = launch ] && { echo "another ChatGPT launch is in progress; retry shortly" >&2; exit 1; }
  exit 0
}
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

if [ "$MODE" = native ]; then
  if ! app_running; then say "ChatGPT is not running"; exit 0; fi
  if ! app_switched; then say "ChatGPT is already running without the launch switches"; exit 0; fi
  "\${BUNDLE_PREFLIGHT[@]}" "$APP_BUNDLE" || { say "ChatGPT bundle verification failed; leaving the app untouched"; exit 1; }
  say "ChatGPT carries the launch switches; restarting it without"
  quit_app || { say "ChatGPT did not quit; quit it manually and reopen it"; exit 1; }
  open -a "$APP_BUNDLE" || { say "could not relaunch ChatGPT with native networking"; exit 1; }
  say "relaunched ChatGPT with native networking"
  exit 0
fi

RESTART_APP=0
if app_running; then
  if app_flagged; then
    if shim_wanted && ! app_has_shim "$(app_pid)"; then
      : # started without the shim; fall through and correct it below
    else
      say "ChatGPT is already running with the launch switches"
      exit 0
    fi
  fi
  # The readiness marker fires this while the app may have been open for hours (opencodex
  # restarted under it). Only an app that just started is restarted; the explicit launch command
  # always acts.
  if [ "$MODE" = watch ] && age=$(app_age "$(app_pid)") && [ "$age" -gt "$FRESH_APP_SECONDS" ]; then
    log "ChatGPT has been running for \${age}s without the launch switches; leaving it (run 'ocx chatgpt launch' to restart it with them)"
    exit 0
  fi
  RESTART_APP=1
elif [ "$MODE" != launch ]; then
  exit 0
fi

"\${BUNDLE_PREFLIGHT[@]}" "$APP_BUNDLE" || { say "ChatGPT bundle verification failed; leaving the app untouched"; exit 1; }
# Prepare every launch argument before quitting; open uses this same PAC snapshot even if the
# file changes while the old app exits. Failed preflight leaves a running app untouched.
ARGS=()
if [ "$PAC_MODE" = 1 ]; then
  PAC_SWITCH=$(pac_arg) || { say "cannot prepare PAC file at $PAC_FILE; start opencodex with pacFallback first"; exit 1; }
  ARGS+=("$PAC_SWITCH")
else
  ARGS+=("$RESOLVER_ARG")
fi
PROXY_ARGS=$(proxy_args) || { say "cannot read the system proxy policy; leaving the app untouched"; exit 1; }
while IFS= read -r arg; do
  [ -n "$arg" ] && ARGS+=("$arg")
done <<< "$PROXY_ARGS"
OPEN_ENV=()
if [ "$SHIM_MODE" = 1 ]; then OPEN_ENV=(--env "CODEX_CLI_PATH=$SHIM_SCRIPT"); fi
# Bundle signature verification can take time. Recheck readiness at the action boundary
# so a listener that stopped during preflight cannot make us quit a healthy native app.
if ! listener_ours || { [ "$PAC_MODE" = 1 ] && ! entry_ours; }; then
  say "ChatGPT listener readiness changed during preflight; leaving the app untouched"
  exit 1
fi
if [ "$RESTART_APP" = 1 ]; then
  say "ChatGPT is running without the launch switches; restarting it"
  quit_app || { say "ChatGPT did not quit; leaving it running without the switches"; exit 1; }
fi
open -a "$APP_BUNDLE" \${OPEN_ENV[@]+"\${OPEN_ENV[@]}"} --args "\${ARGS[@]}" || { say "could not launch ChatGPT"; exit 1; }
say "launched ChatGPT with: \${ARGS[*]}"
`;
}

/** `bash -n` on a script file: parses without running it. */
export function checkChatgptWatcherScriptSyntax(scriptPath: string): CommandResult {
  return sh("/bin/bash", ["-n", scriptPath]);
}

/** One-shot launchd agent: wake on the app's SingletonLock or the readiness marker, run the script, exit. */
export function buildChatgptUnblockWatcherPlist(scriptPath: string, watchPaths: string | readonly string[], errPath: string): string {
  const watched = (typeof watchPaths === "string" ? [watchPaths] : watchPaths).map(path => `    <string>${xmlEscape(path)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${CHATGPT_UNBLOCK_WATCHER_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${xmlEscape(scriptPath)}</string>
    <string>watch</string>
  </array>
  <key>WatchPaths</key>
  <array>
${watched}
  </array>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(errPath)}</string>
</dict>
</plist>
`;
}

interface CommandResult {
  ok: boolean;
  status: number | null;
  output: string;
}

function sh(command: string, args: string[]): CommandResult {
  try {
    const output = execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { ok: true, status: 0, output };
  } catch (error) {
    const err = error as { status?: number | null; stdout?: string; stderr?: string };
    return { ok: false, status: err.status ?? null, output: `${err.stdout ?? ""}${err.stderr ?? ""}`.trim() };
  }
}

/** Runs `launchctl <args>`; injectable so install/uninstall can be tested without launchd. */
export type LaunchctlRunner = (args: string[]) => CommandResult;
const defaultLaunchctl: LaunchctlRunner = args => sh("launchctl", args);

/**
 * Whether a `bootout` exit status means "nothing was loaded there" rather than a failure: 3 is
 * "No such process", 113/112 answer for the service and the domain. Same statuses as
 * `launchctlBootoutBenign` in src/service/launchd.ts, restated so the server-side lifecycle that
 * imports this module does not pull in the service manager.
 */
function launchctlBootoutBenign(status: number | null): boolean {
  return status === 0 || status === 3 || status === 112 || status === 113;
}

function watcherDomain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export interface InstallChatgptUnblockWatcherOptions {
  port: number;
  /** The absolute discovered bundle path, retained and revalidated on every wake. */
  appPath?: string;
  /** PAC mode: the CONNECT entry port the generated script checks and the app is pointed at. */
  entryPort?: number;
  /** Start the app through the app-server shim (`CODEX_CLI_PATH`). */
  shimMode?: boolean;
  configDir?: string;
  /** Test seam: skip the macOS / app-presence guards. */
  assumeSupported?: boolean;
  /** Test seam: where the agent plist is written instead of ~/Library/LaunchAgents. */
  plistPath?: string;
  /** Test seam: the script body written instead of the generated one. */
  scriptText?: string;
  launchctl?: LaunchctlRunner;
}

/**
 * Install the launch watcher: write script + agent plist and load it with launchd. Throws with
 * launchctl's diagnostic when the agent cannot be loaded, and removes the files it wrote so a
 * failed install leaves nothing half-installed behind.
 */
export function installChatgptUnblockWatcher(options: InstallChatgptUnblockWatcherOptions): void {
  if (process.platform !== "darwin" && !options.assumeSupported) {
    throw new Error("the ChatGPT launch watcher is only supported on macOS");
  }
  const appPath = options.appPath ?? CHATGPT_APP_PATH;
  if (!options.assumeSupported) {
    const problem = chatgptWatcherBundleProblem(appPath);
    if (problem) throw new Error(`Refusing to install the ChatGPT watcher: ${problem}`);
  }
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const paths = { ...chatgptUnblockWatcherPaths(options.configDir), ...(options.plistPath ? { plistPath: options.plistPath } : {}) };
  // Unload any previous generation first; "not loaded" is the expected answer on a fresh install.
  const previous = launchctl(["bootout", `${watcherDomain()}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]);
  if (!launchctlBootoutBenign(previous.status)) {
    throw new Error(`could not unload the previous watcher (launchctl bootout exited ${previous.status}): ${previous.output}`);
  }
  if (!options.plistPath) mkdirSync(expandHome("~/Library/LaunchAgents"), { recursive: true });
  writeFileSync(
    paths.scriptPath,
    options.scriptText ?? buildChatgptUnblockWatcherScript(
      options.port,
      options.configDir,
      options.shimMode === true,
      options.entryPort !== undefined ? { entryPort: options.entryPort } : undefined,
      { appPath },
    ),
    { mode: 0o700 },
  );
  // The script is generated from a template literal and never parsed as bash before launchd runs
  // it, so a quoting slip would install a watcher that dies on every app launch. Refuse it here.
  const syntax = checkChatgptWatcherScriptSyntax(paths.scriptPath);
  if (!syntax.ok) {
    rmSync(paths.scriptPath, { force: true });
    throw new Error(`the generated watcher script is not valid bash: ${syntax.output || `bash -n exited ${syntax.status}`}`);
  }
  writeFileSync(paths.plistPath, buildChatgptUnblockWatcherPlist(paths.scriptPath, [paths.lockPath, paths.readyPath], paths.errPath));
  const loaded = launchctl(["bootstrap", watcherDomain(), paths.plistPath]);
  if (!loaded.ok) {
    rmSync(paths.plistPath, { force: true });
    rmSync(paths.scriptPath, { force: true });
    throw new Error(`launchctl bootstrap exited ${loaded.status}: ${loaded.output || "no diagnostic"}`);
  }
}

export interface UninstallChatgptUnblockWatcherOptions {
  configDir?: string;
  plistPath?: string;
  launchctl?: LaunchctlRunner;
}

/**
 * Remove the launch watcher: unload the agent, then delete its files. An agent that was not
 * loaded is fine; any other unload failure throws and keeps the files, so the installed state
 * and what is on disk never disagree.
 */
export function uninstallChatgptUnblockWatcher(options: UninstallChatgptUnblockWatcherOptions = {}): void {
  const launchctl = options.launchctl ?? defaultLaunchctl;
  const paths = { ...chatgptUnblockWatcherPaths(options.configDir), ...(options.plistPath ? { plistPath: options.plistPath } : {}) };
  const unloaded = launchctl(["bootout", `${watcherDomain()}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]);
  if (!launchctlBootoutBenign(unloaded.status)) {
    throw new Error(`launchctl bootout exited ${unloaded.status}: ${unloaded.output || "no diagnostic"}; watcher files kept`);
  }
  rmSync(paths.plistPath, { force: true });
  rmSync(paths.scriptPath, { force: true });
}

export interface ChatgptUnblockWatcherStatus {
  scriptInstalled: boolean;
  plistInstalled: boolean;
  agentLoaded: boolean;
  scriptUpToDate: boolean;
  plistUpToDate: boolean;
}

/** Check launchd state alone, without reading installed watcher files or building a script. */
export function chatgptUnblockWatcherLoaded(launchctl: LaunchctlRunner = defaultLaunchctl): boolean {
  return launchctl(["print", `${watcherDomain()}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]).ok;
}

export function chatgptUnblockWatcherStatus(
  port: number,
  configDir?: string,
  shimMode = false,
  pac?: { entryPort: number },
  appPath = CHATGPT_APP_PATH,
): ChatgptUnblockWatcherStatus {
  const paths = chatgptUnblockWatcherPaths(configDir);
  const scriptInstalled = existsSync(paths.scriptPath);
  const plistInstalled = existsSync(paths.plistPath);
  const agentLoaded = chatgptUnblockWatcherLoaded();
  const scriptUpToDate = scriptInstalled
    && readFileSync(paths.scriptPath, "utf8") === buildChatgptUnblockWatcherScript(port, configDir, shimMode, pac, { appPath });
  const plistUpToDate = plistInstalled
    && readFileSync(paths.plistPath, "utf8") === buildChatgptUnblockWatcherPlist(paths.scriptPath, [paths.lockPath, paths.readyPath], paths.errPath);
  return { scriptInstalled, plistInstalled, agentLoaded, scriptUpToDate, plistUpToDate };
}

/**
 * The running app's command line, or null. Mirrors the script's `app_pid`: exact process name
 * (ancestors included, since `ocx` may run in a terminal inside the app), then the bundle path,
 * never a match against every command line.
 */
export function chatgptAppCommandLine(): string | null {
  const pids = sh("pgrep", ["-a", "-x", "ChatGPT"]);
  if (!pids.ok) return null;
  for (const pid of pids.output.split(/\s+/).filter(Boolean)) {
    const command = sh("ps", ["-o", "command=", "-p", pid]);
    if (command.ok && command.output.includes("ChatGPT.app/Contents/MacOS/ChatGPT")) return command.output.trim();
  }
  return null;
}

/**
 * Whether the running app was started through the app-server shim. The choice travels in the
 * app's CODEX_CLI_PATH environment variable, which "ps eww" shows for the app's own process.
 */
export function chatgptAppHasShim(configDir: string): boolean {
  const pids = sh("pgrep", ["-a", "-x", "ChatGPT"]);
  if (!pids.ok) return false;
  const marker = `CODEX_CLI_PATH=${chatgptShimLauncherPath(configDir)}`;
  for (const pid of pids.output.split(/\s+/).filter(Boolean)) {
    const command = sh("ps", ["eww", "-o", "command=", "-p", pid]);
    if (command.ok && command.output.includes("ChatGPT.app/Contents/MacOS/ChatGPT")) return command.output.includes(marker);
  }
  return false;
}

/** Whether a command line carries the resolver switch for `port`. */
/** Whether a command line carries the PAC switch of the given config dir. */
export function chatgptCommandLineHasPac(commandLine: string, configDir: string): boolean {
  // The exact current script, or a file:// switch from before the inline form (still "ours").
  return commandLine.includes(` ${chatgptUnblockPacArg(configDir)}`)
    || commandLine.includes(` --proxy-pac-url=file://${chatgptUnblockPacPath(configDir)}`);
}

export function chatgptCommandLineHasRule(commandLine: string, port: number): boolean {
  return commandLine.includes(` ${chatgptUnblockResolverArg(port)}`);
}


export type ChatgptListenerProbe =
  | { state: "ours"; preservedSendBlocks: (PreservedSendBlock & { lastSeen: string })[] }
  /** Something answers on the port, but not opencodex's listener. */
  | { state: "foreign" }
  | { state: "down" };

/** Whether anything accepts a TCP connection on the loopback port. */
function loopbackPortOpen(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connectSocket({ host: "127.0.0.1", port });
    const done = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.setTimeout(3000, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * GET the listener's identity path over a raw TLS socket and return the response body, or null.
 * Not fetch: Bun's fetch sends even loopback requests through HTTP(S)_PROXY from the user's
 * shell and ignores `proxy: false` (Bun 1.4), and a proxy cannot reach this machine's loopback.
 */
function requestIdentity(port: number, configDir = getConfigDir()): Promise<string | null> {
  let ca: string;
  try {
    // Trust exactly the locally published authority, never the OS/default root store. A
    // missing, invalid or non-CA certificate cannot authorize a listener on this port.
    const certificate = new X509Certificate(readFileSync(claudeInterceptCaCertPath(configDir)));
    if (!certificate.ca) return Promise.resolve(null);
    ca = certificate.toString();
  } catch {
    return Promise.resolve(null);
  }
  return new Promise(resolve => {
    let raw = "";
    let settled = false;
    let socket: ReturnType<typeof connectTls> | undefined;
    const finish = (body: string | null) => {
      if (settled) return;
      settled = true;
      socket?.destroy();
      resolve(body);
    };
    try {
      socket = connectTls({ host: "127.0.0.1", port, servername: CHATGPT_INTERCEPT_HOST, ca, rejectUnauthorized: true }, () => {
        socket!.write(`GET ${CHATGPT_UNBLOCK_IDENTITY_PATH} HTTP/1.1\r\nHost: ${CHATGPT_INTERCEPT_HOST}\r\nConnection: close\r\n\r\n`);
      });
    } catch {
      finish(null);
      return;
    }
    socket.setTimeout(3000, () => finish(null));
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => { raw += chunk; });
    socket.on("error", () => finish(null));
    socket.on("end", () => {
      const split = raw.indexOf("\r\n\r\n");
      finish(split !== -1 && /^HTTP\/1\.[01] 200\b/.test(raw) ? raw.slice(split + 4) : null);
    });
  });
}

/**
 * Ask the port who holds it. A plain TCP connect decides "down" -- error codes for a refused
 * connection vary by runtime and network setup -- and only an open port is asked for its
 * identity through the listener's local identity path, authenticated by the published local CA.
 */
export async function probeChatgptUnblockListener(
  port: number,
  request: (port: number, configDir?: string) => Promise<string | null> = requestIdentity,
  portOpen: (port: number) => Promise<boolean> = loopbackPortOpen,
  configDir = getConfigDir(),
): Promise<ChatgptListenerProbe> {
  if (!(await portOpen(port))) return { state: "down" };
  const text = await request(port, configDir);
  if (text === null) return { state: "foreign" };
  try {
    const body = JSON.parse(text) as { service?: unknown; preservedSendBlocks?: unknown };
    if (body.service !== CHATGPT_UNBLOCK_SERVICE_ID) return { state: "foreign" };
    const blocks = Array.isArray(body.preservedSendBlocks) ? body.preservedSendBlocks : [];
    return { state: "ours", preservedSendBlocks: blocks as (PreservedSendBlock & { lastSeen: string })[] };
  } catch {
    return { state: "foreign" };
  }
}

function runLaunchScript(
  mode: "launch" | "native",
  port: number,
  configDir?: string,
  shimMode = false,
  pac?: { entryPort: number },
  appPath = CHATGPT_APP_PATH,
): { ok: boolean; output: string } {
  if (process.platform !== "darwin") {
    throw new Error("launching the ChatGPT desktop app is only supported on macOS");
  }
  // The script goes in on stdin, so no file is needed and the script's own command line never
  // looks like the app's.
  // An inherited CODEX_CLI_PATH (ocx run inside the app) must not leak into the relaunch.
  const env = { ...process.env };
  delete env.CODEX_CLI_PATH;
  const result = spawnSync("/bin/bash", ["-s", mode], {
    env,
    input: buildChatgptUnblockWatcherScript(port, configDir, shimMode, pac, { appPath }),
    encoding: "utf8",
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Start the app with the launch arguments, restarting it if it runs without them (macOS). */
export function launchChatgptWithRule(
  port: number,
  configDir?: string,
  shimMode = false,
  pac?: { entryPort: number },
  appPath = CHATGPT_APP_PATH,
): { ok: boolean; output: string } {
  return runLaunchScript("launch", port, configDir, shimMode, pac, appPath);
}

/** Restart an app that carries the launch switches without them, returning it to native networking. */
export function restoreChatgptNative(
  port: number,
  configDir?: string,
  shimMode = false,
  pac?: { entryPort: number },
  appPath = CHATGPT_APP_PATH,
): { ok: boolean; output: string } {
  return runLaunchScript("native", port, configDir, shimMode, pac, appPath);
}
