import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync } from "node:fs";
import { dirname, join, posix, win32 } from "node:path";
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
export function refuseSync(reason, args, hint = []) {
  const exit = reason === "sync-in-progress" ? 1 : 7;
  console.error(reason);
  // Recovery guidance follows the reason line on stderr; stdout and the JSON document never change.
  for (const line of hint) console.error(line);
  if (args.includes("--json")) console.log(JSON.stringify({ schema: "ocx.sync.fanout/1", home: { state: "skipped", exit }, fanout: { state: "not-applicable", reason }, children: [] }));
  return exit;
}

export function acquireSyncGuard(home, args) {
  const lease = tryAcquireUpdateSyncMutex(home, "sync");
  if (lease.kind !== "acquired") return { kind: "refused", exit: refuseSync(lease.holder === "sync" ? "sync-in-progress" : "update-in-flight", args) };
  const detail = {};
  if (inspectUpdateMarker(home, { detail }) !== "free") {
    lease.release();
    return { kind: "refused", exit: refuseSync("update-in-flight", args, detail.witnessless ? staleUpdateMarkerHint(home) : []) };
  }
  return lease;
}

/**
 * Recovery guidance for a marker that records an interrupted installer with no witness (#8524).
 * OpenCodex 2.100.x and earlier never recorded the Windows installer supervisor, so such a marker
 * never clears by itself. Formatting only: the witnessless fact comes from the refusing inspection.
 */
export function staleUpdateMarkerHint(home, platform = process.platform) {
  const windows = platform === "win32";
  // Formatted for the platform the hint names, so the separator matches its rename command.
  const path = (windows ? win32 : posix).join(home, "update-orchestrated.json");
  // A copy-paste command must not expand anything from the path. POSIX single quotes expand
  // nothing. cmd.exe and PowerShell disagree on quoting (PowerShell also closes a string on
  // typographic quotes and globs [ ]), so Windows gets a command only for plain printable ASCII
  // without $ ` % " ! [ ]. A path with a control character gets no command on any platform.
  const controlFree = !/[\x00-\x1f\x7f-\x9f]/.test(path);
  const rename = !controlFree ? null : windows
    ? (/^[\x20-\x7e]+$/.test(path) && !/[$`%"![\]]/.test(path) ? `ren "${path}" update-orchestrated.json.stale` : null)
    : `mv -n ${posixQuote(path)} ${posixQuote(path + ".stale")}`;
  const shown = path.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  return [
    `The update marker ${shown} records an interrupted update whose installer can no longer be checked`,
    windows
      ? "(OpenCodex 2.100.x and earlier did not record the Windows installer), so it will not clear by itself."
      : "(its installer was never recorded), so it will not clear by itself.",
    "If no update is running (no ocx update, no npm, pnpm or bun global install, no OpenCodex installer",
    "PowerShell process running npm-install-job.ps1), rename the marker and run ocx update again:",
    rename === null ? "  rename that file by hand, for example to update-orchestrated.json.stale" : `  ${rename}`,
  ];
}

function posixQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

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

export function inspectUpdateMarker(home, { now = Date.now, platform = process.platform, signal, detail } = {}) {
  const probe = signal ?? (id => process.kill(id, 0));
  const windows = platform === "win32";
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
      if (!Number.isSafeInteger(marker[key]) || marker[key] <= 0 || (key === "installerPgid" && windows)) return "unknown";
      // A recorded installer pid is probed whenever present, on every platform: a live installer
      // keeps the marker fenced. On Windows confirmInstallerExit drops the supervisor pid, so a
      // finished update leaves none to be held by a reused pid (#8524).
      ids.push(key === "installerPgid" ? -marker[key] : marker[key]);
    }
    let unknown = false;
    for (const id of ids) {
      try { probe(id); return "active"; }
      catch (error) { if (error?.code !== "ESRCH") unknown = true; }
    }
    // An unconfirmed installer is free only once its process-tree witness is gone: the POSIX group,
    // or on Windows the supervisor whose exit closes the kill-on-close job.
    const witness = windows ? marker.installerPid : marker.installerPgid;
    if (unknown) return "unknown";
    if (marker.terminationUnconfirmed && witness === undefined) {
      // Unknown only because nothing witnesses the installer: the fence has passed and every
      // recorded process is gone. The refusal can then name the marker and its manual recovery.
      if (detail) detail.witnessless = true;
      return "unknown";
    }
    return "free";
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
