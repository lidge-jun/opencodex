import { chmodSync, existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { usageDisplayTotalTokens } from "./totals";
import type { OcxUsage } from "../types";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

export type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "image-413";

export interface PersistedUsageAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: UsageStatus;
  inputTokenEstimate?: number;
  usage?: OcxUsage;
  totalTokens?: number;
  errorCode?: string;
}

export interface PersistedUsageEntry {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  surface?: "claude";
  resolvedModel?: string;
  requestedModel?: string;
  status: number;
  durationMs: number;
  usageStatus: UsageStatus;
  usage?: OcxUsage;
  totalTokens?: number;
  attempts?: PersistedUsageAttempt[];
  // Failure diagnostics (devlog/_plan/260716_claudecode_hardening/030): persisted for
  // status>=400 or non-completed terminals so incidents survive the in-memory ring buffer.
  errorCode?: string;
  terminalStatus?: string;
  closeReason?: "terminal" | "client_cancel" | "non_stream" | "body_stall" | "body_overflow";
  /** Already redacted + capped at capture (request-log.ts redactSecretString().slice(0,500)). */
  upstreamError?: string;
}

export function usageLogPath(): string {
  return join(getConfigDir(), "usage.jsonl");
}

export function usageTotalTokens(usage: OcxUsage | undefined): number | undefined {
  return usageDisplayTotalTokens(usage);
}

/**
 * Providers whose adapters can only estimate usage (no authoritative per-turn frame).
 * Callers should pass the route ADAPTER when available; the name-prefix match is a
 * fallback for paths that only know the configured provider name (e.g. "cursor-mykey").
 */
function isEstimatedUsageProvider(providerOrAdapter: string): boolean {
  return providerOrAdapter === "kiro" || providerOrAdapter.startsWith("kiro-")
    || providerOrAdapter === "cursor" || providerOrAdapter.startsWith("cursor-");
}

export function usageForFinalLog(provider: string, usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  if (usage.estimated || isEstimatedUsageProvider(provider)) return { ...usage, estimated: true };
  return usage;
}

export function usageStatusForFinalLog(usage: OcxUsage | undefined): UsageStatus {
  if (!usage) return "unreported";
  return usage.estimated ? "estimated" : "reported";
}

function normalizeUsageValue(usage: OcxUsage | undefined): OcxUsage | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...(typeof usage.totalTokens === "number" ? { totalTokens: usage.totalTokens } : {}),
    ...(typeof usage.cachedInputTokens === "number" ? { cachedInputTokens: usage.cachedInputTokens } : {}),
    ...(typeof usage.cacheReadInputTokens === "number" ? { cacheReadInputTokens: usage.cacheReadInputTokens } : {}),
    ...(typeof usage.cacheCreationInputTokens === "number" ? { cacheCreationInputTokens: usage.cacheCreationInputTokens } : {}),
    ...(typeof usage.reasoningOutputTokens === "number" ? { reasoningOutputTokens: usage.reasoningOutputTokens } : {}),
    ...(usage.estimated ? { estimated: true } : {}),
  };
}

const ATTEMPT_RECOVERY_KINDS = new Set<AttemptRecoveryKind>([
  "transient-5xx",
  "connection-reset",
  "oauth-401",
  "key-429",
  "image-413",
]);
const USAGE_STATUSES = new Set<UsageStatus>([
  "reported",
  "unreported",
  "unsupported",
  "estimated",
]);

function isNonNegativeFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function normalizeAttemptUsage(raw: unknown): OcxUsage | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const usage = raw as Record<string, unknown>;
  if (!isNonNegativeFiniteNumber(usage.inputTokens)
    || !isNonNegativeFiniteNumber(usage.outputTokens)) return null;
  for (const key of [
    "totalTokens",
    "cachedInputTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "reasoningOutputTokens",
  ] as const) {
    if (key in usage && !isNonNegativeFiniteNumber(usage[key])) return null;
  }
  if ("estimated" in usage && typeof usage.estimated !== "boolean") return null;
  return normalizeUsageValue(usage as unknown as OcxUsage) ?? null;
}

function normalizeUsageAttempt(raw: unknown): PersistedUsageAttempt | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const attempt = raw as Record<string, unknown>;
  if (typeof attempt.ordinal !== "number" || !Number.isInteger(attempt.ordinal)
    || attempt.ordinal < 1
    || typeof attempt.provider !== "string" || !attempt.provider
    || typeof attempt.model !== "string" || !attempt.model
    || typeof attempt.adapter !== "string" || !attempt.adapter
    || typeof attempt.status !== "number" || !Number.isInteger(attempt.status)
    || attempt.status < 100 || attempt.status > 599
    || typeof attempt.durationMs !== "number" || !Number.isFinite(attempt.durationMs)
    || attempt.durationMs < 0
    || typeof attempt.sendCount !== "number" || !Number.isInteger(attempt.sendCount)
    || attempt.sendCount < 0
    || typeof attempt.usageStatus !== "string"
    || !USAGE_STATUSES.has(attempt.usageStatus as UsageStatus)) {
    return null;
  }
  if ("inputTokenEstimate" in attempt
    && !isNonNegativeFiniteNumber(attempt.inputTokenEstimate)) return null;
  if ("totalTokens" in attempt
    && !isNonNegativeFiniteNumber(attempt.totalTokens)) return null;
  const usage = "usage" in attempt ? normalizeAttemptUsage(attempt.usage) : undefined;
  if ("usage" in attempt && usage === null) return null;
  const recoveryKinds = Array.isArray(attempt.recoveryKinds)
    ? [...new Set(attempt.recoveryKinds.filter(
      (value): value is AttemptRecoveryKind => typeof value === "string"
        && ATTEMPT_RECOVERY_KINDS.has(value as AttemptRecoveryKind),
    ))]
    : [];
  return {
    ordinal: attempt.ordinal as number,
    provider: attempt.provider,
    model: attempt.model,
    adapter: attempt.adapter,
    status: attempt.status,
    durationMs: attempt.durationMs,
    sendCount: attempt.sendCount as number,
    recoveryKinds,
    usageStatus: attempt.usageStatus as UsageStatus,
    ...(isNonNegativeFiniteNumber(attempt.inputTokenEstimate)
      ? { inputTokenEstimate: attempt.inputTokenEstimate }
      : {}),
    ...(usage ? { usage } : {}),
    ...(isNonNegativeFiniteNumber(attempt.totalTokens)
      ? { totalTokens: attempt.totalTokens }
      : {}),
    ...(typeof attempt.errorCode === "string" ? { errorCode: attempt.errorCode } : {}),
  };
}

function normalizedAttempts(raw: unknown): PersistedUsageAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUsageAttempt)
    .filter((attempt): attempt is PersistedUsageAttempt => attempt !== null);
}

function normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  const attempts = normalizedAttempts(entry.attempts);
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    ...(entry.surface === "claude" ? { surface: entry.surface } : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    usageStatus: entry.usageStatus,
    ...(entry.usage ? { usage: normalizeUsageValue(entry.usage) } : {}),
    ...(typeof entry.totalTokens === "number" ? { totalTokens: entry.totalTokens } : {}),
    ...(attempts.length > 0 ? { attempts } : {}),
    ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
    ...(entry.terminalStatus ? { terminalStatus: entry.terminalStatus } : {}),
    ...(entry.closeReason ? { closeReason: entry.closeReason } : {}),
    ...(entry.upstreamError ? { upstreamError: entry.upstreamError } : {}),
  };
}

function ensureUsageLogDir(): void {
  const dir = getConfigDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(normalizeUsageEntry(entry))}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function readUsageEntries(): PersistedUsageEntry[] {
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, "utf-8").split(/\r?\n/);
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedUsageEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
        entries.push(normalizeUsageEntry(parsed));
      }
    } catch {
      /* keep reading after a partially written or hand-edited line */
    }
  }
  return entries;
}
