import { createHash, randomUUID } from "node:crypto";
import { chmodSync, closeSync, constants, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync,
  readFileSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getConfigDir } from "../config";
import { assertTrustedCodexCliAncestry } from "./cli-update-paths";
import type { CodexCliApplyResult } from "./cli-update-apply";
import { CODEX_CLI_JOB_REASONS as SAFE_REASONS, CODEX_CLI_JOB_CLEANUP_ERRORS,
  CodexCliJobStoreBusyError, normalizeCodexCliJobResult, runCodexCliUpdateJobWork } from "./cli-update-job-execution";

const MAX_BYTES = 256 * 1024;
const MAX_JOBS = 64;
const JOB_DIR = "codex-cli-update-jobs";
const FILE = "jobs.json";
const LOCK = "admission.lock";
type JobStatus = "queued" | "running" | "applied" | "not_applied" | "refused" | "ambiguous";

interface StoredJob {
  id: string; requestKey: string; payloadHash: string; generation: string; revision: number;
  status: JobStatus; createdAt: string; updatedAt: string; planId: string;
  outcome: CodexCliApplyResult["outcome"] | null; reason: string | null;
  cleanupErrors: readonly string[]; leaseRetained: boolean;
}
interface Store { version: 1; jobs: StoredJob[] }
export interface CodexCliUpdateJobDto {
  readonly jobId: string; readonly status: "queued" | "running" | "applied" | "not_applied" | "refused" | "ambiguous";
  readonly ownerState: "active" | "unknown" | "finished"; readonly lifetimeUncertain: boolean;
  readonly childState: "not_started" | "active_or_not_observed" | "terminal" | "unknown";
  readonly leaseState: "not_acquired_or_released" | "retained" | "unknown";
  readonly createdAt: string; readonly updatedAt: string; readonly planId: string;
  readonly outcome: CodexCliApplyResult["outcome"] | null; readonly reason: string | null;
  readonly cleanupErrors: readonly string[];
}

const live = new Map<string, string>();
const started = new Set<string>();
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
const now = () => new Date().toISOString();

function paths(configDir = getConfigDir()) {
  const config = resolve(configDir);
  const dir = join(config, JOB_DIR);
  return { config, dir, file: join(dir, FILE), lock: join(dir, LOCK) };
}
function assertTrustedConfigAncestry(parent: string) {
  try { assertTrustedCodexCliAncestry(parent); }
  catch { throw new Error("unsafe_store"); }
}
function prepare(configDir?: string, create = false, createConfigRoot = false) {
  const p = paths(configDir);
  if (process.platform === "win32" || process.geteuid?.() === undefined) throw new Error("unsupported_store");
  const parent = dirname(p.config);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || parentStat.uid !== process.geteuid()
    || (parentStat.mode & 0o022) !== 0 || (parentStat.mode & 0o300) !== 0o300
    || realpathSync.native(parent) !== parent) throw new Error("unsafe_store");
  assertTrustedConfigAncestry(parent);
  let configStat: ReturnType<typeof lstatSync>;
  try { configStat = lstatSync(p.config); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !createConfigRoot) throw error;
    const parentIdentity = { dev: parentStat.dev, ino: parentStat.ino };
    let created = false;
    try { mkdirSync(p.config, { mode: 0o700 }); created = true; }
    catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
    const parentAfter = lstatSync(parent);
    if (parentAfter.dev !== parentIdentity.dev || parentAfter.ino !== parentIdentity.ino
      || !parentAfter.isDirectory() || parentAfter.isSymbolicLink() || parentAfter.uid !== process.geteuid()
      || (parentAfter.mode & 0o022) !== 0 || (parentAfter.mode & 0o300) !== 0o300
      || realpathSync.native(parent) !== parent) {
      throw new Error("unsafe_store");
    }
    configStat = lstatSync(p.config);
    if (!configStat.isDirectory() || configStat.isSymbolicLink() || configStat.uid !== process.geteuid()
      || realpathSync.native(p.config) !== p.config) throw new Error("unsafe_store");
    if (created && ((configStat.mode & 0o077) !== 0 || (configStat.mode & 0o700) !== 0o700)) {
      throw new Error("unsafe_store");
    }
    configStat = lstatSync(p.config);
  }
  if (!configStat.isDirectory() || configStat.isSymbolicLink() || realpathSync.native(p.config) !== p.config
    || (configStat.mode & 0o022) !== 0) throw new Error("unsafe_store");
  if (create) {
    if (configStat.uid !== process.geteuid()) throw new Error("unsupported_store");
    try { mkdirSync(p.dir, { mode: 0o700 }); chmodSync(p.dir, 0o700); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(p.dir);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== configStat.uid || (stat.mode & 0o077) !== 0
    || realpathSync.native(p.dir) !== p.dir) throw new Error("unsafe_store");
  return p;
}
function readStore(configDir?: string): Store {
  let p: ReturnType<typeof paths>;
  try { p = prepare(configDir); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] }; throw error; }
  let fd: number | undefined;
  try {
    fd = openSync(p.file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES || (stat.mode & 0o077) !== 0
      || stat.uid !== process.geteuid?.() || stat.nlink !== 1) throw new Error("unsafe_store");
    const lexical = lstatSync(p.file);
    if (lexical.isSymbolicLink() || lexical.dev !== stat.dev || lexical.ino !== stat.ino) throw new Error("unsafe_store");
    const bytes = Buffer.alloc(MAX_BYTES + 1);
    const length = readSync(fd, bytes, 0, bytes.length, 0);
    if (length > MAX_BYTES) throw new Error("unsafe_store");
    const value = JSON.parse(bytes.subarray(0, length).toString("utf8")) as Store;
    if (value.version !== 1 || !Array.isArray(value.jobs) || value.jobs.length > MAX_JOBS
      || value.jobs.some(job => !job || typeof job !== "object" || !/^[0-9a-f-]{36}$/.test(job.id)
        || !/^[0-9a-f]{64}$/.test(job.requestKey) || !/^[0-9a-f]{64}$/.test(job.payloadHash)
        || !/^[0-9a-f-]{36}$/.test(job.generation) || !Number.isSafeInteger(job.revision) || job.revision < 0
        || !["queued", "running", "applied", "not_applied", "refused", "ambiguous"].includes(job.status)
        || typeof job.planId !== "string" || !/^[0-9a-f]{32}$/.test(job.planId)
        || (job.reason !== null && (typeof job.reason !== "string" || !SAFE_REASONS.has(job.reason)))
        || !Array.isArray(job.cleanupErrors) || job.cleanupErrors.length > 8
        || job.cleanupErrors.some((item: unknown) => typeof item !== "string" || !CODEX_CLI_JOB_CLEANUP_ERRORS.has(item))
        || typeof job.leaseRetained !== "boolean"
        || typeof job.createdAt !== "string" || typeof job.updatedAt !== "string")) throw new Error("invalid_store");
    return value;
  } finally { if (fd !== undefined) closeSync(fd); }
}
function rollbackInitializingLock(p: ReturnType<typeof paths>, lockIdentity: { dev: number; ino: number }, ownerIdentity?: { dev: number; ino: number }) {
  try {
    const ownsDirectory = () => {
      const stat = lstatSync(p.lock);
      return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === lockIdentity.dev && stat.ino === lockIdentity.ino
        && stat.uid === process.geteuid?.() && (stat.mode & 0o077) === 0 && realpathSync.native(p.lock) === p.lock;
    };
    if (!ownsDirectory()) return;
    if (ownerIdentity) {
      const owner = join(p.lock, "owner.json");
      const fd = openSync(owner, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd), lexical = lstatSync(owner);
        if (!stat.isFile() || stat.uid !== process.geteuid?.() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0
          || stat.dev !== ownerIdentity.dev || stat.ino !== ownerIdentity.ino || lexical.isSymbolicLink()
          || lexical.dev !== stat.dev || lexical.ino !== stat.ino || !ownsDirectory()) return;
      } finally { closeSync(fd); }
      unlinkSync(owner);
    }
    // This call created the directory. Never remove a replacement or nonempty lock.
    if (ownsDirectory()) rmdirSync(p.lock);
  } catch { /* Unprovable initialization ownership stays fail-closed. */ }
}
function withLock<T>(configDir: string | undefined, fn: (p: ReturnType<typeof paths>) => T, createConfigRoot = false): T {
  const p = prepare(configDir, true, createConfigRoot);
  let lockIdentity: { dev: number; ino: number } | undefined;
  let ownerIdentity: { dev: number; ino: number } | undefined;
  const owner = join(p.lock, "owner.json");
  const record = JSON.stringify({ version: 1, token: randomUUID() });
  try {
    try { mkdirSync(p.lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new CodexCliJobStoreBusyError();
      throw error;
    }
    const lockStat = lstatSync(p.lock);
    if (!lockStat.isDirectory() || lockStat.isSymbolicLink() || lockStat.uid !== process.geteuid?.()
      || (lockStat.mode & 0o077) !== 0 || realpathSync.native(p.lock) !== p.lock) throw new Error("unsafe_store");
    lockIdentity = { dev: lockStat.dev, ino: lockStat.ino };
    try {
      const fd = openSync(owner, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { ownerIdentity = fstatSync(fd); writeFileSync(fd, record); fsyncSync(fd); } finally { closeSync(fd); }
    } catch (error) {
      rollbackInitializingLock(p, lockIdentity, ownerIdentity);
      lockIdentity = undefined;
      throw error;
    }
    return fn(p);
  } finally {
    if (lockIdentity && ownerIdentity) {
      try {
        const dir = lstatSync(p.lock);
        const fd = openSync(owner, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const stat = fstatSync(fd);
          if (dir.dev === lockIdentity.dev && dir.ino === lockIdentity.ino && stat.isFile()
            && stat.size <= 1024 && stat.uid === process.geteuid?.() && stat.nlink === 1
            && stat.dev === ownerIdentity.dev && stat.ino === ownerIdentity.ino
            && readFileSync(fd, "utf8") === record) {
            unlinkSync(owner); rmdirSync(p.lock);
          }
        } finally { closeSync(fd); }
      } catch { /* Fail closed; a leftover lock blocks future admission. */ }
    }
  }
}
function writeStore(p: ReturnType<typeof paths>, store: Store) {
  const body = JSON.stringify(store);
  if (Buffer.byteLength(body) > MAX_BYTES) throw new Error("store_full");
  const temp = join(p.dir, `.jobs-${randomUUID()}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    writeFileSync(fd, body); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, p.file);
    const dirFd = openSync(p.dir, constants.O_RDONLY);
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* already renamed */ }
  }
}
function validStore(configDir?: string): Store {
  try { return readStore(configDir); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, jobs: [] };
    throw error;
  }
}
type LifecycleInput = Pick<StoredJob, "status" | "outcome" | "reason" | "cleanupErrors" | "leaseRetained"> & { active: boolean };
type LifecycleProjection = Pick<CodexCliUpdateJobDto, "status" | "ownerState" | "lifetimeUncertain" | "childState" | "leaseState" | "outcome" | "reason">;

/** Project only states supported by persisted evidence; retention booleans alone are ambiguous. */
export function projectCodexCliUpdateJobLifecycle(job: LifecycleInput): LifecycleProjection {
  const ownerUnknown = job.status === "queued" || job.status === "running" ? !job.active : false;
  const uncertain = ownerUnknown || job.outcome === "ambiguous";
  const leaseReleaseUnconfirmed = job.cleanupErrors.some(error =>
    error === "lease_release_unverified" || error === "lease_release_exception");
  const retainedWithEvidence = job.leaseRetained && !leaseReleaseUnconfirmed
    && (job.reason === "installer_state_unknown" || job.reason === "version_process_state_unknown"
      || job.reason === "installer_or_readback_error");
  const childUnknown = ownerUnknown || job.reason === "job_result_unknown"
    || job.reason === "installer_state_unknown" || job.reason === "version_process_state_unknown"
    || (job.reason === "installer_or_readback_error" && job.leaseRetained);
  const childState = childUnknown ? "unknown" : job.status === "queued" || job.outcome === "refused" ? "not_started"
    : job.status === "running" ? "active_or_not_observed" : "terminal";
  const leaseState = ownerUnknown || job.status === "queued" || job.status === "running"
    || job.reason === "job_result_unknown" || leaseReleaseUnconfirmed ? "unknown"
    : retainedWithEvidence ? "retained" : job.leaseRetained ? "unknown" : "not_acquired_or_released";
  return Object.freeze({ status: uncertain ? "ambiguous" : job.status,
    ownerState: job.active ? "active" : ownerUnknown ? "unknown" : "finished", lifetimeUncertain: uncertain,
    childState, leaseState, outcome: ownerUnknown ? "ambiguous" : job.outcome,
    reason: ownerUnknown ? "owner_state_unknown" : job.reason });
}

function dto(job: StoredJob): CodexCliUpdateJobDto {
  const lifecycle = projectCodexCliUpdateJobLifecycle({ ...job, active: live.get(job.id) === job.generation });
  return Object.freeze({ jobId: job.id, ...lifecycle,
    createdAt: job.createdAt, updatedAt: job.updatedAt, planId: job.planId,
    cleanupErrors: Object.freeze([...job.cleanupErrors]) });
}

export function readCodexCliUpdateJob(jobId: string, configDir?: string): CodexCliUpdateJobDto | null {
  if (!/^[0-9a-f-]{36}$/.test(jobId)) return null;
  const job = readStore(configDir).jobs.find(item => item.id === jobId);
  return job ? dto(job) : null;
}

/** Persist dedupe admission before returning; a duplicate key never schedules a second installer. */
export function admitCodexCliUpdateJob(input: { requestId: string; planId: string; confirmed: true; configDir?: string }):
  { kind: "accepted" | "duplicate"; job: CodexCliUpdateJobDto; generation: string } {
  if (input.confirmed !== true || !/^[A-Za-z0-9._:-]{8,128}$/.test(input.requestId)
    || !/^[0-9a-f]{32}$/.test(input.planId)) throw new Error("invalid_request");
  const requestKey = digest(input.requestId);
  const payloadHash = digest(JSON.stringify({ planId: input.planId }));
  return withLock(input.configDir, p => {
    const store = validStore(input.configDir);
    const existing = store.jobs.find(job => job.requestKey === requestKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new Error("idempotency_conflict");
      return { kind: "duplicate", job: dto(existing), generation: existing.generation };
    }
    if (store.jobs.length >= MAX_JOBS) throw new Error("store_full");
    const stamp = now();
    const record: StoredJob = { id: randomUUID(), requestKey, payloadHash, generation: randomUUID(), revision: 0,
      status: "queued", createdAt: stamp, updatedAt: stamp, planId: input.planId, outcome: null,
      reason: null, cleanupErrors: [], leaseRetained: false };
    store.jobs.push(record); writeStore(p, store);
    live.set(record.id, record.generation);
    return { kind: "accepted", job: dto(record), generation: record.generation };
  }, true);
}

/** Updates are generation/revision fenced so an old worker cannot replace a newer state. */
export function finishCodexCliUpdateJob(jobId: string, generation: string, expectedRevision: number,
  result: CodexCliApplyResult, configDir?: string): CodexCliUpdateJobDto | null {
  return withLock(configDir, p => {
    const store = validStore(configDir);
    const index = store.jobs.findIndex(job => job.id === jobId);
    if (index < 0) return null;
    const current = store.jobs[index]!;
    const safe = normalizeCodexCliJobResult(result);
    // A rename can succeed before a directory-fsync error. Retry the same
    // completed revision while this generation still owns it, never the engine.
    if (current.generation === generation && current.revision === expectedRevision + 1
      && live.get(jobId) === generation && started.has(jobId)
      && current.outcome === safe.outcome && current.reason === safe.reason
      && current.leaseRetained === safe.leaseRetained
      && JSON.stringify(current.cleanupErrors) === JSON.stringify(safe.cleanupErrors)) {
      writeStore(p, store); live.delete(jobId); started.delete(jobId); return dto(current);
    }
    if (current.generation !== generation || current.revision !== expectedRevision
      || live.get(jobId) !== generation || !started.has(jobId)) return dto(current);
    const next: StoredJob = { ...current, revision: current.revision + 1, status: safe.outcome,
      outcome: safe.outcome, reason: safe.reason, cleanupErrors: safe.cleanupErrors, leaseRetained: safe.leaseRetained, updatedAt: now() };
    store.jobs[index] = next; writeStore(p, store); live.delete(jobId); started.delete(jobId);
    return dto(next);
  });
}

export async function runCodexCliUpdateJob(jobId: string, generation: string, run: () => Promise<CodexCliApplyResult>, configDir?: string): Promise<CodexCliUpdateJobDto | null> {
  let ownsExecution = false;
  return runCodexCliUpdateJobWork(run, {
    begin: () => withLock(configDir, p => {
      const store = validStore(configDir); const index = store.jobs.findIndex(job => job.id === jobId);
      if (index < 0 || store.jobs[index]!.generation !== generation) throw new Error("job_generation_changed");
      if (live.get(jobId) !== generation || started.has(jobId)) throw new Error("job_not_owned");
      const current = store.jobs[index]!; const next = { ...current, revision: current.revision + 1, status: "running" as const, updatedAt: now() };
      store.jobs[index] = next; writeStore(p, store); started.add(jobId); ownsExecution = true; return next.revision;
    }),
    finish: (revision, result) => finishCodexCliUpdateJob(jobId, generation, revision, result, configDir),
    read: () => readCodexCliUpdateJob(jobId, configDir),
    release: () => {
      if (live.get(jobId) === generation && (ownsExecution || !started.has(jobId))) {
        live.delete(jobId); if (ownsExecution) started.delete(jobId);
      }
    },
  });
}
