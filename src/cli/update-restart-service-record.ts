import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, join } from "node:path";
import { plistPath, resolveServiceOwnership, resolveServiceState, serviceStatePaths, type ServiceStateEvidence } from "../service/state";
import { unitPath } from "../service/systemd";
import { inspectInstallStateBytes } from "../service/install-state-contract.mjs";

export interface UpdateRestartServiceRecord { schema: 1; digest: string }
export interface UpdateRestartServiceRecordDeps {
  platform?: NodeJS.Platform;
  paths?: () => readonly string[];
  definitionPath?: () => string;
  open?: (path: string, flags: number) => number;
  fstat?: (fd: number) => BigIntStats;
  read?: (fd: number, buffer: Buffer, offset: number, length: number, position: number) => number;
  lstat?: (path: string) => BigIntStats;
}
/** Maximum bytes per state candidate or platform definition: 1 MiB, including growth during read. */
export const UPDATE_RESTART_SERVICE_RECORD_MAX_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const FAILURE = "update_restart_service_record_unverified";
const hash = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const metadata = (stat: BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.mode, stat.uid, stat.gid].map(String);
const absent = (error: unknown) => !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";

// Canonicalize directories, never the record itself: a record symlink is a refusal.
function canonicalPath(path: string): string {
  const parent = dirname(path);
  try { return join(realpathSync.native(parent), basename(path)); }
  catch (error) {
    if (!absent(error) || parent === path) throw new Error(FAILURE);
    return join(canonicalPath(parent), basename(path));
  }
}

function readBoundedRecord(fd: number, read: NonNullable<UpdateRestartServiceRecordDeps["read"]>): Buffer {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    // At the limit, a one-byte read distinguishes EOF from concurrent growth.
    const length = Math.min(chunk.length, UPDATE_RESTART_SERVICE_RECORD_MAX_BYTES - total + 1);
    const count = read(fd, chunk, 0, length, total);
    if (!Number.isInteger(count) || count < 0 || count > length) throw new Error(FAILURE);
    if (count === 0) return Buffer.concat(chunks, total);
    total += count;
    if (total > UPDATE_RESTART_SERVICE_RECORD_MAX_BYTES) throw new Error(FAILURE);
    chunks.push(Buffer.from(chunk.subarray(0, count)));
  }
}

/** Read all authority/mirror candidates and the platform definition as one frozen record. */
export function captureUpdateRestartServiceRecord(deps: UpdateRestartServiceRecordDeps = {}) {
  try {
    const platform = deps.platform ?? process.platform;
    const paths = (deps.paths ?? serviceStatePaths)();
    const definition = platform === "darwin" ? (deps.definitionPath ?? plistPath)()
      : platform === "linux" ? (deps.definitionPath ?? unitPath)() : undefined;
    const statPath = deps.lstat ?? (path => lstatSync(path, { bigint: true }));
    const captures = [...paths, ...(definition ? [definition] : [])].map((path, index) => {
      const canonical = canonicalPath(path);
      let before: BigIntStats;
      try { before = statPath(path); }
      catch (error) {
        if (!absent(error)) throw error;
        return { path, canonical, index, identity: null, bytes: undefined };
      }
      if (!before.isFile() || before.isSymbolicLink()) throw new Error(FAILURE);
      const fd = (deps.open ?? openSync)(path, constants.O_RDONLY | (platform === "win32" ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
      try {
        const statFd = deps.fstat ?? (handle => fstatSync(handle, { bigint: true }));
        const opened = statFd(fd);
        const identity = metadata(before);
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
          || opened.size < 0n || opened.size > BigInt(UPDATE_RESTART_SERVICE_RECORD_MAX_BYTES)
          || JSON.stringify(identity) !== JSON.stringify(metadata(opened))) throw new Error(FAILURE);
        const bytes = readBoundedRecord(fd, deps.read ?? readSync);
        const after = statFd(fd);
        if (!after.isFile() || JSON.stringify(identity) !== JSON.stringify(metadata(after))
          || BigInt(bytes.length) !== after.size) throw new Error(FAILURE);
        return { path, canonical, index, identity, bytes };
      } finally { closeSync(fd); }
    });
    // Pin path-to-descriptor identity after every read; also confirm each ENOENT again.
    for (const entry of captures) {
      let current: BigIntStats;
      try { current = statPath(entry.path); }
      catch (error) { if (entry.identity === null && absent(error)) continue; throw error; }
      if (!current.isFile() || JSON.stringify(metadata(current)) !== JSON.stringify(entry.identity)
        || canonicalPath(entry.path) !== entry.canonical) throw new Error(FAILURE);
    }
    const evidence: ServiceStateEvidence[] = captures.slice(0, paths.length).map(entry => {
      if (!entry.bytes) return { path: entry.canonical, kind: "absent" };
      const parsed = inspectInstallStateBytes(entry.canonical, () => entry.bytes!.toString("utf8"));
      if (parsed.kind !== "valid") throw new Error(FAILURE);
      return parsed as ServiceStateEvidence;
    });
    const state = resolveServiceState(evidence);
    const owner = resolveServiceOwnership(evidence);
    if (state.kind === "unknown" || owner.kind === "unknown") throw new Error(FAILURE);
    const serviceRecord: UpdateRestartServiceRecord = { schema: 1, digest: hash(JSON.stringify({
      platform, authority: paths.length - 1,
      records: captures.map(entry => [entry.canonical, entry.index, entry.identity, entry.bytes ? hash(entry.bytes) : null]),
    })) };
    return { serviceRecord, state, owner };
  } catch { throw new Error(FAILURE); }
}

/** Drift is terminal; never replace the transaction's original digest. */
export function assertUpdateRestartServiceRecord(expected: UpdateRestartServiceRecord, deps: UpdateRestartServiceRecordDeps = {}) {
  try {
    const current = captureUpdateRestartServiceRecord(deps);
    if (expected.schema !== 1 || current.serviceRecord.digest !== expected.digest) throw new Error(FAILURE);
    return current;
  } catch { throw new Error("update_restart_home_changed"); }
}
