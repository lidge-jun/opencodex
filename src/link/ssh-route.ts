import { buildResolveArgv } from "./ssh-argv";
import type { SshRunner } from "./ssh-runner";

/**
 * Which way a link's SSH alias reaches the other machine (#3023): through a ProxyCommand (a relay
 * such as Pen, or any wrapper), through a ProxyJump host, or directly. Read from `ssh -G <alias>`,
 * which resolves the alias the way the tunnel's own ssh does without connecting (it does run any
 * `Match exec` command the user's config names, as every ssh of that alias does). Only the kind
 * leaves this module, never the command, the jump host or any address. A failed, slow or
 * unparsable resolution is "unknown". Results are cached per alias so a status read spawns at most
 * one `ssh -G` per alias per `LINK_PATH_CACHE_MS`. At most `LINK_PATH_MAX_CONCURRENT` run at once
 * and at most `LINK_PATH_MAX_PENDING` aliases wait or run; an alias beyond that reads "unknown"
 * without a spawn and without caching, so a later read resolves it.
 */
export type LinkPathVia = "proxy-command" | "proxy-jump" | "direct" | "unknown";
export interface LinkPath { via: LinkPathVia }

export const LINK_PATH_CACHE_MS = 600_000;
export const LINK_PATH_UNKNOWN_CACHE_MS = 60_000;
export const LINK_PATH_RESOLVE_TIMEOUT_MS = 3_000;
export const LINK_PATH_MAX_CONCURRENT = 4;
export const LINK_PATH_MAX_PENDING = 32;
const MAX_ALIASES = 256;
const MAX_OUTPUT_BYTES = 64 * 1024;

/** Classify `ssh -G` output. A key whose value is `none` is unset. */
export function classifySshResolvedConfig(stdout: string): Exclude<LinkPathVia, "unknown"> {
  let jump = false;
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^(proxycommand|proxyjump)\s+(.+)$/i.exec(line.trim());
    if (!match || match[2]!.trim().toLowerCase() === "none") continue;
    if (match[1]!.toLowerCase() === "proxycommand") return "proxy-command";
    jump = true;
  }
  return jump ? "proxy-jump" : "direct";
}

export interface LinkPathResolver {
  resolve(alias: string): Promise<LinkPath>;
}

export function createLinkPathResolver(deps: { runner: () => SshRunner; now?: () => number; timeoutMs?: number }): LinkPathResolver {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { via: LinkPathVia; until: number }>();
  const inflight = new Map<string, Promise<LinkPath>>();
  let running = 0;
  const waiting: Array<() => void> = [];
  // A finished lookup hands its slot straight to the next waiter, so `running` never exceeds the cap.
  const slot = async (): Promise<() => void> => {
    if (running >= LINK_PATH_MAX_CONCURRENT) await new Promise<void>(resolve => waiting.push(resolve));
    else running += 1;
    return () => {
      const next = waiting.shift();
      if (next) next(); else running -= 1;
    };
  };
  const lookup = async (alias: string): Promise<LinkPathVia> => {
    const release = await slot();
    try {
      const result = await deps.runner().run(buildResolveArgv(alias), {
        timeoutMs: deps.timeoutMs ?? LINK_PATH_RESOLVE_TIMEOUT_MS, maxOutputBytes: MAX_OUTPUT_BYTES,
      });
      return result.code === 0 ? classifySshResolvedConfig(result.stdout) : "unknown";
    } catch {
      return "unknown";
    } finally {
      release();
    }
  };
  return {
    resolve(alias) {
      const cached = cache.get(alias);
      if (cached && cached.until > now()) return Promise.resolve({ via: cached.via });
      const pending = inflight.get(alias);
      if (pending) return pending;
      if (inflight.size >= LINK_PATH_MAX_PENDING) return Promise.resolve({ via: "unknown" });
      const flight = lookup(alias).then(via => {
        cache.delete(alias);
        cache.set(alias, { via, until: now() + (via === "unknown" ? LINK_PATH_UNKNOWN_CACHE_MS : LINK_PATH_CACHE_MS) });
        if (cache.size > MAX_ALIASES) cache.delete(cache.keys().next().value!);
        return { via };
      }).finally(() => { inflight.delete(alias); });
      inflight.set(alias, flight);
      return flight;
    },
  };
}
