import { randomBytes, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";
import { inspectUpdateMarker, tryAcquireUpdateSyncMutex } from "./sync-update-mutex.mjs";
import { assertNotRealHomeUnderTest } from "./test-home-guard.mjs";

function atomicJson(path, value) {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let created = false;
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    created = true;
    renameSync(temp, path);
    created = false;
  } finally {
    if (created) { try { unlinkSync(temp); } catch { /* preserve the original write error */ } }
  }
}

// Result handoff. The child writes only into a single-link, non-symlink regular file whose entire
// content equals the capability document for the token it was given, and only through the
// descriptor it validated; the parent reads and removes only the file and directory it recorded.
const CAPABILITY = /^[A-Za-z0-9_-]{43}$/;
// Outcome records are a few hundred bytes; anything larger is not a record this channel published.
const MAX_RESULT_BYTES = 65536;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const capabilityDocument = token => JSON.stringify({ ocxUpdateResultCapability: token });
// BigInt stats: NTFS/ReFS file ids can exceed Number.MAX_SAFE_INTEGER, and two ids must never round to equal.
const EXACT = { bigint: true };
const sameIdentity = (a, b) => a.dev === b.dev && a.ino === b.ino;
const ownerOnly = stat => process.platform === "win32" || (stat.uid === BigInt(process.getuid()) && (stat.mode & 0o077n) === 0n);
const invalidDestination = () => new Error("invalid orchestrated result destination");
/**
 * Path-based cleanup is safe only where no other principal can replace an ancestor between check and use: on POSIX
 * every ancestor is owned by this user or root and not group/other-writable, unless root-owned and sticky. Windows
 * has no cheap equivalent, so it never removes by path.
 */
function removableChannel(directory) {
  if (process.platform === "win32") return false;
  try {
    for (let entry = dirname(directory); ; entry = dirname(entry)) {
      const stat = lstatSync(entry, EXACT), uid = Number(stat.uid), mode = Number(stat.mode);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== process.getuid() && uid !== 0)
        || ((mode & 0o022) !== 0 && !(uid === 0 && (mode & 0o1000) !== 0))) return false;
      if (dirname(entry) === entry) return true;
    }
  } catch { return false; }
}
function readAll(fd, size) {
  const bytes = Buffer.alloc(size);
  let read = 0;
  while (read < size) { const count = readSync(fd, bytes, read, size - read, read); if (count === 0) break; read += count; }
  return bytes.subarray(0, read).toString("utf8");
}

/** Create a new owner-only capability file at path; returns its token and recorded identity. */
export function issueOrchestratedResultCapability(path) {
  const capability = randomBytes(32).toString("base64url");
  const fd = openSync(path, "wx", 0o600);
  try {
    const document = Buffer.from(capabilityDocument(capability), "utf8");
    for (let written = 0; written < document.length;) written += writeSync(fd, document, written, document.length - written, written);
    return { capability, identity: fstatSync(fd, EXACT) };
  } finally { closeSync(fd); }
}

/** Parent side: a fresh private directory holding one exclusive capability file for one child. */
export function createOrchestratedResultChannel() {
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "ocx-update-")));
  const resultPath = join(directory, "result.json");
  const directoryStat = lstatSync(directory, EXACT);
  const { capability, identity: fileStat } = issueOrchestratedResultCapability(resultPath);
  return {
    directory, resultPath, capability,
    /** The child's recorded outcome, or null unless the recorded file is still in place and parses. */
    read() {
      let readFd;
      try {
        const before = lstatSync(resultPath, EXACT);
        if (!before.isFile() || before.isSymbolicLink() || !sameIdentity(before, fileStat)) return null;
        readFd = openSync(resultPath, constants.O_RDONLY | NOFOLLOW);
        const opened = fstatSync(readFd, EXACT);
        if (!sameIdentity(opened, fileStat) || opened.size > BigInt(MAX_RESULT_BYTES)) return null;
        const text = readAll(readFd, Number(opened.size));
        if (text === capabilityDocument(capability)) return null;
        const value = JSON.parse(text);
        return value && typeof value === "object" && !Array.isArray(value) ? value : null;
      } catch { return null; }
      finally { if (readFd !== undefined) closeSync(readFd); }
    },
    /**
     * Remove only the recorded file, then the recorded directory if it is empty; anything else stays. Path-based
     * removal runs only on POSIX and only when no ancestor can be replaced by another principal; otherwise the
     * channel (at most this parent's own capability or result record) is left in place.
     */
    dispose() {
      if (!removableChannel(directory)) return;
      try { const current = lstatSync(resultPath, EXACT); if (current.isFile() && sameIdentity(current, fileStat)) unlinkSync(resultPath); }
      catch { /* leave whatever is there */ }
      try { const current = lstatSync(directory, EXACT); if (current.isDirectory() && sameIdentity(current, directoryStat)) rmdirSync(directory); }
      catch { /* a non-empty or replaced directory is left in place */ }
    },
  };
}

/** Child side: validate the destination through the descriptor it will keep, before any write. */
function openResultDestination(resultPath, capability) {
  if (typeof resultPath !== "string" || !isAbsolute(resultPath) || basename(resultPath) !== "result.json"
    || typeof capability !== "string" || !CAPABILITY.test(capability)) throw invalidDestination();
  let fd;
  try {
    const canonical = realpathSync.native(resultPath);
    if (process.platform === "win32" ? canonical.toLowerCase() !== resultPath.toLowerCase() : canonical !== resultPath) throw invalidDestination();
    const directory = lstatSync(dirname(resultPath), EXACT);
    if (!directory.isDirectory() || directory.isSymbolicLink() || !ownerOnly(directory)) throw invalidDestination();
    const file = lstatSync(resultPath, EXACT);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1n || !ownerOnly(file)) throw invalidDestination();
    fd = openSync(resultPath, constants.O_RDWR | NOFOLLOW);
    const opened = fstatSync(fd, EXACT);
    const expected = capabilityDocument(capability);
    // Size first: nothing is read from a file that cannot be the capability document.
    if (!sameIdentity(opened, file) || opened.size !== file.size || opened.nlink !== 1n || opened.size !== BigInt(Buffer.byteLength(expected))) throw invalidDestination();
    if (readAll(fd, Number(opened.size)) !== expected) throw invalidDestination();
    return fd;
  } catch {
    if (fd !== undefined) closeSync(fd);
    throw invalidDestination();
  }
}

/** Truncate, then write the whole record at explicit offsets: an interruption never leaves a mixed record. */
function publishResult(fd, value) {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  ftruncateSync(fd, 0);
  for (let written = 0; written < bytes.length;) written += writeSync(fd, bytes, written, bytes.length - written, written);
  fsyncSync(fd);
}

function validateExpect(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== "cliRoot,home,planToken,runtimePid,servingRoot"
    || typeof value.home !== "string" || !isAbsolute(value.home)
    || typeof value.cliRoot !== "string" || !isAbsolute(value.cliRoot)
    || (value.servingRoot !== null && (typeof value.servingRoot !== "string" || !isAbsolute(value.servingRoot)))
    || (value.runtimePid !== null && (!Number.isSafeInteger(value.runtimePid) || value.runtimePid <= 0))
    || typeof value.planToken !== "string" || !/^[A-Za-z0-9_-]{16,128}$/.test(value.planToken)) {
    throw new Error("invalid orchestrated expectation");
  }
  return value;
}
export function encodeOrchestratedExpect(value) {
  return Buffer.from(JSON.stringify(validateExpect(value)), "utf8").toString("base64url");
}
export function decodeOrchestratedExpect(encoded) {
  if (typeof encoded !== "string" || !/^[A-Za-z0-9_-]+$/.test(encoded)) throw new Error("invalid orchestrated expectation");
  const bytes = Buffer.from(encoded, "base64url");
  if (bytes.toString("base64url") !== encoded) throw new Error("invalid orchestrated expectation");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error("invalid orchestrated expectation"); }
  return validateExpect(parsed);
}

export function createOrchestratedChildSession({ home, resultPath, resultCapability, expect, notAfter, now = Date.now, pid = process.pid, verifyIdentity }) {
  if (expect !== undefined) validateExpect(expect);
  if ((expect !== undefined && expect.home !== home)
    || (notAfter !== undefined && (!Number.isSafeInteger(notAfter) || notAfter <= 0))
    || !Number.isSafeInteger(pid) || pid <= 0 || typeof now !== "function" || typeof verifyIdentity !== "function") {
    throw new Error("invalid orchestrated session options");
  }
  assertNotRealHomeUnderTest(home);
  const markerPath = join(home, "update-orchestrated.json");
  // Validated before any session write, mutex use or identity probe; every result goes through this descriptor.
  let resultFd = resultPath === undefined && resultCapability === undefined ? undefined : openResultDestination(resultPath, resultCapability);
  const result = value => { if (resultFd !== undefined) publishResult(resultFd, value); };
  const closeResult = () => { if (resultFd !== undefined) { const fd = resultFd; resultFd = undefined; closeSync(fd); } };
  let state = "new", mutex, startedAt, untrackedPending = false, retainFence = false;
  const marker = (phase, preserveInstaller = false, terminationUnconfirmed = false, retainFence = false, dropWindowsWitness = false) => {
    let installer = {};
    if (preserveInstaller) {
      const current = JSON.parse(readFileSync(markerPath, "utf8"));
      if (current.pid !== pid || current.startedAt !== startedAt) throw new Error("orchestrated marker changed");
      // A Windows supervisor pid (no POSIX group beside it) only witnesses an unconfirmed installer;
      // once its exit is confirmed it is dropped so a later run in this session can record its own.
      if (current.installerPid !== undefined && !(dropWindowsWitness && current.installerPgid === undefined)) {
        installer.installerPid = current.installerPid;
      }
      if (current.installerPgid !== undefined) installer.installerPgid = current.installerPgid;
    }
    atomicJson(markerPath, { pid, phase, startedAt, ...installer,
      ...((phase === "mutating" || retainFence) ? { fenceUntil: startedAt + 900000 } : {}),
      ...(terminationUnconfirmed ? { terminationUnconfirmed: true } : {}) });
  };
  return {
    start() {
      if (state !== "new") throw new Error("orchestrated session already started");
      result({ phase: "preflight" });
      const acquired = tryAcquireUpdateSyncMutex(home, "update");
      if (acquired.kind === "busy") {
        const error = acquired.holder === "sync" ? "sync-in-progress" : "update-in-flight";
        result({ phase: "refused", error }); state = "refused"; closeResult();
        return { ok: false, error };
      }
      mutex = acquired;
      const detail = {};
      if (inspectUpdateMarker(home, { detail }) !== "free") {
        mutex.release(); mutex = undefined;
        result({ phase: "refused", error: "update-in-flight" }); state = "refused"; closeResult();
        // staleMarker never enters the result record; it lets the launcher print recovery guidance.
        return { ok: false, error: "update-in-flight", ...(detail.witnessless ? { staleMarker: true } : {}) };
      }
      try { startedAt = now(); marker("preflight"); }
      catch (error) { mutex.release(); mutex = undefined; throw error; }
      state = "preflight";
      return { ok: true };
    },
    finishPreflight() {
      if (state !== "preflight") return;
      marker("failed");
      mutex.release(); mutex = undefined; state = "finished"; closeResult();
    },
    async enterMutation() {
      if (state !== "preflight") throw new Error("orchestrated session is not in preflight");
      state = "entering";
      marker("mutating");
      result({ phase: "mutating" });
      let error;
      if (notAfter !== undefined && now() > notAfter) error = "deadline-passed";
      else {
        try { if (await verifyIdentity() !== true) error = "plan-changed"; }
        catch { error = "plan-changed"; }
      }
      if (!error && notAfter !== undefined && now() > notAfter) error = "deadline-passed";
      if (error) {
        marker("refused");
        result({ phase: "refused", error });
        mutex.release(); mutex = undefined; state = "refused"; closeResult();
        return { ok: false, error };
      }
      state = "mutating";
      return { ok: true };
    },
    noteUntrackedInstaller() {
      if (state !== "mutating") throw new Error("orchestrated session is not mutating");
      marker("mutating", true, true); untrackedPending = true;
    },
    confirmInstallerExit() {
      if (state !== "mutating" || !untrackedPending) throw new Error("no untracked installer");
      marker("mutating", true, false, false, true); untrackedPending = false;
    },
    retainInstallerFence() {
      if (state !== "mutating") throw new Error("orchestrated session is not mutating");
      retainFence = true;
    },
    finish(outcome) {
      if (state !== "mutating") throw new Error("orchestrated session is not mutating");
      if (!outcome || (outcome.phase !== "installed" && outcome.phase !== "failed")) throw new Error("invalid final outcome");
      if (untrackedPending) outcome = { phase: "failed", error: "installer-termination-unconfirmed", terminationConfirmed: false };
      result(outcome);
      marker(outcome.phase, true, outcome.error === "installer-termination-unconfirmed",
        retainFence || outcome.terminationConfirmed === false || outcome.error === "installer-termination-unconfirmed" || outcome.error === "installer-timeout");
      mutex.release(); mutex = undefined; state = "finished"; closeResult();
    },
  };
}

export function createLegacyUpdateSession({ home }) {
  return createOrchestratedChildSession({ home, verifyIdentity: () => true });
}
