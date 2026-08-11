import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return undefined;
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as unknown;
}

export function loadLabAutomationPolicy(configDir?: string): LabAutomationPolicyV1 {
  ensureLabDirs(configDir);
  const path = labAutomationPolicyPath(configDir);
  const raw = readJsonFile(path);
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
  if (obj.schemaVersion !== 1) throw new LabAutomationError("unsupported routes schemaVersion", "invalid_routes");
  if (!Array.isArray(obj.routes)) throw new LabAutomationError("routes must be an array", "invalid_routes");
  if (obj.routes.length > LAB_AUTOMATION_HARD_MAX.maxAutomationRoutes) {
    throw new LabAutomationError("too many automation routes", "invalid_routes");
  }
  const routes = obj.routes.map((row, index) => {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw new LabAutomationError(`invalid route row ${index}`, "invalid_routes");
    }
    const entry = row as Record<string, unknown>;
    const providerName = entry.providerName;
    const modelId = entry.modelId;
    if (typeof providerName !== "string" || providerName.length === 0) {
      throw new LabAutomationError(`invalid providerName at ${index}`, "invalid_routes");
    }
    if (typeof modelId !== "string" || modelId.length === 0) {
      throw new LabAutomationError(`invalid modelId at ${index}`, "invalid_routes");
    }
    return { providerName, modelId };
  });
  return Object.freeze({ schemaVersion: 1, routes: Object.freeze(routes) });
}

export function defaultLabAutomationRoutesV1(): LabAutomationRoutesV1 {
  return Object.freeze({ schemaVersion: 1, routes: Object.freeze([]) });
}

export function loadLabAutomationRoutes(configDir?: string): LabAutomationRoutesV1 {
  ensureLabDirs(configDir);
  const raw = readJsonFile(labAutomationRoutesPath(configDir));
  if (raw === undefined) return defaultLabAutomationRoutesV1();
  return normalizeRoutes(raw);
}

export function saveLabAutomationRoutes(routes: LabAutomationRoutesV1, configDir?: string): void {
  ensureLabDirs(configDir);
  atomicWriteJson(labAutomationRoutesPath(configDir), normalizeRoutes(routes));
}

function normalizeRunRecord(raw: unknown, index: number): LabAutomationRunRecordV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError(`invalid run record ${index}`, "invalid_state");
  }
  const row = raw as Record<string, unknown>;
  const state = row.state;
  const allowedStates = new Set(["queued", "running", "completed", "blocked", "failed", "cancelled", "abandoned"]);
  if (typeof state !== "string" || !allowedStates.has(state)) {
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
  const requiredStrings = [
    "runId", "runKey", "suiteId", "suiteVersion", "suiteManifestDigest",
    "scenarioId", "scenarioVersion", "scenarioManifestDigest", "subjectId", "reason",
  ];
  for (const key of requiredStrings) {
    if (typeof row[key] !== "string" || (row[key] as string).length === 0) {
      throw new LabAutomationError(`invalid ${key} at ${index}`, "invalid_state");
    }
  }
  if (typeof row.priority !== "number" || !Number.isInteger(row.priority)) {
    throw new LabAutomationError(`invalid priority at ${index}`, "invalid_state");
  }
  if (typeof row.eligibleAt !== "number" || !Number.isInteger(row.eligibleAt)) {
    throw new LabAutomationError(`invalid eligibleAt at ${index}`, "invalid_state");
  }
  if (typeof row.createdAt !== "number" || !Number.isInteger(row.createdAt)) {
    throw new LabAutomationError(`invalid createdAt at ${index}`, "invalid_state");
  }
  if (typeof row.updatedAt !== "number" || !Number.isInteger(row.updatedAt)) {
    throw new LabAutomationError(`invalid updatedAt at ${index}`, "invalid_state");
  }
  return {
    runId: row.runId as string,
    runKey: row.runKey as string,
    state: state as LabAutomationRunRecordV1["state"],
    evidenceLayer,
    suiteId: row.suiteId as string,
    suiteVersion: row.suiteVersion as string,
    suiteManifestDigest: row.suiteManifestDigest as string,
    scenarioId: row.scenarioId as string,
    scenarioVersion: row.scenarioVersion as string,
    scenarioManifestDigest: row.scenarioManifestDigest as string,
    subjectId: row.subjectId as string,
    reason: row.reason as LabAutomationRunRecordV1["reason"],
    priority: row.priority as number,
    eligibleAt: row.eligibleAt as number,
    trigger,
    createdAt: row.createdAt as number,
    updatedAt: row.updatedAt as number,
    ...(typeof row.startedAt === "number" ? { startedAt: row.startedAt } : {}),
    ...(typeof row.completedAt === "number" ? { completedAt: row.completedAt } : {}),
    ...(typeof row.terminalCode === "string" ? { terminalCode: row.terminalCode } : {}),
    ...(typeof row.providerName === "string" ? { providerName: row.providerName } : {}),
    ...(typeof row.modelId === "string" ? { modelId: row.modelId } : {}),
  };
}

function normalizeState(raw: unknown): LabAutomationStateV1 {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LabAutomationError("automation state must be an object", "invalid_state");
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== 1) throw new LabAutomationError("unsupported state schemaVersion", "invalid_state");
  if (!Array.isArray(obj.runs)) throw new LabAutomationError("state runs must be an array", "invalid_state");
  if (obj.runs.length > LAB_AUTOMATION_HARD_MAX.maxPersistedRuns) {
    throw new LabAutomationError("too many persisted runs", "invalid_state");
  }
  const runs = obj.runs.map((row, index) => normalizeRunRecord(row, index));
  const cooldownUntilByKey: Record<string, number> = {};
  if (obj.cooldownUntilByKey !== undefined) {
    if (!obj.cooldownUntilByKey || typeof obj.cooldownUntilByKey !== "object" || Array.isArray(obj.cooldownUntilByKey)) {
      throw new LabAutomationError("invalid cooldownUntilByKey", "invalid_state");
    }
    for (const [key, value] of Object.entries(obj.cooldownUntilByKey as Record<string, unknown>)) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        throw new LabAutomationError(`invalid cooldown for ${key}`, "invalid_state");
      }
      cooldownUntilByKey[key] = value;
    }
  }
  return {
    schemaVersion: 1,
    runs,
    budgetWindowStartedAt: typeof obj.budgetWindowStartedAt === "number" ? obj.budgetWindowStartedAt : 0,
    runsThisHour: typeof obj.runsThisHour === "number" ? obj.runsThisHour : 0,
    liveRequestsThisHour: typeof obj.liveRequestsThisHour === "number" ? obj.liveRequestsThisHour : 0,
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

export function loadLabAutomationState(configDir?: string): LabAutomationStateV1 {
  ensureLabDirs(configDir);
  const raw = readJsonFile(labAutomationStatePath(configDir));
  if (raw === undefined) return defaultLabAutomationStateV1();
  return normalizeState(raw);
}

export function saveLabAutomationState(state: LabAutomationStateV1, configDir?: string): void {
  ensureLabDirs(configDir);
  atomicWriteJson(labAutomationStatePath(configDir), normalizeState(state));
}
