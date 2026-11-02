import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { acquireOwnershipMutationLease, inspectOwnershipMutationLease, ownershipMutationLeasePath } from "../service/ownership-mutation-lease.mjs";
import { serviceStateFilesFor } from "../service/install-state-contract.mjs";
import { homedir } from "node:os";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed } from "./test-home-guard.mjs";


function paths(home) { return [join(home, "sync-update")]; }
function ensureHome(home) {
  try { lstatSync(home); return; } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const parent = dirname(home);
  if (parent === home) throw new Error("missing home authority");
  ensureHome(parent);
  try { mkdirSync(home, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  const stat = lstatSync(home);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("home creation was replaced");
}
function missingHome(home) {
  let current = home;
  for (;;) {
    try { lstatSync(current); realpathSync.native(current); return current !== home; }
    catch (error) {
      if (error?.code !== "ENOENT") throw error;
      // A dangling symlink is not evidence that the home is absent.
      try { lstatSync(current); throw new Error("unresolved home authority"); }
      catch (again) { if (again?.code !== "ENOENT") throw again; }
      const parent = dirname(current);
      if (parent === current) throw new Error("missing home authority");
      current = parent;
    }
  }
}
function mutexPath(home) {
  const canonicalHome = realpathSync.native(home);
  try { lstatSync(join(canonicalHome, "sync-update")); throw new Error("mutex authority path is occupied"); }
  catch (error) { if (error?.code !== "ENOENT") throw error; }
  return join(canonicalHome, "sync-update.mutation.lock");
}
function holderKind(holder) {
  return holder?.alive === true && (holder.holderKind === "sync" || holder.holderKind === "update")
    ? holder.holderKind : "unknown";
}

/** Non-blocking and never joins the separate service-ownership lease. */
export function tryAcquireUpdateSyncMutex(home, kind, deps = {}) {
  assertNotRealHomeUnderTest(home);
  try {
    ensureHome(home);
    const lease = acquireOwnershipMutationLease(paths(home), { ...deps, waitMs: 0, isolated: true, holderKind: kind, processImage: () => null, lockPath: mutexPath(home) });
    return { kind: "acquired", addDelegate: pid => lease.addDelegate(pid), release: () => lease.release() };
  } catch (error) {
    if (error && typeof error === "object" && "holder" in error) {
      return { kind: "busy", holder: holderKind(error.holder) };
    }
    return { kind: "busy", holder: "unknown" };
  }
}

/** Read only: absence is accepted only after an explicit filesystem absence check. */
export function inspectUpdateSyncMutex(home) {
  assertNotRealHomeUnderTest(home);
  try {
    if (missingHome(home)) return "free";
    const lock = mutexPath(home);
    try { lstatSync(lock); } catch (error) {
      return error?.code === "ENOENT" ? "free" : "unknown";
    }
    return holderKind(inspectOwnershipMutationLease(paths(home), { processImage: () => null, lockPath: lock }));
  } catch { return "unknown"; }
}

/** A delegated child may reuse only its live parent's sync lease. */
export function parentHoldsSyncMutex(home, claimedPid = process.env.OCX_SYNC_MUTEX_HELD_BY) {
  if (!claimedPid) return false;
  try {
    const holder = inspectOwnershipMutationLease(paths(home), { processImage: () => null, lockPath: mutexPath(home) });
    return holder?.alive === true && holder.record === "complete" && holder.holderKind === "sync" && String(holder.pid) === claimedPid && holder.delegatePid === process.pid;
  } catch { return false; }
}

/** Shared wire format for launcher and Bun sync admission refusals. */
export function refuseSync(reason, args) {
  const exit = reason === "sync-in-progress" ? 1 : 7;
  console.error(reason);
  if (args.includes("--json")) console.log(JSON.stringify({ schema: "ocx.sync.fanout/1", home: { state: "skipped", exit }, fanout: { state: "not-applicable", reason }, children: [] }));
  return exit;
}

export function acquireSyncGuard(home, args) {
  const lease = tryAcquireUpdateSyncMutex(home, "sync");
  if (lease.kind !== "acquired") return { kind: "refused", exit: refuseSync(lease.holder === "sync" ? "sync-in-progress" : "update-in-flight", args) };
  if (inspectUpdateMarker(home) !== "free") {
    lease.release();
    return { kind: "refused", exit: refuseSync("update-in-flight", args) };
  }
  return lease;
}

function inspectOwnershipLease(home) {
  try {
    const statePaths = serviceStateFilesFor(home, isTestHomeGuardArmed() ? home : join(homedir(), ".opencodex"));
    const path = ownershipMutationLeasePath(statePaths);
    try { lstatSync(path); } catch (error) {
      return error?.code === "ENOENT" ? "free" : "unknown";
    }
    const holder = inspectOwnershipMutationLease(statePaths, { processImage: () => null });
    return holder?.alive === true ? "active" : holder?.alive === false ? "free" : "unknown";
  } catch { return "unknown"; }
}

export function inspectUpdateMarker(home, { now = Date.now } = {}) {
  const path = join(home, "update-orchestrated.json");
  let found = false;
  let fd;
  try {
    const before = lstatSync(path);
    found = true;
    if (!before.isFile() || before.size > 4096) return "unknown";
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) return "unknown";
    const buffer = Buffer.alloc(4097);
    const count = readSync(fd, buffer, 0, buffer.length, 0);
    if (count > 4096 || count !== opened.size) return "unknown";
    const raw = buffer.subarray(0, count).toString("utf8");
    const after = lstatSync(path);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) return "unknown";
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object") return "unknown";
    const marker = value;
    if (!Number.isSafeInteger(marker.pid) || Number(marker.pid) <= 0 || typeof marker.phase !== "string"
      || !Number.isSafeInteger(marker.startedAt) || Number(marker.startedAt) <= 0) return "unknown";
    const terminal = ["installed", "failed", "refused"].includes(marker.phase);
    if (!terminal && !["preflight", "mutating", "overrun"].includes(marker.phase)) return "unknown";
    if (marker.terminationUnconfirmed !== undefined && marker.terminationUnconfirmed !== true) return "unknown";
    if (marker.fenceUntil !== undefined && (!Number.isSafeInteger(marker.fenceUntil) || marker.fenceUntil < marker.startedAt)) return "unknown";
    if (marker.fenceUntil !== undefined && now() < marker.fenceUntil) return "active";
    const ids = [];
    if (!terminal) ids.push(marker.pid);
    for (const key of ["installerPid", "installerPgid"]) {
      if (marker[key] === undefined) continue;
      if (!Number.isSafeInteger(marker[key]) || marker[key] <= 0 || (key === "installerPgid" && process.platform === "win32")) return "unknown";
      ids.push(key === "installerPgid" ? -marker[key] : marker[key]);
    }
    let unknown = false;
    for (const id of ids) {
      try { process.kill(id, 0); return "active"; }
      catch (error) { if (error?.code !== "ESRCH") unknown = true; }
    }
    return unknown || (marker.terminationUnconfirmed && marker.installerPgid === undefined) ? "unknown" : "free";
  } catch (error) { return !found && error?.code === "ENOENT" ? "free" : "unknown"; }
  finally { if (fd !== undefined) closeSync(fd); }
}

/** False requires positive absence of an update across all three read-only observations. */
export function isUpdateInFlight(home, deps = { mutex: inspectUpdateSyncMutex, ownershipLease: inspectOwnershipLease, marker: inspectUpdateMarker }) {
  try {
    const mutex = deps.mutex(home);
    if (mutex !== "free" && mutex !== "sync") return true;
    return deps.ownershipLease(home) !== "free" || deps.marker(home) !== "free";
  } catch { return true; }
}
