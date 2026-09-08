import type { RetainedStoreSnapshot } from "../lib/app-owned-memory";
import type { GuardrailsTurn } from "./turn";

const MAX_GUARDRAILS_ACTIVITY_EVENTS = 1_000;
const MAX_GUARDRAILS_ACTIVITY_BYTES = 2 * 1024 * 1024;
const GUARDRAILS_ACTIVITY_TTL_MS = 60 * 60 * 1_000;
const MAX_EVENT_RULES = 32;
const MAX_EVENT_CATEGORIES = 16;

export type GuardrailsTelemetrySurface = "responses" | "chat" | "messages" | "compact";
export type GuardrailsTelemetryResult =
  | "scanned"
  | "masked"
  | "detected"
  | "blocked"
  | "passthrough"
  | "demask_warning"
  | "tool_argument_restore_skipped";

export interface GuardrailsActivityEvent {
  id: number;
  timestamp: number;
  surface: GuardrailsTelemetrySurface;
  mode: "enforce" | "detect";
  result: GuardrailsTelemetryResult;
  registryGeneration: number;
  count: number;
  categoryIds: number[];
  ruleIds: string[];
  latencyMs: number;
  severity: "info" | "warning" | "high";
}

interface StoredGuardrailsActivityEvent {
  event: GuardrailsActivityEvent;
  categoryContributions: Array<readonly [number, number]>;
  countedScan: boolean;
  ruleContributions: Array<readonly [string, number]>;
  sizeBytes: number;
}

export interface GuardrailsTelemetryCounters {
  scanned: number;
  masked: number;
  detected: number;
  blocked: number;
  passthrough: number;
  demaskWarning: number;
  toolArgumentRestoreSkipped: number;
}

const events: StoredGuardrailsActivityEvent[] = [];
const counters: GuardrailsTelemetryCounters = {
  scanned: 0,
  masked: 0,
  detected: 0,
  blocked: 0,
  passthrough: 0,
  demaskWarning: 0,
  toolArgumentRestoreSkipped: 0,
};
const ruleCounts = new Map<string, number>();
const categoryCounts = new Map<number, number>();
let retainedBytes = 0;
let evictedEvents = 0;
let nextEventId = 1;

function clampLatency(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(60 * 60_000, Math.round(value * 100) / 100))
    : 0;
}

function safeRuleId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-z0-9_.-]{1,128}$/.test(value) ? value : undefined;
}

function uniqueBounded<T>(values: readonly T[], limit: number): T[] {
  return [...new Set(values)].slice(0, limit);
}

function boundedContributions<T>(
  values: readonly T[],
  limit: number,
): Array<readonly [T, number]> {
  const contributions = new Map<T, number>();
  for (const value of values) {
    const previous = contributions.get(value);
    if (previous !== undefined) {
      contributions.set(value, previous + 1);
    } else if (contributions.size < limit) {
      contributions.set(value, 1);
    }
  }
  return [...contributions.entries()];
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? null : Buffer.byteLength(serialized, "utf8");
  } catch {
    return null;
  }
}

function decrementAggregate(entry: StoredGuardrailsActivityEvent): void {
  for (const [ruleId, contribution] of entry.ruleContributions) {
    const next = (ruleCounts.get(ruleId) ?? 0) - contribution;
    if (next > 0) ruleCounts.set(ruleId, next);
    else ruleCounts.delete(ruleId);
  }
  for (const [categoryId, contribution] of entry.categoryContributions) {
    const next = (categoryCounts.get(categoryId) ?? 0) - contribution;
    if (next > 0) categoryCounts.set(categoryId, next);
    else categoryCounts.delete(categoryId);
  }
  const { count, result } = entry.event;
  if (entry.countedScan) {
    counters.scanned = Math.max(0, counters.scanned - 1);
  }
  if (result === "masked") counters.masked = Math.max(0, counters.masked - count);
  if (result === "detected") counters.detected = Math.max(0, counters.detected - count);
  if (result === "blocked") counters.blocked = Math.max(0, counters.blocked - 1);
  if (result === "passthrough") counters.passthrough = Math.max(0, counters.passthrough - 1);
  if (result === "demask_warning") {
    counters.demaskWarning = Math.max(0, counters.demaskWarning - 1);
  }
  if (result === "tool_argument_restore_skipped") {
    counters.toolArgumentRestoreSkipped = Math.max(
      0,
      counters.toolArgumentRestoreSkipped - count,
    );
  }
}

function removeOldest(): number {
  const entry = events.shift();
  if (!entry) return 0;
  retainedBytes = Math.max(0, retainedBytes - entry.sizeBytes);
  decrementAggregate(entry);
  evictedEvents += 1;
  return entry.sizeBytes;
}

function prune(at = Date.now()): void {
  while (events[0] && at - events[0].event.timestamp > GUARDRAILS_ACTIVITY_TTL_MS) removeOldest();
  while (events.length > MAX_GUARDRAILS_ACTIVITY_EVENTS || retainedBytes > MAX_GUARDRAILS_ACTIVITY_BYTES) {
    if (removeOldest() === 0) break;
  }
}

function incrementCounter(
  result: GuardrailsTelemetryResult,
  count: number,
  countedScan: boolean,
): void {
  if (countedScan) counters.scanned += 1;
  if (result === "masked") counters.masked += count;
  if (result === "detected") counters.detected += count;
  if (result === "blocked") counters.blocked += 1;
  if (result === "passthrough") counters.passthrough += 1;
  if (result === "demask_warning") counters.demaskWarning += 1;
  if (result === "tool_argument_restore_skipped") counters.toolArgumentRestoreSkipped += count;
}

/** Best-effort metadata-only recorder. It never propagates observability failures. */
export function recordGuardrailsEvent(input: Omit<GuardrailsActivityEvent, "id" | "timestamp"> & {
  countAsScan?: boolean;
  timestamp?: number;
}): void {
  try {
    const timestamp = typeof input.timestamp === "number" && Number.isFinite(input.timestamp)
      ? input.timestamp
      : Date.now();
    const count = Number.isSafeInteger(input.count) ? Math.max(0, Math.min(4_096, input.count)) : 0;
    const safeRuleIds = input.ruleIds
      .map(safeRuleId)
      .filter((value): value is string => value !== undefined);
    const safeCategoryIds = input.categoryIds
      .filter(value => Number.isSafeInteger(value) && value >= 1 && value <= 6);
    const ruleContributions = boundedContributions(safeRuleIds, MAX_EVENT_RULES);
    const categoryContributions = boundedContributions(safeCategoryIds, MAX_EVENT_CATEGORIES);
    const ruleIds = uniqueBounded(ruleContributions.map(([id]) => id), MAX_EVENT_RULES);
    const categoryIds = uniqueBounded(categoryContributions.map(([id]) => id), MAX_EVENT_CATEGORIES);
    const event: GuardrailsActivityEvent = {
      id: nextEventId++,
      timestamp,
      surface: input.surface,
      mode: input.mode,
      result: input.result,
      registryGeneration: Number.isSafeInteger(input.registryGeneration)
        ? Math.max(0, input.registryGeneration)
        : 0,
      count,
      categoryIds,
      ruleIds,
      latencyMs: clampLatency(input.latencyMs),
      severity: input.severity,
    };
    const countedScan = input.countAsScan
      ?? (event.result === "scanned" || event.result === "masked" || event.result === "detected");
    const sizeBytes = serializedBytes({
      event,
      ruleContributions,
      categoryContributions,
      countedScan,
    });
    if (sizeBytes === null || sizeBytes > MAX_GUARDRAILS_ACTIVITY_BYTES) return;
    events.push({
      event,
      ruleContributions,
      categoryContributions,
      countedScan,
      sizeBytes,
    });
    retainedBytes += sizeBytes;
    incrementCounter(event.result, event.count, countedScan);
    for (const [ruleId, contribution] of ruleContributions) {
      ruleCounts.set(ruleId, (ruleCounts.get(ruleId) ?? 0) + contribution);
    }
    for (const [categoryId, contribution] of categoryContributions) {
      categoryCounts.set(categoryId, (categoryCounts.get(categoryId) ?? 0) + contribution);
    }
    prune(timestamp);
  } catch {
    // Telemetry is deliberately non-throwing and cannot change request policy.
  }
}

export function recordGuardrailsTurn(
  surface: GuardrailsTelemetrySurface,
  turn: GuardrailsTurn,
  latencyMs: number,
): void {
  const count = turn.findings.length;
  recordGuardrailsEvent({
    surface,
    mode: turn.mode,
    result: count === 0 ? "scanned" : turn.mode === "enforce" ? "masked" : "detected",
    registryGeneration: turn.snapshot.generation,
    count,
    categoryIds: turn.findings.map(finding => finding.dataType),
    ruleIds: turn.findings.map(finding => finding.ruleId),
    latencyMs,
    severity: "info",
  });
}

/**
 * Record findings introduced by a later local transformation without counting
 * another client request. Original values never enter this metadata-only event.
 */
export function recordGuardrailsTurnDelta(
  surface: GuardrailsTelemetrySurface,
  turn: GuardrailsTurn,
  fromFindingIndex: number,
  latencyMs: number,
): void {
  const findings = turn.findings.slice(Math.max(0, fromFindingIndex));
  if (findings.length === 0) return;
  recordGuardrailsEvent({
    surface,
    mode: turn.mode,
    result: turn.mode === "enforce" ? "masked" : "detected",
    registryGeneration: turn.snapshot.generation,
    count: findings.length,
    categoryIds: findings.map(finding => finding.dataType),
    ruleIds: findings.map(finding => finding.ruleId),
    latencyMs,
    severity: "info",
    countAsScan: false,
  });
}

export function recordGuardrailsToolArgumentRestoreSkipped(
  surface: GuardrailsTelemetrySurface,
  turn: GuardrailsTurn | undefined,
  count: number,
): void {
  if (!turn || count <= 0) return;
  recordGuardrailsEvent({
    surface,
    mode: turn.mode,
    result: "tool_argument_restore_skipped",
    registryGeneration: turn.snapshot.generation,
    count,
    categoryIds: [],
    ruleIds: [],
    latencyMs: 0,
    severity: "info",
  });
}

function ranked<T extends string | number>(source: ReadonlyMap<T, number>, limit = 10): Array<{
  id: T;
  count: number;
}> {
  return [...source.entries()]
    .sort((left, right) => right[1] - left[1] || String(left[0]).localeCompare(String(right[0])))
    .slice(0, limit)
    .map(([id, count]) => ({ id, count }));
}

function lastEventTimestamp(result: GuardrailsTelemetryResult): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    if (events[index]!.event.result === result) return events[index]!.event.timestamp;
  }
  return null;
}

export function guardrailsTelemetryOverview() {
  prune();
  return {
    counters: { ...counters },
    topRules: ranked(ruleCounts),
    topCategories: ranked(categoryCounts),
    recentEvents: events.slice(-10).reverse().map(entry => structuredClone(entry.event)),
    lastPassthroughAt: lastEventTimestamp("passthrough"),
    retention: {
      kind: "in-memory" as const,
      ttlMs: GUARDRAILS_ACTIVITY_TTL_MS,
      maxEvents: MAX_GUARDRAILS_ACTIVITY_EVENTS,
      maxBytes: MAX_GUARDRAILS_ACTIVITY_BYTES,
      currentEvents: events.length,
      currentBytes: retainedBytes,
      evictedEvents,
      oldestAt: events[0]?.event.timestamp ?? null,
      lastEventAt: events.at(-1)?.event.timestamp ?? null,
    },
  };
}

export function guardrailsActivity(options: {
  category?: number;
  limit?: number;
  mode?: "enforce" | "detect";
  result?: GuardrailsTelemetryResult;
  surface?: GuardrailsTelemetrySurface;
} = {}) {
  prune();
  const limit = Number.isSafeInteger(options.limit) ? Math.max(1, Math.min(200, options.limit!)) : 100;
  const filtered = events
    .filter(entry => options.category === undefined || entry.event.categoryIds.includes(options.category))
    .filter(entry => options.mode === undefined || entry.event.mode === options.mode)
    .filter(entry => options.result === undefined || entry.event.result === options.result)
    .filter(entry => options.surface === undefined || entry.event.surface === options.surface);
  const filteredRuleCounts = new Map<string, number>();
  const filteredCategoryCounts = new Map<number, number>();
  let findingCount = 0;
  let totalLatencyMs = 0;
  for (const entry of filtered) {
    if (entry.event.result === "masked" || entry.event.result === "detected") {
      findingCount += entry.event.count;
    }
    totalLatencyMs += entry.event.latencyMs;
    for (const [ruleId, contribution] of entry.ruleContributions) {
      filteredRuleCounts.set(ruleId, (filteredRuleCounts.get(ruleId) ?? 0) + contribution);
    }
    for (const [categoryId, contribution] of entry.categoryContributions) {
      filteredCategoryCounts.set(categoryId, (filteredCategoryCounts.get(categoryId) ?? 0) + contribution);
    }
  }
  return {
    events: filtered.slice(-limit).reverse().map(entry => structuredClone(entry.event)),
    totalMatching: filtered.length,
    filteredSummary: {
      eventCount: filtered.length,
      findingCount,
      averageLatencyMs: filtered.length === 0 ? 0 : totalLatencyMs / filtered.length,
      topRules: ranked(filteredRuleCounts),
      topCategories: ranked(filteredCategoryCounts),
    },
    ...guardrailsTelemetryOverview(),
  };
}

export function sweepExpiredGuardrailsActivity(at = Date.now()): number {
  const before = events.length;
  prune(at);
  return before - events.length;
}

export function guardrailsActivityRetainedStoreSnapshot(): RetainedStoreSnapshot {
  prune();
  return {
    count: events.length,
    bytes: retainedBytes,
    evictableBytes: retainedBytes,
    pinnedBytes: 0,
    oldestAt: events[0]?.event.timestamp ?? null,
  };
}

export function evictOldestGuardrailsActivityForBudget(): number {
  return removeOldest();
}

export function clearGuardrailsTelemetryForTests(): void {
  events.splice(0, events.length);
  retainedBytes = 0;
  evictedEvents = 0;
  nextEventId = 1;
  ruleCounts.clear();
  categoryCounts.clear();
  for (const key of Object.keys(counters) as Array<keyof GuardrailsTelemetryCounters>) counters[key] = 0;
}
