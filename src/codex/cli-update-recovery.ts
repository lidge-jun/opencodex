import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../config/paths";
import { assertTrustedCodexCliAncestry } from "./cli-update-paths";
import { withWindowsCliRecoveryStore } from "./cli-update-job-store-windows";
import { windowsCodexCliChildGone } from "./windows-cli-recovery";

export interface CodexCliUpdateNativeChildIdentity { jobName: string; creationTime: string }
export interface CodexCliUpdateNativeRecoveryProof { path: string; terminal: string }

interface RecoveryRecord {
  version: 1; token: string; parentPid: number;
  phase: "armed" | "child" | "terminal"; pgid: number | null;
  windows?: { jobName: string | null; creationTime: string | null };
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
  if (process.platform === "win32") return withWindowsCliRecoveryStore(configDir, create, io => io.dir);
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
  if (process.platform === "win32") {
    const record = withWindowsCliRecoveryStore(dirname(dir), false, io => JSON.parse(io.read(token + suffix))) as RecoveryRecord;
    if (!validRecord(record, token)) throw new Error("invalid_recovery_owner");
    return record;
  }
  const path = join(dir, token + suffix);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), lexical = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024 || stat.nlink !== 1 || stat.uid !== process.geteuid?.()
      || (stat.mode & 0o077) !== 0 || lexical.isSymbolicLink() || lexical.dev !== stat.dev || lexical.ino !== stat.ino) {
      throw new Error("unsafe_recovery_store");
    }
    const record = JSON.parse(readFileSync(fd, "utf8")) as RecoveryRecord;
    if (!validRecord(record, token)) throw new Error("invalid_recovery_owner");
    return record;
  } finally { closeSync(fd); }
}
function validRecord(record: RecoveryRecord, token: string): boolean {
  return !!record && record.version === 1 && record.token === token && Number.isSafeInteger(record.parentPid) && record.parentPid > 0
    && ["armed", "child", "terminal"].includes(record.phase)
    && (record.pgid === null || (Number.isSafeInteger(record.pgid) && record.pgid > 0))
    && (record.windows === undefined || (!!record.windows
      && (record.windows.jobName === null || (typeof record.windows.jobName === "string" && /^Global\\ocx-cli-[0-9a-f-]{36}$/.test(record.windows.jobName)))
      && (record.windows.creationTime === null || (typeof record.windows.creationTime === "string" && /^[1-9][0-9]{0,19}$/.test(record.windows.creationTime)))));
}
function childGone(record: RecoveryRecord, proof?: (token: string) => RecoveryRecord): boolean {
  if (record.pgid === null) return false;
  if (process.platform !== "win32") return codexCliUpdateGroupGone(record.pgid);
  if (!record.windows?.jobName || !record.windows.creationTime || !proof) return false;
  const terminal = proof(record.token);
  return terminal.phase === "terminal" && terminal.pgid === null && terminal.parentPid === record.parentPid
    && terminal.windows?.jobName === record.windows.jobName
    && windowsCodexCliChildGone(record.pgid, record.windows.creationTime, record.windows.jobName);
}
/** Called only after this generation's fence was sealed against another spawn. */
export function closedWindowsCodexCliUpdateChildGone(token: string, configDir = getConfigDir(), expectedPid?: number): boolean {
  try { const dir = directory(configDir, false), record = read(dir, token);
    return record.phase === "child" && record.pgid === expectedPid && childGone(record, token => read(dir, token, ".proof")); }
  catch { return false; }
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
  if (process.platform === "win32") {
    withWindowsCliRecoveryStore(dirname(dir), true, io => io.write(record.token + ".json", record.token + ".pending", JSON.stringify(record)));
    return;
  }
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
    arm(jobName?: string): CodexCliUpdateNativeRecoveryProof | undefined {
      dir ??= directory(configDir, true);
      try {
        if (read(dir, token, ".terminal").phase !== "terminal") throw new Error("invalid_recovery_owner");
        return; // Parent recovery already ended this exact token.
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      record = { ...record, phase: "armed", pgid: null,
        ...(process.platform === "win32" ? { windows: { jobName: jobName ?? null, creationTime: null } } : {}) }; write(dir, record);
      if (process.platform === "win32" && jobName) {
        withWindowsCliRecoveryStore(configDir, true, io => io.write(token + ".proof", token + ".proof.pending", JSON.stringify(record)));
        return { path: join(dir, token + ".proof"), terminal: JSON.stringify({ ...record, phase: "terminal" }) };
      }
    },
    child(pgid: number, identity?: CodexCliUpdateNativeChildIdentity) {
      if (dir) { record = { ...record, phase: "child", pgid, ...(identity ? { windows: identity } : {}) }; write(dir, record); }
    },
    terminal() { if (dir) { record = { ...record, phase: "terminal", pgid: null }; write(dir, record); } },
  };
}
/** Parent recovery owns this exact run token, never another generation's record. */
export function finishClosedCodexCliUpdateRecovery(token: string, configDir = getConfigDir()): void {
  const dir = directory(configDir, true);
  if (process.platform === "win32") {
    withWindowsCliRecoveryStore(configDir, true, io => io.write(token + ".terminal", token + ".terminal.pending",
      JSON.stringify({ version: 1, token, parentPid: process.pid, phase: "terminal", pgid: null })));
    return;
  }
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
/** Proven Windows pending children may publish; ambiguous job receipts stay unchanged. */
export function codexCliUpdateRecoveryBlocksAdmission(configDir = getConfigDir()): boolean {
  // Ordinary callers can use a home alias without any updater history. Probe
  // lexically first: a dangling store link is existing, unsafe evidence too.
  try { lstatSync(join(configDir, "codex-cli-update-recovery")); }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ENOENT"; }
  try {
    // Resolve only the supported home alias, never a linked recovery store.
    // Mutation eligibility still requires the original canonical ancestry.
    const canonical = realpathSync.native(configDir);
    if (process.platform === "win32") return withWindowsCliRecoveryStore(canonical, false, io =>
      inspectRecoveryFiles(io.names(), (token, suffix = ".json") => {
        const record = JSON.parse(io.read(token + suffix)) as RecoveryRecord;
        if (!validRecord(record, token)) throw new Error("invalid_recovery_owner");
        return record;
      }, record => io.write(record.token + ".json", record.token + ".pending", JSON.stringify(record), true)), true);
    const dir = directory(canonical, false);
    return inspectRecoveryFiles(readdirSync(dir), (token, suffix) => read(dir, token, suffix));
  } catch { return true; } // Existing evidence that disappears/is unreadable stays fenced.
}

function inspectRecoveryFiles(files: string[], readRecord: (token: string, suffix?: string) => RecoveryRecord,
  publishChild?: (record: RecoveryRecord) => void): boolean {
    if (new Set(files.map(file => file.slice(0, 36))).size > 256) return true;
    const terminal = new Set<string>();
    const active = new Map<string, RecoveryRecord>();
    for (const file of files.filter(file => file.endsWith(".terminal"))) {
      const record = readRecord(file.slice(0, -9), ".terminal");
      if (record.phase !== "terminal") return true;
      terminal.add(record.token);
    }
    for (const file of files.filter(file => file.endsWith(".json"))) {
      if (terminal.has(file.slice(0, -5))) continue;
      const record = readRecord(file.slice(0, -5));
      if (record.phase === "terminal") { terminal.add(record.token); continue; }
      active.set(record.token, record);
    }
    const reconciled = new Map<string, RecoveryRecord>();
    for (const file of files.filter(file => !file.endsWith(".json") && !file.endsWith(".terminal"))) {
      if (process.platform === "win32" && /^[0-9a-f-]{36}\.proof\.pending$/.test(file)) {
        if (terminal.has(file.slice(0, 36))) continue;
        return true;
      }
      if (process.platform === "win32" && /^[0-9a-f-]{36}\.proof$/.test(file)) {
        const token = file.slice(0, 36);
        if (terminal.has(token) || active.get(token)?.windows?.jobName) continue;
        return true;
      }
      const partial = /^([0-9a-f-]{36})(?:\.(?:terminal|[0-9a-f-]{36}))?\.pending$/.exec(file);
      if (!partial) return true;
      const token = partial[1]!;
      if (terminal.has(token)) continue; // Published terminal authority shadows late writes.
      const suffix = file.slice(token.length);
      if (suffix !== ".pending" && suffix !== ".terminal.pending") return true;
      const record = readRecord(token, suffix);
      const previous = active.get(token) ?? reconciled.get(token);
      if (process.platform === "win32" && suffix === ".pending" && record.phase === "child") {
        const armed = active.get(token);
        if (!publishChild || armed?.phase !== "armed" || armed.pgid !== null
          || armed.parentPid !== record.parentPid || !armed.windows?.jobName
          || armed.windows.creationTime !== null || armed.windows.jobName !== record.windows?.jobName
          || record.pgid === null || record.pgid > 0xffffffff || !record.windows?.creationTime
          || BigInt(record.windows.creationTime) > 0xffffffffffffffffn
          || !processGone(record.parentPid) || !childGone(record, token => readRecord(token, ".proof"))) return true;
        publishChild(record); // Existing protected flush/ACL/rename path; any failure fences.
        reconciled.set(token, record); continue;
      }
      // A complete cleanup write can survive a crash before rename. Recognize
      // only this owner's terminal evidence, with fresh lifetime proofs. Never
      // infer completion from an armed/potential verifier publication.
      if (record.phase !== "terminal" || record.pgid !== null || !processGone(record.parentPid)
        || (previous && previous.parentPid !== record.parentPid)) return true;
      if (previous?.phase === "child"
        && !childGone(previous, token => readRecord(token, ".proof"))) return true;
      reconciled.set(token, record);
    }
    for (const record of active.values()) {
      if (reconciled.has(record.token)) continue;
      // Re-probe on every admission attempt, including after a restart. A live
      // or inaccessible group stays fenced until the whole group proves absent.
      if (record.phase === "child" && record.pgid !== null
        && processGone(record.parentPid) && childGone(record, token => readRecord(token, ".proof"))) continue;
      return true;
    }
    return false;
}
