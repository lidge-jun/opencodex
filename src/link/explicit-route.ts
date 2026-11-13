import { accessSync, constants, lstatSync, readlinkSync, type Stats } from "node:fs";
import { dirname } from "node:path";
/**
 * An explicit SSH route for a Home-initiated link (structure/remote-link.md, "Explicit route"): the
 * ProxyCommand, user and port ssh uses for the link's alias. ssh-argv passes them on the command line,
 * where ssh takes them before anything in ssh_config, so a later ssh_config edit cannot move the link.
 *
 * These values reach ssh's argv, and ssh runs ProxyCommand as "exec <command>" through the user's
 * shell, so only a closed form is accepted (refused, never repaired):
 * - proxyCommand: 1-1024 ASCII characters; 1-32 words separated by exactly one space. The first word is
 *   an absolute POSIX path ("/" then letters, digits and . _ + - /), so neither PATH nor an "exec -flag"
 *   can change what runs. Every later word uses only letters, digits and . _ / : @ + , = - and does not
 *   start with "=" (zsh expands a leading "="). Nothing else: no quote, backslash, $ or backquote, no
 *   ; & | < > ( ) { } [ ] * ? ! # ~, no % (ssh expands %h, %p, %r and %n from values ssh_config controls),
 *   no tab, newline, NUL or non-ASCII character.
 * - user: a letter or "_" then up to 31 letters, digits, ".", "_" or "-".
 * - port: an integer from 1 to 65535.
 * - identityFile (optional, link.route/2): the private key the link authenticates with. An absolute POSIX path of 2-1024
 *   characters, "/" then letters, digits and . _ + - /, already normal (no empty, "." or ".." segment, no trailing "/").
 *   ssh expands ~, %-tokens and ${VAR} in IdentityFile and splits an -o value at whitespace or a quote; none of those
 *   characters is accepted, so the path reaches ssh as written. With it, ssh offers that key alone: IdentitiesOnly=yes,
 *   IdentityAgent=none, IdentityFile=<path>. Without it, nothing changes.
 * The path forms are POSIX only, so a Windows Home cannot use an explicit route yet.
 */

export interface ExplicitRoute {
  proxyCommand: string;
  user: string;
  port: number;
  /** The only key ssh offers for this link (link.route/2); absent, ssh authenticates as before. */
  identityFile?: string;
}

export type ExplicitRouteRefusal = "shape" | "proxy_command_form" | "user_form" | "port_form" | "identity_file_form";

const KEYS = ["port", "proxyCommand", "user"];
const KEYS_WITH_IDENTITY = ["identityFile", "port", "proxyCommand", "user"];
export const EXPLICIT_ROUTE_MAX_IDENTITY_FILE = 1024;
const PROGRAM = /^\/[A-Za-z0-9._+\/-]*$/;
const WORD = /^[A-Za-z0-9._\/:@+,-][A-Za-z0-9._\/:@+,=-]*$/;
const USER = /^[A-Za-z_][A-Za-z0-9_.-]{0,31}$/;
export const EXPLICIT_ROUTE_MAX_COMMAND = 1024;
export const EXPLICIT_ROUTE_MAX_WORDS = 32;

function isProxyCommand(value: string): boolean {
  if (value.length < 1 || value.length > EXPLICIT_ROUTE_MAX_COMMAND) return false;
  const words = value.split(" ");
  if (words.length > EXPLICIT_ROUTE_MAX_WORDS || !PROGRAM.test(words[0]!)) return false;
  return words.slice(1).every(word => WORD.test(word));
}

function isIdentityFile(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 2 || value.length > EXPLICIT_ROUTE_MAX_IDENTITY_FILE || !PROGRAM.test(value)) return false;
  return value.slice(1).split("/").every(segment => segment !== "" && segment !== "." && segment !== "..");
}

export function checkExplicitRoute(value: unknown): { ok: true; route: ExplicitRoute } | { ok: false; reason: ExplicitRouteRefusal } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "shape" };
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw).sort().join(",");
  if ((keys !== KEYS.join(",") && keys !== KEYS_WITH_IDENTITY.join(",")) || typeof raw.proxyCommand !== "string" || typeof raw.user !== "string") {
    return { ok: false, reason: "shape" };
  }
  if (!isProxyCommand(raw.proxyCommand)) return { ok: false, reason: "proxy_command_form" };
  if (!USER.test(raw.user)) return { ok: false, reason: "user_form" };
  if (typeof raw.port !== "number" || !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return { ok: false, reason: "port_form" };
  if ("identityFile" in raw && !isIdentityFile(raw.identityFile)) return { ok: false, reason: "identity_file_form" };
  // The key is added last, and only when given: a route without it is the exact object (and digest) it was before.
  return { ok: true, route: { proxyCommand: raw.proxyCommand, user: raw.user, port: raw.port, ...("identityFile" in raw ? { identityFile: raw.identityFile as string } : {}) } };
}

/** The route when the value is an accepted form, otherwise null. */
export function parseExplicitRoute(value: unknown): ExplicitRoute | null {
  const checked = checkExplicitRoute(value);
  return checked.ok ? checked.route : null;
}

/** Both absent, or the same values, the identity file included (both without one counts as the same). */
export function sameExplicitRoute(left: ExplicitRoute | null | undefined, right: ExplicitRoute | null | undefined): boolean {
  if (!left || !right) return !left && !right;
  return left.proxyCommand === right.proxyCommand && left.user === right.user && left.port === right.port && left.identityFile === right.identityFile;
}

/**
 * The ssh options of a route. ProxyUseFdpass=no keeps an ssh_config "ProxyUseFdpass yes" from changing
 * how the proxy command's output is used. With an identity file, ssh offers that key alone: IdentitiesOnly=yes drops the
 * default ~/.ssh/id_* files, IdentityAgent=none keeps the agent's keys out, and IdentityFile names the one key, each as
 * one argument. Throws for a value that is not an accepted form.
 */
export function explicitRouteSshOptions(route: ExplicitRoute): string[] {
  const checked = checkExplicitRoute(route);
  if (!checked.ok) throw new ExplicitRouteError(checked.reason);
  return [
    "-o", "ProxyCommand=" + checked.route.proxyCommand,
    "-o", "ProxyUseFdpass=no",
    "-o", "User=" + checked.route.user,
    "-o", "Port=" + String(checked.route.port),
    ...(checked.route.identityFile === undefined ? [] : ["-o", "IdentitiesOnly=yes", "-o", "IdentityAgent=none", "-o", "IdentityFile=" + checked.route.identityFile]),
  ];
}

export type IdentityFileProblem = "identity_file_missing" | "identity_file_not_regular" | "identity_file_permissions" | "identity_file_directory"
  | "identity_file_ancestor" | "identity_file_unreadable" | "identity_file_unsupported_platform";

/**
 * What to fix for each refusal, written here once: the management API answers it as the message and the CLI prints it with
 * the code and hint. None names the path or a part of it.
 */
export const IDENTITY_FILE_GUIDANCE: Readonly<Record<IdentityFileProblem, string>> = {
  identity_file_missing: "The identity file does not exist.",
  identity_file_not_regular: "The identity file must be a regular file, not a symlink or a directory.",
  identity_file_permissions: "The identity file must be owned by this user with no group or other permissions (chmod 600 on it). Use a key file of this user's own; never chown another user's or the system's key.",
  identity_file_directory: "The directory that holds the identity file must be owned by this user or root and not writable by group or others. Move the key to a path that passes; if a tool chose the path, run chmod go-w on that tool's own private folder or have it use a path that passes. Never change a shared or system directory such as /tmp, even when the Home runs as root.",
  identity_file_ancestor: "Every directory above the identity file must be owned by this user or root and not writable by group or others unless sticky, and every symlink on its path must be owned by this user or root; a folder made under umask 002 is group-writable. Run chmod go-w on such a private folder of this user's or of the tool that chose the path, or use a path that passes. Never change a shared or system directory or another user's symlink, even as root.",
  identity_file_unreadable: "This user cannot read the identity file or a directory on its path, or the path is too long or has too many symlinks. Use a shorter path without symlink loops; fix read access only on this user's own file or folder.",
  identity_file_unsupported_platform: "A Windows Home does not support an identity file yet.",
};

/**
 * Whether an identity file is usable as the link's key, decided from its metadata alone: the file is never opened or read.
 * It must be a regular file (a symlink is refused, so the path names the key itself), owned by this user with no group or
 * other permission bits (ssh ignores a key file of its owner that others can read, and the link would then fail public-key
 * authentication with nothing pointing at the cause), and readable by this user. Its directory must be owned by this user or
 * root and not writable by group or others (a world-writable sticky directory such as /tmp is refused too:
 * identity_file_directory). Every other directory the path passes through as it resolves, the directories holding its
 * symlinks and their targets included, must be owned by this user or root and not writable by group or others unless it is
 * sticky, and every symlink on the path must be owned by this user or root (identity_file_ancestor). A group-writable
 * directory is refused even when the group is the user's own, as sshd's StrictModes does. It is a check of metadata at
 * request time: ssh opens the path later, and a change this user or root makes in between is not caught. Null when usable.
 * lstat is a parameter only so a test can give a symlink another owner.
 * A Windows Home refuses every identity file before looking at it: the accepted form is a POSIX path, which Windows resolves
 * against the current drive, and owner and mode bits there say nothing about the file's ACL.
 */
export function identityFileProblem(path: string, platform: NodeJS.Platform = process.platform, lstat: (path: string) => Stats = lstatSync): IdentityFileProblem | null {
  if (platform === "win32") return "identity_file_unsupported_platform";
  let stat;
  try { stat = lstat(path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "identity_file_missing" : "identity_file_unreadable";
  }
  if (stat.isSymbolicLink() || !stat.isFile()) return "identity_file_not_regular";
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) return "identity_file_permissions";
  if ((stat.mode & 0o077) !== 0) return "identity_file_permissions";
  const directory = resolvedDirectory(dirname(path), lstat);
  if (typeof directory === "string") return directory;
  if ((directory.mode & 0o022) !== 0) return "identity_file_directory";
  try { accessSync(path, constants.R_OK); } catch { return "identity_file_unreadable"; }
  return null;
}

const MAX_SYMLINKS = 40;

/** Owned by this user or root. */
function trustedOwner(stat: Stats): boolean {
  return typeof process.getuid !== "function" || stat.uid === process.getuid() || stat.uid === 0;
}

/** Owned by this user or root, and not writable by group or others unless sticky. */
function safeDirectory(stat: Stats): boolean {
  return trustedOwner(stat) && ((stat.mode & 0o022) === 0 || (stat.mode & 0o1000) !== 0);
}

/**
 * Resolves an absolute directory path one entry at a time, as the kernel does, and checks every directory it passes
 * through with safeDirectory (the root, each directory on the way, the directory holding each symlink and each symlink's
 * target) and every symlink's owner. A failure at the final directory is identity_file_directory, anywhere above it
 * identity_file_ancestor. Answers the final directory's metadata, or the problem.
 */
function resolvedDirectory(path: string, lstat: (path: string) => Stats): Stats | IdentityFileProblem {
  const failed = (error: unknown): IdentityFileProblem => {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "identity_file_missing" : "identity_file_unreadable";
  };
  try {
    let current = "/";
    let stat = lstat(current);
    const pending = path.split("/").filter(name => name !== "" && name !== ".");
    if (!safeDirectory(stat)) return pending.length === 0 ? "identity_file_directory" : "identity_file_ancestor";
    let links = 0;
    while (pending.length > 0) {
      const name = pending.shift()!;
      // After a symlink target's "..", the pending count can name the wrong level in the hint; the refusal itself still holds.
      if (name === "..") { current = dirname(current); stat = lstat(current); continue; }
      const next = current === "/" ? "/" + name : current + "/" + name;
      const entry = lstat(next);
      if (entry.isSymbolicLink()) {
        // A link another user owns can be repointed by them, even in a sticky directory.
        if (!trustedOwner(entry)) return "identity_file_ancestor";
        if (++links > MAX_SYMLINKS) return "identity_file_unreadable";
        const target = readlinkSync(next);
        if (target.startsWith("/")) { current = "/"; stat = lstat(current); }
        pending.unshift(...target.split("/").filter(part => part !== "" && part !== "."));
        continue;
      }
      if (!entry.isDirectory()) return "identity_file_missing";
      if (!safeDirectory(entry)) return pending.length === 0 ? "identity_file_directory" : "identity_file_ancestor";
      current = next;
      stat = entry;
    }
    return stat;
  } catch (error) { return failed(error); }
}

export class ExplicitRouteError extends Error {
  constructor(readonly reason: ExplicitRouteRefusal) {
    super("invalid explicit route: " + reason);
    this.name = "ExplicitRouteError";
  }
}
