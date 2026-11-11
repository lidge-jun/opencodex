import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import pkg from "../../package.json";
import {
  INSTALL_CHANNELS,
  MODEL_FAMILIES,
  PROVIDER_KINDS,
  REQUEST_FAILURE_CAUSES,
} from "../../src/telemetry/contract";
import type {
  TelemetryStatsRange as CollectorStatsRange,
  TelemetryStatsV1 as CollectorStatsV1,
} from "../../services/telemetry-collector/src/types";
import {
  DEFAULT_TELEMETRY_RANGE,
  GITHUB_RELEASES_URL,
  GITHUB_REPO_SLUG,
  HEATMAP_GRADE_COLORS,
  NPM_DOWNLOADS_WEEKLY_URL,
  NPM_PACKAGE_NAME,
  TELEMETRY_GUIDE_PATH,
  TELEMETRY_RANGES,
  TELEMETRY_STATS_ENDPOINT,
  TOKSCALE_REPO_URL,
  buildChannelRows,
  buildDailyChartAccessibleTable,
  buildDailyProviderChart,
  buildHeatmapCalendar,
  buildKpiStrip,
  buildModelShareRows,
  buildPlatformRows,
  buildProviderShareRows,
  buildReliabilitySummary,
  buildStatsUrl,
  buildTokenMix,
  buildVersionRows,
  classifyStatsResponse,
  computeHeatmapGrade,
  createEmptyStatsSnapshot,
  createStatsRequestSequencer,
  fetchGithubReleasesPages,
  fetchJsonWithTimeout,
  formatActiveHours,
  formatAvgDailyActiveInstalls,
  formatCompactNumber,
  formatHeatmapCellAriaLabel,
  formatLocalizedMonthShort,
  getHeatmapGradeColor,
  getLocalizedWeekdayLabels,
  getStatsRangeDays,
  isStatsSnapshotEmpty,
  isValidTelemetryStatsV1,
  navigateHeatmapDate,
  parseDownloadsPayload,
  parseGithubNextLink,
  parseStatsRangeParam,
  resolveAvgDailyActiveInstalls,
  type TelemetryStatsRange as DashboardStatsRange,
  type TelemetryStatsV1 as DashboardStatsV1,
} from "../../docs-site/src/components/telemetry-dashboard/index";
import { mountTelemetryDashboard } from "../../docs-site/src/components/telemetry-dashboard/client";
import {
  TELEMETRY_DASHBOARD_LOCALES,
  TELEMETRY_DASHBOARD_STRINGS,
  getTelemetryDashboardCopy,
  resolveTelemetryDashboardLocale,
} from "../../docs-site/src/data/telemetry-dashboard-i18n";
import { repoPath } from "../helpers/repo-root";

type NormalizeCollectorStatsForParity<T extends { totals: { activeInstalls: number } }> = Omit<
  T,
  "totals"
> & {
  totals: Omit<T["totals"], "avgDailyActiveInstalls"> & {
    avgDailyActiveInstalls?: number;
  };
};

type AssertExactType<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

const _assertStatsParity: AssertExactType<
  NormalizeCollectorStatsForParity<CollectorStatsV1>,
  NormalizeCollectorStatsForParity<DashboardStatsV1>
> = true;
const _assertCollectorAssignableToDashboard: [CollectorStatsV1] extends [DashboardStatsV1]
  ? true
  : never = true;
const _assertRangeParity: AssertExactType<CollectorStatsRange, DashboardStatsRange> = true;

function makeFixtureStats(overrides: Partial<DashboardStatsV1> = {}): DashboardStatsV1 {
  const heatmap: DashboardStatsV1["heatmap"] = [];
  const startMs = Date.UTC(2025, 10, 9); // 2025-11-09 .. 2026-11-08 (365 days)
  for (let i = 0; i < 365; i++) {
    const day = new Date(startMs + i * 86_400_000).toISOString().slice(0, 10);
    const activeInstalls =
      i === 364
        ? 400
        : i === 300
          ? 250
          : i === 200
            ? 120
            : i % 5 === 0
              ? 40
              : 0;
    heatmap.push({ day, activeInstalls });
  }

  return {
    schemaVersion: 1,
    generatedAt: "2026-11-08T00:00:00.000Z",
    range: "30d",
    totals: {
      activeInstalls: 4_820,
      avgDailyActiveInstalls: 160.7,
      newInstalls: 640,
      activeMinutes: 187_500,
      requests: 1_250_000,
      tokens: {
        input: 450_000_000,
        cacheRead: 1_200_000_000,
        cacheWrite: 150_000_000,
        output: 120_000_000,
        reasoning: 80_000_000,
      },
    },
    daily: [
      {
        day: "2026-11-06",
        activeInstalls: 180,
        newInstalls: 24,
        activeMinutes: 6_200,
        requests: 42_000,
        failed: 420,
        tokens: 68_000_000,
      },
      {
        day: "2026-11-07",
        activeInstalls: 210,
        newInstalls: 31,
        activeMinutes: 7_500,
        requests: 51_000,
        failed: 380,
        tokens: 82_000_000,
      },
      {
        day: "2026-11-08",
        activeInstalls: 400,
        newInstalls: 45,
        activeMinutes: 9_600,
        requests: 64_000,
        failed: 510,
        tokens: 110_000_000,
      },
    ],
    dailyByProvider: [
      { day: "2026-11-06", providerKind: "anthropic", requests: 22_000, tokens: 38_000_000 },
      { day: "2026-11-06", providerKind: "openai", requests: 14_000, tokens: 20_000_000 },
      { day: "2026-11-06", providerKind: "google", requests: 6_000, tokens: 10_000_000 },
      { day: "2026-11-07", providerKind: "anthropic", requests: 28_000, tokens: 46_000_000 },
      { day: "2026-11-07", providerKind: "openai", requests: 16_000, tokens: 24_000_000 },
      { day: "2026-11-07", providerKind: "google", requests: 7_000, tokens: 12_000_000 },
      { day: "2026-11-08", providerKind: "anthropic", requests: 34_000, tokens: 60_000_000 },
      { day: "2026-11-08", providerKind: "openai", requests: 20_000, tokens: 32_000_000 },
      { day: "2026-11-08", providerKind: "google", requests: 10_000, tokens: 18_000_000 },
    ],
    heatmap,
    providers: [
      { providerKind: PROVIDER_KINDS[2]!, requests: 640_000, tokens: 1_100_000_000 },
      { providerKind: PROVIDER_KINDS[0]!, requests: 410_000, tokens: 620_000_000 },
      { providerKind: PROVIDER_KINDS[4]!, requests: 200_000, tokens: 280_000_000 },
    ],
    models: [
      { modelFamily: MODEL_FAMILIES[6]!, requests: 520_000, tokens: 900_000_000 },
      { modelFamily: MODEL_FAMILIES[1]!, requests: 410_000, tokens: 620_000_000 },
      { modelFamily: MODEL_FAMILIES[8]!, requests: 200_000, tokens: 280_000_000 },
      { modelFamily: MODEL_FAMILIES[5]!, requests: 120_000, tokens: 200_000_000 },
    ],
    versions: [
      { version: "2.99.0", installs: 3_100, newInstalls: 420 },
      { version: "2.98.0", installs: 1_220, newInstalls: 150 },
      { version: "2.97.0", installs: 500, newInstalls: 70 },
    ],
    platforms: [
      { os: "darwin", arch: "arm64", installs: 2_600 },
      { os: "linux", arch: "x64", installs: 1_420 },
      { os: "win32", arch: "x64", installs: 800 },
    ],
    channels: [
      { installChannel: INSTALL_CHANNELS[0]!, installs: 2_400, newInstalls: 310 },
      { installChannel: INSTALL_CHANNELS[2]!, installs: 1_420, newInstalls: 190 },
      { installChannel: INSTALL_CHANNELS[5]!, installs: 1_000, newInstalls: 140 },
    ],
    outcomes: {
      completed: 1_210_000,
      incomplete: 18_000,
      aborted: 9_500,
      failed: 12_500,
    },
    errors: [
      { cause: REQUEST_FAILURE_CAUSES[3]!, count: 6_200 },
      { cause: REQUEST_FAILURE_CAUSES[11]!, count: 3_800 },
      { cause: REQUEST_FAILURE_CAUSES[4]!, count: 2_500 },
    ],
    ...overrides,
  };
}

describe("docs telemetry dashboard route and navigation", () => {
  test("dashboard.mdx exists as a splash page mounting TelemetryDashboard.astro", () => {
    expect(_assertStatsParity).toBe(true);
    expect(_assertCollectorAssignableToDashboard).toBe(true);
    expect(_assertRangeParity).toBe(true);

    const mdxPath = repoPath("docs-site/src/content/docs/dashboard.mdx");
    expect(existsSync(mdxPath)).toBe(true);
    const mdx = readFileSync(mdxPath, "utf8");
    expect(mdx).toContain("template: splash");
    expect(mdx).toContain("editUrl: false");
    expect(mdx).toContain("lastUpdated: false");
    expect(mdx).toContain("import TelemetryDashboard from '../../components/TelemetryDashboard.astro'");
    expect(mdx).toContain("<TelemetryDashboard />");
  });

  test("Header.astro links /dashboard/ in both the desktop nav and the splash mobile menu", () => {
    const header = readFileSync(repoPath("docs-site/src/components/Header.astro"), "utf8");
    expect(header).toContain("href: `${prefix}dashboard/`");
    const desktopMatches = header.match(/href={dashboard.href}/g) ?? [];
    expect(desktopMatches.length).toBeGreaterThanOrEqual(2);
    expect(header).toContain('<a class="nav-link" href={dashboard.href}>{dashboard.label}</a>');
    expect(header).toContain('<a class="lp-menu-contrib" href={dashboard.href}>{dashboard.label}</a>');
    expect(header).toContain("flex-shrink: 0;");
  });

  test("constants match collector endpoint, root package.json name, GitHub repo, guide link, and tokscale credit", () => {
    expect(TELEMETRY_STATS_ENDPOINT).toBe("https://telemetry.opencodex.me/v1/stats");
    expect(TELEMETRY_RANGES).toEqual(["7d", "30d", "90d", "365d"]);
    expect(DEFAULT_TELEMETRY_RANGE).toBe("30d");
    expect(NPM_PACKAGE_NAME).toBe(pkg.name);
    expect(NPM_DOWNLOADS_WEEKLY_URL).toContain(pkg.name);
    expect(GITHUB_REPO_SLUG).toBe("lidge-jun/opencodex");
    expect(GITHUB_RELEASES_URL).toContain("lidge-jun/opencodex");
    expect(GITHUB_RELEASES_URL).toContain("per_page=100");
    expect(TOKSCALE_REPO_URL).toBe("https://github.com/junhoyeo/tokscale");
    expect(TELEMETRY_GUIDE_PATH).toBe("guides/telemetry/");

    const guidePath = repoPath("docs-site/src/content/docs/guides/telemetry.md");
    expect(existsSync(guidePath)).toBe(true);
    const guideMd = readFileSync(guidePath, "utf8");
    expect(guideMd).toContain("(/dashboard/)");

    const astroSource = readFileSync(
      repoPath("docs-site/src/components/TelemetryDashboard.astro"),
      "utf8",
    );
    expect(astroSource).toContain('import.meta.glob("../content/docs/guides/telemetry.{md,mdx}")');
    expect(astroSource).not.toContain("TELEMETRY_GUIDE_LINK_ENABLED");
  });
});

describe("telemetry dashboard formatting and bucketing helpers", () => {
  test("formatCompactNumber formats K/M/B/T and promotes boundary values without 1000.0K artifacts", () => {
    expect(formatCompactNumber(-5)).toBe("0");
    expect(formatCompactNumber(0)).toBe("0");
    expect(formatCompactNumber(999)).toBe("999");
    expect(formatCompactNumber(1_250)).toBe("1.3K");
    expect(formatCompactNumber(999_960)).toBe("1.0M");
    expect(formatCompactNumber(1_250_000)).toBe("1.3M");
    expect(formatCompactNumber(999_960_000)).toBe("1.0B");
    expect(formatCompactNumber(2_000_000_000)).toBe("2.0B");
    expect(formatCompactNumber(1_500_000_000_000)).toBe("1.5T");
  });

  test("buildKpiStrip and buildTokenMix format and bucket a fixture TelemetryStatsV1", () => {
    const fixture = makeFixtureStats();
    const kpis = buildKpiStrip(fixture, "en-US");
    expect(kpis).toEqual([
      {
        id: "activeInstalls",
        rawValue: 160.7,
        compact: "160.7",
        exactTitle: "160.7 (4,820 install-days)",
      },
      { id: "newInstalls", rawValue: 640, compact: "640", exactTitle: "640" },
      { id: "requests", rawValue: 1_250_000, compact: "1.3M", exactTitle: "1,250,000" },
      { id: "tokens", rawValue: 2_000_000_000, compact: "2.0B", exactTitle: "2,000,000,000" },
      {
        id: "activeHours",
        rawValue: 187_500,
        compact: "3.1Kh",
        exactTitle: "3,125h (187,500 min)",
      },
    ]);

    expect(formatActiveHours(0)).toEqual({
      hours: 0,
      compact: "0h",
      exactTitle: "0h (0 min)",
    });
    expect(formatAvgDailyActiveInstalls(0, 0)).toEqual({
      avg: 0,
      compact: "0",
      exactTitle: "0 (0 install-days)",
    });
    expect(getStatsRangeDays("7d")).toBe(7);
    expect(getStatsRangeDays("30d")).toBe(30);
    expect(getStatsRangeDays("90d")).toBe(90);
    expect(getStatsRangeDays("365d")).toBe(365);
    expect(getStatsRangeDays("unknown")).toBe(30);

    // Explicit avgDailyActiveInstalls from newer collector takes precedence
    const withExplicitAvg = makeFixtureStats({
      totals: {
        ...fixture.totals,
        avgDailyActiveInstalls: 42.5,
      },
    });
    expect(resolveAvgDailyActiveInstalls(withExplicitAvg)).toBe(42.5);
    expect(buildKpiStrip(withExplicitAvg, "en-US")[0]).toEqual({
      id: "activeInstalls",
      rawValue: 42.5,
      compact: "42.5",
      exactTitle: "42.5 (4,820 install-days)",
    });

    // Older collector without avgDailyActiveInstalls computes activeInstalls / days rounded to 1 decimal
    const withoutExplicitAvg = makeFixtureStats({
      totals: {
        ...fixture.totals,
        avgDailyActiveInstalls: undefined,
      },
    });
    expect(resolveAvgDailyActiveInstalls(withoutExplicitAvg)).toBe(160.7);
    expect(buildKpiStrip(withoutExplicitAvg, "en-US")[0]).toEqual({
      id: "activeInstalls",
      rawValue: 160.7,
      compact: "160.7",
      exactTitle: "160.7 (4,820 install-days)",
    });
    expect(
      resolveAvgDailyActiveInstalls({
        range: "7d",
        totals: { ...fixture.totals, activeInstalls: 100, avgDailyActiveInstalls: undefined },
      }),
    ).toBe(14.3);

    const mix = buildTokenMix(fixture.totals.tokens, "en-US");
    expect(mix.totalTokens).toBe(2_000_000_000);
    expect(mix.totalCompact).toBe("2.0B");
    expect(mix.totalExactTitle).toBe("2,000,000,000");
    expect(mix.segments.map((s) => s.id)).toEqual([
      "input",
      "cacheRead",
      "cacheWrite",
      "output",
      "reasoning",
    ]);
    const sumValues = mix.segments.reduce((acc, s) => acc + s.value, 0);
    const sumPct = mix.segments.reduce((acc, s) => acc + s.percent, 0);
    expect(sumValues).toBe(mix.totalTokens);
    expect(sumPct).toBeCloseTo(100, 5);
    expect(mix.segments[1]).toMatchObject({
      id: "cacheRead",
      compact: "1.2B",
      exactTitle: "1,200,000,000",
      percentLabel: "60.0%",
    });
  });

  test("parseStatsRangeParam and buildStatsUrl handle valid and fallback ranges", () => {
    expect(parseStatsRangeParam("7d")).toBe("7d");
    expect(parseStatsRangeParam("30d")).toBe("30d");
    expect(parseStatsRangeParam("90d")).toBe("90d");
    expect(parseStatsRangeParam("365d")).toBe("365d");
    expect(parseStatsRangeParam("invalid")).toBe("30d");
    expect(parseStatsRangeParam(null)).toBe("30d");
    expect(buildStatsUrl("90d")).toBe("https://telemetry.opencodex.me/v1/stats?range=90d");
  });

  test("computeHeatmapGrade and buildHeatmapCalendar grade and lay out 365 days into 52/53 weeks", () => {
    expect(computeHeatmapGrade(0, 400)).toBe(0);
    expect(computeHeatmapGrade(50, 0)).toBe(0);
    expect(computeHeatmapGrade(1, 400)).toBe(1);
    expect(computeHeatmapGrade(99, 400)).toBe(1);
    expect(computeHeatmapGrade(100, 400)).toBe(2);
    expect(computeHeatmapGrade(199, 400)).toBe(2);
    expect(computeHeatmapGrade(200, 400)).toBe(3);
    expect(computeHeatmapGrade(299, 400)).toBe(3);
    expect(computeHeatmapGrade(300, 400)).toBe(4);
    expect(computeHeatmapGrade(400, 400)).toBe(4);

    for (const grade of [0, 1, 2, 3, 4] as const) {
      expect(getHeatmapGradeColor("light", grade)).toBe(HEATMAP_GRADE_COLORS.light[grade]);
      expect(getHeatmapGradeColor("dark", grade)).toBe(HEATMAP_GRADE_COLORS.dark[grade]);
    }

    const fixture = makeFixtureStats();
    const calendar = buildHeatmapCalendar(fixture.heatmap);
    expect(calendar.weekCount).toBeGreaterThanOrEqual(52);
    expect(calendar.weekCount).toBeLessThanOrEqual(54);
    expect(calendar.cells.length).toBe(calendar.weekCount * 7);
    expect(calendar.startDate).toBe("2025-11-09");
    expect(calendar.endDate).toBe("2026-11-08");
    expect(calendar.maxActiveInstalls).toBe(400);
    expect(calendar.peakDay).toEqual({ date: "2026-11-08", activeInstalls: 400 });
    expect(calendar.activeDays).toBeGreaterThan(70);
    expect(calendar.monthMarkers.length).toBeGreaterThanOrEqual(10);

    const selectable = calendar.cells.filter((c) => c.selectable);
    expect(selectable.length).toBe(365);
    const peakCell = selectable.find((c) => c.date === "2026-11-08")!;
    expect(peakCell.grade).toBe(4);
    expect(formatHeatmapCellAriaLabel(peakCell, "en-US")).toBe(
      "2026-11-08: 400 active installs (grade 4)",
    );
    expect(formatHeatmapCellAriaLabel(peakCell, "ko", "활성 설치")).toBe(
      "2026-11-08: 400 활성 설치 (4/4)",
    );
    expect(formatLocalizedMonthShort(0, "en-US")).toBe("Jan");
    expect(getLocalizedWeekdayLabels("en-US")).toEqual({
      mon: "Mon",
      wed: "Wed",
      fri: "Fri",
    });

    // Keyboard navigation across selectable days
    expect(navigateHeatmapDate(calendar.cells, "2026-11-08", "Home")).toBe("2025-11-09");
    expect(navigateHeatmapDate(calendar.cells, "2025-11-09", "End")).toBe("2026-11-08");
    expect(navigateHeatmapDate(calendar.cells, "2026-11-08", "ArrowUp")).toBe("2026-11-07");
    expect(navigateHeatmapDate(calendar.cells, "2026-11-08", "ArrowLeft")).toBe("2026-11-01");
    expect(navigateHeatmapDate(calendar.cells, "2025-11-09", "ArrowDown")).toBe("2025-11-10");
  });

  test("buildDailyProviderChart, share tables, install tables, and reliability summary bucket fixture data", () => {
    const fixture = makeFixtureStats();
    const chartTokens = buildDailyProviderChart(
      fixture.dailyByProvider,
      fixture.daily,
      "tokens",
      2,
    );
    expect(chartTokens.days).toEqual(["2026-11-06", "2026-11-07", "2026-11-08"]);
    // Top 2 providers ("anthropic", "openai") plus folded "other" ("google")
    expect(chartTokens.series.map((s) => s.providerKind)).toEqual([
      "anthropic",
      "openai",
      "other",
    ]);
    expect(chartTokens.series[0]?.values).toEqual([38_000_000, 46_000_000, 60_000_000]);
    expect(chartTokens.series[2]?.values).toEqual([10_000_000, 12_000_000, 18_000_000]);

    const srTable = buildDailyChartAccessibleTable(chartTokens, "en-US");
    expect(srTable.length).toBe(9);
    expect(srTable[0]).toEqual({
      day: "2026-11-06",
      providerKind: "anthropic",
      value: 38_000_000,
      valueCompact: "38.0M",
      valueExact: "38,000,000",
    });

    const providerRows = buildProviderShareRows(fixture.providers);
    expect(providerRows[0]).toMatchObject({
      key: "anthropic",
      requestsCompact: "640.0K",
      tokensCompact: "1.1B",
      tokenShareLabel: "55.0%",
    });

    const modelRows = buildModelShareRows(fixture.models);
    expect(modelRows[0]).toMatchObject({
      key: "claude-sonnet",
      tokensCompact: "900.0M",
      tokenShareLabel: "45.0%",
    });

    const versionRows = buildVersionRows(fixture.versions);
    expect(versionRows[0]).toMatchObject({
      key: "2.99.0",
      label: "v2.99.0",
      installsCompact: "3.1K",
      newInstallsCompact: "420",
    });

    const platformRows = buildPlatformRows(fixture.platforms);
    expect(platformRows[0]).toMatchObject({
      key: "darwin/arm64",
      installsCompact: "2.6K",
    });

    const channelRows = buildChannelRows(fixture.channels);
    expect(channelRows[0]).toMatchObject({
      key: "npm-global",
      installsCompact: "2.4K",
      newInstallsCompact: "310",
    });

    const reliability = buildReliabilitySummary(fixture.outcomes, fixture.errors);
    expect(reliability.totalRequests).toBe(1_250_000);
    expect(reliability.completedRatioLabel).toBe("96.8%");
    expect(reliability.totalErrors).toBe(12_500);
    expect(reliability.errors[0]).toMatchObject({
      cause: "rate-limit",
      compact: "6.2K",
      shareLabel: "49.6%",
    });
  });

  test("table and state helpers filter out partial or malformed array entries without throwing", () => {
    const malformedStats = makeFixtureStats({
      heatmap: [
        null as unknown as DashboardStatsV1["heatmap"][number],
        {} as unknown as DashboardStatsV1["heatmap"][number],
        { day: "2026-11-08", activeInstalls: 12 },
      ],
      providers: [
        null as unknown as DashboardStatsV1["providers"][number],
        { providerKind: null as unknown as string, requests: 100, tokens: 500 },
        { providerKind: "   ", requests: 100, tokens: 500 },
        { providerKind: "anthropic", requests: 50, tokens: 1_000 },
      ],
      models: [
        undefined as unknown as DashboardStatsV1["models"][number],
        { modelFamily: 123 as unknown as string, requests: 10, tokens: 100 },
        { modelFamily: "claude-opus", requests: 25, tokens: 2_000 },
      ],
      versions: [
        null as unknown as DashboardStatsV1["versions"][number],
        { version: undefined as unknown as string, installs: 10, newInstalls: 1 },
        { version: "2.99.0", installs: 40, newInstalls: 5 },
      ],
      platforms: [
        null as unknown as DashboardStatsV1["platforms"][number],
        { os: "darwin", arch: null as unknown as string, installs: 10 },
        { os: null as unknown as string, arch: "arm64", installs: 10 },
        { os: "darwin", arch: "arm64", installs: 30 },
      ],
      channels: [
        {} as unknown as DashboardStatsV1["channels"][number],
        { installChannel: "", installs: 5, newInstalls: 1 },
        { installChannel: "npm-global", installs: 20, newInstalls: 3 },
      ],
      errors: [
        null as unknown as DashboardStatsV1["errors"][number],
        { cause: null as unknown as string, count: 10 },
        { cause: "   ", count: 10 },
        { cause: "rate-limit", count: 4 },
      ],
    });

    expect(isStatsSnapshotEmpty(malformedStats)).toBe(false);
    expect(buildProviderShareRows(malformedStats.providers).map((r) => r.key)).toEqual(["anthropic"]);
    expect(buildModelShareRows(malformedStats.models).map((r) => r.key)).toEqual(["claude-opus"]);
    expect(buildVersionRows(malformedStats.versions).map((r) => r.key)).toEqual(["2.99.0"]);
    expect(buildPlatformRows(malformedStats.platforms).map((r) => r.key)).toEqual(["darwin/arm64"]);
    expect(buildChannelRows(malformedStats.channels).map((r) => r.key)).toEqual(["npm-global"]);
    expect(buildReliabilitySummary(malformedStats.outcomes, malformedStats.errors).errors.map((e) => e.cause)).toEqual([
      "rate-limit",
    ]);
  });

  test("createStatsRequestSequencer, fetchJsonWithTimeout, and createEmptyStatsSnapshot guard range switches and timeouts", async () => {
    const sequencer = createStatsRequestSequencer(5_000);
    const t1 = sequencer.begin("30d");
    expect(t1.requestId).toBe(1);
    expect(t1.isCurrent()).toBe(true);
    expect(t1.signal.aborted).toBe(false);

    // Switching range to 7d aborts in-flight 30d request and invalidates its ticket
    const t2 = sequencer.begin("7d");
    expect(t1.signal.aborted).toBe(true);
    expect(t1.isCurrent()).toBe(false);
    expect(t2.requestId).toBe(2);
    expect(t2.isCurrent()).toBe(true);
    expect(t2.signal.aborted).toBe(false);

    // Finishing stale t1 does not disturb active t2
    t1.finish();
    expect(t2.isCurrent()).toBe(true);
    t2.finish();

    // Timeout aborts active request and marks didTimeout()
    const tTimeout = sequencer.begin("90d", 15);
    await new Promise((r) => setTimeout(r, 35));
    expect(tTimeout.signal.aborted).toBe(true);
    expect(tTimeout.didTimeout()).toBe(true);
    tTimeout.finish();

    // fetchJsonWithTimeout aborts hanging download request and returns null
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
      })) as typeof fetch;
    const timedOutResult = await fetchJsonWithTimeout(
      "https://api.npmjs.org/downloads/point/last-week/@bitkyc08/opencodex",
      15,
      hangingFetch,
    );
    expect(timedOutResult).toBeNull();

    // Empty snapshot resets stale range metrics cleanly
    const emptySnap = createEmptyStatsSnapshot("7d");
    expect(emptySnap.range).toBe("7d");
    expect(isValidTelemetryStatsV1(emptySnap)).toBe(true);
    expect(isStatsSnapshotEmpty(emptySnap)).toBe(true);
  });

  test("classifyStatsResponse and parseDownloadsPayload handle ready, empty, error, and download fallbacks", () => {
    const fixture = makeFixtureStats();
    expect(isValidTelemetryStatsV1(fixture)).toBe(true);
    expect(isStatsSnapshotEmpty(fixture)).toBe(false);

    const ready = classifyStatsResponse({ ok: true, status: 200, body: fixture });
    expect(ready.state).toBe("ready");
    expect(ready.reason).toBe("ok");

    // Not deployed yet (HTTP 404 / 503) -> explicit empty state
    const notDeployed = classifyStatsResponse({ ok: false, status: 404, body: null });
    expect(notDeployed).toEqual({
      state: "empty",
      stats: null,
      reason: "collector-not-deployed",
      detail: "HTTP 404",
    });

    // Zeroed stats snapshot -> explicit empty state
    const emptySnapshot = makeFixtureStats({
      totals: {
        activeInstalls: 0,
        newInstalls: 0,
        activeMinutes: 0,
        requests: 0,
        tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      },
      heatmap: [{ day: "2026-11-08", activeInstalls: 0 }],
    });
    expect(classifyStatsResponse({ ok: true, status: 200, body: emptySnapshot })).toMatchObject({
      state: "empty",
      reason: "no-reports-yet",
    });

    // Server error / network error / invalid schema -> explicit error state
    expect(classifyStatsResponse({ ok: false, status: 500, body: {} })).toMatchObject({
      state: "error",
      reason: "http-error",
    });
    expect(
      classifyStatsResponse({ networkError: true, errorMessage: "Failed to fetch" }),
    ).toMatchObject({
      state: "error",
      reason: "network-error",
      detail: "Failed to fetch",
    });
    expect(
      classifyStatsResponse({ ok: true, status: 200, body: { schemaVersion: 999 } }),
    ).toMatchObject({
      state: "error",
      reason: "invalid-payload",
    });

    // Downloads parser with live-shaped payloads and graceful null fallback
    const dl = parseDownloadsPayload({
      npmWeekly: { downloads: 18_420 },
      npmMonthly: { downloads: 74_900 },
      npmYearly: { downloads: 612_300 },
      githubReleases: [
        {
          tag_name: "v2.99.0",
          draft: false,
          assets: [{ download_count: 1_200 }, { download_count: 850 }],
        },
        {
          tag_name: "v2.98.0",
          draft: false,
          assets: [{ download_count: 3_400 }],
        },
        {
          tag_name: "v3.0.0-draft",
          draft: true,
          assets: [{ download_count: 99_999 }],
        },
      ],
    });
    expect(dl).toEqual({
      npmWeekly: 18_420,
      npmMonthly: 74_900,
      npmYearly: 612_300,
      githubTotalDownloads: 5_450,
      githubDownloadsPartial: false,
      githubLatestTag: "v2.99.0",
      githubLatestDownloads: 2_050,
      githubReleaseCount: 2,
    });

    // A preview published after a stable release counts toward totals but is not "the latest release".
    expect(
      parseDownloadsPayload({
        githubReleases: [
          { tag_name: "v3.0.0-preview.20261108", draft: false, prerelease: true, assets: [{ download_count: 7 }] },
          { tag_name: "v2.99.0", draft: false, prerelease: false, assets: [{ download_count: 5 }] },
        ],
      }),
    ).toMatchObject({ githubLatestTag: "v2.99.0", githubLatestDownloads: 5, githubTotalDownloads: 12, githubReleaseCount: 2 });

    expect(parseDownloadsPayload({})).toEqual({
      npmWeekly: null,
      npmMonthly: null,
      npmYearly: null,
      githubTotalDownloads: null,
      githubDownloadsPartial: false,
      githubLatestTag: null,
      githubLatestDownloads: null,
      githubReleaseCount: 0,
    });

    expect(
      parseGithubNextLink(
        '<https://api.github.com/repos/lidge-jun/opencodex/releases?per_page=100&page=2>; rel="next", <https://api.github.com/repos/lidge-jun/opencodex/releases?per_page=100&page=5>; rel="last"',
        GITHUB_RELEASES_URL,
      ),
    ).toBe(
      "https://api.github.com/repos/lidge-jun/opencodex/releases?per_page=100&page=2",
    );
    expect(
      parseGithubNextLink(
        '<https://evil.example.com/releases?page=2>; rel="next"',
        GITHUB_RELEASES_URL,
      ),
    ).toBeNull();
    expect(parseGithubNextLink(null)).toBeNull();
  });

  test("all configured site locales carry complete dashboard copy and component markup contains no secrets", () => {
    const configured = ["en", ...readFileSync(repoPath("docs-site/astro.config.mjs"), "utf8")
      .matchAll(/^\s*["']?([a-z]{2}(?:-[a-z]{2})?)["']?:\s*\{\s*label:/gm)]
      .map(value => typeof value === "string" ? value : value[1]!);
    expect([...TELEMETRY_DASHBOARD_LOCALES].sort()).toEqual(configured.sort());
    const enKeys = Object.keys(TELEMETRY_DASHBOARD_STRINGS.en).sort();
    const optInPattern = /\bopt(?:ed)?[-\s]?in\b|オプトイン|참여에\s*동의한/i;
    const hangulPattern = /[\uac00-\ud7af\u1100-\u11ff\u3130-\u318f]/;
    for (const locale of TELEMETRY_DASHBOARD_LOCALES) {
      const copy = getTelemetryDashboardCopy(locale);
      expect(Object.keys(copy).sort()).toEqual(enKeys);
      for (const [k, v] of Object.entries(copy)) {
        expect(typeof v, `${locale}.${k}`).toBe("string");
        expect(v.trim().length, `${locale}.${k} non-empty`).toBeGreaterThan(0);
        expect(optInPattern.test(v), `${locale}.${k} must not claim opt-in`).toBe(false);
        if (locale !== "ko") {
          expect(hangulPattern.test(v), `${locale}.${k} must not contain Hangul`).toBe(false);
        }
      }
      if (locale !== "en") {
        expect(copy.stateEmptyTitle).not.toContain("Collector not deployed yet");
      }
    }
    expect(TELEMETRY_DASHBOARD_STRINGS.en.subtitle).toContain("on by default");
    expect(TELEMETRY_DASHBOARD_STRINGS.en.subtitle).toContain("privacy notice");
    expect(TELEMETRY_DASHBOARD_STRINGS.en.kpiActiveInstalls).toBe(
      "Avg daily active installs",
    );
    expect(TELEMETRY_DASHBOARD_STRINGS.en.subtitle.toLowerCase()).toContain(
      "self-reported by opencodex installs",
    );
    expect(resolveTelemetryDashboardLocale("KO")).toBe("ko");
    expect(resolveTelemetryDashboardLocale("unknown")).toBe("en");

    const astroSource = readFileSync(
      repoPath("docs-site/src/components/TelemetryDashboard.astro"),
      "utf8",
    );
    expect(astroSource).toContain('data-state-panel="loading"');
    expect(astroSource).toContain('data-state-panel="empty"');
    expect(astroSource).toContain('data-state-panel="error"');
    expect(astroSource).toContain("data-self-reported-label");
    expect(astroSource).toContain("data-daily-chart-table");
    expect(astroSource).toContain("var(--sl-color-gray-3)");
    expect(astroSource).toContain("junhoyeo/tokscale");

    const clientSource = readFileSync(
      repoPath("docs-site/src/components/telemetry-dashboard/client.ts"),
      "utf8",
    );
    expect(clientSource).toContain('aria-describedby", "td-heatmap-tooltip"');

    const helperDir = repoPath("docs-site/src/components/telemetry-dashboard");
    const scannedFiles = [
      repoPath("docs-site/src/content/docs/dashboard.mdx"),
      repoPath("docs-site/src/components/TelemetryDashboard.astro"),
      repoPath("docs-site/src/data/telemetry-dashboard-i18n.ts"),
      ...readdirSync(helperDir).map((name) => repoPath("docs-site/src/components/telemetry-dashboard", name)),
    ];
    const secretPattern = /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AIza[0-9A-Za-z-_]{35}|Bearer\s+[A-Za-z0-9._-]{20,})/;
    for (const file of scannedFiles) {
      const text = readFileSync(file, "utf8");
      expect(secretPattern.test(text), `secret pattern in ${file}`).toBe(false);
    }
  });

  test("D15 breakdown tables format 'other' rows without a 'v' prefix and sort 'other' last", () => {
    const versionRows = buildVersionRows([
      { version: "other", installs: 900, newInstalls: 50 },
      { version: "2.99.0", installs: 500, newInstalls: 40 },
      { version: "2.98.0", installs: 300, newInstalls: 20 },
    ]);
    expect(versionRows.map((r) => r.label)).toEqual(["v2.99.0", "v2.98.0", "other"]);

    const platformRows = buildPlatformRows([
      { os: "other", arch: "other", installs: 800 },
      { os: "other", arch: "", installs: 50 },
      { os: "darwin", arch: "arm64", installs: 600 },
    ]);
    expect(platformRows.map((r) => ({ key: r.key, installs: r.installs }))).toEqual([
      { key: "darwin/arm64", installs: 600 },
      { key: "other", installs: 850 },
    ]);

    const providerRows = buildProviderShareRows([
      { providerKind: "other", requests: 900, tokens: 9_000_000 },
      { providerKind: "anthropic", requests: 500, tokens: 5_000_000 },
    ]);
    expect(providerRows.map((r) => r.key)).toEqual(["anthropic", "other"]);

    const modelRows = buildModelShareRows([
      { modelFamily: "other", requests: 900, tokens: 9_000_000 },
      { modelFamily: "claude-opus", requests: 500, tokens: 5_000_000 },
    ]);
    expect(modelRows.map((r) => r.key)).toEqual(["claude-opus", "other"]);

    const channelRows = buildChannelRows([
      { installChannel: "other", installs: 900, newInstalls: 50 },
      { installChannel: "npm-global", installs: 500, newInstalls: 40 },
    ]);
    expect(channelRows.map((r) => r.key)).toEqual(["npm-global", "other"]);

    const reliability = buildReliabilitySummary(
      { completed: 100, failed: 20, incomplete: 0, aborted: 0 },
      [
        { cause: "other", count: 15 },
        { cause: "rate-limit", count: 5 },
      ],
    );
    expect(reliability.errors.map((e) => e.cause)).toEqual(["rate-limit", "other"]);

    const dailyChart = buildDailyProviderChart(
      [
        { day: "2026-11-08", providerKind: "other", requests: 500, tokens: 9_000_000 },
        { day: "2026-11-08", providerKind: "anthropic", requests: 200, tokens: 3_000_000 },
      ],
      [{ day: "2026-11-08", activeInstalls: 50, newInstalls: 5, activeMinutes: 100, requests: 700, failed: 0, tokens: 12_000_000 }],
      "tokens",
      6,
    );
    expect(dailyChart.series.map((s) => s.providerKind)).toEqual(["anthropic", "other"]);
  });

  test("D20 mountTelemetryDashboard clears heatmap on empty snapshot and paginates GitHub release downloads up to 10 pages", async () => {
    class MockElement {
      tagName: string;
      className = "";
      textContent = "";
      title = "";
      type = "";
      hidden = false;
      disabled = false;
      tabIndex = 0;
      dataset: Record<string, string> = {};
      attributes = new Map<string, string>();
      styleProps = new Map<string, string>();
      style: Record<string, unknown> = {
        setProperty: (k: string, v: string) => {
          this.styleProps.set(k, v);
        },
      };
      children: MockElement[] = [];
      listeners = new Map<string, Array<(ev?: unknown) => void>>();
      constructor(tagName = "div", attrs: Record<string, string> = {}) {
        this.tagName = tagName.toLowerCase();
        for (const [k, v] of Object.entries(attrs)) {
          this.setAttribute(k, v);
        }
      }
      setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
        if (name.startsWith("data-")) {
          const camel = name
            .slice(5)
            .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          this.dataset[camel] = value;
        }
      }
      getAttribute(name: string): string | null {
        return this.attributes.get(name) ?? null;
      }
      append(...nodes: MockElement[]) {
        this.children.push(...nodes);
      }
      appendChild(node: MockElement) {
        this.children.push(node);
        return node;
      }
      replaceChildren(...nodes: MockElement[]) {
        this.children = [...nodes];
      }
      addEventListener(type: string, cb: (ev?: unknown) => void) {
        const list = this.listeners.get(type) ?? [];
        list.push(cb);
        this.listeners.set(type, list);
      }
      click() {
        for (const cb of this.listeners.get("click") ?? []) cb({});
      }
      focus() {}
      matchesSelector(sel: string): boolean {
        if (sel === "button[data-date]") {
          return this.tagName === "button" && Boolean(this.dataset.date);
        }
        const attrMatch = /^\[([a-z0-9-]+)(?:="([^"]*)")?\]$/i.exec(sel.trim());
        if (!attrMatch) return false;
        const [, attrName, attrVal] = attrMatch;
        if (!attrName) return false;
        if (attrVal === undefined) {
          if (attrName.startsWith("data-")) {
            const camel = attrName
              .slice(5)
              .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
            return this.attributes.has(attrName) || camel in this.dataset;
          }
          return this.attributes.has(attrName);
        }
        if (attrName.startsWith("data-")) {
          const camel = attrName
            .slice(5)
            .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
          return this.attributes.get(attrName) === attrVal || this.dataset[camel] === attrVal;
        }
        return this.attributes.get(attrName) === attrVal;
      }
      querySelectorAll(sel: string): MockElement[] {
        const results: MockElement[] = [];
        const visit = (node: MockElement) => {
          for (const child of node.children) {
            if (child.matchesSelector(sel)) results.push(child);
            visit(child);
          }
        };
        visit(this);
        return results;
      }
      querySelector(sel: string): MockElement | null {
        return this.querySelectorAll(sel)[0] ?? null;
      }
    }

    const root = new MockElement("div", {
      "data-telemetry-dashboard": "",
      "data-locale": "en",
      "data-stats-endpoint": "https://telemetry.opencodex.me/v1/stats",
      "data-default-range": "30d",
      "data-npm-weekly-url": "https://api.npmjs.org/downloads/point/last-week/@bitkyc08/opencodex",
      "data-npm-monthly-url": "https://api.npmjs.org/downloads/point/last-month/@bitkyc08/opencodex",
      "data-npm-yearly-url": "https://api.npmjs.org/downloads/point/last-year/@bitkyc08/opencodex",
      "data-github-releases-url": GITHUB_RELEASES_URL,
      "data-copy": JSON.stringify(TELEMETRY_DASHBOARD_STRINGS.en),
    });
    const gridEl = new MockElement("div", { "data-heatmap-grid": "" });
    const monthsEl = new MockElement("div", { "data-heatmap-months": "" });
    const activeDaysEl = new MockElement("span", { "data-heatmap-active-days": "" });
    const peakEl = new MockElement("span", { "data-heatmap-peak": "" });
    const rangeLabelEl = new MockElement("span", { "data-heatmap-range-label": "" });
    const tooltipEl = new MockElement("div", { "data-heatmap-tooltip": "" });
    const retryBtn = new MockElement("button", { "data-retry-btn": "" });
    const ghTotalEl = new MockElement("dd", { "data-dl-gh-total": "" });
    const ghLatestEl = new MockElement("dd", { "data-dl-gh-latest": "" });
    const ghLatestTagEl = new MockElement("span", { "data-dl-gh-latest-tag": "" });
    root.append(
      gridEl,
      monthsEl,
      activeDaysEl,
      peakEl,
      rangeLabelEl,
      tooltipEl,
      retryBtn,
      ghTotalEl,
      ghLatestEl,
      ghLatestTagEl,
    );

    const prevWindow = (globalThis as Record<string, unknown>).window;
    const prevDocument = (globalThis as Record<string, unknown>).document;
    const prevMutationObserver = (globalThis as Record<string, unknown>).MutationObserver;
    const prevFetch = globalThis.fetch;

    let statsReturnEmptyNext = false;
    const fetchedUrls: string[] = [];

    try {
      (globalThis as Record<string, unknown>).window = {
        location: { search: "", href: "https://opencodex.me/dashboard/" },
        history: { replaceState: () => {} },
        addEventListener: () => {},
      };
      (globalThis as Record<string, unknown>).document = {
        createElement: (tag: string) => new MockElement(tag),
        documentElement: new MockElement("html"),
        body: new MockElement("body"),
      };
      (globalThis as Record<string, unknown>).MutationObserver = class {
        observe() {}
      };
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const url = String(input);
        fetchedUrls.push(url);
        if (url.includes("/v1/stats")) {
          if (statsReturnEmptyNext) {
            return new Response("Service Unavailable", { status: 503 });
          }
          return new Response(JSON.stringify(makeFixtureStats()), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (new URL(url).hostname === "api.npmjs.org") {
          return new Response(JSON.stringify({ downloads: 1_000 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        if (new URL(url).hostname === "api.github.com") {
          const parsed = new URL(url);
          const page = Number(parsed.searchParams.get("page") ?? "1");
          const nextPage = page + 1;
          const linkHeader = `<https://api.github.com/repos/lidge-jun/opencodex/releases?per_page=100&page=${nextPage}>; rel="next"`;
          return new Response(
            JSON.stringify([
              {
                tag_name: `v2.${100 - page}.0`,
                draft: false,
                assets: [{ download_count: 100 }],
              },
            ]),
            {
              status: 200,
              headers: {
                "content-type": "application/json",
                link: linkHeader,
              },
            },
          );
        }
        return new Response("Not found", { status: 404 });
      }) as typeof fetch;

      mountTelemetryDashboard(root as unknown as HTMLElement);
      await new Promise((r) => setTimeout(r, 25));

      // After initial stats load, heatmap has 365 selectable [data-date] buttons
      expect(gridEl.querySelectorAll("button[data-date]").length).toBe(365);
      expect(rangeLabelEl.textContent).toBe("2025-11-09 → 2026-11-08 (UTC)");
      expect(peakEl.hidden).toBe(false);

      // Downloads followed pagination up to 10 pages (10 * 100 = 1,000) and marked partial
      const ghReleaseFetches = fetchedUrls.filter((u) => new URL(u).hostname === "api.github.com");
      expect(ghReleaseFetches.length).toBe(10);
      expect(ghTotalEl.dataset.partial).toBe("true");
      expect(ghTotalEl.textContent).toContain("partial");
      expect(ghTotalEl.title).toContain("1,000");
      expect(ghTotalEl.title).toContain("partial");

      // Now trigger retry where collector returns 503 -> empty snapshot applied
      statsReturnEmptyNext = true;
      retryBtn.click();
      await new Promise((r) => setTimeout(r, 25));

      // Heatmap must be cleared: 0 [data-date] buttons, range label reset, peak hidden
      expect(gridEl.querySelectorAll("button[data-date]").length).toBe(0);
      expect(gridEl.children.length).toBe(53 * 7);
      expect(gridEl.children.every((c) => c.disabled && c.dataset.grade === "0")).toBe(true);
      expect(monthsEl.children.length).toBe(0);
      expect(rangeLabelEl.textContent).toBe("365d UTC");
      expect(peakEl.hidden).toBe(true);
    } finally {
      (globalThis as Record<string, unknown>).window = prevWindow;
      (globalThis as Record<string, unknown>).document = prevDocument;
      (globalThis as Record<string, unknown>).MutationObserver = prevMutationObserver;
      globalThis.fetch = prevFetch;
    }
  });
});
