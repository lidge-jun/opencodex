import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandSshIncludeGlob, splitSshDirective } from "./ssh-config";

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
 * oversized file, or too many files. Only the kind leaves this module, never a command, a jump host
 * or an address. The tunnel's ssh is started with no `-F` and no proxy option of its own, so these
 * are the files it reads.
 */
export type LinkPathVia = "proxy-command" | "proxy-jump" | "direct" | "unknown";
export interface LinkPath { via: LinkPathVia }

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FILES = 64;
const MAX_INCLUDE_DEPTH = 16;

export interface LinkPathConfigDeps {
  /** Home directory whose `.ssh/config` is read. Defaults to the user's home. */
  home?: string;
  /** The system-wide file, or null for none. Defaults to the platform's path. */
  systemConfig?: string | null;
  readFile?: (path: string) => string;
  /** Expand one absolute Include glob to file paths. */
  glob?: (pattern: string) => string[];
}

function defaultSystemConfig(): string {
  return process.platform === "win32"
    ? join(process.env.PROGRAMDATA ?? "C:\\ProgramData", "ssh", "ssh_config")
    : "/etc/ssh/ssh_config";
}

function globMatch(pattern: string, host: string): boolean {
  let regex = "^";
  pattern = pattern.replace(/\*+/g, "*");
  for (const char of pattern) regex += char === "*" ? ".*" : char === "?" ? "." : char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(regex + "$").test(host);
}

/** OpenSSH Host matching: any positive pattern matches and no negated one does, case-insensitively. */
function hostMatches(patterns: readonly string[], host: string): boolean {
  let positive = false;
  for (const raw of patterns) {
    const negated = raw.startsWith("!");
    const pattern = (negated ? raw.slice(1) : raw).toLowerCase();
    if (!globMatch(pattern, host)) continue;
    if (negated) return false;
    positive = true;
  }
  return positive;
}

class Undecidable extends Error {}

export function resolveLinkPathFromConfig(alias: string, deps: LinkPathConfigDeps = {}): LinkPathVia {
  const home = deps.home ?? homedir();
  const read = deps.readFile ?? ((path: string) => readFileSync(path, "utf8"));
  const glob = deps.glob ?? expandSshIncludeGlob;
  const host = alias.toLowerCase();
  let files = 0;
  const load = (path: string): string | null => {
    if (++files > MAX_FILES) throw new Undecidable();
    let body: string;
    try { body = read(path); } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") return null;
      throw new Undecidable();
    }
    if (body.length > MAX_FILE_BYTES) throw new Undecidable();
    return body;
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
        case "proxyjump": if (applies) return value === "none" ? "direct" : "proxy-jump"; break;
        case "include": {
          if (!applies) break;
          if (depth >= MAX_INCLUDE_DEPTH) throw new Undecidable();
          for (const pattern of directive.args) {
            const expanded = pattern.startsWith("~/") ? join(home, pattern.slice(2)) : pattern;
            const absolute = isAbsolute(expanded) ? expanded : resolve(baseDir, expanded);
            let paths: string[];
            try { paths = glob(absolute); } catch { throw new Undecidable(); }
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
}
