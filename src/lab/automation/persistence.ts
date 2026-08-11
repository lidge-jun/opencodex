import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  ensureLabDirs,
  labAutomationPolicyPath,
  labAutomationRoutesPath,
  labAutomationStatePath,
} from "../paths";
import { LAB_AUTOMATION_HARD_MAX } from "./constants";
import { defaultLabAutomationPolicyV1, normalizeLabAutomationPolicyV1 } from "./policy";
import type {
  LabAutomationPolicyV1,
  LabAutomationRoutesV1,
  LabAutomationRunRecordV1,
  LabAutomationStateV1,
} from "./types";
import { LabAutomationError } from "./types";

const ROUTES_KEYS = new Set(["schemaVersion", "routes"]);
const ROUTE_KEYS = new Set(["providerName", "modelId"]);
const STATE_KEYS = new Set([
  "schemaVersion",
  "runs",
  "budgetWindowStartedAt",
  "runsThisHour",
  "liveRequestsThisHour",
  "cooldownUntilByKey",
]);
const RUN_KEYS = new Set([
  "runId",
  "runKey",
  "state",
  "evidenceLayer",
  "suiteId",
  "suiteVersion",
  "suiteManifestDigest",
  "scenarioId",
  "scenarioVersion",
  "scenarioManifestDigest",
  "subjectId",
  "reason",
  "priority",
  "eligibleAt",
  "trigger",
  "createdAt",
  "updatedAt",
  "startedAt",
  "completedAt",
  "terminalCode",
  "providerName",
  "modelId",
]);
const RUN_STATES = new Set(["queued", "running", "completed", "blocked", "failed", "cancelled", "abandoned"]);
const RUN_REASONS = new Set([
  "automation_disabled",
  "layer_disabled",
  "fresh",
  "refresh_due",
  "missing",
  "cooldown",
  "budget_blocked",
  "already_queued",
  "already_running",
  "route_ineligible",
  "scenario_inapplicable",
  "task_background_disabled",
]);
const STATE_LOCK_WAIT_MS = 5_000;
const STATE_LOCK_STALE_MS = 30_000;
const LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

function assertClosedKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  label: string,
  code: "invalid_routes" | "invalid_state",
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new LabAutomationError(`unknown ${label} field ${key}`, code);
  }
}

function assertBoundedString(
  value: unknown,
  field: string,
  code: "invalid_routes" | "invalid_state",
  max = 512,
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new LabAutomationError(`invalid ${field}`, code);
  }
  return value;
}

function assertNonNegativeInt(
  value: unknown,
  field: string,
  code: "invalid_state",
  max = Number.MAX_SAFE_INTEGER,
): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new LabAutomationError(`invalid ${field}`, code);
  }
  return value;
}

function atomicWriteJson(path: string, payload: unknown): void {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
  const text = JSON.stringify(payload);
  writeFileSync(tmp, text, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, path);
}

function basename(path: string): string {
  const idx = path.replace(/\\/g, "/").lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

function readJsonFile(path: string, code: "invalid_policy" | "invalid_routes" | "invalid_state"): unknown {
  if (!existsSync(path)) return undefined;
  try {
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as unknown;
  } catch (error) {
    if (error instanceof LabAutomationError) throw error;
    throw new LabAutomationError(`invalid automation JSON at ${basename(path)}`, code);
  }
}

function sleepLockRetry(): void {
  Atomics.wait(LOCK_SLEEP, 0, 0, 10);
}

function stateLockPath(configDir?: string): string {
  return `${labAutomationStatePath(configDir)}.lock`;
}

function acquireStateLock(configDir?: string): () => void {
  ensureLabDirs(configDir);
  const lockPath = stateLockPath(configDir);
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  while (true) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeFileSync(fd, `${process.pid}:${Date.now()}`, { encoding: "utf8" });
      } finally {
        closeSync(fd);
      }
      return () => {
        try { unlinkSync(lockPath); } catch { /* already released/cleaned */ }
      };
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error
        ? String((error as { code?: unknown }).code)
        : undefined;
      if (code !== "EEXIST") throw new LabAutomationError("automation state lock failed", "state_lock_failed");
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STATE_LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new LabAutomationError("automation state is busy", "state_lock_busy");
      }
      sleepLockRetry();
    }
  }
}

export function loadLabAutomationPolicy(configDir?: string): LabAutomationPolicyV1 {
  ensureLabDirs(configDir);
  const path = labAutomationPolicyPath(configDir);
  const raw = readJsonFile(path, "invalid_policy");
  if (raw === undefined) return defaultLabAutomationPolicyV1();
  return normalizeLabAutomationPolicyV1(raw);
}

export function saveLabAutomationPolicy(policy: LabAutomationPolicyV1, configDir?: string): void {
  ensureLabDirs(configDir);
  const normalized = normalizeLabAutomationPolicyV1(policy);
  atomicWriteJson(labAutomationPolicyPath(configDir), normalized);
}

function normalizeRoutes(raw: unknown): LabAutomationRoutesV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError("automation routes must be an object", "invalid_routes");
  }
  const obj = raw as Record<string, unknown>;
  assertClosedKeys(obj, ROUTES_KEYS, "routes", "invalid_routes");
  if (obj.schemaVersion !== 1) throw new LabAutomationError("unsupported routes schemaVersion", "invalid_routes");
  if (!Array.isArray(obj.routes)) throw new LabAutomationError("routes must be an array", "invalid_routes");
  if (obj.routes.length > LAB_AUTOMATION_HARD_MAX.maxAutomationRoutes) {
    throw new LabAutomationError("too many automation routes", "invalid_routes");
  }
  const seen = new Set<string>();
  const routes = obj.routes.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new LabAutomationError(`invalid route row ${index}`, "invalid_routes");
    }
    const entry = row as Record<string, unknown>;
    assertClosedKeys(entry, ROUTE_KEYS, `route ${index}`, "invalid_routes");
    const providerName = assertBoundedString(entry.providerName, `providerName at ${index}`, "invalid_routes", 256);
    const modelId = assertBoundedString(entry.modelId, `modelId at ${index}`, "invalid_routes", 512);
    const key = `${providerName}\u0000${modelId}`;
    if (seen.has(key)) throw new LabAutomationError(`duplicate automation route at ${index}`, "invalid_routes");
    seen.add(key);
    return Object.freeze({ providerName, modelId });
  });
  return Object.freeze({ schemaVersion: 1, routes: Object.freeze(routes) });
}

export function defaultLabAutomationRoutesV1(): LabAutomationRoutesV1 {
  return Object.freeze({ schemaVersion: 1, routes: Object.freeze([]) });
}

export function loadLabAutomationRoutes(configDir?: string): LabAutomationRoutesV1 {
  ensureLabDirs(configDir);
  const raw = readJsonFile(labAutomationRoutesPath(configDir), "invalid_routes");
  if (raw === undefined) return defaultLabAutomationRoutesV1();
  return normalizeRoutes(raw);
}

export function saveLabAutomationRoutes(routes: LabAutomationRoutesV1, configDir?: string): void {
  ensureLabDirs(configDir);
  atomicWriteJson(labAutomationRoutesPath(configDir), normalizeRoutes(routes));
}

function optionalTimestamp(row: Record<string, unknown>, key: "startedAt" | "completedAt", index: number): number | undefined {
  if (row[key] === undefined) return undefined;
  return assertNonNegativeInt(row[key], `${key} at ${index}`, "invalid_state");
}

function normalizeRunRecord(raw: unknown, index: number): LabAutomationRunRecordV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError(`invalid run record ${index}`, "invalid_state");
  }
  const row = raw as Record<string, unknown>;
  assertClosedKeys(row, RUN_KEYS, `run ${index}`, "invalid_state");
  const state = row.state;
  if (typeof state !== "string" || !RUN_STATES.has(state)) {
    throw new LabAutomationError(`invalid run state at ${index}`, "invalid_state");
  }
  const evidenceLayer = row.evidenceLayer;
  if (evidenceLayer !== "protocol_conformance"
    && evidenceLayer !== "live_route_compatibility"
    && evidenceLayer !== "task_effectiveness") {
    throw new LabAutomationError(`invalid evidenceLayer at ${index}`, "invalid_state");
  }
  const trigger = row.trigger;
  if (trigger !== "scheduled" && trigger !== "manual") {
    throw new LabAutomationError(`invalid trigger at ${index}`, "invalid_state");
  }
  const reason = assertBoundedString(row.reason, `reason at ${index}`, "invalid_state", 64);
  if (!RUN_REASONS.has(reason)) throw new LabAutomationError(`invalid reason at ${index}`, "invalid_state");
  const runId = assertBoundedString(row.runId, `runId at ${index}`, "invalid_state", 128);
  const runKey = assertBoundedString(row.runKey, `runKey at ${index}`, "invalid_state", 128);
  const suiteId = assertBoundedString(row.suiteId, `suiteId at ${index}`, "invalid_state", 256);
  const suiteVersion = assertBoundedString(row.suiteVersion, `suiteVersion at ${index}`, "invalid_state", 128);
  const suiteManifestDigest = assertBoundedString(row.suiteManifestDigest, `suiteManifestDigest at ${index}`, "invalid_state", 256);
  const scenarioId = assertBoundedString(row.scenarioId, `scenarioId at ${index}`, "invalid_state", 512);
  const scenarioVersion = assertBoundedString(row.scenarioVersion, `scenarioVersion at ${index}`, "invalid_state", 128);
  const scenarioManifestDigest = assertBoundedString(row.scenarioManifestDigest, `scenarioManifestDigest at ${index}`, "invalid_state", 256);
  const subjectId = assertBoundedString(row.subjectId, `subjectId at ${index}`, "invalid_state", 256);
  const priority = assertNonNegativeInt(row.priority, `priority at ${index}`, "invalid_state", 100);
  const eligibleAt = assertNonNegativeInt(row.eligibleAt, `eligibleAt at ${index}`, "invalid_state");
  const createdAt = assertNonNegativeInt(row.createdAt, `createdAt at ${index}`, "invalid_state");
  const updatedAt = assertNonNegativeInt(row.updatedAt, `updatedAt at ${index}`, "invalid_state");
  const startedAt = optionalTimestamp(row, "startedAt", index);
  const completedAt = optionalTimestamp(row, "completedAt", index);
  if (updatedAt < createdAt) throw new LabAutomationError(`updatedAt precedes createdAt at ${index}`, "invalid_state");
  if (startedAt !== undefined && startedAt < createdAt) throw new LabAutomationError(`startedAt precedes createdAt at ${index}`, "invalid_state");
  if (completedAt !== undefined && startedAt !== undefined && completedAt < startedAt) {
    throw new LabAutomationError(`completedAt precedes startedAt at ${index}`, "invalid_state");
  }
  const terminalCode = row.terminalCode === undefined
    ? undefined
    : assertBoundedString(row.terminalCode, `terminalCode at ${index}`, "invalid_state", 256);
  const providerName = row.providerName === undefined
    ? undefined
    : assertBoundedString(row.providerName, `providerName at ${index}`, "invalid_state", 256);
  const modelId = row.modelId === undefined
    ? undefined
    : assertBoundedString(row.modelId, `modelId at ${index}`, "invalid_state", 512);
  return {
    runId,
    runKey,
    state: state as LabAutomationRunRecordV1["state"],
    evidenceLayer,
    suiteId,
    suiteVersion,
    suiteManifestDigest,
    scenarioId,
    scenarioVersion,
    scenarioManifestDigest,
    subjectId,
    reason: reason as LabAutomationRunRecordV1["reason"],
    priority,
    eligibleAt,
    trigger,
    createdAt,
    updatedAt,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
    ...(terminalCode !== undefined ? { terminalCode } : {}),
    ...(providerName !== undefined ? { providerName } : {}),
    ...(modelId !== undefined ? { modelId } : {}),
  };
}

function normalizeState(raw: unknown): LabAutomationStateV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError("automation state must be an object", "invalid_state");
  }
  const obj = raw as Record<string, unknown>;
  assertClosedKeys(obj, STATE_KEYS, "state", "invalid_state");
  if (obj.schemaVersion !== 1) throw new LabAutomationError("unsupported state schemaVersion", "invalid_state");
  if (!Array.isArray(obj.runs)) throw new LabAutomationError("state runs must be an array", "invalid_state");
  if (obj.runs.length > LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    throw new LabAutomationError("too many persisted runs", "invalid_state");
  }
  const runs = obj.runs.map((row, index) => normalizeRunRecord(row, index));
  const cooldownUntilByKey: Record<string, number> = {};
  if (!obj.cooldownUntilByKey || typeof obj.cooldownUntilByKey !== "object" || Array.isArray(obj.cooldownUntilByKey)) {
    throw new LabAutomationError("invalid cooldownUntilByKey", "invalid_state");
  }
  const cooldownEntries = Object.entries(obj.cooldownUntilByKey as Record<string, unknown>);
  if (cooldownEntries.length > LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    throw new LabAutomationError("too many cooldown entries", "invalid_state");
  }
  for (const [key, value] of cooldownEntries) {
    if (key.length === 0 || key.length > 128) throw new LabAutomationError("invalid cooldown key", "invalid_state");
    cooldownUntilByKey[key] = assertNonNegativeInt(value, `cooldown for ${key}`, "invalid_state");
  }
  return {
    schemaVersion: 1,
    runs,
    budgetWindowStartedAt: assertNonNegativeInt(obj.budgetWindowStartedAt, "budgetWindowStartedAt", "invalid_state"),
    runsThisHour: assertNonNegativeInt(
      obj.runsThisHour,
      "runsThisHour",
      "invalid_state",
      LAB_AUTOMATION_HARD_MAX.maxRunsPerHour,
    ),
    liveRequestsThisHour: assertNonNegativeInt(
      obj.liveRequestsThisHour,
      "liveRequestsThisHour",
      "invalid_state",
      LAB_AUTOMATION_HARD_MAX.maxLiveRequestsPerHour,
    ),
    cooldownUntilByKey,
  };
}

export function defaultLabAutomationStateV1(now = Date.now()): LabAutomationStateV1 {
  return {
    schemaVersion: 1,
    runs: [],
    budgetWindowStartedAt: now,
    runsThisHour: 0,
    liveRequestsThisHour: 0,
    cooldownUntilByKey: {},
  };
}

function loadLabAutomationStateUnlocked(configDir?: string): LabAutomationStateV1 {
  ensureLabDirs(configDir);
  const raw = readJsonFile(labAutomationStatePath(configDir), "invalid_state");
  if (raw === undefined) return defaultLabAutomationStateV1();
  return normalizeState(raw);
}

function saveLabAutomationStateUnlocked(state: LabAutomationStateV1, configDir?: string): void {
  ensureLabDirs(configDir);
  atomicWriteJson(labAutomationStatePath(configDir), normalizeState(state));
}

export function loadLabAutomationState(configDir?: string): LabAutomationStateV1 {
  return loadLabAutomationStateUnlocked(configDir);
}

export function saveLabAutomationState(state: LabAutomationStateV1, configDir?: string): void {
  const release = acquireStateLock(configDir);
  try {
    saveLabAutomationStateUnlocked(state, configDir);
  } finally {
    release();
  }
}

export function mutateLabAutomationState<T>(
  configDir: string | undefined,
  mutate: (state: LabAutomationStateV1) => { state: LabAutomationStateV1; value: T },
): T {
  const release = acquireStateLock(configDir);
  try {
    const current = loadLabAutomationStateUnlocked(configDir);
    const result = mutate(current);
    saveLabAutomationStateUnlocked(result.state, configDir);
    return result.value;
  } finally {
    release();
  }
}
