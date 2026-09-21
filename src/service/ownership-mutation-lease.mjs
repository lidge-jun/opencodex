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
      if (now() >= deadline) throw new Error(`another process owns the runtime mutation lease at ${path}`);
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
