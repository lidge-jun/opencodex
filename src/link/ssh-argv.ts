import { isRouteClientId, type RouteClientId } from "./route-intent";
/**
 * Argument vectors for the system OpenSSH client used by machine links.
 *
 * Every command is built here so the security-relevant options live in one place:
 * - BatchMode=yes: no password or passphrase prompt, keys and agents only.
 * - HostKeyAlias=<alias> with UserKnownHostsFile=<link known_hosts> and
 *   GlobalKnownHostsFile=none: only a host key the user confirmed for this link is trusted,
 *   and the stored entry has the same form for every port and ProxyJump route.
 * - HashKnownHosts=no: private probe records keep their alias-prefixed form even
 *   when the user's normal SSH configuration hashes its own known_hosts file.
 * - KnownHostsCommand=none, VerifyHostKeyDNS=no and CheckHostIP=no: no other source of host-key
 *   trust (a helper command, DNS SSHFP records, IP entries) can stand in for the link file.
 *   Command-line options win over ~/.ssh/config, so a user config cannot re-enable them.
 * - Tunnel and exec commands use StrictHostKeyChecking=yes. Only the probe uses accept-new,
 *   against an empty temporary file, so the key it records can be shown to the user first.
 * - Forwards always bind 127.0.0.1 on both ends.
 * - Remote ocx runs through `remoteOcxArgv`: a non-interactive ssh session reads no interactive
 *   profile, so ~/.bun/bin and Homebrew are usually missing from the remote PATH.
 */

import { isAbsolute } from "node:path";
import { ExplicitRouteError, explicitRouteSshOptions, type ExplicitRoute } from "./explicit-route";
import { POWERSHELL_ENCODED_MAX, PowerShellCommandTooLongError, ROUTE_OVERWRITE_MIN_CHILD_VERSION, windowsGatedOcxArgv, windowsOcxArgv, windowsOverwriteSyncArgv } from "./remote-windows";

export type TunnelDirection = "R" | "L";

const ALIAS_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._@%+:\[\]-]{0,252}$/;

export class LinkSshArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkSshArgumentError";
  }
}

/** A host alias as ssh reads it. A leading "-" would be parsed as an option, so it is refused. */
export function isSshAlias(alias: string): boolean {
  return ALIAS_PATTERN.test(alias);
}

export function assertSshAlias(alias: string): string {
  if (!ALIAS_PATTERN.test(alias)) throw new LinkSshArgumentError(`invalid ssh host alias: ${JSON.stringify(alias)}`);
  return alias;
}

function assertPort(port: number, label: string): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new LinkSshArgumentError(`${label} must be an integer port between 1 and 65535`);
  }
  return port;
}

/**
 * ssh splits `-o` values on whitespace, expands `%` tokens, `${ENV}` and a leading `~` in
 * UserKnownHostsFile, treats the value `none` as "no file" and resolves a relative path against
 * its working directory. Any of those could name a different file than the one written, so only
 * an absolute path without expansion syntax is accepted; whitespace is quoted.
 */
function assertKnownHostsPath(path: string): string {
  if (!path || !isAbsolute(path) || /["%$\x00-\x1f]/.test(path) || path.startsWith("~")) {
    throw new LinkSshArgumentError("known_hosts path is not usable in an ssh option");
  }
  return path;
}

function optionPath(path: string): string {
  assertKnownHostsPath(path);
  return /\s/.test(path) ? `"${path}"` : path;
}

/** ERROR everywhere; DEBUG1 only for a tunnel spawned while opt-in SSH capture is on (src/link/ssh-capture.ts). */
export type SshLogLevel = "ERROR" | "DEBUG1";

/**
 * The link's explicit route (src/link/explicit-route.ts) as command-line options, which ssh takes before
 * anything in ssh_config. It names how to reach the link's own alias, so it is refused with any other
 * destination; null adds nothing, which is the argv of a link without one.
 */
function routeOptions(route: ExplicitRoute | null | undefined, alias: string, destination: string): RouteArgs {
  if (!route) return NO_ROUTE;
  if (destination !== alias) throw new LinkSshArgumentError("an explicit route reaches the link alias only");
  try {
    // Decided by the route itself, never by what its options happen to be: a link with a route reads no ssh_config.
    return { configFile: ["-F", "none"], options: explicitRouteSshOptions(route) };
  } catch (error) {
    if (error instanceof ExplicitRouteError) throw new LinkSshArgumentError(error.message);
    throw error;
  }
}

/**
 * What a route adds to the argv. configFile is ["-F", "none"] for every explicit route and comes first: an explicit route
 * names the transport, user and port and the host key is pinned, so such a link reads no ssh_config at all (list-valued
 * settings such as forwards, SendEnv and IdentityFile would add to ours, a RemoteCommand would break every exec, and no
 * option can remove a configured forward from the tunnel). Links without a route keep reading the owner's ssh_config,
 * which is how they reach their host.
 */
interface RouteArgs { configFile: readonly string[]; options: readonly string[] }
const NO_ROUTE: RouteArgs = { configFile: [], options: [] };

function commonOptions(alias: string, knownHostsFile: string, strict: "yes" | "accept-new", logLevel: SshLogLevel, route: RouteArgs): string[] {
  return [
    ...route.configFile,
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", `StrictHostKeyChecking=${strict}`,
    "-o", `HostKeyAlias=${alias}`,
    "-o", `UserKnownHostsFile=${optionPath(knownHostsFile)}`,
    "-o", "HashKnownHosts=no",
    "-o", "GlobalKnownHostsFile=none",
    "-o", "KnownHostsCommand=none",
    "-o", "VerifyHostKeyDNS=no",
    "-o", "CheckHostIP=no",
    "-o", "UpdateHostKeys=no",
    "-o", "ControlMaster=no",
    "-o", "ControlPath=none",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "PermitLocalCommand=no",
    "-o", `LogLevel=${logLevel}`,
    ...route.options,
  ];
}

export interface TunnelArgvOptions {
  alias: string;
  /**
   * Where ssh connects, when it is another route to the same machine. HostKeyAlias stays alias, so
   * the route is checked against the key pinned for the link. Omitted: alias (today's argv).
   */
  destination?: string;
  /** "R": listen on the remote host and reach this host. "L": listen here and reach the remote host. */
  direction: TunnelDirection;
  /** Port the forward listens on (remote for "R", local for "L"). */
  bindPort: number;
  /** Port the forward connects to on the other side's 127.0.0.1. */
  targetPort: number;
  knownHostsFile: string;
  /** Defaults to ERROR. DEBUG1 is requested only by opt-in SSH capture; the argv is otherwise unchanged. */
  logLevel?: SshLogLevel;
  /**
   * The link's explicit route, or null. Required so every caller decides: a Home-initiated link passes
   * its record's explicitRoute (absent: null); Child-initiated and messaging commands pass null.
   */
  route: ExplicitRoute | null;
}

export function buildTunnelArgv(options: TunnelArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  const destination = assertSshAlias(options.destination ?? alias);
  const bind = assertPort(options.bindPort, "bindPort");
  const target = assertPort(options.targetPort, "targetPort");
  if (options.direction !== "R" && options.direction !== "L") throw new LinkSshArgumentError("direction must be R or L");
  const logLevel = options.logLevel ?? "ERROR";
  if (logLevel !== "ERROR" && logLevel !== "DEBUG1") throw new LinkSshArgumentError("logLevel must be ERROR or DEBUG1");
  return [
    "ssh", "-N", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes", logLevel, routeOptions(options.route, alias, destination)),
    "-o", "ExitOnForwardFailure=yes",
    `-${options.direction}`, `127.0.0.1:${bind}:127.0.0.1:${target}`,
    "--", destination,
  ];
}

export interface ExecArgvOptions {
  alias: string;
  /** Another route to the same machine; HostKeyAlias stays alias. Omitted: alias. */
  destination?: string;
  /** Remote argv. The command must be sh; its arguments are quoted for the remote shell. */
  argv: readonly string[];
  knownHostsFile: string;
  /**
   * The link's explicit route, or null. Required so every caller decides: a Home-initiated link passes
   * its record's explicitRoute (absent: null); Child-initiated and messaging commands pass null.
   */
  route: ExplicitRoute | null;
}

export function buildExecArgv(options: ExecArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  const destination = assertSshAlias(options.destination ?? alias);
  if (options.argv.length === 0) throw new LinkSshArgumentError("remote argv must not be empty");
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes", "ERROR", routeOptions(options.route, alias, destination)),
    "-o", "ClearAllForwardings=yes",
    "--", destination,
    quoteRemote(options.argv),
  ];
}

/** The POSIX shell's exit status for a command it could not find. */
export const REMOTE_COMMAND_NOT_FOUND = 127;
/** Reserved prelude status: the remote OS cannot run the POSIX Remote Link workflow. */
export const REMOTE_PLATFORM_UNSUPPORTED = 125;

/**
 * Reads the first record's \`command\` of \`serving-runtimes.json\` (#8359): one or two absolute paths
 * without quotes or backslashes, printed one per line, from a file of at most 64 KiB. The file must
 * be the complete document in the layout its only writer produces (\`JSON.stringify(_, null, 2)\` in
 * src/config/serving-runtimes.ts): a first record without \`command\` never borrows a later record's,
 * and a file cut off anywhere before its closing brace prints nothing. Any other shape fails, and an
 * unreadable file or a missing awk fails without writing to stderr.
 * Shared by the ocx discovery, pinned sync and runtime inspection scripts.
 */
export const REMOTE_SERVED_RUNTIME = `served_runtime() {
  # The count below reports wc's status, never dd's: a missing dd or an unreadable file ends here,
  # and a dd that fails anyway counts zero bytes, which is refused like an oversized census.
  [ -f "$1" ] && [ -r "$1" ] && command -v dd >/dev/null 2>&1 || return 1
  served_size=$( { dd if="$1" bs=65537 count=1 2>/dev/null | wc -c; } 2>/dev/null ) || return 1
  [ "$served_size" -gt 0 ] 2>/dev/null && [ "$served_size" -le 65536 ] 2>/dev/null || return 1
  awk '
    { prev = last; last = $0 }
    bad || done { next }
    NR == 1 { if ($0 != "{") bad = 1; next }
    NR == 2 { if ($0 != "  \\"runtimes\\": [") bad = 1; next }
    NR == 3 { if ($0 != "    {") bad = 1; next }
    inside {
      if ($0 == "      ]" || $0 == "      ],") { inside = 0; closed = 1; next }
      line = $0; sub(/,$/, "", line)
      if (line !~ /^        "\\/[^"\\\\]*"$/ || ++count > 2) { bad = 1; next }
      path[count] = substr(line, 10, length(line) - 10); next
    }
    $0 == "      \\"command\\": [" { if (closed) bad = 1; else inside = 1; next }
    $0 == "    }" || $0 == "    }," { done = 1 }
    END {
      if (bad || !done || !closed || !count || prev != "  ]" || last != "}") exit 1
      for (i = 1; i <= count; i++) print path[i]
    }
  ' "$1" 2>/dev/null
}
`;

/**
 * Tries the served install with \`attempt\`, which must read \`$served_bin\` and honour \`$ocx_entry\`:
 * a compiled binary runs alone, and a package pair runs as \`bun <entry>\` only while the entry exists.
 * The unquoted \`OCX_SERVED\` heredoc is safe only because \`served_runtime\` prints paths without
 * quotes, backslashes or newlines; relaxing that character class would let a path expand or split.
 */
export function remoteServedRuntimeAttempt(attempt: string): string {
  return `served_bin= served_entry=
if served=$(served_runtime "\${OPENCODEX_HOME:-$HOME/.opencodex}/serving-runtimes.json"); then
  { IFS= read -r served_bin; IFS= read -r served_entry; } <<OCX_SERVED
$served
OCX_SERVED
  if [ -z "$served_entry" ]; then
    ${attempt}
  elif [ -f "$served_entry" ]; then
    ocx_entry=$served_entry
    ${attempt}
    ocx_entry=
  fi
fi`;
}

/**
 * The remote sh script for every ocx call. `quoteRemote` single-quotes it, so the login shell
 * passes it through untouched and `$HOME`/`$PATH` expand in the remote `sh`; the arguments reach
 * ocx as `"$@"` without another round of parsing. After an ephemeral ocx-child, the install that
 * last started serving this home comes first, whatever its version (#8359): every `ocx start` that binds records its own
 * relaunch argv at the front of `serving-runtimes.json` (src/config/serving-runtimes.ts), `[ocx]`
 * for a compiled binary or `[bun, cli/index.ts]` for a package install. Only the first entry's
 * `command`, one or two absolute paths without quotes or backslashes, is read; any other shape
 * falls through. Desktop binaries then precede PATH candidates; each candidate must run --version
 * successfully. A missing runnable ocx exits 127.
 */
const REMOTE_OCX_CANDIDATES = `ocx_entry=
${REMOTE_SERVED_RUNTIME}run_ocx_child() {
  for candidate in "$HOME/.local/bin/ocx-child" "$HOME/.cache/opencodex/bin/ocx-child"; do
    try_ocx "$candidate" "$@"
  done
  remaining=$PATH
  while :; do
    directory=\${remaining%%:*}
    try_ocx "\${directory:-.}/ocx-child" "$@"
    case "$remaining" in *:*) remaining=\${remaining#*:};; *) break;; esac
  done
}
if [ -f "\${OPENCODEX_HOME:-$HOME/.opencodex}/child/state.json" ]; then
  run_ocx_child "$@"
fi
${remoteServedRuntimeAttempt('try_ocx "$served_bin" "$@"')}
for candidate in "$HOME/.opencodex-desktop/bin/ocx" "/Applications/OpenCodex.app/Contents/MacOS/ocx" "/usr/bin/ocx"; do
  try_ocx "$candidate" "$@"
done
remaining=$PATH
while :; do
  directory=\${remaining%%:*}
  try_ocx "\${directory:-.}/ocx" "$@"
  case "$remaining" in *:*) remaining=\${remaining#*:};; *) break;; esac
done
run_ocx_child "$@"`;

export const REMOTE_OCX_SCRIPT = `export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
case "$(uname -s 2>/dev/null)" in Windows*|MSYS*|MINGW*|CYGWIN*) exit ${REMOTE_PLATFORM_UNSUPPORTED};; esac
try_ocx() {
  if [ -x "$1" ] && "$1" \${ocx_entry:+"$ocx_entry"} --version >/dev/null 2>&1; then
    executable=$1
    shift
    exec "$executable" \${ocx_entry:+"$ocx_entry"} "$@"
  fi
}
${REMOTE_OCX_CANDIDATES}
exit ${REMOTE_COMMAND_NOT_FOUND}`;

export function remoteOcxArgv(args: readonly string[], platform: "posix" | "windows" = "posix"): string[] {
  return platform === "windows" ? windowsOcxArgv(args) : ["sh", "-c", REMOTE_OCX_SCRIPT, "ocx", ...args];
}

export interface ProbeArgvOptions {
  alias: string;
  /** An empty, private, temporary file. The probe records the offered host key here. */
  tempKnownHostsFile: string;
  /**
   * The link's explicit route, or null. Required so every caller decides: a Home-initiated link passes
   * its record's explicitRoute (absent: null); Child-initiated and messaging commands pass null.
   */
  route: ExplicitRoute | null;
}

/**
 * First contact with a host that has no confirmed key. accept-new writes the offered key to the
 * temporary file; the caller reads it with `ssh-keygen -lf` and shows the fingerprint before
 * anything is trusted. The remote command is a fixed cross-shell echo; it conveys no authorization.
 */
export function buildProbeArgv(options: ProbeArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.tempKnownHostsFile, "accept-new", "ERROR", routeOptions(options.route, alias, alias)),
    "-o", "ClearAllForwardings=yes",
    "--", alias,
    "echo ocx-link-probe",
  ];
}

export interface RouteProbeArgvOptions {
  /** The link's alias: the name its host key is pinned under. */
  alias: string;
  /** The route being tried. */
  destination: string;
  /** The link known_hosts file. It is only read: the route must offer the key already pinned. */
  knownHostsFile: string;
  /**
   * The link's explicit route, or null. Required so every caller decides: a Home-initiated link passes
   * its record's explicitRoute (absent: null); Child-initiated and messaging commands pass null.
   */
  route: ExplicitRoute | null;
}

/**
 * Does this route reach the pinned machine and accept our key? Strict host-key checking against
 * the link file under HostKeyAlias=alias: a route that answers with any other key fails with "Host
 * key verification failed" and nothing is learned or written. Success prints exactly ocx-link-probe.
 */
export function buildRouteProbeArgv(options: RouteProbeArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  const destination = assertSshAlias(options.destination);
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes", "ERROR", routeOptions(options.route, alias, destination)),
    "-o", "ClearAllForwardings=yes",
    "--", destination,
    "echo ocx-link-probe",
  ];
}

/**
 * Locale-independent Windows check for a host whose SSH shell is cmd.exe or PowerShell. Both run
 * `cmd /c echo %OS%`, and cmd expands it to `Windows_NT` regardless of display language. The
 * command is a fixed literal; a POSIX shell answers "command not found" and nothing else.
 */
export const WINDOWS_OS_PROBE = "cmd /c echo %OS%";

/** Run WINDOWS_OS_PROBE against an already trusted (pinned or just-probed) host key only. */
export function buildWindowsProbeArgv(options: { alias: string; knownHostsFile: string; destination?: string; route: ExplicitRoute | null }): string[] {
  const alias = assertSshAlias(options.alias);
  const destination = assertSshAlias(options.destination ?? alias);
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes", "ERROR", routeOptions(options.route, alias, destination)),
    "-o", "ClearAllForwardings=yes",
    "--", destination,
    WINDOWS_OS_PROBE,
  ];
}

/** Read the fingerprint of the host key recorded by a probe. */
export function buildFingerprintArgv(tempKnownHostsFile: string): string[] {
  return ["ssh-keygen", "-l", "-f", assertKnownHostsPath(tempKnownHostsFile)];
}

/** `ssh -G <alias>`: resolve an alias the same way ssh itself does, without connecting. */
export function buildResolveArgv(alias: string): string[] {
  return ["ssh", "-G", "--", assertSshAlias(alias)];
}

/** Emit only sh in command position; single-quote every argument for the remote shell. */
export function quoteRemote(argv: readonly string[]): string {
  if (argv[0] === "powershell.exe") {
    if (argv.length !== 6 || argv.slice(1, 5).join(" ") !== "-NoLogo -NoProfile -NonInteractive -EncodedCommand"
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(argv[5] ?? "") || (argv[5]?.length ?? 0) > POWERSHELL_ENCODED_MAX) {
      throw new LinkSshArgumentError("invalid encoded PowerShell command");
    }
    return argv.join(" ");
  }
  if (argv[0] !== "sh") throw new LinkSshArgumentError("remote command must be sh or encoded PowerShell");
  return argv.map((arg, index) => {
    if (arg.includes("\0")) throw new LinkSshArgumentError("remote argument contains NUL");
    // PowerShell treats a leading quoted word as an expression, not a command invocation.
    if (index === 0) return "sh";
    return `'${arg.replaceAll("'", `'"'"'`)}'`;
  }).join(" ");
}

/** Minimum served ocx for a gated command. Closed set: the literals are spliced into awk and PowerShell. */
export { ROUTE_OVERWRITE_MIN_CHILD_VERSION };
export type GatedMinVersion = "2.93.0" | "2.97.0" | "2.100.0";
export type GatedLacksMarker = "child-ocx-lacks-expect-link" | "child-ocx-lacks-orchestrated-update" | "child-ocx-lacks-overwrite";
export interface GatedOcxCommand {
  minVersion: GatedMinVersion;
  lacksMarker: GatedLacksMarker;
  /** false: a selected ocx-child exits 121 with ocx-fanout:child-ocx-ephemeral before args run. */
  acceptEphemeral: boolean;
  /** true: print ocx-fanout:entry:pair|binary on stderr right after the selection marker. */
  reportEntry: boolean;
  /** true: print ocx-fanout:child-now:<epoch-ms> (the Child's own clock) after the entry marker. Plan probe only. */
  reportClock: boolean;
  /** With acceptEphemeral, print ocx-fanout:selected-kind:ocx-child when the selected candidate is ocx-child.
   *  Set only by remotePinnedSyncArgv when a restart is requested (ocx-child ignores the restart flags). */
  reportSelectedKind?: boolean;
  /**
   * A4: what the script does with the Node launcher of a package install whose census pair sits under node_modules.
   * "none": nothing. "report": print ocx-fanout:launcher:available|unavailable (the plan probe; never exits for it).
   * "apply": exec <node> <root>/bin/ocx.mjs with the arguments, or exit 121 child-node-unavailable when no Node answers.
   * A closed union spliced as a literal; only the Home's parsed plan (installer npm or pnpm) chooses "apply".
   */
  launcher: "none" | "report" | "apply";
  args: readonly string[];
}
export const GATED_VERSION_PARTS: Readonly<Record<GatedMinVersion, readonly [string, string, string]>> = {
  "2.93.0": ["2", "93", "0"], "2.97.0": ["2", "97", "0"], "2.100.0": ["2", "100", "0"],
};
const LACKS_MARKERS: ReadonlySet<string> = new Set(["child-ocx-lacks-expect-link", "child-ocx-lacks-orchestrated-update", "child-ocx-lacks-overwrite"]);
export const LINK_ID_PATTERN = /^lnk_[0-9a-f]{16}$/;

function assertGated(cmd: GatedOcxCommand): readonly [string, string, string] {
  const parts = Object.hasOwn(GATED_VERSION_PARTS, cmd.minVersion) ? GATED_VERSION_PARTS[cmd.minVersion] : undefined;
  if (!parts || !LACKS_MARKERS.has(cmd.lacksMarker)) throw new LinkSshArgumentError("invalid gated ocx command");
  if (cmd.args.length === 0 || cmd.args.some(arg => arg.includes("\0"))) throw new LinkSshArgumentError("invalid gated ocx arguments");
  if (cmd.launcher !== "none" && cmd.launcher !== "report" && cmd.launcher !== "apply") throw new LinkSshArgumentError("invalid gated ocx launcher");
  return parts;
}

/**
 * The pinned script for one gate: select a candidate, read its version inside the remote script, refuse below the
 * minimum, then exec it with "$@". OCX_NO_DESKTOP_HANDOFF=1 makes a package launcher answer --version for itself and
 * run the command itself, so a Desktop handoff can never pass the gate on behalf of an older launcher.
 * With launcher "report" or "apply" and a census pair under node_modules that ships bin/ocx.mjs, the script looks for a
 * Node that answers --version within 10 s (the npm prefix's bin/node first, then PATH) before the temp dir is removed.
 */
function remoteGatedScript(cmd: GatedOcxCommand): string {
  const [major, minor, patch] = assertGated(cmd);
  const overwriteEphemeral = cmd.lacksMarker === "child-ocx-lacks-overwrite" ? `
  case "\${c##*/}" in ocx-child*) printf '%s\\n' 'ocx-fanout:child-ephemeral-no-overwrite' >&2; exit 121;; esac` : "";
  const ephemeral = cmd.acceptEphemeral || overwriteEphemeral ? "" : `
  case "\${c##*/}" in ocx-child*) printf '%s\\n' 'ocx-fanout:child-ocx-ephemeral' >&2; exit 121;; esac`;
  // Only a pinned sync that carries a restart asks for this, so the plain sync's stderr stays exact.
  const kind = cmd.acceptEphemeral && cmd.reportSelectedKind ? `
  case "\${c##*/}" in ocx-child*) printf '%s\\n' 'ocx-fanout:selected-kind:ocx-child' >&2;; esac` : "";
  const entry = cmd.reportEntry ? `
  if [ -n "$ocx_entry" ]; then printf '%s\\n' 'ocx-fanout:entry:pair' >&2; else printf '%s\\n' 'ocx-fanout:entry:binary' >&2; fi` : "";
  // Seconds resolution is enough for a 120 s window; a date(1) that prints nothing numeric prints no marker.
  const clock = cmd.reportClock ? `
  now=$(date +%s 2>/dev/null); case "$now" in ''|*[!0-9]*) ;; *) printf 'ocx-fanout:child-now:%s000\\n' "$now" >&2;; esac` : "";
  return `export PATH="$PATH:$HOME/.bun/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin"
export OCX_NO_DESKTOP_HANDOFF=1
case "$(uname -s 2>/dev/null)" in Windows*|MSYS*|MINGW*|CYGWIN*) exit ${REMOTE_PLATFORM_UNSUPPORTED};; esac
umask 077
dir=$(mktemp -d "\${TMPDIR:-/tmp}/ocx-fanout.XXXXXXXX") || exit 127
tmp=$dir/version; ready=$dir/ready
trap 'rm -rf "$dir"' EXIT HUP INT TERM
launcher=${cmd.launcher}
node_ok() {
  ( ulimit -c 0; exec "$1" --version ) >/dev/null 2>&1 & np=$!
  ( sleep 10 & ntimer=$!; trap 'kill "$ntimer" 2>/dev/null; wait "$ntimer" 2>/dev/null; exit' TERM HUP INT; : > "$ready"; wait "$ntimer" 2>/dev/null; kill -9 "$np" 2>/dev/null ) >/dev/null 2>&1 & nwd=$!
  while [ ! -f "$ready" ]; do kill -0 "$nwd" 2>/dev/null || break; sleep 0.01 >/dev/null 2>&1; done
  { wait "$np"; nstatus=$?; } 2>/dev/null
  kill "$nwd" 2>/dev/null; wait "$nwd" 2>/dev/null; rm -f "$ready"
  [ "$nstatus" -eq 0 ]
}
find_launcher_node() {
  node_bin=
  case "$1" in */lib/node_modules/@bitkyc08/opencodex)
    n=\${1%/lib/node_modules/@bitkyc08/opencodex}/bin/node
    if [ -x "$n" ] && node_ok "$n"; then node_bin=$n; return 0; fi;; esac
  n=$(command -v node 2>/dev/null) && [ -x "$n" ] && node_ok "$n" && node_bin=$n
  return 0
}
try_ocx() {
  c=$1; shift
  [ -x "$c" ] || return${overwriteEphemeral}
  ( ulimit -c 0; ulimit -f 1; exec "$c" \${ocx_entry:+"$ocx_entry"} --version ) >"$tmp" 2>/dev/null & vp=$!
  ( sleep 10 & timer=$!; trap 'kill "$timer" 2>/dev/null; wait "$timer" 2>/dev/null; exit' TERM HUP INT; : > "$ready"; wait "$timer" 2>/dev/null; kill -9 "$vp" 2>/dev/null ) >/dev/null 2>&1 & watchdog=$!
  while [ ! -f "$ready" ]; do kill -0 "$watchdog" 2>/dev/null || break; sleep 0.01 >/dev/null 2>&1; done
  { wait "$vp"; status=$?; } 2>/dev/null
  kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null; rm -f "$ready"
  [ "$status" -eq 0 ] || return
  bytes=$(wc -c < "$tmp" 2>/dev/null) || return
  [ "$bytes" -le 256 ] 2>/dev/null || return
  version=$(cat "$tmp"); version=\${version#opencodex }
  printf '%s\\n' "$version" | awk '
    function idlist(s,pre, n,a,i) {
      n=split(s,a,/\\./); if (!n) return 0;
      for(i=1;i<=n;i++) if(a[i]=="" || a[i] !~ /^[0-9A-Za-z-]+$/ || (pre && a[i] ~ /^[0-9]+$/ && length(a[i])>1 && substr(a[i],1,1)=="0")) return 0;
      return 1
    }
    function cmp(a,b) { if(length(a)!=length(b)) return length(a)>length(b)?1:-1; return ("x" a)==("x" b)?0:(("x" a)>("x" b)?1:-1) }
    NR==1 {
      v=$0; if(length(v)>128) { result=2; next }
      plus=index(v,"+"); if(plus) { build=substr(v,plus+1); v=substr(v,1,plus-1); if(!idlist(build,0)) {result=2; next} }
      dash=index(v,"-"); if(dash) { pre=substr(v,dash+1); v=substr(v,1,dash-1); if(!idlist(pre,1)) {result=2; next} }
      if(split(v,a,/\\./)!=3) { result=2; next }
      for(i=1;i<=3;i++) if(a[i] !~ /^(0|[1-9][0-9]*)$/) { result=2; next }
      c=cmp(a[1],"${major}"); if(!c)c=cmp(a[2],"${minor}"); if(!c)c=cmp(a[3],"${patch}"); if(c<0 || (!c && dash))result=1
    }
    NR>1 {result=2}
    END {exit result}
  ' 2>/dev/null
  status=$?
  if [ "$status" -eq 1 ]; then printf '%s\\n' 'ocx-fanout:${cmd.lacksMarker}' >&2; exit 121; fi
  if [ "$status" -ne 0 ]; then printf '%s\\n' 'ocx-fanout:child-ocx-version-unknown' >&2; exit 121; fi${ephemeral}
  root=; [ -n "$ocx_entry" ] && root=\${ocx_entry%/src/cli/index.ts}
  case "$root" in */node_modules/*) [ -f "$root/bin/ocx.mjs" ] || root=;; *) root=;; esac
  node_bin=; if [ -n "$root" ] && [ "$launcher" != none ]; then find_launcher_node "$root"; fi
  rm -rf "$dir"; trap - EXIT HUP INT TERM
  printf 'ocx-fanout:selected:%s\\n' "$version" >&2${kind}${entry}${clock}
  if [ -n "$root" ] && [ "$launcher" = report ]; then
    if [ -n "$node_bin" ]; then printf '%s\\n' 'ocx-fanout:launcher:available' >&2
    else printf '%s\\n' 'ocx-fanout:launcher:unavailable' >&2; fi
  fi
  if [ -n "$root" ] && [ "$launcher" = apply ]; then
    [ -n "$node_bin" ] || { printf '%s\\n' 'ocx-fanout:child-node-unavailable' >&2; exit 121; }
    printf '%s\\n' 'ocx-fanout:launcher:exec' >&2
    printf '%s\\n' 'ocx-fanout:stdout-begin'
    unset OCX_UPDATE_ORCHESTRATED_CHILD
    exec "$node_bin" "$root/bin/ocx.mjs" "$@"
  fi
  printf '%s\\n' 'ocx-fanout:stdout-begin'
  exec "$c" \${ocx_entry:+"$ocx_entry"} "$@"
}
${REMOTE_OCX_CANDIDATES}
exit ${REMOTE_COMMAND_NOT_FOUND}`;
}

export function remoteGatedOcxArgv(cmd: GatedOcxCommand, platform: "posix" | "windows" = "posix"): string[] {
  const versionParts = assertGated(cmd);
  if (platform === "windows") {
    // A dropped channel kills the orchestrating parent with the Job, so no Windows apply is ever built (D20).
    // Only a plan is ever built for Windows: an update spelled without --plan (or a future mutating flag) is refused.
    if (cmd.args[0] === "update" && (!cmd.args.includes("--plan") || cmd.args.includes("--yes"))) throw new LinkSshArgumentError("unsupported:windows-apply");
    try {
      return windowsGatedOcxArgv({ ...cmd, versionParts });
    } catch (error) {
      if (error instanceof PowerShellCommandTooLongError) throw new LinkSshArgumentError("windows-command-too-long");
      throw error;
    }
  }
  return ["sh", "-c", remoteGatedScript(cmd), "ocx", ...cmd.args];
}

export type ChildRestartRequest = "app-server" | "codex";
export interface PinnedSyncOptions { restart?: ChildRestartRequest; overwrite?: boolean; overwriteClient?: RouteClientId }
const RESTART_FLAG: Readonly<Record<ChildRestartRequest, string>> = { "app-server": "--restart-app-server-only", codex: "--restart-codex" };

export function remotePinnedSyncArgv(linkId: string, platform: "posix" | "windows" = "posix", opts: PinnedSyncOptions | boolean = {}, overwriteClient?: RouteClientId): string[] {
  if (typeof opts === "boolean") opts = { overwrite: opts, ...(overwriteClient !== undefined ? { overwriteClient } : {}) };
  else if (overwriteClient !== undefined) throw new LinkSshArgumentError("invalid overwrite client");
  const overwrite = opts.overwrite === true;
  overwriteClient = opts.overwriteClient;
  if (overwriteClient !== undefined && (!overwrite || !isRouteClientId(overwriteClient))) throw new LinkSshArgumentError("invalid overwrite client");
  if (!LINK_ID_PATTERN.test(linkId)) throw new LinkSshArgumentError("invalid link id");
  if (opts.restart !== undefined && !Object.hasOwn(RESTART_FLAG, opts.restart)) throw new LinkSshArgumentError("invalid restart request");
  // D20: the Home never sends a restart to a Windows Child.
  if (opts.restart !== undefined && platform === "windows") throw new LinkSshArgumentError("unsupported:windows-restart");
  const restart = opts.restart === undefined ? [] : [RESTART_FLAG[opts.restart]];
  if (overwrite && platform === "windows") {
    try { return windowsOverwriteSyncArgv(linkId, true, overwriteClient); }
    catch (error) { if (error instanceof PowerShellCommandTooLongError) throw new LinkSshArgumentError("windows-command-too-long"); throw error; }
  }
  return remoteGatedOcxArgv({ minVersion: overwrite ? "2.100.0" : "2.93.0", lacksMarker: overwrite ? "child-ocx-lacks-overwrite" : "child-ocx-lacks-expect-link", acceptEphemeral: !overwrite,
    reportEntry: false, reportClock: false, reportSelectedKind: restart.length > 0, launcher: "none",
    args: ["sync", "--expect-link", linkId, "--json", ...restart, ...(overwrite ? ["--overwrite-conflict"] : []), ...(overwriteClient ? ["--overwrite-client", overwriteClient] : [])] }, platform);
}
