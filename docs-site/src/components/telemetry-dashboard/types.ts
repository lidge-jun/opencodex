export type TelemetryStatsRange = "7d" | "30d" | "90d" | "365d";

/**
 * Public response contract of `GET https://telemetry.opencodex.me/v1/stats`.
 * Kept in lockstep with `services/telemetry-collector/src/types.ts` and
 * verified by `tests/ci-workflows/docs-telemetry-dashboard.test.ts`.
 */
export type TelemetryStatsV1 = {
  schemaVersion: 1;
  generatedAt: string;
  range: TelemetryStatsRange;
  totals: {
    activeInstalls: number;
    avgDailyActiveInstalls?: number;
    newInstalls: number;
    activeMinutes: number;
    requests: number;
    tokens: {
      input: number;
      cacheRead: number;
      cacheWrite: number;
      output: number;
      reasoning: number;
    };
  };
  daily: Array<{
    day: string;
    activeInstalls: number;
    newInstalls: number;
    activeMinutes: number;
    requests: number;
    failed: number;
    tokens: number;
  }>;
  dailyByProvider: Array<{
    day: string;
    providerKind: string;
    requests: number;
    tokens: number;
  }>;
  heatmap: Array<{
    day: string;
    activeInstalls: number;
  }>;
  providers: Array<{
    providerKind: string;
    requests: number;
    tokens: number;
  }>;
  models: Array<{
    modelFamily: string;
    requests: number;
    tokens: number;
  }>;
  versions: Array<{
    version: string;
    installs: number;
    newInstalls: number;
  }>;
  platforms: Array<{
    os: string;
    arch: string;
    installs: number;
  }>;
  channels: Array<{
    installChannel: string;
    installs: number;
    newInstalls: number;
  }>;
  outcomes: {
    completed: number;
    failed: number;
    incomplete: number;
    aborted: number;
  };
  errors: Array<{
    cause: string;
    count: number;
  }>;
};

export type HeatmapGrade = 0 | 1 | 2 | 3 | 4;

export type KpiMetricId =
  | "activeInstalls"
  | "newInstalls"
  | "requests"
  | "tokens"
  | "activeHours";

export interface KpiCardItem {
  id: KpiMetricId;
  rawValue: number;
  compact: string;
  exactTitle: string;
}

export type TokenBucketId =
  | "input"
  | "cacheRead"
  | "cacheWrite"
  | "output"
  | "reasoning";

export interface TokenMixSegment {
  id: TokenBucketId;
  value: number;
  compact: string;
  exactTitle: string;
  percent: number;
  percentLabel: string;
  color: string;
}

export interface TokenMixSummary {
  totalTokens: number;
  totalCompact: string;
  totalExactTitle: string;
  segments: TokenMixSegment[];
}

export interface HeatmapCell {
  date: string;
  activeInstalls: number;
  grade: HeatmapGrade;
  inRange: boolean;
  selectable: boolean;
  weekIndex: number;
  dayOfWeek: number;
}

export interface HeatmapMonthMarker {
  label: string;
  monthIndex: number;
  weekIndex: number;
}

export interface HeatmapCalendar {
  cells: HeatmapCell[];
  weekCount: number;
  activeDays: number;
  totalActiveInstalls: number;
  maxActiveInstalls: number;
  peakDay: { date: string; activeInstalls: number } | null;
  startDate: string | null;
  endDate: string | null;
  monthMarkers: HeatmapMonthMarker[];
}

export type DailyChartMetric = "tokens" | "requests";

export interface DailyProviderSeries {
  providerKind: string;
  color: string;
  total: number;
  values: number[];
}

export interface StackedDailyChartModel {
  days: string[];
  metric: DailyChartMetric;
  total: number;
  series: DailyProviderSeries[];
}

export interface ShareRow {
  key: string;
  label: string;
  color: string;
  requests: number;
  requestsCompact: string;
  requestsExact: string;
  requestSharePercent: number;
  requestShareLabel: string;
  tokens: number;
  tokensCompact: string;
  tokensExact: string;
  tokenSharePercent: number;
  tokenShareLabel: string;
}

export interface InstallRow {
  key: string;
  label: string;
  installs: number;
  installsCompact: string;
  installsExact: string;
  newInstalls?: number;
  newInstallsCompact?: string;
  newInstallsExact?: string;
  sharePercent: number;
  shareLabel: string;
}

export type OutcomeClassId = "completed" | "failed" | "incomplete" | "aborted";

export interface OutcomeRow {
  key: OutcomeClassId;
  count: number;
  compact: string;
  exact: string;
  sharePercent: number;
  shareLabel: string;
  color: string;
}

export interface ErrorCauseRow {
  cause: string;
  count: number;
  compact: string;
  exact: string;
  sharePercent: number;
  shareLabel: string;
}

export interface ReliabilitySummary {
  totalRequests: number;
  completedRatioPercent: number;
  completedRatioLabel: string;
  outcomes: OutcomeRow[];
  errors: ErrorCauseRow[];
  totalErrors: number;
}

export interface DownloadStats {
  npmWeekly: number | null;
  npmMonthly: number | null;
  npmYearly: number | null;
  githubTotalDownloads: number | null;
  githubDownloadsPartial: boolean;
  githubLatestTag: string | null;
  githubLatestDownloads: number | null;
  githubReleaseCount: number;
}

export type DashboardFetchState = "loading" | "ready" | "empty" | "error";
