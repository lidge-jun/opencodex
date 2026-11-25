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
  type BigIntStats,
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
  isLocalControlPrivateSocketName,
  isPrivateSocketDir,
  localControlLeasePath,
  localControlPrivateSocketPath,
  localControlSocketDir,
  localControlSocketPath,
  localControlSocketPathFits,
  localControlSocketSupported,
  removeWindowsPrivateSocket,
  windowsPlainDirectory,
  windowsSocketEntry,
  windowsTrustedPath,
} from "../../lib/local-control-socket";
import { hardenSecretDir } from "../../lib/windows-secret-acl";
import type { OcxConfig } from "../../types";

const WINDOWS = process.platform === "win32";

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
  if (WINDOWS) {
    // Trust the path above the run directory before creating anything in it (#8998).
    if (!windowsTrustedPath(dir, false)) throw new Error("socket directory path is not trusted");
    try { mkdirSync(dir); } catch (error) { if (!isCode(error, "EEXIST")) throw error; }
    // Refuse a pre-existing junction or other reparse point before any ACL operation can follow it.
    if (!windowsPlainDirectory(dir)) throw new Error("socket directory is not a plain directory");
    hardenSecretDir(dir, { required: true, verifyExistingRuntimeDirectory: true });
    if (!isPrivateSocketDir(dir)) throw new Error("socket directory could not be made private");
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!()) {
    throw new Error("socket directory is not a directory owned by this user");
  }
  chmodSync(dir, 0o700);
  if (!isPrivateSocketDir(dir)) throw new Error("socket directory could not be made private");
}

/** Inode identity as the kernel reports it. Bigint keeps every bit of a Windows file ID. */
interface FileIdentity { dev: bigint; ino: bigint }

/**
 * Windows cannot read an AF_UNIX file's identity (lstat refuses it), so a socket this runtime
 * published there carries this marker instead. What makes such a path this runtime's is the lease:
 * every unlink of a marked path happens inside the claim mutex while the lease still names this
 * runtime's token, and a successor can publish only after it holds the lease.
 */
const WINDOWS_SOCKET_IDENTITY: FileIdentity = Object.freeze({ dev: -1n, ino: -1n });

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
  | { kind: "failed"; error: unknown; retained?: "socket" | "lease" };

const PUBLISH_ATTEMPTS = 4;
/** `withLockClaim` is a try-lock; a contender retries a bounded number of times and then refuses. */
const LEASE_LOCK_ATTEMPTS = 8;
const LEASE_LOCK_RETRY_MS = 2;
/** A release is on the shutdown path, so it retries longer than the acquire does. */
const RELEASE_ATTEMPTS = 12;
const RELEASE_RETRY_MS = 5;
/** Filesystems without hard links reject `link` with one of these; the socket cannot be published. */
const HARD_LINK_UNSUPPORTED = new Set(["EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV", "EMLINK"]);
const HARD_LINK_WARNING = "[local-control] the socket directory's filesystem does not support hard links; ocx link status will use the TCP listener";

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
  if (WINDOWS) return windowsSocketEntry(path) ? WINDOWS_SOCKET_IDENTITY : null;
  try {
    const stat = lstatSync(path, { bigint: true });
    return { dev: stat.dev, ino: stat.ino };
  } catch {
    return null;
  }
}

function sameIdentity(path: string, identity: FileIdentity): boolean {
  if (identity === WINDOWS_SOCKET_IDENTITY) return windowsSocketEntry(path);
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

/**
 * Remove the record only when it is still this instance's; the caller holds the claim mutex.
 * Only a record that is already gone counts as removed: any other unlink failure throws, so the
 * caller keeps its retry state instead of reporting a release that left a live lease behind.
 */
function removeOwnedLease(path: string, token: string): void {
  const current = readLease(path);
  if (current.kind !== "record" || current.lease.token !== token) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if (!isCode(error, "ENOENT")) throw error;
  }
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
  for (const name of entries) {
    // The exact private-socket name, never a prefix: the lease shares the prefix.
    if (!isLocalControlPrivateSocketName(port, name)) continue;
    const candidate = join(dir, name);
    try {
      if (WINDOWS) {
        if (windowsSocketEntry(candidate)) unlinkSync(candidate);
        continue;
      }
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
    let existing: BigIntStats;
    if (WINDOWS) {
      // A socket left there can only be a crashed predecessor's: this runtime holds the lease and
      // the directory is private. Anything lstat can read is not a socket and is left alone.
      if (!windowsSocketEntry(target)) throw new Error("socket path is occupied");
      unlinkSync(target);
      continue;
    }
    try {
      existing = lstatSync(target, { bigint: true });
    } catch (error) {
      if (isCode(error, "ENOENT")) continue;
      throw error;
    }
    if (!existing.isSocket() || existing.uid !== BigInt(process.getuid!())) throw new Error("socket path is occupied");
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
function acquireLease(leasePath: string, token: string, publish: () => void, rollback: () => void = () => {}): LeaseDecision {
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
        // Undo what this attempt bound while it still holds the lease. A rollback that fails keeps
        // the lease, so no successor publishes over a name this attempt may still own.
        try { rollback(); } catch { return { kind: "failed", error, retained: "socket" }; }
        // The names are gone; a lease that cannot be deleted still names this runtime, so it is
        // retained for the next stop() or start() exactly like a release that failed.
        try { removeOwnedLease(leasePath, token); } catch { return { kind: "failed", error, retained: "lease" }; }
        return { kind: "failed", error };
      }
      return { kind: "acquired" };
    });
    if (outcome.ok) return outcome.value;
    if (attempt + 1 < LEASE_LOCK_ATTEMPTS) Bun.sleepSync(LEASE_LOCK_RETRY_MS);
  }
  return { kind: "contended" };
}

/** The record and the paths one runtime published, kept until the release actually succeeds. */
interface OwnedSocket {
  leasePath: string;
  token: string;
  publicPath: string | null;
  privatePath: string | null;
  identity: FileIdentity | null;
}

type ReleaseOutcome =
  | { kind: "released" }
  | { kind: "contended" }
  | { kind: "failed"; error: unknown };

/**
 * A stop that could not give the port back. The record stays on the listener, so a later stop()
 * or start() retries it; this error is how the caller learns the socket may still be live.
 */
export class LocalControlReleaseError extends Error {
  readonly code = "LOCAL_CONTROL_RELEASE_FAILED";
  constructor(readonly outcome: "contended" | "failed", cause?: unknown) {
    super(outcome === "contended"
      ? "another runtime held the control socket ownership record; the lease and socket were left in place"
      : "the control socket ownership record could not be released", { cause });
    this.name = "LocalControlReleaseError";
  }
}

function releaseFailure(outcome: Exclude<ReleaseOutcome, { kind: "released" }>): string {
  return outcome.kind === "contended"
    ? "another runtime held the control socket ownership record"
    : `the control socket ownership record could not be released: ${messageOf(outcome.error)}`;
}

/**
 * Remove the published link and the lease, inside the claim mutex. The outcome is explicit: a
 * lost mutex is contention the caller must retry, never a release that silently did nothing.
 */
function releaseOwnedSocket(state: OwnedSocket): ReleaseOutcome {
  try {
    const outcome = withLockClaim(state.leasePath, state.token, ownerDefaults, () => {
      if (WINDOWS) {
        // Without inode identity, the lease is the proof: unlink only while it still names us, and
        // keep the lease (the release throws) unless both names are proven gone.
        const current = readLease(state.leasePath);
        // An unreadable record proves nothing about who owns the names: fail, keep the retry state.
        if (current.kind === "unsafe") throw new Error("the control socket ownership record could not be read");
        // Absent, or a confirmed successor's token: nothing here is this runtime's any more.
        if (current.kind !== "record" || current.lease.token !== state.token) return;
        if (state.publicPath) removeWindowsPrivateSocket(state.publicPath);
        if (state.privatePath) removeWindowsPrivateSocket(state.privatePath);
        removeOwnedLease(state.leasePath, state.token);
        return;
      }
      if (state.publicPath && state.identity && sameIdentity(state.publicPath, state.identity)) unlinkSync(state.publicPath);
      if (state.privatePath && state.identity && sameIdentity(state.privatePath, state.identity)) unlinkSync(state.privatePath);
      removeOwnedLease(state.leasePath, state.token);
    });
    return outcome.ok ? { kind: "released" } : { kind: "contended" };
  } catch (error) {
    return { kind: "failed", error };
  }
}

/**
 * Retry a contended release a bounded number of times. The wait is synchronous on purpose:
 * stop() has to give the record up before it suspends on its own socket teardown, or a successor
 * starting in the same turn reads a live lease and abandons a port nobody will serve. A
 * same-process peer holds this mutex only inside a synchronous critical section, so a blocking
 * wait always reaches it; a peer process makes progress on its own.
 */
function releaseBlocking(state: OwnedSocket): ReleaseOutcome {
  let outcome = releaseOwnedSocket(state);
  for (let attempt = 1; attempt < RELEASE_ATTEMPTS && outcome.kind === "contended"; attempt += 1) {
    Bun.sleepSync(RELEASE_RETRY_MS);
    outcome = releaseOwnedSocket(state);
  }
  return outcome;
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
  /** A release that could not run yet. Retained so the next stop() or start() finishes it. */
  let pendingRelease: OwnedSocket | null = null;

  const liveState = (): OwnedSocket | null => leasePath && leaseToken
    ? { leasePath, token: leaseToken, publicPath, privatePath, identity }
    : null;

  const clearLive = (): void => {
    server = null;
    publicPath = null;
    privatePath = null;
    identity = null;
    leasePath = null;
    leaseToken = null;
  };

  return {
    ownsListener: candidate => server !== null && candidate === server,
    socketPath: () => publicPath,
    start(ctx) {
      if (server || !localControlSocketWanted(ctx.config)) return;
      // A previous stop could not give the port back; finish that before asking for it again,
      // because the record it left names this pid and would read as a live owner.
      if (pendingRelease) {
        const previous = releaseBlocking(pendingRelease);
        if (previous.kind !== "released") {
          console.warn(`[local-control] ${releaseFailure(previous)}; leaving the previous record in place`);
          return;
        }
        pendingRelease = null;
      }
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
        // Windows has no mode to set: its boundary is the directory's verified ACL.
        if (!WINDOWS) chmodSync(privateTarget, 0o600);
        const socketIdentity = identityOf(privateTarget);
        if (!socketIdentity) throw new Error("socket identity unavailable");
        publishPublicLink(target, privateTarget);
        published = socketIdentity;
      };
      // Bun unlinks its bound name only when its stop completes, after this attempt gave the lease
      // up. On Windows, where no inode identity guards a later cleanup, a failed publication removes
      // the name itself, inside the claim mutex and before the lease goes. POSIX keeps Bun's cleanup.
      const rollback = (): void => {
        if (!WINDOWS) return;
        // The name is removed here, not by the stop: unlinking a listening AF_UNIX name works on
        // Windows, and the stop only completes after this attempt gave the lease up. A stop that
        // fails or completes late leaves a listener with no name: a nameless AF_UNIX listener
        // accepts no new connection, and a successor binds its own per-token name, so neither
        // can collide with it. The failure is reported.
        if (bound) {
          void (bound as Server<T>).stop(true).catch(error => {
            console.warn(`[local-control] a failed publication's listener did not stop: ${messageOf(error)}`);
          });
        }
        removeWindowsPrivateSocket(privateTarget);
      };
      let decision: LeaseDecision;
      try {
        decision = acquireLease(leaseFile, token, publish, rollback);
      } catch (error) {
        if (bound) void (bound as Server<T>).stop(true).catch(() => {});
        console.warn(hardLinkUnsupported(error) ? HARD_LINK_WARNING : `[local-control] socket unavailable: ${messageOf(error)}`);
        return;
      }
      if (decision.kind === "failed") {
        if (bound) void (bound as Server<T>).stop(true).catch(() => {});
        if (decision.retained === "socket") {
          // The rollback could not remove what this attempt bound; keep the port owned and let the
          // next stop() or start() finish the release, exactly as a release that failed would.
          pendingRelease = { leasePath: leaseFile, token, publicPath: null, privatePath: privateTarget, identity: WINDOWS_SOCKET_IDENTITY };
        } else if (decision.retained === "lease") {
          // The names are gone and only the record survived its unlink: retry just the record.
          pendingRelease = { leasePath: leaseFile, token, publicPath: null, privatePath: null, identity: null };
        }
        // Publishing is where a hard-link-less filesystem actually fails, and that error is
        // returned rather than thrown, so this branch is the one that has to classify it.
        console.warn(hardLinkUnsupported(decision.error) ? HARD_LINK_WARNING : `[local-control] socket unavailable: ${messageOf(decision.error)}`);
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
      // Bun's own stop unlinks the private name, so this rollback leaves that one to it.
      const live = liveState();
      const state = pendingRelease ?? (live ? { ...live, privatePath: null } : null);
      clearLive();
      // startServer is synchronous, so this rollback cannot await. Bun begins closing the listen
      // socket on the call itself and unlinks its own private name; the published link and the
      // lease must go now, because a stranded live lease keeps the next runtime off a dead socket.
      if (running) {
        try { void running.stop(true).catch(() => {}); } catch { /* the startup error is the one to report */ }
      }
      if (!state) return;
      const outcome = releaseBlocking(state);
      if (outcome.kind === "released") { pendingRelease = null; return; }
      // abort() runs inside startServer's catch, so it must not replace the startup error. The
      // record is retained and reported here, and the next stop() or start() retries it.
      pendingRelease = state;
      console.warn(`[local-control] ${releaseFailure(outcome)}; the record is retained for the next start or stop`);
    },
    async stop() {
      const running = server;
      const state = pendingRelease ?? liveState();
      clearLive();
      // Give the record up BEFORE awaiting the socket teardown. A successor that starts while
      // this stop is suspended must not read a live lease and abandon a port nobody will serve.
      let releaseError: LocalControlReleaseError | null = null;
      if (state) {
        const outcome = releaseBlocking(state);
        if (outcome.kind === "released") {
          pendingRelease = null;
        } else {
          pendingRelease = state;
          releaseError = new LocalControlReleaseError(outcome.kind, outcome.kind === "failed" ? outcome.error : undefined);
        }
      }
      let failure: unknown;
      try {
        if (running) await running.stop(true);
      } catch (error) {
        failure = error;
      }
      // A record that could not be released is the failure worth reporting: the socket may live,
      // and the caller's shutdown has to say so rather than look complete.
      if (releaseError) throw releaseError;
      if (failure) throw failure;
    },
  };
}
