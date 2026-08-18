import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { renameAtomicFile } from "../../lib/windows-atomic-replace";
import {
  ensureLabDirs,
  labAutomationPolicyPath,
} from "../paths";
import { normalizeLabAutomationPolicyV1 } from "./policy";
import {
  loadLabAutomationPolicy,
  loadLabAutomationRoutes,
  normalizeLabAutomationRoutesV1,
} from "./persistence";
import type { LabAutomationPolicyV1, LabAutomationRoutesV1 } from "./types";
import { LabAutomationError } from "./types";

const CONFIG_SCHEMA_VERSION = 1 as const;
const CONFIG_KEYS = new Set(["schemaVersion", "policy", "routes"]);
const CONFIG_LOCK_WAIT_MS = 5_000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

interface ConfigLockMeta {
  pid: number;
  token: string;
}

export interface LabAutomationConfigV1 {
  schemaVersion: typeof CONFIG_SCHEMA_VERSION;
  policy: LabAutomationPolicyV1;
  routes: LabAutomationRoutesV1;
}

type ConfigCommitFault = "before_publish" | null;
let configCommitFaultForTests: ConfigCommitFault = null;

function configPath(configDir?: string): string {
  return join(dirname(labAutomationPolicyPath(configDir)), "automation-config.json");
}

function configLockPath(configDir?: string): string {
  return `${configPath(configDir)}.lock`;
}

function sleepLockRetry(): void {
  Atomics.wait(LOCK_SLEEP, 0, 0, 10);
}

function readLockMeta(lockPath: string): ConfigLockMeta | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const row = parsed as Record<string, unknown>;
    if (!Number.isSafeInteger(row.pid) || (row.pid as number) <= 0) return null;
    if (typeof row.token !== "string" || row.token.length < 16 || row.token.length > 128) return null;
    return { pid: row.pid as number, token: row.token };
  } catch {
    return null;
  }
}

function pidDefinitelyDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : undefined;
    return code === "ESRCH";
  }
}

function cleanupFile(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Absent or already cleaned.
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (readLockMeta(lockPath)?.token === token) unlinkSync(lockPath);
  } catch {
    // Already released or replaced.
  }
}

function reclaimDeadLock(lockPath: string): boolean {
  const observed = readLockMeta(lockPath);
  if (!observed || !pidDefinitelyDead(observed.pid)) return false;
  const current = readLockMeta(lockPath);
  if (!current || current.pid !== observed.pid || current.token !== observed.token) return false;
  try {
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireConfigLock(configDir?: string): () => void {
  ensureLabDirs(configDir);
  const lockPath = configLockPath(configDir);
  const deadline = Date.now() + CONFIG_LOCK_WAIT_MS;
  while (true) {
    const token = randomUUID();
    const privatePath = `${lockPath}.${process.pid}.${token}.tmp`;
    let publicationAttempted = false;
    try {
      const fd = openSync(privatePath, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), { encoding: "utf8" });
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      publicationAttempted = true;
      linkSync(privatePath, lockPath);
      cleanupFile(privatePath);
      return () => releaseLock(lockPath, token);
    } catch (error) {
      cleanupFile(privatePath);
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code === "EEXIST" && !publicationAttempted) continue;
      if (code !== "EEXIST") {
        throw new LabAutomationError("automation config lock failed", "state_lock_failed");
      }
      if (reclaimDeadLock(lockPath)) continue;
      if (Date.now() >= deadline) {
        throw new LabAutomationError("automation config is busy", "state_lock_busy");
      }
      sleepLockRetry();
    }
  }
}

function withConfigLock<T>(configDir: string | undefined, action: () => T): T {
  const release = acquireConfigLock(configDir);
  try {
    return action();
  } finally {
    release();
  }
}

function normalizeConfig(raw: unknown): LabAutomationConfigV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError("automation config must be an object", "invalid_state");
  }
  const row = raw as Record<string, unknown>;
  for (const key of Object.keys(row)) {
    if (!CONFIG_KEYS.has(key)) {
      throw new LabAutomationError(`unknown automation config field ${key}`, "invalid_state");
    }
  }
  if (row.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new LabAutomationError("unsupported automation config schemaVersion", "invalid_state");
  }
  return Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    policy: normalizeLabAutomationPolicyV1(row.policy),
    routes: normalizeLabAutomationRoutesV1(row.routes),
  });
}

function loadConfigUnlocked(configDir?: string): LabAutomationConfigV1 {
  ensureLabDirs(configDir);
  const path = configPath(configDir);
  if (!existsSync(path)) {
    return Object.freeze({
      schemaVersion: CONFIG_SCHEMA_VERSION,
      policy: loadLabAutomationPolicy(configDir),
      routes: loadLabAutomationRoutes(configDir),
    });
  }
  try {
    return normalizeConfig(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof LabAutomationError) throw error;
    throw new LabAutomationError("invalid automation config JSON", "invalid_state");
  }
}

function writeConfigUnlocked(
  policy: LabAutomationPolicyV1,
  routes: LabAutomationRoutesV1,
  configDir?: string,
): LabAutomationConfigV1 {
  ensureLabDirs(configDir);
  const normalized = Object.freeze({
    schemaVersion: CONFIG_SCHEMA_VERSION,
    policy: normalizeLabAutomationPolicyV1(policy),
    routes: normalizeLabAutomationRoutesV1(routes),
  });
  const path = configPath(configDir);
  const tmp = join(dirname(path), `.automation-config.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tmp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(normalized), { encoding: "utf8" });
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (configCommitFaultForTests === "before_publish") {
      throw new LabAutomationError("synthetic automation config commit failure", "invalid_state");
    }
    renameAtomicFile(tmp, path, undefined, "lab-automation");
    return normalized;
  } finally {
    if (fd !== null) closeSync(fd);
    cleanupFile(tmp);
  }
}

/** Load one coherent policy/routes generation. */
export function loadLabAutomationConfig(configDir?: string): LabAutomationConfigV1 {
  return withConfigLock(configDir, () => loadConfigUnlocked(configDir));
}

/** Atomically publish one coherent policy/routes generation. */
export function saveLabAutomationConfig(
  policy: LabAutomationPolicyV1,
  routes: LabAutomationRoutesV1,
  configDir?: string,
): LabAutomationConfigV1 {
  return withConfigLock(configDir, () => writeConfigUnlocked(policy, routes, configDir));
}

/** Update only policy while preserving routes from the same committed generation. */
export function saveLabAutomationPolicyConfig(
  policy: LabAutomationPolicyV1,
  configDir?: string,
): LabAutomationConfigV1 {
  return withConfigLock(configDir, () => {
    const current = loadConfigUnlocked(configDir);
    return writeConfigUnlocked(policy, current.routes, configDir);
  });
}

/** Test-only fault injection before the atomic rename publication point. */
export function setLabAutomationConfigCommitFaultForTests(fault: ConfigCommitFault): void {
  configCommitFaultForTests = fault;
}
