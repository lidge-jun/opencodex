import {
  GITHUB_RELEASES_MAX_PAGES,
  GITHUB_RELEASES_PER_PAGE,
} from "./constants";
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
  if (
    value.totals.avgDailyActiveInstalls !== undefined &&
    (typeof value.totals.avgDailyActiveInstalls !== "number" ||
      !Number.isFinite(value.totals.avgDailyActiveInstalls) ||
      value.totals.avgDailyActiveInstalls < 0)
  ) {
    return false;
  }
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
      avgDailyActiveInstalls: 0,
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

export function parseGithubNextLink(
  linkHeader: string | null | undefined,
  currentUrl?: string,
): string | null {
  if (!linkHeader || typeof linkHeader !== "string") return null;
  for (const part of linkHeader.split(",")) {
    const urlMatch = /<([^>]+)>/.exec(part);
    if (!urlMatch?.[1]) continue;
    const params = part.slice(urlMatch.index + urlMatch[0].length);
    if (!/;\s*rel\s*=\s*(?:"next"|'next'|next\b)/i.test(params)) continue;
    try {
      const parsed = currentUrl
        ? new URL(urlMatch[1].trim(), currentUrl)
        : new URL(urlMatch[1].trim());
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return null;
      }
      if (currentUrl) {
        const base = new URL(currentUrl);
        if (parsed.origin !== base.origin) return null;
      }
      return parsed.toString();
    } catch {
      return null;
    }
  }
  return null;
}

export interface GithubReleasesFetchResult {
  releases: unknown[] | null;
  partial: boolean;
  pagesFetched: number;
}

export async function fetchGithubReleasesPages(
  initialUrl: string | undefined,
  timeoutMs = DEFAULT_STATS_REQUEST_TIMEOUT_MS,
  fetchImpl: typeof fetch = fetch,
  maxPages = GITHUB_RELEASES_MAX_PAGES,
): Promise<GithubReleasesFetchResult> {
  if (!initialUrl) {
    return { releases: null, partial: false, pagesFetched: 0 };
  }
  const pageCap = Math.max(1, Math.floor(maxPages));
  let nextUrl: string | null = null;
  try {
    const normalized = new URL(initialUrl);
    if (!normalized.searchParams.has("per_page")) {
      normalized.searchParams.set("per_page", String(GITHUB_RELEASES_PER_PAGE));
    }
    nextUrl = normalized.toString();
  } catch {
    nextUrl = initialUrl;
  }

  const allReleases: unknown[] = [];
  let pagesFetched = 0;

  while (nextUrl && pagesFetched < pageCap) {
    const controller = new AbortController();
    const timer =
      timeoutMs > 0 && Number.isFinite(timeoutMs)
        ? setTimeout(() => controller.abort(), timeoutMs)
        : null;
    let res: Response;
    try {
      res = await fetchImpl(nextUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
    } catch {
      if (timer !== null) clearTimeout(timer);
      return pagesFetched === 0
        ? { releases: null, partial: false, pagesFetched: 0 }
        : { releases: allReleases, partial: true, pagesFetched };
    }
    let pageBody: unknown;
    try {
      if (!res.ok) {
        return pagesFetched === 0
          ? { releases: null, partial: false, pagesFetched: 0 }
          : { releases: allReleases, partial: true, pagesFetched };
      }
      pageBody = await res.json();
    } catch {
      return pagesFetched === 0
        ? { releases: null, partial: false, pagesFetched: 0 }
        : { releases: allReleases, partial: true, pagesFetched };
    } finally {
      if (timer !== null) clearTimeout(timer);
    }

    if (!Array.isArray(pageBody)) {
      return pagesFetched === 0
        ? { releases: null, partial: false, pagesFetched: 0 }
        : { releases: allReleases, partial: true, pagesFetched };
    }

    pagesFetched += 1;
    allReleases.push(...pageBody);

    const linkHeader = res.headers?.get?.("link") ?? null;
    const linkedNext = parseGithubNextLink(linkHeader, nextUrl);
    if (!linkedNext) {
      return { releases: allReleases, partial: false, pagesFetched };
    }
    if (pagesFetched >= pageCap) {
      return { releases: allReleases, partial: true, pagesFetched };
    }
    nextUrl = linkedNext;
  }

  return {
    releases: pagesFetched > 0 ? allReleases : null,
    partial: false,
    pagesFetched,
  };
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
  githubDownloadsPartial?: boolean;
}): DownloadStats {
  const npmWeekly = parseNpmDownloadsCount(input.npmWeekly);
  const npmMonthly = parseNpmDownloadsCount(input.npmMonthly);
  const npmYearly = parseNpmDownloadsCount(input.npmYearly);

  let githubTotalDownloads: number | null = null;
  let githubDownloadsPartial = Boolean(input.githubDownloadsPartial);
  let githubLatestTag: string | null = null;
  let githubLatestDownloads: number | null = null;
  let githubReleaseCount = 0;

  let releasesArray: unknown[] | null = null;
  if (Array.isArray(input.githubReleases)) {
    releasesArray = input.githubReleases;
  } else if (
    isPlainObject(input.githubReleases) &&
    Array.isArray(input.githubReleases.releases)
  ) {
    releasesArray = input.githubReleases.releases;
    if (typeof input.githubReleases.partial === "boolean") {
      githubDownloadsPartial = input.githubReleases.partial;
    }
  }

  if (releasesArray) {
    let total = 0;
    for (const rel of releasesArray) {
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
      // Previews count toward the totals, but "latest release" is the newest stable one.
      if (githubLatestTag === null && rel.prerelease !== true && typeof rel.tag_name === "string" && rel.tag_name.trim()) {
        githubLatestTag = rel.tag_name.trim();
        githubLatestDownloads = releaseTotal;
      }
    }
    githubTotalDownloads = total;
  } else {
    githubDownloadsPartial = false;
  }

  return {
    npmWeekly,
    npmMonthly,
    npmYearly,
    githubTotalDownloads,
    githubDownloadsPartial,
    githubLatestTag,
    githubLatestDownloads,
    githubReleaseCount,
  };
}
