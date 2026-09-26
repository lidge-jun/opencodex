import { execFileSync, spawnSync } from "node:child_process";
import { connect as connectSocket } from "node:net";
import { connect as connectTls } from "node:tls";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getConfigDir } from "../../config/paths";
import { CHATGPT_INTERCEPT_HOST, CHATGPT_UNBLOCK_IDENTITY_PATH, CHATGPT_UNBLOCK_SERVICE_ID } from "./listener";
import type { PreservedSendBlock } from "./rewrite";
import { chatgptUnblockPacArg, chatgptUnblockResolverArg } from "./runtime";

/**
 * Launch integration for the ChatGPT desktop send-unblock intercept.
 *
 * The launch switches only apply when the app is launched with them, so a normal
 * Dock/Spotlight start reaches the real chatgpt.com and the composer locks again. This module
 * installs a launchd agent that watches the app's Electron `SingletonLock` -- written on every
 * launch -- and, exactly once per launch, restarts the app with the switches if it was
 * started without them. There is no resident polling process: launchd wakes the script on the
 * lock event and the script exits after one check. Because it fires on launch, it never quits
 * an app the user is already working in.
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
 *     `--proxy-server=<proxy>,direct://` and `--proxy-bypass-list=chatgpt.com`. Chromium hands
 *     proxied hosts to the proxy unresolved, which would skip the resolver rule, so the apex host
 *     must bypass the proxy. The bypass list only takes effect beside an explicit proxy server,
 *     and a bare hostname there matches that host exactly (subdomains stay on the proxy). The
 *     `direct://` fallback keeps the app working if the VPN is switched off after launch;
 *   - with no proxy, or TUN mode (loopback never enters the tunnel), the resolver rule alone;
 *   - with a PAC file, the resolver rule alone: PAC cannot be combined with a bypass, so
 *     chatgpt.com may stay on the proxy and the composer may lock, but nothing else breaks.
 *
 *   PAC-fallback mode (`chatgptDesktop.pacFallback`): only `--proxy-pac-url=file://<pac>`. The
 *   PAC (regenerated at every opencodex start) sends chatgpt.com to the CONNECT entry listener,
 *   which splices onto the TLS origin listener; when opencodex is down the refused CONNECT makes
 *   Chromium fall through to the captured system chain and finally DIRECT -- no resolver rule
 *   may be present, or it would blackhole that fallback to the dead origin port. No app restart
 *   is needed to recover.
 */

export const CHATGPT_APP_PATH = "/Applications/ChatGPT.app";
/** The desktop app is `openai-codex-electron` internally: its Electron userData dir is `Codex`. */
export const CHATGPT_SINGLETON_LOCK_PATH = "Library/Application Support/Codex/SingletonLock";
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
}

export function chatgptUnblockWatcherPaths(configDir?: string): ChatgptUnblockWatcherPaths {
  const dir = configDir ?? getConfigDir();
  return {
    scriptPath: join(dir, "chatgpt-unblock-watcher.sh"),
    plistPath: expandHome(`~/Library/LaunchAgents/${CHATGPT_UNBLOCK_WATCHER_LABEL}.plist`),
    errPath: join(dir, "chatgpt-unblock-watcher.err"),
    lockPath: expandHome(`~/${CHATGPT_SINGLETON_LOCK_PATH}`),
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
export function buildChatgptUnblockWatcherScript(port: number, configDir?: string, pacMode = false, entryPort?: number): string {
  const pacArg = chatgptUnblockPacArg(configDir ?? getConfigDir());
  return `#!/bin/bash
# opencodex ChatGPT send-unblock launcher.
#   watch  (launchd, fired by the app's Electron SingletonLock on every launch): if the app is
#          running WITHOUT the launch switches (a normal Dock/Spotlight launch), restart it once
#          with them. A correctly launched app, or an absent intercept, is left alone.
#   launch (ocx chatgpt launch): same, and start the app if it is not running.
#   native (ocx chatgpt restore): restart an app that carries the switches without them.

PORT=${port}
MODE="\${1:-watch}"
RESOLVER_ARG=${shellQuote(chatgptUnblockResolverArg(port))}
PAC_ARG=${shellQuote(pacArg)}
PAC_MODE=${pacMode ? "1" : "0"}
BYPASS_HOST=${shellQuote(CHATGPT_INTERCEPT_HOST)}
APP_PATTERN='ChatGPT.app/Contents/MacOS/ChatGPT'
IDENTITY_URL=${shellQuote(`https://127.0.0.1:${port}${CHATGPT_UNBLOCK_IDENTITY_PATH}`)}
ENTRY_URL=${shellQuote(`http://127.0.0.1:${entryPort ?? 0}/`)}
SERVICE_ID=${shellQuote(`"service":"${CHATGPT_UNBLOCK_SERVICE_ID}"`)}
LOG=${shellQuote(chatgptUnblockWatcherLogPath(configDir))}
LOCK_DIR="\${TMPDIR:-/tmp}/opencodex-chatgpt-launch.lock"

log() { echo "$(date '+%F %T') $*" >> "$LOG"; }
say() { [ "$MODE" != watch ] && echo "$*"; log "$*"; }
# The app's main process: found by exact process name, then confirmed by path. Matching the
# whole command line instead would also match any shell whose command mentions the rule.
app_pid() {
  local pid
  for pid in $(pgrep -x ChatGPT 2>/dev/null); do
    case "$(ps -o command= -p "$pid" 2>/dev/null)" in
      *"$APP_PATTERN"*) echo "$pid"; return 0 ;;
    esac
  done
  return 1
}
app_running() { app_pid >/dev/null; }
app_flagged() {
  local pid
  pid=$(app_pid) || return 1
  local cmdline
  cmdline=$(ps -o command= -p "$pid" 2>/dev/null)
  if [ "$PAC_MODE" = 1 ]; then
    case "$cmdline" in *" $PAC_ARG"*) return 0 ;; esac
  else
    case "$cmdline" in *" $RESOLVER_ARG"*) return 0 ;; esac
  fi
  return 1
}
# Either launch switch, whatever the configured mode: restore must also undo the switch an app
# was launched with before pacFallback was toggled.
app_switched() {
  local pid
  pid=$(app_pid) || return 1
  local cmdline
  cmdline=$(ps -o command= -p "$pid" 2>/dev/null)
  case "$cmdline" in *" $PAC_ARG"*|*" $RESOLVER_ARG"*) return 0 ;; esac
  return 1
}
# The port must be held by opencodex's listener, not just by any process. The listener answers
# its identity path itself; -k because its certificate names chatgpt.com, --noproxy because a
# proxy in the environment must not be asked to reach loopback.
listener_ours() {
  curl -sk --noproxy '*' --max-time 3 "$IDENTITY_URL" 2>/dev/null | grep -qF "$SERVICE_ID"
}
# In PAC mode the entry listener must also be up: the PAC points chatgpt.com at it, and a
# missing entry would send every chatgpt.com request to a dead first hop.
entry_ours() {
  [ "$ENTRY_URL" != ${shellQuote("http://127.0.0.1:0/")} ] || return 1
  # The probe fetches through the entry as an HTTP proxy (the same job the PAC gives it). It
  # must not carry --noproxy: that would bypass the very proxy being tested. The identity
  # host keeps the probe off the network -- the entry refuses non-CONNECT chatgpt.com:443
  # targets and answers before dialing anything.
  curl -s --max-time 3 -o /dev/null -x "$ENTRY_URL" ${shellQuote(`http://${CHATGPT_INTERCEPT_HOST}/`)} 2>/dev/null
  local status=$?
  # Exit 0 (answered) or 56 (connected, nothing received) means the entry is there; any
  # connection-level failure (7 and friends) means it is not.
  [ "$status" -eq 0 ] || [ "$status" -eq 56 ]
}
# \`open\` on a running app only activates it and drops the arguments, so the old instance must
# be fully gone first. Quit is re-sent because the app can ignore it while starting up.
quit_app() {
  for attempt in 1 2 3; do
    osascript -e 'quit app "ChatGPT"' >/dev/null 2>&1
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
  out=$(scutil --proxy 2>/dev/null) || return 0
  val() { printf '%s\\n' "$out" | awk -v k="$1" '$1 == k { print $3; exit }'; }
  [ "$(val ProxyAutoConfigEnable)" = 1 ] && return 0
  local scheme host port
  if [ "$(val HTTPSEnable)" = 1 ]; then scheme=http; host=$(val HTTPSProxy); port=$(val HTTPSPort)
  elif [ "$(val HTTPEnable)" = 1 ]; then scheme=http; host=$(val HTTPProxy); port=$(val HTTPPort)
  elif [ "$(val SOCKSEnable)" = 1 ]; then scheme=socks5; host=$(val SOCKSProxy); port=$(val SOCKSPort)
  else return 0
  fi
  [ -n "$host" ] && [ -n "$port" ] || return 0
  printf '%s\\n' "--proxy-server=$scheme://$host:$port,direct://" "--proxy-bypass-list=$BYPASS_HOST"
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
mkdir "$LOCK_DIR" 2>/dev/null || exit 0
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

if [ "$MODE" = native ]; then
  if ! app_running; then say "ChatGPT is not running"; exit 0; fi
  if ! app_switched; then say "ChatGPT is already running without the launch switches"; exit 0; fi
  say "ChatGPT carries the launch switches; restarting it without"
  quit_app || { say "ChatGPT did not quit; quit it manually and reopen it"; exit 1; }
  open -a ChatGPT
  say "relaunched ChatGPT with native networking"
  exit 0
fi

if app_running; then
  if app_flagged; then
    say "ChatGPT is already running with the launch switches"
    exit 0
  fi
  say "ChatGPT is running without the launch switches; restarting it"
  quit_app || { say "ChatGPT did not quit; leaving it running without the switches"; exit 1; }
elif [ "$MODE" != launch ]; then
  exit 0
fi

ARGS=()
if [ "$PAC_MODE" = 1 ]; then
  ARGS+=("$PAC_ARG")
else
  ARGS+=("$RESOLVER_ARG")
fi
while IFS= read -r arg; do
  [ -n "$arg" ] && ARGS+=("$arg")
done < <(proxy_args)
open -a ChatGPT --args "\${ARGS[@]}"
say "launched ChatGPT with: \${ARGS[*]}"
`;
}

/** One-shot launchd agent: wake on the app's SingletonLock event, run the script, exit. */
export function buildChatgptUnblockWatcherPlist(scriptPath: string, watchPath: string, errPath: string): string {
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
    <string>${xmlEscape(watchPath)}</string>
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
  /** PAC mode: the CONNECT entry port the generated script checks and the app is pointed at. */
  entryPort?: number;
  configDir?: string;
  /** Test seam: skip the macOS / app-presence guards. */
  assumeSupported?: boolean;
  /** Test seam: where the agent plist is written instead of ~/Library/LaunchAgents. */
  plistPath?: string;
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
  if (!options.assumeSupported && !existsSync(CHATGPT_APP_PATH)) {
    throw new Error(`${CHATGPT_APP_PATH} not found; install the ChatGPT desktop app first`);
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
    buildChatgptUnblockWatcherScript(options.port, options.configDir, options.entryPort !== undefined, options.entryPort),
    { mode: 0o700 },
  );
  writeFileSync(paths.plistPath, buildChatgptUnblockWatcherPlist(paths.scriptPath, paths.lockPath, paths.errPath));
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

export function chatgptUnblockWatcherStatus(port: number, configDir?: string, pacMode = false, entryPort?: number): ChatgptUnblockWatcherStatus {
  const paths = chatgptUnblockWatcherPaths(configDir);
  const scriptInstalled = existsSync(paths.scriptPath);
  const plistInstalled = existsSync(paths.plistPath);
  const agentLoaded = sh("launchctl", ["print", `${watcherDomain()}/${CHATGPT_UNBLOCK_WATCHER_LABEL}`]).ok;
  const scriptUpToDate = scriptInstalled
    && readFileSync(paths.scriptPath, "utf8") === buildChatgptUnblockWatcherScript(port, configDir, pacMode, entryPort);
  const plistUpToDate = plistInstalled
    && readFileSync(paths.plistPath, "utf8") === buildChatgptUnblockWatcherPlist(paths.scriptPath, paths.lockPath, paths.errPath);
  return { scriptInstalled, plistInstalled, agentLoaded, scriptUpToDate, plistUpToDate };
}

/**
 * The running app's command line, or null. Mirrors the script's `app_pid`: exact process name,
 * then the bundle path, never a match against every command line.
 */
export function chatgptAppCommandLine(): string | null {
  const pids = sh("pgrep", ["-x", "ChatGPT"]);
  if (!pids.ok) return null;
  for (const pid of pids.output.split(/\s+/).filter(Boolean)) {
    const command = sh("ps", ["-o", "command=", "-p", pid]);
    if (command.ok && command.output.includes("ChatGPT.app/Contents/MacOS/ChatGPT")) return command.output.trim();
  }
  return null;
}

/** Whether a command line carries the resolver switch for `port`. */
export function chatgptCommandLineHasRule(commandLine: string, port: number): boolean {
  return commandLine.includes(` ${chatgptUnblockResolverArg(port)}`);
}

/** Whether a command line carries the PAC switch of the given config dir. */
export function chatgptCommandLineHasPac(commandLine: string, configDir: string): boolean {
  return commandLine.includes(` ${chatgptUnblockPacArg(configDir)}`);
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
function requestIdentity(port: number): Promise<string | null> {
  return new Promise(resolve => {
    let raw = "";
    let settled = false;
    const finish = (body: string | null) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(body);
    };
    // The leaf names chatgpt.com, not 127.0.0.1; identity is established by the answer, not TLS.
    const socket = connectTls({ host: "127.0.0.1", port, servername: CHATGPT_INTERCEPT_HOST, rejectUnauthorized: false }, () => {
      socket.write(`GET ${CHATGPT_UNBLOCK_IDENTITY_PATH} HTTP/1.1\r\nHost: ${CHATGPT_INTERCEPT_HOST}\r\nConnection: close\r\n\r\n`);
    });
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
 * identity through the listener's local identity path.
 */
export async function probeChatgptUnblockListener(
  port: number,
  request: (port: number) => Promise<string | null> = requestIdentity,
  portOpen: (port: number) => Promise<boolean> = loopbackPortOpen,
): Promise<ChatgptListenerProbe> {
  if (!(await portOpen(port))) return { state: "down" };
  const text = await request(port);
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

function runLaunchScript(mode: "launch" | "native", port: number, configDir?: string, pacMode = false, entryPort?: number): { ok: boolean; output: string } {
  if (process.platform !== "darwin") {
    throw new Error("launching the ChatGPT desktop app is only supported on macOS");
  }
  // The script goes in on stdin, so no file is needed and the script's own command line never
  // looks like the app's.
  const result = spawnSync("/bin/bash", ["-s", mode], {
    input: buildChatgptUnblockWatcherScript(port, configDir, pacMode, entryPort),
    encoding: "utf8",
  });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

/** Start the app with the launch arguments, restarting it if it runs without them (macOS). */
export function launchChatgptWithRule(port: number, configDir?: string, pacMode = false, entryPort?: number): { ok: boolean; output: string } {
  return runLaunchScript("launch", port, configDir, pacMode, entryPort);
}

/** Restart an app that carries the launch switches without them, returning it to native networking. */
export function restoreChatgptNative(port: number, configDir?: string, pacMode = false, entryPort?: number): { ok: boolean; output: string } {
  return runLaunchScript("native", port, configDir, pacMode, entryPort);
}
