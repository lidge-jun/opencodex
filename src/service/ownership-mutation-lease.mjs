import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

const WAIT_MS = 2_000;
const POLL_MS = 20;
const STALE_MS = 30_000;
const PROCESS_INSTANCE = randomUUID();
const held = new Map();
const delegatedTokens = new Map();
const sleeper = new Int32Array(new SharedArrayBuffer(4));
export const OWNERSHIP_MUTATION_LEASE_TOKEN_ENV = "OCX_OWNERSHIP_MUTATION_LEASE_TOKEN";

export function ownershipMutationLeaseChildEnvironment(environment, token) {
  return { ...environment, [OWNERSHIP_MUTATION_LEASE_TOKEN_ENV]: token };
}

export function unprivilegedOwnershipMutationEnvironment(environment) {
  const child = { ...environment };
  delete child[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  return child;
}

function sleep(ms) { Atomics.wait(sleeper, 0, 0, ms); }
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== "ESRCH"; }
}

function leasePath(statePaths) {
  const authority = statePaths.at(-1);
  if (!authority) throw new Error("cannot acquire ownership mutation lease without a service-state path");
  try { return `${realpathSync.native(authority)}.mutation.lock`; }
  catch {
    try { return join(realpathSync.native(dirname(authority)), `${basename(authority)}.mutation.lock`); }
    catch { return `${authority}.mutation.lock`; }
  }
}

function ownerName(record) {
  return `v1-${record.pid}-${record.processInstance}-${record.token}.json`;
}

function parseOwnerName(name) {
  const match = /^v1-([1-9][0-9]*)-[0-9a-f-]+-[0-9a-f-]+[.]json$/i.exec(name);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

function readOwner(path) {
  try {
    const lock = lstatSync(path);
    if (!lock.isDirectory()) return null;
    const entries = readdirSync(path);
    if (entries.length !== 1) return null;
    const ownerPath = join(path, entries[0]);
    const owner = lstatSync(ownerPath);
    if (!owner.isFile() || owner.size > 4096) return null;
    const record = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (record?.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid <= 0
      || typeof record.processInstance !== "string" || !record.processInstance
      || typeof record.token !== "string" || !record.token
      || !Number.isFinite(record.createdAt) || entries[0] !== ownerName(record)) return null;
    const currentLock = lstatSync(path);
    const currentOwner = lstatSync(ownerPath);
    if (currentLock.dev !== lock.dev || currentLock.ino !== lock.ino
      || currentOwner.dev !== owner.dev || currentOwner.ino !== owner.ino
      || currentOwner.size !== owner.size) return null;
    return { path, ownerPath, record, lockDev: lock.dev, lockIno: lock.ino, ownerDev: owner.dev, ownerIno: owner.ino, ownerSize: owner.size, mtimeMs: owner.mtimeMs };
  } catch { return null; }
}

function sameOwner(left, right) {
  return left.record.token === right.record.token
    && left.record.pid === right.record.pid
    && left.record.processInstance === right.record.processInstance
    && left.lockDev === right.lockDev && left.lockIno === right.lockIno
    && left.ownerDev === right.ownerDev && left.ownerIno === right.ownerIno
    && left.ownerSize === right.ownerSize;
}

function readIncompleteOwner(path) {
  try {
    const lock = lstatSync(path);
    if (!lock.isDirectory()) return null;
    const entries = readdirSync(path);
    if (entries.length === 0) return { path, ownerPath: null, pid: null, mtimeMs: lock.mtimeMs };
    if (entries.length !== 1) return null;
    const pid = parseOwnerName(entries[0]);
    if (!pid) return null;
    const ownerPath = join(path, entries[0]);
    const owner = lstatSync(ownerPath);
    return owner.isFile() ? { path, ownerPath, pid, mtimeMs: owner.mtimeMs } : null;
  } catch { return null; }
}

/** The current executable at the recorded PID, identity unverified; null if unreadable within a second. */
function processImage(pid) {
  try {
    // This module also runs in the Node npm/pnpm launcher, before Bun is available.
    // Without a kernel-backed system-directory resolver, omit the optional Windows
    // image label rather than searching the caller's directory/PATH or trusting env roots.
    // PID, liveness, age and lease ownership decisions do not depend on this label.
    if (process.platform === "win32") return null;
    const listed = spawnSync("ps", ["-o", "comm=", "-p", String(pid)], { encoding: "utf8", timeout: 1_000 });
    const command = (listed.stdout ?? "").trim();
    return listed.status === 0 && command ? basename(command) : null;
  } catch { return null; }
}

/**
 * The recorded owner of the lease directory at `path`, read as stale recovery reads it, or null
 * when no lock directory exists. `pid` is null when the directory has no parseable owner; `age`
 * uses the same clock as reclamation (the later of the record's creation and its file mtime).
 * Liveness and image describe the current process at the recorded PID; its identity is not verified.
 */
function leaseHolder(path, now, alive, image) {
  if (!existsSync(path)) return null;
  const observed = readOwner(path);
  const incomplete = observed ? null : readIncompleteOwner(path);
  // Neither reader matched: the holder may have released between these reads. Report a free
  // lease then, not an unreadable one.
  if (!observed && !incomplete && !existsSync(path)) return null;
  const pid = observed?.record.pid ?? incomplete?.pid ?? null;
  const since = observed ? Math.max(observed.record.createdAt, observed.mtimeMs) : incomplete?.mtimeMs ?? null;
  const live = pid === null ? null : alive(pid);
  return {
    path,
    pid,
    alive: live,
    image: live ? image(pid) : null,
    ageMs: since === null ? null : Math.max(0, now() - since),
    record: observed ? "complete" : incomplete?.ownerPath ? "incomplete" : incomplete ? "empty" : "unreadable",
  };
}

function describeHolder(holder) {
  const age = holder.ageMs === null ? "" : `, lease age ${Math.round(holder.ageMs / 1_000)}s`;
  if (holder.record === "unreadable") return "holder unknown: the lock directory does not hold exactly one owner file";
  if (holder.record === "empty") return `no owner file written yet${age}`;
  const state = holder.alive ? ["alive", ...(holder.image ? [holder.image] : [])].join(", ") : "not alive";
  const partial = holder.record === "incomplete" ? ", owner record incomplete" : "";
  return `recorded PID ${holder.pid} [${state}, identity unverified${partial}]${age}`;
}

const RECLAIM_HINT = `stale leases are reclaimed after ${STALE_MS / 1_000}s once the recorded PID is no longer alive`;

/** The recorded lease owner for `statePaths`, identity unverified, or null if free. Reads only; never reclaims. */
export function inspectOwnershipMutationLease(statePaths, options = {}) {
  return leaseHolder(leasePath(statePaths), options.now ?? Date.now, options.processAlive ?? processAlive,
    options.processImage ?? processImage);
}

/** One status line naming the recorded PID, identity unverified, or null when the lease is free. */
export function ownershipMutationLeaseStatusLine(statePaths, options = {}) {
  const holder = inspectOwnershipMutationLease(statePaths, options);
  if (!holder) return null;
  return `Runtime mutation lease busy at ${holder.path} (${describeHolder(holder)}); `
    + `opencodex waits for it to start or change service state, and ${RECLAIM_HINT}.`;
}

function reclaim(path, now, alive) {
  const observed = readOwner(path);
  const incomplete = observed ? null : readIncompleteOwner(path);
  if (!observed && !incomplete) return false;
  const createdAt = observed ? Math.max(observed.record.createdAt, observed.mtimeMs) : incomplete.mtimeMs;
  const pid = observed?.record.pid ?? incomplete.pid;
  if (now() - createdAt <= STALE_MS || (pid !== null && alive(pid))) return false;
  if (observed) {
    const current = readOwner(path);
    if (!current || !sameOwner(observed, current)) return false;
  }
  try {
    const ownerPath = observed?.ownerPath ?? incomplete.ownerPath;
    if (ownerPath) unlinkSync(ownerPath);
    rmdirSync(path);
    return true;
  } catch { return false; }
}

export function acquireOwnershipMutationLease(
  statePaths,
  options = {},
) {
  const path = leasePath(statePaths);
  const nested = held.get(path);
  if (nested) {
    nested.depth += 1;
    return { token: nested.snapshot.record.token, release: () => release(path, options) };
  }
  const now = options.now ?? Date.now;
  const alive = options.processAlive ?? processAlive;
  const explicitJoinToken = options.joinToken;
  const envJoinToken = process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
  const joinToken = explicitJoinToken ?? envJoinToken ?? delegatedTokens.get(path);
  if (joinToken) {
    const owner = readOwner(path);
    if (owner?.record.token === joinToken && alive(owner.record.pid)) {
      delegatedTokens.set(path, joinToken);
      if (envJoinToken === joinToken) delete process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
      held.set(path, { depth: 1, snapshot: owner, delegated: true });
      return { token: joinToken, release: () => release(path, options) };
    }
    delegatedTokens.delete(path);
    if (envJoinToken === joinToken) delete process.env[OWNERSHIP_MUTATION_LEASE_TOKEN_ENV];
    if (explicitJoinToken) throw new Error("ownership mutation lease delegation is invalid or no longer live");
  }
  const wait = options.waitMs ?? WAIT_MS;
  const deadline = now() + wait;
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (;;) {
    const record = { version: 1, pid: process.pid, processInstance: PROCESS_INSTANCE, token: randomUUID(), createdAt: now() };
    const ownerPath = join(path, ownerName(record));
    let madeDirectory = false;
    let descriptor = null;
    try {
      mkdirSync(path, { mode: 0o700 });
      madeDirectory = true;
      descriptor = openSync(ownerPath, "wx", 0o600);
      writeFileSync(descriptor, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = null;
      const snapshot = readOwner(path);
      if (!snapshot || snapshot.record.token !== record.token) throw new Error("ownership mutation lease could not be verified");
      held.set(path, { depth: 1, snapshot, delegated: false });
      return { token: record.token, release: () => release(path, options) };
    } catch (error) {
      if (descriptor !== null) { try { closeSync(descriptor); } catch { /* stale recovery owns uncertain cleanup */ } }
      if (madeDirectory) {
        try { unlinkSync(ownerPath); } catch { /* partial owner is recovered after dead-PID proof */ }
        try { rmdirSync(path); } catch { /* owner entry or successor keeps the directory live */ }
      }
      if (error?.code !== "EEXIST") throw error;
      if (reclaim(path, now, alive)) continue;
      if (now() >= deadline) {
        const holder = leaseHolder(path, now, alive, options.processImage ?? processImage);
        const error = new Error(`another process owns the runtime mutation lease at ${path}`
          + (holder ? ` (${describeHolder(holder)}; ${RECLAIM_HINT})` : ""));
        error.code = "OWNERSHIP_MUTATION_LEASE_BUSY";
        error.holder = holder;
        throw error;
      }
      (options.sleep ?? sleep)(POLL_MS);
    }
  }
}

function release(path, options) {
  const currentHeld = held.get(path);
  if (!currentHeld) return;
  currentHeld.depth -= 1;
  if (currentHeld.depth > 0) return;
  held.delete(path);
  if (currentHeld.delegated) return;
  options.beforeRelease?.(path);
  try {
    const current = readOwner(path);
    if (!current || !sameOwner(currentHeld.snapshot, current)) return;
    unlinkSync(currentHeld.snapshot.ownerPath);
    rmdirSync(path);
  } catch { /* token-specific stale recovery handles an uncertain release */ }
}

export function withOwnershipMutationLease(statePaths, run, options = {}) {
  const lease = acquireOwnershipMutationLease(statePaths, options);
  try { return run(); }
  finally { lease.release(); }
}
