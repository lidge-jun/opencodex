import {
  finiteNonNegativeInt,
  isTelemetryStatsRange,
  safeAddInt,
  sumDisjointTokens,
} from "./format";
import type {
  DashboardFetchState,
  DownloadStats,
  TelemetryStatsRange,
  TelemetryStatsV1,
} from "./types";

export const DEFAULT_STATS_REQUEST_TIMEOUT_MS = 15_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isValidTelemetryStatsV1(value: unknown): value is TelemetryStatsV1 {
  if (!isPlainObject(value)) return false;
  if (value.schemaVersion !== 1) return false;
  if (typeof value.generatedAt !== "string") return false;
  if (!isTelemetryStatsRange(value.range)) return false;
  if (!isPlainObject(value.totals)) return false;
  if (!isPlainObject(value.totals.tokens)) return false;
  if (!isPlainObject(value.outcomes)) return false;
  if (
    !Array.isArray(value.daily) ||
    !Array.isArray(value.dailyByProvider) ||
    !Array.isArray(value.heatmap) ||
    !Array.isArray(value.providers) ||
    !Array.isArray(value.models) ||
    !Array.isArray(value.versions) ||
    !Array.isArray(value.platforms) ||
    !Array.isArray(value.channels) ||
    !Array.isArray(value.errors)
  ) {
    return false;
  }
  return true;
}

export function isStatsSnapshotEmpty(stats: TelemetryStatsV1): boolean {
  const totalTokens = sumDisjointTokens(stats.totals.tokens);
  const heatmap = Array.isArray(stats.heatmap) ? stats.heatmap : [];
  const hasHeatmapActivity = heatmap.some(
    (d) => isPlainObject(d) && finiteNonNegativeInt(d.activeInstalls) > 0,
  );
  return (
    finiteNonNegativeInt(stats.totals.activeInstalls) === 0 &&
    finiteNonNegativeInt(stats.totals.newInstalls) === 0 &&
    finiteNonNegativeInt(stats.totals.requests) === 0 &&
    totalTokens === 0 &&
    !hasHeatmapActivity
  );
}

export function createEmptyStatsSnapshot(
  range: TelemetryStatsRange = "30d",
): TelemetryStatsV1 {
  return {
    schemaVersion: 1,
    generatedAt: "",
    range,
    totals: {
      activeInstalls: 0,
      newInstalls: 0,
      activeMinutes: 0,
      requests: 0,
      tokens: {
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
      },
    },
    daily: [],
    dailyByProvider: [],
    heatmap: [],
    providers: [],
    models: [],
    versions: [],
    platforms: [],
    channels: [],
    outcomes: {
      completed: 0,
      failed: 0,
      incomplete: 0,
      aborted: 0,
    },
    errors: [],
  };
}

export interface StatsRequestTicket {
  readonly requestId: number;
  readonly range: TelemetryStatsRange;
  readonly signal: AbortSignal;
  isCurrent(): boolean;
  didTimeout(): boolean;
  finish(): void;
}

export interface StatsRequestSequencer {
  begin(range: TelemetryStatsRange, timeoutMs?: number): StatsRequestTicket;
  abortActive(): void;
  getCurrentRequestId(): number;
}

export function createStatsRequestSequencer(
  defaultTimeoutMs = DEFAULT_STATS_REQUEST_TIMEOUT_MS,
): StatsRequestSequencer {
  let currentRequestId = 0;
  let activeController: AbortController | null = null;
  let activeTimer: ReturnType<typeof setTimeout> | null = null;

  const clearActiveTimer = () => {
    if (activeTimer !== null) {
      clearTimeout(activeTimer);
      activeTimer = null;
    }
  };

  const abortActive = () => {
    clearActiveTimer();
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  };

  return {
    begin(range: TelemetryStatsRange, timeoutMs = defaultTimeoutMs): StatsRequestTicket {
      abortActive();
      currentRequestId += 1;
      const myRequestId = currentRequestId;
      const controller = new AbortController();
      activeController = controller;
      let timedOut = false;

      if (timeoutMs > 0 && Number.isFinite(timeoutMs)) {
        activeTimer = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);
      }

      return {
        requestId: myRequestId,
        range,
        signal: controller.signal,
        isCurrent: () => myRequestId === currentRequestId,
        didTimeout: () => timedOut,
        finish: () => {
          if (myRequestId === currentRequestId) {
            clearActiveTimer();
            if (activeController === controller) {
              activeController = null;
            }
          }
        },
      };
    },
    abortActive,
    getCurrentRequestId: () => currentRequestId,
  };
}

export async function fetchJsonWithTimeout(
  url: string | undefined,
  timeoutMs = DEFAULT_STATS_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
): Promise<unknown> {
  if (!url) return null;
  const controller = new AbortController();
  const timer =
    timeoutMs > 0 && Number.isFinite(timeoutMs)
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
  try {
    const res = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export interface ClassifyStatsInput {
  ok?: boolean;
  status?: number;
  body?: unknown;
  networkError?: boolean;
  errorMessage?: string;
}

export interface ClassifiedStatsResult {
  state: Exclude<DashboardFetchState, "loading">;
  stats: TelemetryStatsV1 | null;
  reason:
    | "ok"
    | "collector-not-deployed"
    | "no-reports-yet"
    | "http-error"
    | "invalid-payload"
    | "network-error";
  detail?: string;
}

export function classifyStatsResponse(
  input: ClassifyStatsInput,
): ClassifiedStatsResult {
  if (input.networkError) {
    return {
      state: "error",
      stats: null,
      reason: "network-error",
      detail: input.errorMessage ?? "Network request failed",
    };
  }

  const status = input.status ?? (input.ok ? 200 : 500);
  if (status === 404 || status === 502 || status === 503) {
    return {
      state: "empty",
      stats: null,
      reason: "collector-not-deployed",
      detail: `HTTP ${status}`,
    };
  }

  if (status < 200 || status >= 300 || input.ok === false) {
    return {
      state: "error",
      stats: null,
      reason: "http-error",
      detail: input.errorMessage ?? `HTTP ${status}`,
    };
  }

  if (!isValidTelemetryStatsV1(input.body)) {
    return {
      state: "error",
      stats: null,
      reason: "invalid-payload",
      detail: "Malformed TelemetryStatsV1 payload",
    };
  }

  if (isStatsSnapshotEmpty(input.body)) {
    return {
      state: "empty",
      stats: input.body,
      reason: "no-reports-yet",
    };
  }

  return {
    state: "ready",
    stats: input.body,
    reason: "ok",
  };
}

function parseNpmDownloadsCount(payload: unknown): number | null {
  if (!isPlainObject(payload)) return null;
  const raw = payload.downloads;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return null;
  return Math.floor(raw);
}

export function parseDownloadsPayload(input: {
  npmWeekly?: unknown;
  npmMonthly?: unknown;
  npmYearly?: unknown;
  githubReleases?: unknown;
}): DownloadStats {
  const npmWeekly = parseNpmDownloadsCount(input.npmWeekly);
  const npmMonthly = parseNpmDownloadsCount(input.npmMonthly);
  const npmYearly = parseNpmDownloadsCount(input.npmYearly);

  let githubTotalDownloads: number | null = null;
  let githubLatestTag: string | null = null;
  let githubLatestDownloads: number | null = null;
  let githubReleaseCount = 0;

  if (Array.isArray(input.githubReleases)) {
    let total = 0;
    for (const rel of input.githubReleases) {
      if (!isPlainObject(rel) || rel.draft === true) continue;
      githubReleaseCount += 1;
      const assets = Array.isArray(rel.assets) ? rel.assets : [];
      let releaseTotal = 0;
      for (const asset of assets) {
        if (!isPlainObject(asset)) continue;
        const count = finiteNonNegativeInt(asset.download_count);
        releaseTotal = safeAddInt(releaseTotal, count);
      }
      total = safeAddInt(total, releaseTotal);
      if (githubLatestTag === null && typeof rel.tag_name === "string" && rel.tag_name.trim()) {
        githubLatestTag = rel.tag_name.trim();
        githubLatestDownloads = releaseTotal;
      }
    }
    githubTotalDownloads = total;
  }

  return {
    npmWeekly,
    npmMonthly,
    npmYearly,
    githubTotalDownloads,
    githubLatestTag,
    githubLatestDownloads,
    githubReleaseCount,
  };
}
