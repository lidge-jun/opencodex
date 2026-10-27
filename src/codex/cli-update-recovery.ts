import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config/paths";
import { assertTrustedCodexCliAncestry } from "./cli-update-paths";

interface RecoveryRecord {
  version: 1; token: string; parentPid: number;
  phase: "armed" | "child" | "terminal"; pgid: number | null;
}
/** ESRCH on the entire owned group is proof; EPERM and PID-only death are not. */
export function codexCliUpdateGroupGone(pgid: number): boolean {
  if (process.platform === "win32" || !Number.isSafeInteger(pgid) || pgid <= 0) return false;
  try { process.kill(-pgid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function processGone(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function syncDirectory(dir: string): void {
  const fd = openSync(dir, constants.O_RDONLY);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function directory(configDir: string, create: boolean): string {
  assertTrustedCodexCliAncestry(configDir);
  const dir = join(configDir, "codex-cli-update-recovery");
  if (create) {
    try { mkdirSync(dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.geteuid?.()
    || (stat.mode & 0o077) !== 0 || realpathSync.native(dir) !== dir) throw new Error("unsafe_recovery_store");
  // Persist the store's directory entry too, including a concurrent creator.
  if (create) syncDirectory(configDir);
  return dir;
}
function read(dir: string, token: string, suffix = ".json"): RecoveryRecord {
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new Error("invalid_recovery_owner");
  const path = join(dir, token + suffix);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), lexical = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 || stat.nlink !== 1 || stat.uid !== process.geteuid?.()
      || (stat.mode & 0o077) !== 0 || lexical.isSymbolicLink() || lexical.dev !== stat.dev || lexical.ino !== stat.ino) {
      throw new Error("unsafe_recovery_store");
    }
    const record = JSON.parse(readFileSync(fd, "utf8")) as RecoveryRecord;
    if (record.version !== 1 || record.token !== token || !Number.isSafeInteger(record.parentPid) || record.parentPid <= 0
      || !["armed", "child", "terminal"].includes(record.phase)
      || (record.pgid !== null && (!Number.isSafeInteger(record.pgid) || record.pgid <= 0))) throw new Error("invalid_recovery_owner");
    return record;
  } finally { closeSync(fd); }
}
function pending(path: string): number {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd), lexical = lstatSync(path);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0
      || lexical.isSymbolicLink() || lexical.dev !== stat.dev || lexical.ino !== stat.ino) throw new Error("unsafe_recovery_store");
    ftruncateSync(fd, 0); return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function write(dir: string, record: RecoveryRecord): void {
  const temp = join(dir, record.token + ".pending");
  const fd = pending(temp);
  try { writeFileSync(fd, JSON.stringify(record)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temp, join(dir, record.token + ".json"));
  syncDirectory(dir);
}
/** Written before COMMITTED; a crash in the spawn/publication gap stays armed. */
export function createCodexCliUpdateRecovery(token: string, configDir = getConfigDir()) {
  let dir: string | undefined;
  let record: RecoveryRecord = { version: 1, token, parentPid: process.pid, phase: "armed", pgid: null };
  return {
    arm() {
      dir ??= directory(configDir, true);
      try {
        if (read(dir, token, ".terminal").phase !== "terminal") throw new Error("invalid_recovery_owner");
        return; // Parent recovery already ended this exact token.
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      record = { ...record, phase: "armed", pgid: null }; write(dir, record);
    },
    child(pgid: number) { if (dir) { record = { ...record, phase: "child", pgid }; write(dir, record); } },
    terminal() { if (dir) { record = { ...record, phase: "terminal", pgid: null }; write(dir, record); } },
  };
}
/** Parent recovery owns this exact run token, never another generation's record. */
export function finishClosedCodexCliUpdateRecovery(token: string, configDir = getConfigDir()): void {
  const dir = directory(configDir, true);
  // An independent terminal marker cannot be overwritten by an interrupted
  // worker finishing its old armed-record rename after the close notification.
  const marker = join(dir, token + ".terminal");
  const temp = join(dir, token + ".terminal.pending");
  const fd = pending(temp);
  try { writeFileSync(fd, JSON.stringify({ version: 1, token, parentPid: process.pid, phase: "terminal", pgid: null })); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, marker);
  syncDirectory(dir);
}
/** No mutation on a read. Old ambiguous job receipts remain ambiguous after recovery. */
export function codexCliUpdateRecoveryBlocksAdmission(configDir = getConfigDir()): boolean {
  if (process.platform === "win32") return false; // POSIX apply only
  // Ordinary callers can use a home alias without any updater history. Probe
  // lexically first: a dangling store link is existing, unsafe evidence too.
  try { lstatSync(join(configDir, "codex-cli-update-recovery")); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  try {
    // Resolve only the supported home alias, never a linked recovery store.
    // Mutation eligibility still requires the original canonical ancestry.
    const dir = directory(realpathSync.native(configDir), false);
    const files = readdirSync(dir);
    if (new Set(files.map(file => file.slice(0, 36))).size > 256) return true;
    const terminal = new Set<string>();
    const active = new Map<string, RecoveryRecord>();
    for (const file of files.filter(file => file.endsWith(".terminal"))) {
      const record = read(dir, file.slice(0, -9), ".terminal");
      if (record.phase !== "terminal") return true;
      terminal.add(record.token);
    }
    for (const file of files.filter(file => file.endsWith(".json"))) {
      if (terminal.has(file.slice(0, -5))) continue;
      const record = read(dir, file.slice(0, -5));
      if (record.phase === "terminal") { terminal.add(record.token); continue; }
      active.set(record.token, record);
    }
    const reconciled = new Map<string, RecoveryRecord>();
    for (const file of files.filter(file => !file.endsWith(".json") && !file.endsWith(".terminal"))) {
      const partial = /^([0-9a-f-]{36})(?:\.(?:terminal|[0-9a-f-]{36}))?\.pending$/.exec(file);
      if (!partial) return true;
      const token = partial[1]!;
      if (terminal.has(token)) continue; // Published terminal authority shadows late writes.
      const suffix = file.slice(token.length);
      if (suffix !== ".pending" && suffix !== ".terminal.pending") return true;
      const record = read(dir, token, suffix);
      const previous = active.get(token) ?? reconciled.get(token);
      // A complete cleanup write can survive a crash before rename. Recognize
      // only this owner's terminal evidence, with fresh lifetime proofs. Never
      // infer completion from an armed/potential verifier publication.
      if (record.phase !== "terminal" || record.pgid !== null || !processGone(record.parentPid)
        || (previous && previous.parentPid !== record.parentPid)) return true;
      if (previous?.phase === "child"
        && (previous.pgid === null || !codexCliUpdateGroupGone(previous.pgid))) return true;
      reconciled.set(token, record);
    }
    for (const record of active.values()) {
      if (reconciled.has(record.token)) continue;
      // Re-probe on every admission attempt, including after a restart. A live
      // or inaccessible group stays fenced until the whole group proves absent.
      if (record.phase === "child" && record.pgid !== null
        && processGone(record.parentPid) && codexCliUpdateGroupGone(record.pgid)) continue;
      return true;
    }
    return false;
  } catch { return true; } // Existing evidence that disappears/is unreadable stays fenced.
}
