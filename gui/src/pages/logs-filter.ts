import { matchesLogConversationId } from "../log-conversation-id";
import type { LogSurface, LogSurfaceFilter } from "./logs-surface-filter";
import { logMatchesSurface } from "./logs-surface-filter";

export type LogTimeWindow = "all" | "15m" | "1h" | "24h";
export type LogStatusFilter = "all" | "success" | "errors";

export interface LogFilterState {
  surface: LogSurfaceFilter;
  model: string;
  provider: string;
  status: LogStatusFilter;
  timeWindow: LogTimeWindow;
  minTokPerSec?: number;
  maxTokPerSec?: number;
  interceptedOnly: boolean;
  conversationId: string;
  conversationQueryHash?: string;
}

export const DEFAULT_LOG_FILTER_STATE: LogFilterState = {
  surface: "all",
  model: "",
  provider: "",
  status: "all",
  timeWindow: "all",
  interceptedOnly: false,
  conversationId: "",
};

export interface FilterableLogAttempt {
  provider?: unknown;
  model?: unknown;
}

export interface FilterableLogEntry {
  timestamp?: unknown;
  model?: unknown;
  resolvedModel?: unknown;
  provider?: unknown;
  surface?: LogSurface;
  status?: unknown;
  conversationId?: string;
  shadowCallRewrittenFrom?: unknown;
  attempts?: unknown;
  displayMetrics?: {
    tokPerSecond?: { kind: "value"; value: number } | { kind: "unavailable" };
  };
}

export function hasActiveLogFilters(filters: LogFilterState): boolean {
  return filters.surface !== "all"
    || filters.model.trim() !== ""
    || filters.provider.trim() !== ""
    || filters.status !== "all"
    || filters.timeWindow !== "all"
    || filters.minTokPerSec !== undefined
    || filters.maxTokPerSec !== undefined
    || filters.interceptedOnly
    || filters.conversationId.trim() !== "";
}

function attempts(log: FilterableLogEntry): FilterableLogAttempt[] {
  if (!Array.isArray(log.attempts)) return [];
  return log.attempts.filter(
    (attempt): attempt is FilterableLogAttempt => attempt !== null && typeof attempt === "object",
  );
}

function normalized(value: unknown): string | undefined {
  return typeof value === "string" ? value.toLowerCase() : undefined;
}

function timeThreshold(window: LogTimeWindow, now: number): number | undefined {
  if (window === "15m") return now - 15 * 60 * 1000;
  if (window === "1h") return now - 60 * 60 * 1000;
  if (window === "24h") return now - 24 * 60 * 60 * 1000;
  return undefined;
}

export function filterLogs<T extends FilterableLogEntry>(
  logs: readonly T[],
  filters: LogFilterState,
  now: number = Date.now(),
): T[] {
  const modelQuery = filters.model.trim().toLowerCase();
  const providerQuery = filters.provider.trim().toLowerCase();
  const conversationQuery = filters.conversationId.trim();
  const since = timeThreshold(filters.timeWindow, now);

  return logs.filter(log => {
    if (!logMatchesSurface(log, filters.surface)) return false;
    if (filters.interceptedOnly && typeof log.shadowCallRewrittenFrom !== "string") return false;
    if (conversationQuery && !matchesLogConversationId(
      log.conversationId,
      conversationQuery,
      filters.conversationQueryHash,
    )) return false;

    if (filters.status === "success"
      && (typeof log.status !== "number" || log.status < 200 || log.status >= 300)) return false;
    if (filters.status === "errors"
      && (typeof log.status !== "number" || log.status < 400)) return false;

    const logAttempts = attempts(log);
    if (modelQuery && ![
      normalized(log.model),
      normalized(log.resolvedModel),
      ...logAttempts.map(attempt => normalized(attempt.model)),
    ].some(value => value?.includes(modelQuery))) return false;

    if (providerQuery && ![
      normalized(log.provider),
      ...logAttempts.map(attempt => normalized(attempt.provider)),
    ].some(value => value === providerQuery)) return false;

    if (since !== undefined
      && (typeof log.timestamp !== "number" || !Number.isFinite(log.timestamp) || log.timestamp < since)) return false;

    const tokPerSecond = log.displayMetrics?.tokPerSecond?.kind === "value"
      && Number.isFinite(log.displayMetrics.tokPerSecond.value)
      ? log.displayMetrics.tokPerSecond.value
      : undefined;
    if (filters.minTokPerSec !== undefined
      && (tokPerSecond === undefined || tokPerSecond < filters.minTokPerSec)) return false;
    if (filters.maxTokPerSec !== undefined
      && (tokPerSecond === undefined || tokPerSecond >= filters.maxTokPerSec)) return false;

    return true;
  });
}

export function extractLogFilterOptions(logs: readonly FilterableLogEntry[]): {
  models: string[];
  providers: string[];
} {
  const models = new Set<string>();
  const providers = new Set<string>();
  for (const log of logs) {
    for (const value of [log.model, log.resolvedModel, ...attempts(log).map(attempt => attempt.model)]) {
      if (typeof value === "string" && value.trim()) models.add(value);
    }
    for (const value of [log.provider, ...attempts(log).map(attempt => attempt.provider)]) {
      if (typeof value === "string" && value.trim()) providers.add(value);
    }
  }
  return {
    models: [...models].sort(),
    providers: [...providers].sort(),
  };
}
