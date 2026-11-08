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
import { dirname, join } from "node:path";
import type { Server } from "bun";
import { isLoopbackHostname } from "../../codex/loopback-target";
import { withLockClaim } from "../../codex/prompt-lock-claim";
import { ownEvidence, ownerDefaults, ownerState, type OwnerEvidence } from "../../codex/prompt-lock-owner";
import { getConfigDir } from "../../config/paths";
import { ConfigOwnershipLockError, registerOwnedConfigPath } from "../../lib/config-ownership";
import { assertNotRealHomeUnderTest } from "../../lib/test-home-guard";
import {
  isPrivateSocketDir,
  localControlLeasePath,
  localControlPrivateSocketPath,
  localControlSocketDir,
  localControlSocketPath,
  localControlSocketPathFits,
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
  /**
   * Synchronous teardown for a startup that failed after this listener started. `startServer` is
   * synchronous, so the ownership record has to go before the startup error propagates; an
   * awaited `stop()` would leave a live lease nobody serves.
   */
  abort(): void;
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

/**
 * The per-port ownership record. `host` and `processStart` come from the shared owner evidence
 * (`src/codex/prompt-lock-owner.ts`), so a record from another machine, or from a pid that has
 * been reused, is never mistaken for a crashed predecessor.
 */
interface LocalControlLease extends OwnerEvidence { token: string }

type LeaseRead =
  | { kind: "absent" }
  | { kind: "record"; lease: LocalControlLease }
  | { kind: "unsafe" };

type LeaseDecision =
  | { kind: "acquired" }
  | { kind: "held" }
  | { kind: "unsafe" }
  | { kind: "contended" }
  | { kind: "failed"; error: unknown };

const PUBLISH_ATTEMPTS = 4;
/** `withLockClaim` is a try-lock; a contender retries a bounded number of times and then refuses. */
const LEASE_LOCK_ATTEMPTS = 8;
const LEASE_LOCK_RETRY_MS = 2;
/** Filesystems without hard links reject `link` with one of these; the socket cannot be published. */
const HARD_LINK_UNSUPPORTED = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV", "EMLINK"]);

function isCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && (error as { code?: unknown }).code === code;
}

function hardLinkUnsupported(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && HARD_LINK_UNSUPPORTED.has(code);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A fresh identity per listener instance, so a same-pid restart never reuses a name or a record. */
function randomToken(): string {
  return randomBytes(8).toString("hex");
}

/**
 * Record the run directory as state uninstall may remove. Another runtime may hold the ownership
 * lock for a moment, and refusing the socket over that transient would silently drop the only
 * ingress `ocx link status` has on a hub, so a busy lock is retried briefly.
 */
function registerRunDirectory(root: string, dir: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (registerOwnedConfigPath(root, dir) === "full") {
        console.warn("[local-control] the config ownership manifest is full; the run directory may survive uninstall");
      }
      return;
    } catch (error) {
      if (!(error instanceof ConfigOwnershipLockError) || attempt >= 2) throw error;
      Bun.sleepSync(5);
    }
  }
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
 * A record that exists but cannot be read is `unsafe`, never `absent`: treating a corrupt lease
 * as "no owner" is how a live runtime gets displaced by a reader that could not parse it.
 */
function readLease(path: string): LeaseRead {
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (error) {
    return isCode(error, "ENOENT") ? { kind: "absent" } : { kind: "unsafe" };
  }
  try {
    const parsed = JSON.parse(body) as Partial<LocalControlLease>;
    if (typeof parsed.token !== "string" || parsed.token.length === 0) return { kind: "unsafe" };
    return { kind: "record", lease: parsed as LocalControlLease };
  } catch {
    return { kind: "unsafe" };
  }
}

/** Replace the record in one rename, so no reader ever sees a half-written lease. */
function writeLease(path: string, lease: LocalControlLease): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(lease), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch { /* renamed or never written */ }
  }
}

/** Remove the record only when it is still this instance's; the caller holds the claim mutex. */
function removeOwnedLease(path: string, token: string): void {
  const current = readLease(path);
  if (current.kind !== "record" || current.lease.token !== token) return;
  try { unlinkSync(path); } catch { /* already gone */ }
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
 * Publish the private socket at the public path with an atomic hard link. The caller holds the
 * lease, so a same-user socket already there can only be a crashed predecessor's and is removed;
 * any other file is left alone and the socket is not served.
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
    unlinkSync(target);
  }
  throw new Error("socket path is occupied");
}

/**
 * Read the record, decide, and publish, all inside the shared claim mutex
 * (`withLockClaim`, `src/codex/prompt-lock-claim.ts`). The mutex is what makes this a decision
 * rather than a recheck: no other runtime can be between its own read and its own write, so a
 * record judged stale cannot be replaced by a live one before this runtime publishes.
 */
function acquireLease(leasePath: string, token: string, publish: () => void): LeaseDecision {
  for (let attempt = 0; attempt < LEASE_LOCK_ATTEMPTS; attempt += 1) {
    const outcome = withLockClaim(leasePath, token, ownerDefaults, (): LeaseDecision => {
      const current = readLease(leasePath);
      if (current.kind === "unsafe") return { kind: "unsafe" };
      if (current.kind === "record") {
        const state = ownerState(current.lease, ownerDefaults);
        if (state !== "dead") return { kind: state === "live" ? "held" : "unsafe" };
      }
      // Absent, or provably a crashed predecessor: this runtime owns the port now.
      writeLease(leasePath, { ...ownEvidence(ownerDefaults), token });
      try {
        publish();
      } catch (error) {
        removeOwnedLease(leasePath, token);
        return { kind: "failed", error };
      }
      return { kind: "acquired" };
    });
    if (outcome.ok) return outcome.value;
    if (attempt + 1 < LEASE_LOCK_ATTEMPTS) Bun.sleepSync(LEASE_LOCK_RETRY_MS);
  }
  return { kind: "contended" };
}

/**
 * Give the port back. The lease is held for the whole teardown, so no successor can publish into
 * these paths while they are being removed; the identity checks keep a successor's socket safe if
 * a previous teardown is still in flight.
 */
function releaseOwnedSocket(state: {
  leasePath: string;
  token: string;
  publicPath: string | null;
  privatePath: string | null;
  identity: FileIdentity | null;
}): void {
  try {
    withLockClaim(state.leasePath, state.token, ownerDefaults, () => {
      if (state.publicPath && state.identity && sameIdentity(state.publicPath, state.identity)) unlinkSync(state.publicPath);
      if (state.privatePath && state.identity && sameIdentity(state.privatePath, state.identity)) unlinkSync(state.privatePath);
      removeOwnedLease(state.leasePath, state.token);
    });
  } catch {
    // A foreign, unreadable or vanished record is left for the next runtime to judge.
  }
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

  const release = (state: {
    lease: string | null;
    token: string | null;
    publicPath: string | null;
    privatePath: string | null;
    identity: FileIdentity | null;
  }): void => {
    if (!state.lease || !state.token) return;
    releaseOwnedSocket({
      leasePath: state.lease,
      token: state.token,
      publicPath: state.publicPath,
      privatePath: state.privatePath,
      identity: state.identity,
    });
  };

  return {
    ownsListener: candidate => server !== null && candidate === server,
    socketPath: () => publicPath,
    start(ctx) {
      if (server || !localControlSocketWanted(ctx.config)) return;
      const target = localControlSocketPath(ctx.publicPort, ctx.configDir);
      const leaseFile = localControlLeasePath(ctx.publicPort, ctx.configDir);
      const token = randomToken();
      const privateTarget = localControlPrivateSocketPath(ctx.publicPort, token, ctx.configDir);
      if (!localControlSocketPathFits(target) || !localControlSocketPathFits(privateTarget)) {
        console.warn("[local-control] socket path is too long; ocx link status will use the TCP listener");
        return;
      }
      try {
        preparePrivateDir(dirname(target));
      } catch (error) {
        console.warn(`[local-control] socket unavailable: ${messageOf(error)}`);
        return;
      }
      try {
        // The run directory is state this runtime creates inside the config home, so uninstall has
        // to know about it. Only the directory is recorded: the sockets and the lease inside it are
        // transient, and the ownership API refuses to adopt an entry it did not record.
        registerRunDirectory(ctx.configDir ?? getConfigDir(), dirname(target));
      } catch (error) {
        console.warn(`[local-control] socket unavailable: ${messageOf(error)}`);
        return;
      }
      let bound: Server<T> | null = null;
      let published: FileIdentity | null = null;
      const publish = (): void => {
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
        const socketIdentity = identityOf(privateTarget);
        if (!socketIdentity) throw new Error("socket identity unavailable");
        publishPublicLink(target, privateTarget);
        published = socketIdentity;
      };
      let decision: LeaseDecision;
      try {
        decision = acquireLease(leaseFile, token, publish);
      } catch (error) {
        if (bound) void (bound as Server<T>).stop(true).catch(() => {});
        console.warn(hardLinkUnsupported(error)
          ? "[local-control] the socket directory's filesystem does not support hard links; ocx link status will use the TCP listener"
          : `[local-control] socket unavailable: ${messageOf(error)}`);
        return;
      }
      if (decision.kind === "failed") {
        if (bound) void (bound as Server<T>).stop(true).catch(() => {});
        console.warn(`[local-control] socket unavailable: ${messageOf(decision.error)}`);
        return;
      }
      if (decision.kind === "held") {
        console.warn("[local-control] another runtime owns this port's control socket; leaving it in place");
        return;
      }
      if (decision.kind === "unsafe") {
        console.warn("[local-control] the control socket ownership record is not this machine's; leaving it in place");
        return;
      }
      if (decision.kind === "contended") {
        console.warn("[local-control] could not take the control socket ownership record; leaving it in place");
        return;
      }
      server = bound;
      publicPath = target;
      privatePath = privateTarget;
      identity = published;
      leasePath = leaseFile;
      leaseToken = token;
    },
    abort() {
      const running = server;
      const state = { lease: leasePath, token: leaseToken, publicPath, privatePath: null, identity };
      server = null;
      publicPath = null;
      privatePath = null;
      identity = null;
      leasePath = null;
      leaseToken = null;
      // startServer is synchronous, so this rollback cannot await. Bun begins closing the listen
      // socket on the call itself and unlinks its own private name; the published link and the
      // lease must go now, because a stranded live lease keeps the next runtime off a dead socket.
      if (running) {
        try { void running.stop(true).catch(() => {}); } catch { /* the startup error is the one to report */ }
      }
      release(state);
    },
    async stop() {
      const running = server;
      const state = { lease: leasePath, token: leaseToken, publicPath, privatePath, identity };
      server = null;
      publicPath = null;
      privatePath = null;
      identity = null;
      leasePath = null;
      leaseToken = null;
      try {
        if (running) await running.stop(true);
      } finally {
        release(state);
      }
    },
  };
}
