import { chmodSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../config";
import { recordOwnedConfigPath } from "../lib/config-ownership";
import { usageDisplayTotalTokens } from "./totals";
import type { OcxUsage } from "../types";

export type UsageStatus = "reported" | "unreported" | "unsupported" | "estimated";

export type AttemptRecoveryKind =
  | "transient-5xx"
  | "connection-reset"
  | "oauth-401"
  | "key-429"
  | "anthropic-oauth-429"
  | "image-413";

export interface PersistedUsageAttempt {
  ordinal: number;
  provider: string;
  model: string;
  adapter: string;
  status: number;
  durationMs: number;
  /** TTFT relative to THIS attempt's start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
  sendCount: number;
  recoveryKinds: AttemptRecoveryKind[];
  usageStatus: UsageStatus;
  inputTokenEstimate?: number;
  usage?: OcxUsage;
  totalTokens?: number;
  errorCode?: string;
  /** Target-specific reasoning intent and exact adapter-normalized wire parameter. */
  requestedEffort?: string;
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
}

export interface PersistedUsageEntry {
  requestId: string;
  timestamp: number;
  provider: string;
  model: string;
  surface?: "claude" | "claude-desktop" | "grok";
  /** Best-effort chat/session correlation for Logs grouping (#330). */
  conversationId?: string;
  resolvedModel?: string;
  requestedModel?: string;
  /** Reasoning effort / service-tier metadata for GUI Logs after restart. */
  requestedEffort?: string;
  /** Adapter-normalized tier and exact upstream parameter emitted for this request. */
  effectiveEffort?: string;
  reasoningWireField?: string;
  reasoningWireValue?: string | number;
  requestedServiceTier?: string;
  requestedSpeedLabel?: string;
  configuredServiceTier?: string;
  configuredSpeedLabel?: string;
  modelSupportsServiceTier?: boolean;
  responseServiceTier?: string;
  status: number;
  durationMs: number;
  /** TTFT relative to the request start (WP4); unset for non-streaming/tool-only. */
  firstOutputMs?: number;
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

const KNOWN_USAGE_SURFACES = new Set<NonNullable<PersistedUsageEntry["surface"]>>([
  "claude",
  "claude-desktop",
  "grok",
]);

/**
 * The serializer guard for `surface`. Two failure modes shaped this: a literal
 * whitelist ("claude" | "claude-desktop" only) silently dropped every NEW surface at
 * write time, while a plain truthy spread would persist junk values from hand-edited
 * logs. Membership in this set is the middle path: adding a surface here is one edit,
 * and unknown values are still dropped.
 */
export function isKnownUsageSurface(value: unknown): value is NonNullable<PersistedUsageEntry["surface"]> {
  return typeof value === "string" && KNOWN_USAGE_SURFACES.has(value as NonNullable<PersistedUsageEntry["surface"]>);
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
  "anthropic-oauth-429",
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
  if ("firstOutputMs" in attempt
    && !isNonNegativeFiniteNumber(attempt.firstOutputMs)) return null;
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
    ...(isNonNegativeFiniteNumber(attempt.firstOutputMs)
      ? { firstOutputMs: attempt.firstOutputMs }
      : {}),
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
    ...(typeof attempt.requestedEffort === "string" && attempt.requestedEffort
      ? { requestedEffort: capMetadataString(attempt.requestedEffort) }
      : {}),
    ...(typeof attempt.effectiveEffort === "string" && attempt.effectiveEffort
      ? { effectiveEffort: capMetadataString(attempt.effectiveEffort) }
      : {}),
    ...(typeof attempt.reasoningWireField === "string" && attempt.reasoningWireField
      ? { reasoningWireField: capMetadataString(attempt.reasoningWireField) }
      : {}),
    ...(typeof attempt.reasoningWireValue === "string" && attempt.reasoningWireValue
      ? { reasoningWireValue: capMetadataString(attempt.reasoningWireValue) }
      : isNonNegativeFiniteNumber(attempt.reasoningWireValue)
        ? { reasoningWireValue: attempt.reasoningWireValue }
        : {}),
  };
}

function normalizedAttempts(raw: unknown): PersistedUsageAttempt[] {
  if (!Array.isArray(raw)) return [];
  return raw.map(normalizeUsageAttempt)
    .filter((attempt): attempt is PersistedUsageAttempt => attempt !== null);
}

const MAX_METADATA_STRING_LEN = 64;
function capMetadataString(s: string): string {
  return s.length > MAX_METADATA_STRING_LEN ? s.slice(0, MAX_METADATA_STRING_LEN) : s;
}

function normalizeUsageEntry(entry: PersistedUsageEntry): PersistedUsageEntry {
  const attempts = normalizedAttempts(entry.attempts);
  return {
    requestId: entry.requestId,
    timestamp: entry.timestamp,
    provider: entry.provider,
    model: entry.model,
    ...(isKnownUsageSurface(entry.surface) ? { surface: entry.surface } : {}),
    ...(typeof entry.conversationId === "string" && entry.conversationId.trim()
      ? { conversationId: entry.conversationId.trim().slice(0, 128) }
      : {}),
    ...(entry.resolvedModel ? { resolvedModel: entry.resolvedModel } : {}),
    ...(entry.requestedModel ? { requestedModel: entry.requestedModel } : {}),
    ...(typeof entry.requestedEffort === "string" && entry.requestedEffort
      ? { requestedEffort: capMetadataString(entry.requestedEffort) }
      : {}),
    ...(typeof entry.effectiveEffort === "string" && entry.effectiveEffort
      ? { effectiveEffort: capMetadataString(entry.effectiveEffort) }
      : {}),
    ...(typeof entry.reasoningWireField === "string" && entry.reasoningWireField
      ? { reasoningWireField: capMetadataString(entry.reasoningWireField) }
      : {}),
    ...(typeof entry.reasoningWireValue === "string" && entry.reasoningWireValue
      ? { reasoningWireValue: capMetadataString(entry.reasoningWireValue) }
      : isNonNegativeFiniteNumber(entry.reasoningWireValue)
        ? { reasoningWireValue: entry.reasoningWireValue }
        : {}),
    ...(typeof entry.requestedServiceTier === "string" && entry.requestedServiceTier
      ? { requestedServiceTier: capMetadataString(entry.requestedServiceTier) }
      : {}),
    ...(typeof entry.requestedSpeedLabel === "string" && entry.requestedSpeedLabel
      ? { requestedSpeedLabel: capMetadataString(entry.requestedSpeedLabel) }
      : {}),
    ...(typeof entry.configuredServiceTier === "string" && entry.configuredServiceTier
      ? { configuredServiceTier: capMetadataString(entry.configuredServiceTier) }
      : {}),
    ...(typeof entry.configuredSpeedLabel === "string" && entry.configuredSpeedLabel
      ? { configuredSpeedLabel: capMetadataString(entry.configuredSpeedLabel) }
      : {}),
    ...(typeof entry.modelSupportsServiceTier === "boolean"
      ? { modelSupportsServiceTier: entry.modelSupportsServiceTier }
      : {}),
    ...(typeof entry.responseServiceTier === "string" && entry.responseServiceTier
      ? { responseServiceTier: capMetadataString(entry.responseServiceTier) }
      : {}),
    status: entry.status,
    durationMs: entry.durationMs,
    ...(isNonNegativeFiniteNumber(entry.firstOutputMs)
      ? { firstOutputMs: entry.firstOutputMs }
      : {}),
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
  recordOwnedConfigPath(dir, usageLogPath());
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* best-effort on platforms that ignore chmod */ }
}

export function appendUsageEntry(entry: PersistedUsageEntry): void {
  ensureUsageLogDir();
  const path = usageLogPath();
  appendFileSync(path, `${JSON.stringify(normalizeUsageEntry(entry))}\n`, { encoding: "utf-8", mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* best-effort on platforms that ignore chmod */ }
}

export type UsageLogRevision = {
  path: string;
  dev: number;
  ino: number;
  birthtimeMs: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

let usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
let managementUsageReadInflight: {
  key: string;
  promise: Promise<{ entries: PersistedUsageEntry[]; revision: UsageLogRevision }>;
} | null = null;

/** Test-only observability for proving that unchanged prefixes are not reparsed. */
export function usageReadCacheStatsForTests(): Readonly<typeof usageReadCacheStats> {
  return { ...usageReadCacheStats };
}

export function resetUsageReadCacheForTests(): void {
  usageReadCacheStats = { fullReads: 0, tailReads: 0, parsedLines: 0 };
  managementUsageReadInflight = null;
}

function readExactly(fd: number, length: number, position: number): Buffer | null {
  const output = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const read = readSync(fd, output, offset, length - offset, position + offset);
    if (read === 0) return null;
    offset += read;
  }
  return output;
}

function usageLogRevision(path: string, stat: ReturnType<typeof fstatSync>): UsageLogRevision {
  if (!stat.isFile()) throw new Error("usage log is not a regular file");
  return {
    path,
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtimeMs: Number(stat.birthtimeMs),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

export function usageLogRevisionKey(revision: UsageLogRevision | null): string {
  if (!revision) return "missing";
  return [
    revision.path,
    revision.dev,
    revision.ino,
    revision.birthtimeMs,
    revision.size,
    revision.mtimeMs,
    revision.ctimeMs,
  ].join("\0");
}

export function currentUsageLogRevision(): UsageLogRevision | null {
  const path = usageLogPath();
  if (!existsSync(path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    return usageLogRevision(path, fstatSync(fd));
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

async function parseUsageTextCooperatively(text: string): Promise<PersistedUsageEntry[]> {
  const lines = text.split(/\r?\n/);
  usageReadCacheStats.parsedLines += lines.filter(line => line.trim()).length;
  const entries: PersistedUsageEntry[] = [];
  const batchSize = 1_000;
  for (let offset = 0; offset < lines.length; offset += batchSize) {
    entries.push(...parseUsageLines(lines.slice(offset, offset + batchSize)));
    if (offset + batchSize < lines.length) {
      // JSON parsing dominates large-log startup. Yield between bounded batches so
      // Bun can continue serving health and settings requests on the same thread.
      await new Promise<void>(resolve => setTimeout(resolve, 0));
    }
  }
  return entries;
}

async function readUsageEntriesFullCooperatively(
  path: string,
): Promise<{ entries: PersistedUsageEntry[]; revision: UsageLogRevision }> {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const stat = fstatSync(fd);
    const size = Number(stat.size);
    const bytes = readExactly(fd, size, 0);
    if (bytes === null) throw new Error("usage log changed while it was being read");
    const entries = await parseUsageTextCooperatively(bytes.toString("utf-8"));
    usageReadCacheStats.fullReads += 1;
    return { entries, revision: usageLogRevision(path, stat) };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Management API reader: full parses yield between bounded batches and concurrent
 * callers share work only when they observed the same exact file revision. Parsed rows
 * are returned to the request and never retained in module state.
 */
export async function readUsageSnapshotForManagement(): Promise<{
  entries: PersistedUsageEntry[];
  revision: UsageLogRevision | null;
}> {
  const path = usageLogPath();
  if (!existsSync(path)) return { entries: [], revision: null };
  const observed = currentUsageLogRevision();
  const key = usageLogRevisionKey(observed);
  if (managementUsageReadInflight?.key === key) {
    const shared = await managementUsageReadInflight.promise;
    return { entries: shared.entries.slice(), revision: shared.revision };
  }
  const promise = readUsageEntriesFullCooperatively(path);
  managementUsageReadInflight = { key, promise };
  try {
    return await promise;
  } finally {
    if (managementUsageReadInflight?.promise === promise) managementUsageReadInflight = null;
  }
}

export async function readUsageEntriesForManagement(): Promise<PersistedUsageEntry[]> {
  return (await readUsageSnapshotForManagement()).entries;
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

function parseUsageLines(lines: string[]): PersistedUsageEntry[] {
  const entries: PersistedUsageEntry[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PersistedUsageEntry;
      if (parsed && typeof parsed === "object" && typeof parsed.requestId === "string") {
        entries.push(normalizeUsageEntry(parsed));
      }
    } catch {
      /* skip partial / hand-edited lines */
    }
  }
  return entries;
}

/**
 * Read only the newest `limit` usage.jsonl rows without loading the whole append-only
 * file into memory. Used by request-log hydration on `ocx start`.
 */
export function readRecentUsageEntries(limit: number): PersistedUsageEntry[] {
  if (!Number.isFinite(limit) || limit <= 0) return [];
  const path = usageLogPath();
  if (!existsSync(path)) return [];
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size;
    if (size <= 0) return [];
    // ~4 KiB/row budget with a floor; expand once if the window yields too few lines.
    let windowBytes = Math.min(size, Math.max(64 * 1024, Math.ceil(limit) * 4 * 1024));
    for (let attempt = 0; attempt < 2; attempt++) {
      const start = Math.max(0, size - windowBytes);
      const buf = Buffer.alloc(size - start);
      readSync(fd, buf, 0, buf.length, start);
      let text = buf.toString("utf-8");
      if (start > 0) {
        const nl = text.indexOf("\n");
        if (nl < 0) {
          if (start === 0) break;
          windowBytes = Math.min(size, windowBytes * 4);
          continue;
        }
        text = text.slice(nl + 1);
      }
      const lines = text.split(/\r?\n/).filter(line => line.trim());
      // Parse ALL lines first, then take the last N valid entries. This way corrupt
      // or partial lines are filtered out during parsing and we always return the
      // most recent N valid rows (not N physical lines minus corrupt ones).
      const entries = parseUsageLines(lines);
      if (entries.length >= limit || start === 0 || windowBytes >= size) return entries.slice(-limit);
      windowBytes = Math.min(size, windowBytes * 4);
    }
    return [];
  } catch {
    return [];
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}
