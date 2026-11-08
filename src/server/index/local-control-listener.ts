import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Server } from "bun";
import { isLoopbackHostname } from "../../codex/loopback-target";
import { assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import {
  LOCAL_CONTROL_SOCKET_PATH_MAX,
  isPrivateSocketDir,
  localControlLeasePath,
  localControlPrivateSocketPath,
  localControlSocketDir,
  localControlSocketPath,
  localControlSocketSupported,
} from "../../lib/local-control-socket";
import type { OcxConfig } from "../../types";

/**
 * The one request the local control socket serves (#8184). `ocx link status` needs admin-token
 * authority on trusted loopback ingress, which a hub whose public listener is not loopback cannot
 * give it: the hub management listener is reached through Tailscale Serve, so it must never count
 * as trusted loopback (#6913). The socket is a separate ingress with that trust, limited to this
 * read and still requiring the admin token.
 */
export function localControlRouteAllowed(url: URL, req: Request): boolean {
  return req.method === "GET" && url.pathname === "/api/link/status" && !req.headers.has("upgrade");
}

/** A loopback public listener already gives the CLI trusted ingress; only other binds need this. */
export function localControlSocketWanted(config: Pick<OcxConfig, "hostname">): boolean {
  return localControlSocketSupported() && !isLoopbackHostname(config.hostname ?? "127.0.0.1");
}

export interface LocalControlStartContext<T> {
  config: OcxConfig;
  publicPort: number;
  dispatch: (req: Request, server: Server<T>) => Promise<Response>;
  configDir?: string;
}

export interface LocalControlListener<T> {
  ownsListener(server: Server<T>): boolean;
  socketPath(): string | null;
  start(ctx: LocalControlStartContext<T>): void;
  stop(): Promise<void>;
}

function preparePrivateDir(dir: string): void {
  assertNotRealHomeUnderTest(dirname(dir));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) {
    throw new Error("socket directory is not a directory owned by this user");
  }
  chmodSync(dir, 0o700);
  if (!isPrivateSocketDir(dir)) throw new Error("socket directory could not be made private");
}

interface FileIdentity { dev: number; ino: number }

interface LocalControlLease { pid: number; start: string; token: string }

const UNKNOWN_PROCESS_START = "unknown";
const LEASE_STARTING_GRACE_MS = 5_000;
const PUBLISH_ATTEMPTS = 4;

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === code;
}

function randomSuffix(): string {
  return randomBytes(6).toString("hex");
}

function identityOf(path: string): FileIdentity | null {
  try {
    const stat = lstatSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameIdentity(path: string, identity: FileIdentity): boolean {
  const current = identityOf(path);
  return current !== null && current.dev === identity.dev && current.ino === identity.ino;
}

/**
 * A pid alone can be reused, so a lease records the process start time as well. Linux reads it
 * from /proc, macOS from ps; where neither is available the pid is all we have and a live pid is
 * treated as the owner rather than risking a takeover.
 */
function processStartIdentity(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const close = stat.lastIndexOf(")");
      if (close < 0) return null;
      // Field 22 of /proc/<pid>/stat: the first field after `)` is field 3.
      const starttime = stat.slice(close + 2).split(" ")[19];
      return starttime ? `linux:${starttime}` : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const started = execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(pid)], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 2_000,
      }).trim();
      return started ? `ps:${started}` : null;
    } catch {
      return null;
    }
  }
  return null;
}

function readLease(path: string): LocalControlLease | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LocalControlLease>;
    if (typeof parsed.pid !== "number" || typeof parsed.start !== "string" || typeof parsed.token !== "string") return null;
    return { pid: parsed.pid, start: parsed.start, token: parsed.token };
  } catch {
    return null;
  }
}

function leaseOwnerIsLive(lease: LocalControlLease): boolean {
  if (!Number.isInteger(lease.pid) || lease.pid <= 0) return false;
  try {
    process.kill(lease.pid, 0);
  } catch (error) {
    // ESRCH, EINVAL and an out-of-range pid all prove the owner is gone; EPERM and anything
    // else mean a process with that pid still exists.
    return !(isCode(error, "ESRCH") || isCode(error, "EINVAL") || isCode(error, "ERR_OUT_OF_RANGE"));
  }
  if (lease.start === UNKNOWN_PROCESS_START) return true;
  const start = processStartIdentity(lease.pid);
  return start === null || start === lease.start;
}

function leaseIsFresh(path: string): boolean {
  try {
    return Date.now() - lstatSync(path).mtimeMs < LEASE_STARTING_GRACE_MS;
  } catch {
    return false;
  }
}

/**
 * Remove the lease only if it is still the record the caller judged. The entry is taken with an
 * atomic rename first, so two starters recovering the same stale record cannot both win: the loser
 * sees the winner's record, puts it back, and refuses.
 */
function takeLease(path: string, matches: (lease: LocalControlLease | null) => boolean): boolean {
  const aside = `${path}.${process.pid}.${randomSuffix()}.taken`;
  try {
    renameSync(path, aside);
  } catch (error) {
    if (isCode(error, "ENOENT")) return true;
    throw error;
  }
  if (matches(readLease(aside))) {
    try { unlinkSync(aside); } catch { /* ignore */ }
    return true;
  }
  try { linkSync(aside, path); unlinkSync(aside); } catch { /* leave the aside entry */ }
  return false;
}

/** Create the lease with its full record in one atomic link, so a reader never sees a blank file. */
function createLease(path: string, lease: LocalControlLease): boolean {
  const temp = `${path}.${process.pid}.${randomSuffix()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(lease), { mode: 0o600 });
    try {
      linkSync(temp, path);
      return true;
    } catch (error) {
      if (isCode(error, "EEXIST")) return false;
      throw error;
    }
  } finally {
    try { unlinkSync(temp); } catch { /* already gone */ }
  }
}

/**
 * Take the port's ownership record. A live owner is never displaced; a record whose process is
 * gone is a crashed predecessor and is replaced. A record that exists but cannot be read is only
 * treated as stale after the grace window, so a concurrent starter is never mistaken for one.
 */
function acquireLease(path: string, token: string): boolean {
  const lease: LocalControlLease = {
    pid: process.pid,
    start: processStartIdentity(process.pid) ?? UNKNOWN_PROCESS_START,
    token,
  };
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    if (createLease(path, lease)) return true;
    const owner = readLease(path);
    if (owner && leaseOwnerIsLive(owner)) return false;
    if (!owner && leaseIsFresh(path)) return false;
    const stale = owner === null
      ? (candidate: LocalControlLease | null) => candidate === null
      : (candidate: LocalControlLease | null) => candidate !== null
        && candidate.pid === owner.pid && candidate.start === owner.start && candidate.token === owner.token;
    if (!takeLease(path, stale)) return false;
  }
  return false;
}

function releaseLease(path: string, token: string): void {
  try {
    takeLease(path, owner => owner === null || owner.token === token);
  } catch { /* not ours any more */ }
}

/**
 * Remove a private socket left by a runtime that died before it could clean up. The lease is ours,
 * so every other `.c<port>.*` socket is a crashed predecessor's; a live owner would have kept the
 * lease and this code would never run.
 */
function removeOrphanPrivateSockets(port: number, configDir: string | undefined): void {
  const dir = localControlSocketDir(configDir);
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  const prefix = `.c${port}.`;
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const candidate = join(dir, name);
    try {
      const stat = lstatSync(candidate);
      if (stat.isSocket() && stat.uid === process.getuid!()) unlinkSync(candidate);
    } catch { /* raced with another cleanup */ }
  }
}

/**
 * Publish the private socket at the public path with an atomic hard link. A same-user socket that
 * is already there can only be a crashed predecessor's, because a live owner holds the lease; it
 * is moved aside and verified by inode before it is discarded. Any other file is left alone.
 */
function publishPublicLink(target: string, privateTarget: string): void {
  for (let attempt = 0; attempt < PUBLISH_ATTEMPTS; attempt += 1) {
    try {
      linkSync(privateTarget, target);
      return;
    } catch (error) {
      if (!isCode(error, "EEXIST")) throw error;
    }
    let existing: Stats;
    try {
      existing = lstatSync(target);
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!existing.isSocket() || existing.uid !== process.getuid!()) throw new Error("socket path is occupied");
    discardStaleLink(target, existing);
  }
  throw new Error("socket path is occupied");
}

function discardStaleLink(target: string, expected: Stats): void {
  const aside = `${target}.${process.pid}.${randomSuffix()}.stale`;
  try {
    renameSync(target, aside);
  } catch (error) {
    if (isCode(error, "ENOENT")) return;
    throw error;
  }
  const moved = identityOf(aside);
  if (moved && moved.dev === expected.dev && moved.ino === expected.ino) {
    try { unlinkSync(aside); } catch { /* ignore */ }
    return;
  }
  // The entry changed between the stat and the rename: put the newcomer back and refuse.
  try { linkSync(aside, target); unlinkSync(aside); } catch { /* leave the aside entry */ }
  throw new Error("socket path is occupied");
}

/**
 * Remove one directory entry only if it is still the inode this runtime published. Bun's stop()
 * unlinks whatever path it was given, so the public path is never handed to Bun; this check is
 * what keeps an old runtime's shutdown from unlinking a successor's socket.
 */
function unlinkOwnedEntry(path: string, identity: FileIdentity): void {
  if (!sameIdentity(path, identity)) return;
  const aside = `${path}.${process.pid}.${randomSuffix()}.stopped`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  const moved = identityOf(aside);
  if (moved && moved.dev === identity.dev && moved.ino === identity.ino) {
    try { unlinkSync(aside); } catch { /* ignore */ }
    return;
  }
  try { linkSync(aside, path); unlinkSync(aside); } catch { /* leave the aside entry */ }
}

const notFound = () => Response.json(
  { error: { code: "not_found", message: "The local control socket serves only GET /api/link/status." } },
  { status: 404 },
);

export function createLocalControlListener<T>(): LocalControlListener<T> {
  let server: Server<T> | null = null;
  let publicPath: string | null = null;
  let privatePath: string | null = null;
  let identity: FileIdentity | null = null;
  let leasePath: string | null = null;
  let leaseToken: string | null = null;
  return {
    ownsListener: candidate => server !== null && candidate === server,
    socketPath: () => publicPath,
    start(ctx) {
      if (server || !localControlSocketWanted(ctx.config)) return;
      const target = localControlSocketPath(ctx.publicPort, ctx.configDir);
      const privateTarget = localControlPrivateSocketPath(ctx.publicPort, ctx.configDir);
      const lease = localControlLeasePath(ctx.publicPort, ctx.configDir);
      if ([target, privateTarget, lease].some(candidate => candidate.length > LOCAL_CONTROL_SOCKET_PATH_MAX)) {
        console.warn("[local-control] socket path is too long; ocx link status will use the TCP listener");
        return;
      }
      const token = basename(privateTarget);
      let bound: Server<T> | null = null;
      let holdsLease = false;
      try {
        preparePrivateDir(dirname(target));
        // The lease is the ownership decision. A live owner keeps its socket; only a record whose
        // process is gone lets this runtime replace what it left behind.
        holdsLease = acquireLease(lease, token);
        if (!holdsLease) {
          console.warn("[local-control] another runtime owns this port's control socket; leaving it in place");
          return;
        }
        removeOrphanPrivateSockets(ctx.publicPort, ctx.configDir);
        // Bun binds a process-specific address, so its own stop() can only ever unlink this one.
        bound = Bun.serve<T, never>({
          unix: privateTarget,
          maxRequestBodySize: 0,
          fetch(req, requestServer) {
            let url: URL;
            try { url = new URL(req.url); } catch { return notFound(); }
            return localControlRouteAllowed(url, req) ? ctx.dispatch(req, requestServer) : notFound();
          },
        });
        // The private directory is the access boundary; the socket mode is a second fence.
        chmodSync(privateTarget, 0o600);
        const published = identityOf(privateTarget);
        if (!published) throw new Error("socket identity unavailable");
        publishPublicLink(target, privateTarget);
        server = bound;
        publicPath = target;
        privatePath = privateTarget;
        identity = published;
        leasePath = lease;
        leaseToken = token;
      } catch (error) {
        if (bound) void bound.stop(true).catch(() => {});
        if (holdsLease) releaseLease(lease, token);
        console.warn(`[local-control] socket unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
    async stop() {
      const running = server;
      const published = publicPath;
      const privateSocket = privatePath;
      const publishedIdentity = identity;
      const lease = leasePath;
      const token = leaseToken;
      server = null;
      publicPath = null;
      privatePath = null;
      identity = null;
      leasePath = null;
      leaseToken = null;
      try {
        if (running) await running.stop(true);
      } finally {
        try {
          if (published && publishedIdentity) unlinkOwnedEntry(published, publishedIdentity);
          if (privateSocket && publishedIdentity) unlinkOwnedEntry(privateSocket, publishedIdentity);
        } finally {
          if (lease && token) releaseLease(lease, token);
        }
      }
    },
  };
}
