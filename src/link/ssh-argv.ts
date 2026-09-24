/**
 * Argument vectors for the system OpenSSH client used by machine links.
 *
 * Every command is built here so the security-relevant options live in one place:
 * - BatchMode=yes: no password or passphrase prompt, keys and agents only.
 * - HostKeyAlias=<alias> with UserKnownHostsFile=<link known_hosts> and
 *   GlobalKnownHostsFile=none: only a host key the user confirmed for this link is trusted,
 *   and the stored entry has the same form for every port and ProxyJump route.
 * - KnownHostsCommand=none, VerifyHostKeyDNS=no and CheckHostIP=no: no other source of host-key
 *   trust (a helper command, DNS SSHFP records, IP entries) can stand in for the link file.
 *   Command-line options win over ~/.ssh/config, so a user config cannot re-enable them.
 * - Tunnel and exec commands use StrictHostKeyChecking=yes. Only the probe uses accept-new,
 *   against an empty temporary file, so the key it records can be shown to the user first.
 * - Forwards always bind 127.0.0.1 on both ends.
 */

import { isAbsolute } from "node:path";

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
function optionPath(path: string): string {
  if (!path || !isAbsolute(path) || /["%$\x00-\x1f]/.test(path) || path.startsWith("~")) {
    throw new LinkSshArgumentError("known_hosts path is not usable in an ssh option");
  }
  return /\s/.test(path) ? `"${path}"` : path;
}

function commonOptions(alias: string, knownHostsFile: string, strict: "yes" | "accept-new"): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "ConnectTimeout=10",
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", `StrictHostKeyChecking=${strict}`,
    "-o", `HostKeyAlias=${alias}`,
    "-o", `UserKnownHostsFile=${optionPath(knownHostsFile)}`,
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
    "-o", "LogLevel=ERROR",
  ];
}

export interface TunnelArgvOptions {
  alias: string;
  /** "R": listen on the remote host and reach this host. "L": listen here and reach the remote host. */
  direction: TunnelDirection;
  /** Port the forward listens on (remote for "R", local for "L"). */
  bindPort: number;
  /** Port the forward connects to on the other side's 127.0.0.1. */
  targetPort: number;
  knownHostsFile: string;
}

export function buildTunnelArgv(options: TunnelArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  const bind = assertPort(options.bindPort, "bindPort");
  const target = assertPort(options.targetPort, "targetPort");
  if (options.direction !== "R" && options.direction !== "L") throw new LinkSshArgumentError("direction must be R or L");
  return [
    "ssh", "-N", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes"),
    "-o", "ExitOnForwardFailure=yes",
    `-${options.direction}`, `127.0.0.1:${bind}:127.0.0.1:${target}`,
    "--", alias,
  ];
}

export interface ExecArgvOptions {
  alias: string;
  /** Remote argv. Each element is quoted for the remote POSIX shell. */
  argv: readonly string[];
  knownHostsFile: string;
}

export function buildExecArgv(options: ExecArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  if (options.argv.length === 0) throw new LinkSshArgumentError("remote argv must not be empty");
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.knownHostsFile, "yes"),
    "-o", "ClearAllForwardings=yes",
    "--", alias,
    quoteRemote(options.argv),
  ];
}

export interface ProbeArgvOptions {
  alias: string;
  /** An empty, private, temporary file. The probe records the offered host key here. */
  tempKnownHostsFile: string;
}

/**
 * First contact with a host that has no confirmed key. accept-new writes the offered key to the
 * temporary file; the caller reads it with `ssh-keygen -lf` and shows the fingerprint before
 * anything is trusted. The remote command is `true` and its result is not trusted either.
 */
export function buildProbeArgv(options: ProbeArgvOptions): string[] {
  const alias = assertSshAlias(options.alias);
  return [
    "ssh", "-T",
    ...commonOptions(alias, options.tempKnownHostsFile, "accept-new"),
    "-o", "ClearAllForwardings=yes",
    "--", alias,
    "true",
  ];
}

/** `ssh -G <alias>`: resolve an alias the same way ssh itself does, without connecting. */
export function buildResolveArgv(alias: string): string[] {
  return ["ssh", "-G", "--", assertSshAlias(alias)];
}

/** Quote argv for a POSIX remote shell: every element single-quoted, embedded quotes escaped. */
export function quoteRemote(argv: readonly string[]): string {
  return argv.map(arg => {
    if (arg.includes("\0")) throw new LinkSshArgumentError("remote argument contains NUL");
    return `'${arg.replaceAll("'", `'"'"'`)}'`;
  }).join(" ");
}
