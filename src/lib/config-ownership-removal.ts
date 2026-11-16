import { existsSync, lstatSync, readdirSync, readlinkSync, realpathSync, rmdirSync, unlinkSync, type Stats } from "node:fs";
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from "node:path";
import { isWindowsReparsePoint, nativeReparseProbeApplies } from "./private-sqlite-path";
import { isCurrentWindowsProcessElevated } from "./windows-elevation";
import { verifyWindowsEntriesAcl, WINDOWS_OWNER_ACL_TIMEOUT_MS, type WindowsAclEntry } from "./windows-owner-acl";

/**
 * Path checks for `ocx uninstall`'s owned-state removal. Every recorded path is resolved from the
 * canonical config root one component at a time: the directories between the root and the entry must
 * be real directories that resolve exactly to their root-relative location, checked again immediately
 * before each unlink, listing and rmdir. An entry that does not meet this stays in place and is
 * reported. The guarantee covers the state each check observes; Bun and Node provide no
 * directory-handle-relative unlink, so it does not extend to a concurrent change made by the same
 * account between a check and the removal that follows it.
 */

// Read once at load: tests replace `process.platform`, and the native query must follow the real system.
const NATIVE_REPARSE = nativeReparseProbeApplies(process.platform, process.arch);
const DARWIN_LS_BATCH = 128;
/** Linux resolves up to 40 links in one lookup (macOS 32); a longer chain or a cycle stops here. */
const MAX_LINK_DEPTH = 40;
/**
 * Paths per ACL read. Each read is one bounded PowerShell call taking its paths over stdin, so a
 * large tree costs more reads rather than outgrowing a single read's deadline.
 */
const WINDOWS_ACL_BATCH = 256;

export class OwnedPathRedirectedError extends Error {
  constructor() {
    super("a directory on the way to the owned path is not a real directory inside the config root");
    this.name = "OwnedPathRedirectedError";
  }
}

export const ELEVATED_UNINSTALL_REFUSAL = "ocx uninstall is running with elevated privileges, but another account can change "
  + "the config directory, a directory above it or a directory inside it, or the config directory holds a link that leads "
  + "outside it (on Windows, any link). Run 'ocx uninstall' as the account that owns the config directory, without sudo or administrator rights, "
  + "or restrict those directories to that account and remove such links first.";

/** Windows without the native token probe (Bun cannot run `bun:ffi` on ARM64): the run is treated as elevated. */
export const UNKNOWN_ELEVATION_UNINSTALL_REFUSAL = "ocx uninstall could not determine whether it is running with elevated "
  + "privileges, and could not confirm that only this account can change the config directory. Stop opencodex, then "
  + "remove the config directory yourself.";

let elevationProbeForTests: (() => boolean) | null = null;
let directoryListedHookForTests: ((path: string) => void) | null = null;

/** Test seam: decide whether uninstall counts as elevated; null restores the platform probe. */
export function setUninstallElevationProbeForTests(probe: (() => boolean) | null): void {
  elevationProbeForTests = probe;
}

/** Test seam: called after an owned directory is listed and before its children are removed. */
export function setOwnedDirectoryListedHookForTests(hook: ((path: string) => void) | null): void {
  directoryListedHookForTests = hook;
}

type Elevation = "elevated" | "unelevated" | "unknown";

/** POSIX effective uid 0, or an elevated Windows token; a Windows token the native probe cannot read is unknown. */
function uninstallElevation(): Elevation {
  if (elevationProbeForTests) return elevationProbeForTests() ? "elevated" : "unelevated";
  if (process.platform !== "win32") return process.geteuid?.() === 0 ? "elevated" : "unelevated";
  const native = isCurrentWindowsProcessElevated();
  return native === null ? "unknown" : native ? "elevated" : "unelevated";
}

/** Whether the ownership checks apply: an elevated run, or one whose elevation is unknown. */
export function uninstallRunsElevated(): boolean {
  return uninstallElevation() !== "unelevated";
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

/** A link of any kind: a symlink or junction, or on Windows any other reparse point. */
function isLinkEntry(path: string, entry: Stats): boolean {
  return entry.isSymbolicLink() || (NATIVE_REPARSE && isWindowsReparsePoint(path));
}

/** Another account can change this directory's entries (POSIX mode and owner). */
function posixSharedWritable(entry: Stats, euid: number): boolean {
  return entry.uid !== euid || (entry.mode & 0o022) !== 0;
}

/** An ancestor no other account can change: owned by the uid or root, and not shared-writable unless sticky. */
function posixTrustedAncestor(entry: Stats, euid: number): boolean {
  const sticky = (entry.mode & 0o1000) !== 0;
  return (entry.uid === euid || entry.uid === 0) && ((entry.mode & 0o022) === 0 || sticky);
}

function errorCode(error: unknown): unknown {
  return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
}

type Walk = { path: string; complete: boolean };

/**
 * Every directory and link a spelling walk passed. macOS ACLs grant access independently of mode
 * bits, including the right to delete a link itself, so each of them is ACL-checked afterwards.
 */
type Visited = Set<string>;

/**
 * Walk `parts` from the trusted directory `start` the way the kernel resolves them, following
 * links. Every directory passed must be a trusted ancestor and every link must be owned by the uid or
 * root, since a sticky directory still lets a link's owner replace it. A link target's `..` is taken
 * from the physical directory reached so far, as the kernel does. Stops at the first missing entry.
 */
function walkTrusted(
  start: string,
  parts: readonly string[],
  euid: number,
  depth: number,
  visited: Visited,
  /** The last component may be a regular file: a link in the tree can name a file. */
  finalMayBeFile = false,
): Walk {
  let current = start;
  const meaningful = parts.filter(part => part !== "" && part !== ".");
  for (const [index, part] of meaningful.entries()) {
    const last = index === meaningful.length - 1;
    if (part === "..") { current = dirname(current); continue; }
    const next = join(current, part);
    let entry: Stats;
    try {
      entry = lstatSync(next);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return { path: current, complete: false };
      throw error;
    }
    if (entry.isSymbolicLink()) {
      if (depth >= MAX_LINK_DEPTH || (entry.uid !== euid && entry.uid !== 0)) throw new OwnedPathRedirectedError();
      visited.add(next);
      const target = readlinkSync(next);
      const walked = walkTrusted(
        isAbsolute(target) ? parse(target).root : current, target.split(sep), euid, depth + 1, visited, finalMayBeFile && last,
      );
      if (!walked.complete) return walked;
      current = walked.path;
      continue;
    }
    if (finalMayBeFile && last && entry.isFile()) {
      current = next;
      continue;
    }
    if (!entry.isDirectory() || !posixTrustedAncestor(entry, euid)) throw new OwnedPathRedirectedError();
    visited.add(next);
    current = next;
  }
  return { path: current, complete: true };
}

/**
 * The spelling uninstall was given must resolve only through directories and links no other account
 * can change, because the teardown steps before the remover use it as given. A root that does not
 * exist yet needs its nearest existing directory closed to every other account, sticky or not.
 * Returns what the walk passed, for the ACL check, or null when the spelling is not trusted.
 */
function posixSpellingVisited(configDir: string, euid: number): string[] | null {
  const absolute = resolve(configDir);
  const top = parse(absolute).root;
  if (!posixTrustedAncestor(lstatSync(top), euid)) return null;
  const visited: Visited = new Set([top]);
  const walked = walkTrusted(top, absolute.slice(top.length).split(sep), euid, 0, visited);
  // The walk built its path from verified real directories; its realpath only normalizes spelling
  // (case, Unicode form), which a case- or normalization-insensitive volume may store differently.
  if (walked.complete) return realpathSync.native(walked.path) === realpathSync.native(configDir) ? [...visited] : null;
  const nearest = lstatSync(walked.path);
  return (nearest.uid === euid || nearest.uid === 0) && (nearest.mode & 0o022) === 0 ? [...visited, walked.path] : null;
}

/** Windows: no component of the given spelling may be a link; returns the nearest existing directory. */
function windowsSpellingNearest(configDir: string): string | null {
  const absolute = resolve(configDir);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    const next = join(current, part);
    let entry: Stats;
    try {
      entry = lstatSync(next);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return current;
      throw error;
    }
    if (!entry.isDirectory() || isLinkEntry(next, entry)) return null;
    current = next;
  }
  return current;
}

/**
 * Throw unless the root still resolves to itself and every directory in `parts` below it is a real
 * directory, not a link, whose resolved path stays inside the root. The relative part is not compared
 * as a string: a case- or normalization-insensitive volume may store a name in another spelling. With
 * `elevatedUid` set, each directory below the root must also be owned by that uid and not group- or
 * other-writable.
 */
function assertRealDirectoryChain(rootPath: string, parts: readonly string[], options: OwnedRemovalOptions): void {
  const root = lstatSync(rootPath);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new OwnedPathRedirectedError();
  if (options.rootIdentity && !sameIdentity(rootPath, options.rootIdentity)) throw new OwnedPathRedirectedError();
  if (!samePath(realpathSync.native(rootPath), rootPath)) throw new OwnedPathRedirectedError();
  let current = rootPath;
  for (const part of parts) {
    current = join(current, part);
    const entry = lstatSync(current);
    if (!entry.isDirectory() || isLinkEntry(current, entry)) throw new OwnedPathRedirectedError();
    if (options.elevatedUid !== undefined && posixSharedWritable(entry, options.elevatedUid)) throw new OwnedPathRedirectedError();
  }
  if (parts.length > 0 && !isInsideRoot(rootPath, realpathSync.native(current))) throw new OwnedPathRedirectedError();
}

function isInsideRoot(rootPath: string, candidate: string): boolean {
  const prefix = rootPath.endsWith(sep) ? rootPath : rootPath + sep;
  return process.platform === "win32"
    ? candidate.toLowerCase().startsWith(prefix.toLowerCase())
    : candidate.startsWith(prefix);
}

function isAtOrInsideRoot(rootPath: string, candidate: string): boolean {
  return samePath(candidate, rootPath) || isInsideRoot(rootPath, candidate);
}

/** The device and inode of the directory a canonical root named when it was resolved. */
export type RootIdentity = { dev: bigint; ino: bigint };

export function rootIdentity(rootPath: string): RootIdentity {
  const entry = lstatSync(rootPath, { bigint: true });
  return { dev: entry.dev, ino: entry.ino };
}

function sameIdentity(rootPath: string, identity: RootIdentity): boolean {
  const entry = lstatSync(rootPath, { bigint: true });
  return entry.dev === identity.dev && entry.ino === identity.ino;
}

/**
 * Whether the canonical root is still a real directory that resolves to itself and, with
 * `identity`, is still the directory it named when it was resolved.
 */
export function canonicalRootUnchanged(rootPath: string, identity?: RootIdentity): boolean {
  try {
    assertRealDirectoryChain(rootPath, [], { rootIdentity: identity });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether the recorded entry `parts` exists below `rootPath`. Absent means a real directory on the
 * way, or the entry itself, does not exist (or a regular file sits where a directory would be). A link
 * on the way, or any other lookup failure, throws so the entry is reported rather than dropped.
 */
export function ownedEntryPresent(rootPath: string, parts: readonly string[]): boolean {
  let current = rootPath;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let entry: Stats;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    if (index === parts.length - 1) return true;
    if (isLinkEntry(current, entry)) throw new OwnedPathRedirectedError();
    if (!entry.isDirectory()) return false;
  }
  return false;
}

export interface OwnedRemovalOptions {
  /** POSIX uid of an elevated run: directories removal passes through must belong to it alone. */
  elevatedUid?: number;
  /** The root's identity when it was resolved; every check also requires the root to still be it. */
  rootIdentity?: RootIdentity;
}

/**
 * Remove the recorded entry `parts` below the canonical `rootPath`. A final-component link is
 * unlinked itself, never its target; a directory is emptied and removed with the chain rechecked for
 * every child and before the rmdir.
 */
export function removeOwnedEntry(rootPath: string, parts: readonly string[], options: OwnedRemovalOptions = {}): void {
  assertRealDirectoryChain(rootPath, parts.slice(0, -1), options);
  const path = join(rootPath, ...parts);
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    unlinkSync(path);
    return;
  }
  assertRealDirectoryChain(rootPath, parts, options);
  const names = readdirSync(path);
  directoryListedHookForTests?.(path);
  for (const name of names) removeOwnedEntry(rootPath, [...parts, name], options);
  assertRealDirectoryChain(rootPath, parts, options);
  rmdirSync(path);
}

/**
 * Every real directory in the root's tree, and every link in it, for the ownership checks. The
 * teardown steps before the remover read and write files anywhere in the tree, so a link at any
 * depth, to a file or a directory, must resolve to the root or a place inside it, through
 * directories and links `resolveLink` accepts (it returns what it passed, or null). One that does
 * not makes the tree unacceptable and the result is null.
 */
function rootTree(
  rootPath: string,
  resolveLink: (link: string) => { path: string; visited: string[] } | null,
): { directories: string[]; links: string[] } | null {
  const directories: string[] = [];
  const links: string[] = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    directories.push(directory);
    for (const name of readdirSync(directory)) {
      const child = join(directory, name);
      const entry = lstatSync(child);
      if (isLinkEntry(child, entry)) {
        const resolved = resolveLink(child);
        if (resolved === null || !isAtOrInsideRoot(rootPath, resolved.path)) return null;
        links.push(...resolved.visited);
      } else if (entry.isDirectory()) {
        pending.push(child);
      }
    }
  }
  return { directories, links };
}

function rootAncestors(rootPath: string): string[] {
  const ancestors: string[] = [];
  for (let current = dirname(rootPath); ; current = dirname(current)) {
    ancestors.push(current);
    if (dirname(current) === current) return ancestors;
  }
}

function windowsAclAllows(entries: readonly WindowsAclEntry[]): boolean {
  for (let start = 0; start < entries.length; start += WINDOWS_ACL_BATCH) {
    if (!verifyWindowsEntriesAcl(entries.slice(start, start + WINDOWS_ACL_BATCH), WINDOWS_OWNER_ACL_TIMEOUT_MS)) return false;
  }
  return true;
}

/**
 * macOS extended ACLs grant access independently of the mode bits. True when no listed directory has
 * an allow entry; deny entries (such as the stock "everyone deny delete") take nothing away from the
 * owner. A failed read counts as an allow entry.
 */
function darwinAclsDenyOnly(paths: readonly string[]): boolean {
  for (let start = 0; start < paths.length; start += DARWIN_LS_BATCH) {
    const result = Bun.spawnSync(["/bin/ls", "-lde", "--", ...paths.slice(start, start + DARWIN_LS_BATCH)], {
      stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" },
    });
    if (!result.success) return false;
    if (result.stdout.toString().split("\n").some(line => /^\s*\d+: .* allow \S+$/.test(line))) return false;
  }
  return true;
}

/**
 * When uninstall runs elevated, a reason to refuse the whole run if another account can change the
 * spelling it was given, the canonical root, one of its ancestors, or any directory in the root's
 * tree, or if a link in that tree leads outside it. Null when the run is not elevated or all of it
 * belongs to the elevated account alone. A missing root is checked through its nearest existing
 * directory. A run whose elevation is unknown is checked as elevated.
 */
export function elevatedRemovalRefusal(configDir: string): string | null {
  const elevation = uninstallElevation();
  if (elevation === "unelevated") return null;
  const refusal = elevation === "unknown" ? UNKNOWN_ELEVATION_UNINSTALL_REFUSAL : ELEVATED_UNINSTALL_REFUSAL;
  try {
    return onlyThisAccountCanChange(configDir) ? null : refusal;
  } catch {
    return refusal;
  }
}

function onlyThisAccountCanChange(configDir: string): boolean {
  if (process.platform === "win32") {
    const nearest = windowsSpellingNearest(configDir);
    if (nearest === null) return false;
    if (!existsSync(configDir)) {
      return windowsAclAllows([
        ...rootAncestors(nearest).map(path => ({ path, directory: true, policy: "trusted-ancestry" as const })),
        { path: nearest, directory: true, policy: "write-private" as const },
      ]);
    }
    const rootPath = realpathSync.native(configDir);
    // An elevated Windows run accepts no link or reparse point anywhere in the tree.
    const tree = rootTree(rootPath, () => null);
    if (tree === null) return false;
    return windowsAclAllows([
      ...rootAncestors(rootPath).map(path => ({ path, directory: true, policy: "trusted-ancestry" as const })),
      ...tree.directories.map(path => ({ path, directory: true, policy: "write-private" as const })),
    ]);
  }
  const euid = process.geteuid?.();
  if (euid === undefined) return false;
  const visited = posixSpellingVisited(configDir, euid);
  if (visited === null) return false;
  const darwin = process.platform === "darwin";
  if (!existsSync(configDir)) return !darwin || darwinAclsDenyOnly(visited);
  const rootPath = realpathSync.native(configDir);
  // Each link is resolved the way the kernel does, through trusted directories and links only, so a
  // link that leaves the root on the way back into it is refused as well.
  const tree = rootTree(rootPath, link => {
    const linkVisited: Visited = new Set();
    const walked = walkTrusted(dirname(link), [basename(link)], euid, 0, linkVisited, true);
    return walked.complete ? { path: realpathSync.native(walked.path), visited: [...linkVisited] } : null;
  });
  if (tree === null) return false;
  const ancestors = rootAncestors(rootPath);
  if (!ancestors.every(path => posixTrustedAncestor(lstatSync(path), euid))) return false;
  if (tree.directories.some(path => posixSharedWritable(lstatSync(path), euid))) return false;
  return !darwin || darwinAclsDenyOnly([...new Set([...visited, ...ancestors, ...tree.directories, ...tree.links])]);
}
