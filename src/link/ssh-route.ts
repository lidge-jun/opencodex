import { closeSync, constants, fstatSync, opendirSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { splitSshDirective } from "./ssh-config";

/**
 * Which way a link's SSH alias reaches the other machine (#3023): through a ProxyCommand (a relay
 * such as Pen, or any wrapper), through a ProxyJump host, or directly.
 *
 * Read from the ssh_config files themselves, the way OpenSSH reads them for that alias, and never
 * by running ssh: a status read starts no process and runs no `Match exec` command, so nothing it
 * does can stall or outlive it. The reading follows OpenSSH's first-value-wins rule over the user's
 * file and then the system file, `Host` patterns with `*`, `?` and `!`, and `Include` at top
 * level or inside a matching `Host` block. What it cannot decide without running ssh reads
 * "unknown": a `Match` block or `CanonicalizeHostname` before the decision, an unreadable or
 * oversized file, a named pipe or other non-regular file, an Include wildcard outside the last path
 * component or over a directory of more than MAX_DIR_ENTRIES, or too many files. The work is
 * bounded: no file is read past MAX_FILE_BYTES and no open blocks, Host patterns match without
 * backtracking (matchWildcard), and one status read reads each file once and at most
 * MAX_TOTAL_BYTES in all (createLinkPathReader). Only the kind leaves this module, never a command, a jump host
 * or an address. The tunnel's ssh is started with no `-F` and no proxy option of its own, so these
 * are the files it reads.
 */
export type LinkPathVia = "proxy-command" | "proxy-jump" | "direct" | "unknown";
export interface LinkPath { via: LinkPathVia }

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 64;
const MAX_INCLUDE_DEPTH = 16;
const MAX_TOTAL_BYTES = 1024 * 1024;
/** The most directory entries one Include wildcard may list before the reader gives up. */
const MAX_DIR_ENTRIES = 1024;

export interface LinkPathConfigDeps {
  /** Home directory whose `.ssh/config` is read. Defaults to the user's home. */
  home?: string;
  /** The system-wide file, or null for none. Defaults to the platform's path. */
  systemConfig?: string | null;
  /** Read a file; may stop and throw past `maxBytes`. A missing file throws an ENOENT error. */
  readFile?: (path: string, maxBytes: number) => string;
  /** Expand one absolute Include glob to file paths, listing at most `limit + 1`. */
  glob?: (pattern: string, limit: number) => string[];
}

/**
 * Read a regular file of at most `maxBytes` (a larger one is refused by its size, unread). The type
 * is checked before opening and the open does not block, so a named pipe or device never stalls the
 * reader; anything but a regular file throws.
 */
function boundedRead(path: string, maxBytes: number): string {
  if (!statSync(path).isFile()) throw new Error("not a regular file");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    if (stat.size > maxBytes) return " ".repeat(maxBytes + 1);
    const buffer = Buffer.alloc(stat.size + 1);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/**
 * `*` and `?` wildcard matching in O(pattern x text) with no backtracking blow-up: a run of `*`
 * remembers only its last position, so a pattern full of wildcards cannot stall the event loop.
 */
export function matchWildcard(pattern: string, text: string): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === text[t])) { p += 1; t += 1; }
    else if (p < pattern.length && pattern[p] === "*") { star = p; p += 1; mark = t; }
    else if (star !== -1) { p = star + 1; mark += 1; t = mark; }
    else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p += 1;
  return p === pattern.length;
}

/**
 * Expand one absolute Include path without walking a tree: a wildcard (`*`, `?`) is allowed only
 * in the last component and lists that one directory, at most `MAX_DIR_ENTRIES` entries, skipping
 * dot files as OpenSSH's glob does. A wildcard elsewhere, a character class, or a longer listing
 * throws, which reads as unknown.
 */
function boundedInclude(absolute: string, limit: number): string[] {
  const dir = dirname(absolute), name = basename(absolute);
  if (/[*?[\]]/.test(dir) || /[[\]]/.test(name)) throw new Error("unsupported include pattern");
  if (!/[*?]/.test(name)) return [absolute];
  let handle;
  try { handle = opendirSync(dir); } catch (error) {
    if ((error as { code?: unknown } | null)?.code === "ENOENT") return [];
    throw error;
  }
  const out: string[] = [];
  try {
    let seen = 0;
    for (let entry = handle.readSync(); entry !== null; entry = handle.readSync()) {
      if (++seen > MAX_DIR_ENTRIES) throw new Error("include directory too large");
      if (entry.name.startsWith(".") && !name.startsWith(".")) continue;
      if (!matchWildcard(name, entry.name)) continue;
      out.push(join(dir, entry.name));
      if (out.length > limit) break;
    }
  } finally {
    handle.closeSync();
  }
  return out.sort();
}

function defaultSystemConfig(): string {
  return process.platform === "win32"
    ? join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "ssh", "ssh_config")
    : "/etc/ssh/ssh_config";
}

/** OpenSSH Host matching: any positive pattern matches and no negated one does, case-insensitively. */
function hostMatches(patterns: readonly string[], host: string): boolean {
  let positive = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).toLowerCase();
    if (!matchWildcard(pattern, host)) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

class Undecidable extends Error {}

export function resolveLinkPathFromConfig(alias: string, deps: LinkPathConfigDeps = {}): LinkPathVia {
  return createLinkPathReader(deps)(alias);
}

/**
 * A reader for one status read: each file is read at most once across every alias it resolves, and
 * all reads together stop at `MAX_TOTAL_BYTES`.
 */
export function createLinkPathReader(deps: LinkPathConfigDeps = {}): (alias: string) => LinkPathVia {
  const home = deps.home ?? homedir();
  const read = deps.readFile ?? boundedRead;
  const glob = deps.glob ?? boundedInclude;
  const loaded = new Map<string, string | null>();
  let totalBytes = 0;
  const readOnce = (path: string): string | null => {
    if (loaded.has(path)) return loaded.get(path)!;
    let body: string | null;
    try { body = read(path, MAX_FILE_BYTES); } catch (error) {
      if ((error as { code?: unknown } | null)?.code !== "ENOENT") throw new Undecidable();
      body = null;
    }
    if (body !== null && (body.length > MAX_FILE_BYTES || (totalBytes += body.length) > MAX_TOTAL_BYTES)) throw new Undecidable();
    loaded.set(path, body);
    return body;
  };
  return alias => {
    const host = alias.toLowerCase();
    let files = 0;
    // ProxyJump none blocks a later ProxyJump but not a later ProxyCommand (OpenSSH readconf).
    let jumpNone = false;
    const load = (path: string): string | null => {
      if (++files > MAX_FILES) throw new Undecidable();
      return readOnce(path);
    };
    // Returns the decision, or null when this file decided nothing.
    const visit = (body: string, baseDir: string, depth: number): LinkPathVia | null => {
      let applies = true;
      for (const raw of body.split(/\r?\n/)) {
        const directive = splitSshDirective(raw);
        if (!directive) continue;
        const value = directive.args[0]?.toLowerCase();
        switch (directive.keyword) {
          case "host": applies = hostMatches(directive.args, host); break;
          case "match": throw new Undecidable();
          case "canonicalizehostname": if (applies && value !== "no") throw new Undecidable(); break;
          case "proxycommand": if (applies) return value === "none" ? "direct" : "proxy-command"; break;
          case "proxyjump":
            if (!applies || jumpNone) break;
            if (value === "none") jumpNone = true;
            else return "proxy-jump";
            break;
          case "include": {
            if (!applies) break;
            if (depth >= MAX_INCLUDE_DEPTH) throw new Undecidable();
            for (const pattern of directive.args) {
              const expanded = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
              const absolute = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
              let paths: string[];
              try { paths = glob(absolute, MAX_FILES - files); } catch { throw new Undecidable(); }
              if (paths.length > MAX_FILES - files) throw new Undecidable();
              for (const path of paths) {
                const included = load(path);
                const decided = included === null ? null : visit(included, baseDir, depth + 1);
                if (decided) return decided;
              }
            }
            break;
          }
        }
      }
      return null;
    };
    try {
      const userDir = join(home, ".ssh");
      const user = load(join(userDir, "config"));
      const fromUser = user === null ? null : visit(user, userDir, 0);
      if (fromUser) return fromUser;
      const systemPath = deps.systemConfig === undefined ? defaultSystemConfig() : deps.systemConfig;
      const system = systemPath === null ? null : load(systemPath);
      return (system === null ? null : visit(system, join(systemPath!, ".."), 0)) ?? "direct";
    } catch (error) {
      if (error instanceof Undecidable) return "unknown";
      throw error;
    }
  };
}
