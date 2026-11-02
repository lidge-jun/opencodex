import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { acquireOwnershipMutationLease, inspectOwnershipMutationLease, ownershipMutationLeasePath } from "../service/ownership-mutation-lease.mjs";
import { serviceStateFilesFor } from "../service/install-state-contract.mjs";
import { homedir } from "node:os";
import { assertNotRealHomeUnderTest, isTestHomeGuardArmed } from "./test-home-guard.mjs";


function paths(home) { return [join(home, "sync-update")]; }
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
    const lease = acquireOwnershipMutationLease(paths(home), { ...deps, waitMs: 0, isolated: true, holderKind: kind, processImage: () => null, lockPath: mutexPath(home) });
    return { kind: "acquired", release: () => lease.release() };
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
    const lock = mutexPath(home);
    try { lstatSync(lock); } catch (error) {
      return error?.code === "ENOENT" ? "free" : "unknown";
    }
    return holderKind(inspectOwnershipMutationLease(paths(home), { processImage: () => null, lockPath: lock }));
  } catch { return "unknown"; }
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

export function inspectUpdateMarker(home) {
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
    if (["installed", "failed", "refused"].includes(marker.phase)) return "free";
    if (!["preflight", "mutating", "overrun"].includes(marker.phase)) return "unknown";
    try { process.kill(Number(marker.pid), 0); return "active"; }
    catch (error) { return error?.code === "ESRCH" ? "free" : "unknown"; }
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
