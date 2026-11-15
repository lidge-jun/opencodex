import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import worker, {
  ALLOWED_CORS_ORIGINS,
  handleCollectorFetch,
  handleCollectorScheduled,
} from "../../services/telemetry-collector/src/index";
import {
  MAX_INGEST_BODY_BYTES,
  MAX_REPORTS_PER_HOUR,
  computeHourlyIpHash,
  formatBucketHour,
} from "../../services/telemetry-collector/src/ingest";
import { pruneCollectorTables } from "../../services/telemetry-collector/src/prune";
import { clearStatsCache, handleStats } from "../../services/telemetry-collector/src/stats";
import type { CollectorEnv, TelemetryStatsV1 } from "../../services/telemetry-collector/src/types";
import { aggregateTelemetryEntriesForDay, type DailyTelemetryAggregate } from "../../src/telemetry/aggregate";
import { computeInstallDayHash } from "../../src/telemetry/install-id";
import { buildTelemetryPayloadV1 } from "../../src/telemetry/payload";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { repoPath } from "../helpers/repo-root";
import { createInMemoryD1, postEventRequest } from "../helpers/telemetry-collector-d1";

const NOW = Date.parse("2026-11-07T12:30:00.000Z");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

function makeAggregate(day: string, overrides?: Partial<DailyTelemetryAggregate>): DailyTelemetryAggregate {
  const entries: PersistedUsageEntry[] = [
    {
      requestId: "req-1",
      timestamp: Date.parse(`${day}T09:10:00.000Z`),
      provider: "anthropic2-main",
      model: "claude-opus-4-6",
      status: 200,
      terminalStatus: "completed",
      durationMs: 1200,
      usageStatus: "reported",
      usage: {
        inputTokens: 1000,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 100,
        outputTokens: 250,
        reasoningOutputTokens: 50,
        totalTokens: 1250,
      },
    },
    {
      requestId: "req-2",
      timestamp: Date.parse(`${day}T09:10:30.000Z`),
      provider: "openai-multi-p123456",
      model: "gpt-5.4",
      status: 429,
      terminalStatus: "failed",
      failureCause: "rate-limit",
      durationMs: 400,
      usageStatus: "reported",
      usage: {
        inputTokens: 200,
        outputTokens: 40,
        totalTokens: 240,
      },
    },
    {
      requestId: "req-3",
      timestamp: Date.parse(`${day}T14:22:00.000Z`),
      provider: "google-antigravity",
      model: "gemini-3-pro",
      status: 200,
      terminalStatus: "incomplete",
      failureCause: "empty-output",
      durationMs: 800,
      usageStatus: "reported",
      usage: {
        inputTokens: 400,
        outputTokens: 60,
        totalTokens: 460,
      },
    },
    {
      requestId: "req-4",
      timestamp: Date.parse(`${day}T18:05:00.000Z`),
      provider: "deepseek",
      model: "deepseek-r1",
      status: 499,
      closeReason: "client_cancel",
      failureCause: "client-cancelled",
      durationMs: 300,
      usageStatus: "unreported",
    },
  ];
  const built = aggregateTelemetryEntriesForDay(day, entries);
  return {
    ...built,
    ...overrides,
  };
}


describe("telemetry collector worker + D1", () => {
  test("wrangler.toml pins placeholder D1 id 00000000-0000-0000-0000-000000000000 and cron trigger", () => {
    const wranglerToml = readFileSync(
      repoPath("services", "telemetry-collector", "wrangler.toml"),
      "utf8",
    );
    expect(wranglerToml).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(wranglerToml).toContain('binding = "DB"');
    // A Custom Domain: the hostname has no DNS record of its own, which a zone route would need.
    expect(wranglerToml).toContain('routes = [{ pattern = "telemetry.opencodex.me", custom_domain = true }]');
    expect(wranglerToml).not.toContain("telemetry.opencodex.me/*");
    expect(wranglerToml).toContain("[triggers]");
    expect(wranglerToml).toContain("crons =");
  });

  test("accepts a payload built by buildTelemetryPayloadV1, deduplicates re-sent days with a new batchId, and stores no raw installId or IP", async () => {
    const h = createInMemoryD1("unit-salt-secret");
    try {
      const rawInstallId = "9f8e7d6c-5b4a-4321-8765-123456789abc";
      const rawIp = "203.0.113.42";
      const day = "2026-11-06";
      const installDayHash = computeInstallDayHash(rawInstallId, day);
      const aggregate = makeAggregate(day);
      const payload1 = buildTelemetryPayloadV1({
        aggregate,
        installDayHash,
        newInstall: true,
        batchId: "11111111-2222-4333-8444-555555555555",
        version: "2.41.0",
        releaseChannel: "latest",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
        now: NOW,
      });

      const res1 = await handleCollectorFetch(
        postEventRequest(JSON.stringify(payload1), {
          ip: rawIp,
          origin: "https://opencodex.me",
        }),
        h.env,
        undefined,
        NOW,
      );
      expect(res1.status).toBe(200);
      expect(res1.headers.get("access-control-allow-origin")).toBe("https://opencodex.me");
      expect(await res1.json()).toEqual({ ok: true, deduplicated: false });
      // 1 daily_totals + 4 daily_models + 4 daily_provider_installs + 4 daily_family_installs
      // + 3 daily_errors + 1 daily_installs = 17 statements in one atomic batch.
      expect(h.batchCalls).toEqual([17]);

      // Re-send the same (day, installDayHash) with a brand-new batchId and inflated numbers.
      const payload2 = buildTelemetryPayloadV1({
        aggregate: makeAggregate(day, {
          activeMinutes: 999,
          requests: { completed: 500, failed: 500, incomplete: 500, aborted: 500 },
        }),
        installDayHash,
        newInstall: false,
        batchId: "99999999-8888-4777-8666-555555555555",
        version: "2.41.0",
        releaseChannel: "latest",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
        now: NOW,
      });
      const res2 = await handleCollectorFetch(
        postEventRequest(JSON.stringify(payload2), { ip: rawIp }),
        h.env,
        undefined,
        NOW,
      );
      expect(res2.status).toBe(200);
      expect(await res2.json()).toEqual({ ok: true, deduplicated: true });
      // Conditional batch runs atomically and leaves all rollup rows untouched.
      expect(h.batchCalls).toEqual([17, 17]);

      const installs = h.sqlite.query("SELECT * FROM daily_installs").all() as Array<Record<string, unknown>>;
      expect(installs).toHaveLength(1);
      expect(installs[0]).toMatchObject({
        day,
        install_day_hash: installDayHash,
        version: "2.41.0",
        release_channel: "latest",
        os: "darwin",
        arch: "arm64",
        install_channel: "npm-global",
        new_install: 1,
        active_minutes: 3,
      });

      const totals = h.sqlite.query("SELECT * FROM daily_totals").all() as Array<Record<string, unknown>>;
      expect(totals).toEqual([
        {
          day,
          reports: 1,
          new_installs: 1,
          active_minutes: 3,
          completed: 1,
          failed: 1,
          incomplete: 1,
          aborted: 1,
          input: 1200,
          cache_read: 300,
          cache_write: 100,
          output: 300,
          reasoning: 50,
        },
      ]);

      const modelInstalls = h.sqlite
        .query("SELECT provider_kind, model_family, installs FROM daily_models ORDER BY provider_kind ASC")
        .all() as Array<{ provider_kind: string; model_family: string; installs: number }>;
      expect(modelInstalls).toEqual([
        { provider_kind: "chatgpt", model_family: "gpt-5", installs: 1 },
        { provider_kind: "claude-subscription", model_family: "claude-opus", installs: 1 },
        { provider_kind: "deepseek", model_family: "deepseek", installs: 1 },
        { provider_kind: "google", model_family: "gemini-3", installs: 1 },
      ]);
      // Distinct per-day install counts stay at 1 after the deduplicated re-send.
      expect(h.sqlite.query("SELECT provider_kind, installs FROM daily_provider_installs ORDER BY provider_kind ASC").all()).toEqual([
        { provider_kind: "chatgpt", installs: 1 },
        { provider_kind: "claude-subscription", installs: 1 },
        { provider_kind: "deepseek", installs: 1 },
        { provider_kind: "google", installs: 1 },
      ]);
      expect(h.sqlite.query("SELECT model_family, installs FROM daily_family_installs ORDER BY model_family ASC").all()).toEqual([
        { model_family: "claude-opus", installs: 1 },
        { model_family: "deepseek", installs: 1 },
        { model_family: "gemini-3", installs: 1 },
        { model_family: "gpt-5", installs: 1 },
      ]);
      const errorInstalls = h.sqlite
        .query("SELECT cause, installs, count FROM daily_errors ORDER BY cause ASC")
        .all() as Array<{ cause: string; installs: number; count: number }>;
      expect(errorInstalls).toEqual([
        { cause: "client-cancelled", installs: 1, count: 1 },
        { cause: "empty-output", installs: 1, count: 1 },
        { cause: "rate-limit", installs: 1, count: 1 },
      ]);

      // Privacy check: dump every row of every table and ensure no raw installId, batchId, or IP appears.
      const tables = [
        "daily_installs", "daily_totals", "daily_models", "daily_provider_installs",
        "daily_family_installs", "daily_errors", "rate_limits",
      ] as const;
      for (const table of tables) {
        const dump = JSON.stringify(h.sqlite.query(`SELECT * FROM ${table}`).all());
        expect(dump).not.toContain(rawInstallId);
        expect(dump).not.toContain(rawIp);
        expect(dump).not.toContain(payload1.batchId);
        expect(dump).not.toContain(payload2.batchId);
      }

      const rateRows = h.sqlite.query("SELECT * FROM rate_limits").all() as Array<{
        bucket_hour: string;
        ip_hash: string;
        hits: number;
      }>;
      const expectedBucket = formatBucketHour(NOW);
      const expectedIpHash = await computeHourlyIpHash("unit-salt-secret", rawIp, expectedBucket);
      expect(rateRows).toEqual([
        {
          bucket_hour: expectedBucket,
          ip_hash: expectedIpHash,
          hits: 2,
        },
      ]);
      expect(expectedIpHash).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      h.close();
    }
  });

  test("rejects non-JSON content-type, malformed JSON, unknown keys, and non-roster values with 400", async () => {
    const h = createInMemoryD1();
    try {
      const day = "2026-11-06";
      const valid = buildTelemetryPayloadV1({
        aggregate: makeAggregate(day),
        installDayHash: computeInstallDayHash("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", day),
        newInstall: false,
        version: "2.41.0",
        os: "linux",
        arch: "x64",
        installChannel: "standalone",
        now: NOW,
      });

      const nonJsonRes = await handleCollectorFetch(
        postEventRequest(JSON.stringify(valid), { contentType: "text/plain" }),
        h.env,
        undefined,
        NOW,
      );
      expect(nonJsonRes.status).toBe(400);

      const badJsonRes = await handleCollectorFetch(
        postEventRequest("{not-valid-json"),
        h.env,
        undefined,
        NOW,
      );
      expect(badJsonRes.status).toBe(400);

      const invalidPayloads: unknown[] = [
        { ...valid, extraTopKey: true },
        { ...valid, env: { ...valid.env, extraEnvKey: "nope" } },
        { ...valid, env: { ...valid.env, os: "freebsd" } },
        { ...valid, env: { ...valid.env, arch: "mips" } },
        { ...valid, env: { ...valid.env, installChannel: "brew" } },
        { ...valid, env: { ...valid.env, releaseChannel: "nightly" } },
        { ...valid, env: { ...valid.env, version: "2.41.0+build123" } },
        { ...valid, models: [{ ...valid.models[0]!, providerKind: "custom-secret-provider" }] },
        { ...valid, models: [{ ...valid.models[0]!, modelFamily: "secret-finetune" }] },
        { ...valid, errors: { "free-form-error": 1 } },
      ];

      for (const bad of invalidPayloads) {
        const res = await handleCollectorFetch(
          postEventRequest(JSON.stringify(bad)),
          h.env,
          undefined,
          NOW,
        );
        expect(res.status).toBe(400);
      }

      const installsCount = h.sqlite.query("SELECT COUNT(*) AS n FROM daily_installs").get() as { n: number };
      expect(installsCount.n).toBe(0);
    } finally {
      h.close();
    }
  });

  test("enforces 16 KiB body cap with 413 and 120/hour IP hash rate limit with 429 + Retry-After", async () => {
    expect(MAX_REPORTS_PER_HOUR).toBe(120);
    const h = createInMemoryD1("rate-salt");
    try {
      const day = "2026-11-06";
      const basePayload = buildTelemetryPayloadV1({
        aggregate: makeAggregate(day),
        installDayHash: computeInstallDayHash("12121212-3434-4567-89ab-cdef01234567", day),
        newInstall: false,
        version: "2.41.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "desktop",
        now: NOW,
      });

      // 413 via oversized body (> 16 KiB)
      const oversizedBody = new Uint8Array(MAX_INGEST_BODY_BYTES + 1).fill(0x20);
      const res413Body = await handleCollectorFetch(
        postEventRequest(oversizedBody),
        h.env,
        undefined,
        NOW,
      );
      expect(res413Body.status).toBe(413);

      // 413 via declared Content-Length header
      const res413Header = await handleCollectorFetch(
        postEventRequest(JSON.stringify(basePayload), {
          contentLength: String(MAX_INGEST_BODY_BYTES + 100),
        }),
        h.env,
        undefined,
        NOW,
      );
      expect(res413Header.status).toBe(413);

      // Send 120 valid reports from the same IP in the same hour; all 120 succeed.
      const clientIp = "198.51.100.77";
      for (let i = 0; i < MAX_REPORTS_PER_HOUR; i++) {
        const res = await handleCollectorFetch(
          postEventRequest(JSON.stringify(basePayload), { ip: clientIp }),
          h.env,
          undefined,
          NOW,
        );
        expect(res.status).toBe(200);
      }

      // 121st report in the same hour returns 429 with Retry-After.
      const res429 = await handleCollectorFetch(
        postEventRequest(JSON.stringify(basePayload), { ip: clientIp }),
        h.env,
        undefined,
        NOW,
      );
      expect(res429.status).toBe(429);
      const retryAfter = Number(res429.headers.get("retry-after"));
      expect(Number.isInteger(retryAfter)).toBe(true);
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(3600);
      expect(retryAfter).toBe(1800); // NOW is 12:30:00Z -> 1800s until 13:00:00Z

      // A different IP in the same hour is not rate-limited.
      const resOtherIp = await handleCollectorFetch(
        postEventRequest(JSON.stringify(basePayload), { ip: "198.51.100.78" }),
        h.env,
        undefined,
        NOW,
      );
      expect(resOtherIp.status).toBe(200);

      // The original IP succeeds again in the next UTC hour.
      const resNextHour = await handleCollectorFetch(
        postEventRequest(JSON.stringify(basePayload), { ip: clientIp }),
        h.env,
        undefined,
        NOW + HOUR_MS,
      );
      expect(resNextHour.status).toBe(200);
    } finally {
      h.close();
    }
  });

  test("handles CORS for allowed origins, OPTIONS preflight, and 404/405 responses", async () => {
    const h = createInMemoryD1();
    try {
      for (const origin of ALLOWED_CORS_ORIGINS) {
        const preflight = await worker.fetch(
          new Request("https://telemetry.opencodex.me/v1/stats?range=7d", {
            method: "OPTIONS",
            headers: { origin },
          }),
          h.env,
        );
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get("access-control-allow-origin")).toBe(origin);
        expect(preflight.headers.get("access-control-allow-methods")).toContain("GET");
        expect(preflight.headers.get("vary")).toBe("Origin");
      }

      const untrusted = await worker.fetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d", {
          method: "GET",
          headers: { origin: "https://evil.example" },
        }),
        h.env,
      );
      expect(untrusted.status).toBe(200);
      expect(untrusted.headers.get("access-control-allow-origin")).toBeNull();

      const getEvents = await worker.fetch(
        new Request("https://telemetry.opencodex.me/v1/events", {
          method: "GET",
          headers: { origin: "http://localhost:4321" },
        }),
        h.env,
      );
      expect(getEvents.status).toBe(405);
      expect(getEvents.headers.get("allow")).toBe("POST, OPTIONS");
      expect(getEvents.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");

      const postStats = await worker.fetch(
        new Request("https://telemetry.opencodex.me/v1/stats", {
          method: "POST",
          headers: { origin: "https://opencodex.me" },
        }),
        h.env,
      );
      expect(postStats.status).toBe(405);
      expect(postStats.headers.get("allow")).toBe("GET, OPTIONS");
      expect(postStats.headers.get("access-control-allow-origin")).toBe("https://opencodex.me");

      const notFound = await worker.fetch(
        new Request("https://telemetry.opencodex.me/v1/unknown", {
          method: "GET",
          headers: { origin: "https://opencodex.me" },
        }),
        h.env,
      );
      expect(notFound.status).toBe(404);
      expect(notFound.headers.get("access-control-allow-origin")).toBe("https://opencodex.me");
    } finally {
      h.close();
    }
  });

  test("serves TelemetryStatsV1 across 7d, 30d, 90d, and 365d with every field and a 365-day heatmap", async () => {
    const h = createInMemoryD1();
    try {
      const ingestCohortAt = async (
        dayOffset: number,
        cohortPrefix: string,
        options: {
          newInstall: boolean;
          version: string;
          os: "darwin" | "linux" | "win32";
          arch: "arm64" | "x64";
          installChannel: "npm-global" | "desktop" | "standalone";
        },
      ) => {
        const eventNow = NOW - (dayOffset - 1) * DAY_MS;
        const day = new Date(NOW - dayOffset * DAY_MS).toISOString().slice(0, 10);
        for (let i = 0; i < 10; i++) {
          const installUuid = `${cohortPrefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
          const payload = buildTelemetryPayloadV1({
            aggregate: makeAggregate(day),
            installDayHash: computeInstallDayHash(installUuid, day),
            newInstall: options.newInstall && i === 0,
            version: options.version,
            os: options.os,
            arch: options.arch,
            installChannel: options.installChannel,
            now: eventNow,
          });
          const res = await handleCollectorFetch(
            postEventRequest(JSON.stringify(payload), { ip: `10.0.${dayOffset}.${i + 1}` }),
            h.env,
            undefined,
            eventNow,
          );
          expect(res.status).toBe(200);
        }
      };

      // Seed 10 reports per day at 1d ago (in 7d), 20d ago (in 30d), 60d ago (in 90d), and 200d ago (in 365d)
      await ingestCohortAt(1, "10000001", {
        newInstall: true,
        version: "2.41.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      });
      await ingestCohortAt(20, "10000002", {
        newInstall: false,
        version: "2.40.0",
        os: "linux",
        arch: "x64",
        installChannel: "standalone",
      });
      await ingestCohortAt(60, "10000003", {
        newInstall: true,
        version: "2.39.0",
        os: "win32",
        arch: "x64",
        installChannel: "desktop",
      });
      await ingestCohortAt(200, "10000004", {
        newInstall: false,
        version: "2.35.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      });

      const expectedByRange: Record<
        "7d" | "30d" | "90d" | "365d",
        { reports: number; days: number; avgDaily: number }
      > = {
        "7d": { reports: 10, days: 7, avgDaily: 1.4 },
        "30d": { reports: 20, days: 30, avgDaily: 0.7 },
        "90d": { reports: 30, days: 90, avgDaily: 0.3 },
        "365d": { reports: 40, days: 365, avgDaily: 0.1 },
      };

      for (const [range, expected] of Object.entries(expectedByRange) as Array<
        ["7d" | "30d" | "90d" | "365d", { reports: number; days: number; avgDaily: number }]
      >) {
        const expectedReports = expected.reports;
        const expectedDays = expected.reports / 10;
        const res = await handleCollectorFetch(
          new Request(`https://telemetry.opencodex.me/v1/stats?range=${range}`, {
            method: "GET",
            headers: { origin: "https://opencodex.me" },
          }),
          h.env,
          undefined,
          NOW,
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=300");
        expect(res.headers.get("access-control-allow-origin")).toBe("https://opencodex.me");

        const stats = (await res.json()) as TelemetryStatsV1;
        expect(stats.schemaVersion).toBe(1);
        expect(stats.range).toBe(range);
        expect(stats.generatedAt).toBe(new Date(NOW).toISOString());
        expect(stats.totals).toEqual({
          activeInstalls: expectedReports,
          avgDailyActiveInstalls: expected.avgDaily,
          newInstalls: range === "7d" || range === "30d" ? 1 : 2,
          activeMinutes: expectedReports * 3,
          requests: expectedReports * 4,
          tokens: {
            input: expectedReports * 1200,
            cacheRead: expectedReports * 300,
            cacheWrite: expectedReports * 100,
            output: expectedReports * 300,
            reasoning: expectedReports * 50,
          },
        });
        expect(stats.daily).toHaveLength(expectedDays);
        expect(stats.daily[0]).toMatchObject({
          activeInstalls: 10,
          activeMinutes: 30,
          requests: 40,
          failed: 10,
          tokens: 19500,
        });
        expect(stats.dailyByProvider.length).toBe(expectedDays * 4);
        expect(stats.heatmap).toHaveLength(365);
        expect(stats.heatmap[0]?.day).toBe("2025-11-08");
        expect(stats.heatmap[364]?.day).toBe("2026-11-07");
        const nonZeroHeatmapDays = stats.heatmap.filter(d => d.activeInstalls > 0);
        expect(nonZeroHeatmapDays).toHaveLength(4);

        expect(stats.providers).toEqual([
          { providerKind: "claude-subscription", requests: expectedReports, tokens: expectedReports * 1250 },
          { providerKind: "google", requests: expectedReports, tokens: expectedReports * 460 },
          { providerKind: "chatgpt", requests: expectedReports, tokens: expectedReports * 240 },
          { providerKind: "deepseek", requests: expectedReports, tokens: 0 },
        ]);
        expect(stats.models).toEqual([
          { modelFamily: "claude-opus", requests: expectedReports, tokens: expectedReports * 1250 },
          { modelFamily: "gemini-3", requests: expectedReports, tokens: expectedReports * 460 },
          { modelFamily: "gpt-5", requests: expectedReports, tokens: expectedReports * 240 },
          { modelFamily: "deepseek", requests: expectedReports, tokens: 0 },
        ]);
        expect(stats.versions.reduce((sum, row) => sum + row.installs, 0)).toBe(expectedReports);
        expect(stats.platforms.reduce((sum, row) => sum + row.installs, 0)).toBe(expectedReports);
        expect(stats.channels.reduce((sum, row) => sum + row.installs, 0)).toBe(expectedReports);
        expect(stats.outcomes).toEqual({
          completed: expectedReports,
          failed: expectedReports,
          incomplete: expectedReports,
          aborted: expectedReports,
        });
        expect(stats.errors).toEqual([
          { cause: "client-cancelled", count: expectedReports },
          { cause: "empty-output", count: expectedReports },
          { cause: "rate-limit", count: expectedReports },
        ]);
      }

      // Invalid range returns 400
      const badRange = await handleCollectorFetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=14d"),
        h.env,
        undefined,
        NOW,
      );
      expect(badRange.status).toBe(400);
    } finally {
      h.close();
    }
  });

  test("scheduled pruning removes daily_installs older than 400 days and rate_limits older than 2 hours", async () => {
    const h = createInMemoryD1();
    try {
      const oldDay = new Date(NOW - 401 * DAY_MS).toISOString().slice(0, 10);
      const recentDay = new Date(NOW - 399 * DAY_MS).toISOString().slice(0, 10);

      await h.db
        .prepare(
          "INSERT INTO daily_installs (day, install_day_hash, version, release_channel, os, arch, install_channel, new_install, active_minutes) " +
          "VALUES (?1, ?2, '2.0.0', 'latest', 'darwin', 'arm64', 'npm-global', 0, 10)",
        )
        .bind(oldDay, "a".repeat(64))
        .run();
      await h.db
        .prepare(
          "INSERT INTO daily_installs (day, install_day_hash, version, release_channel, os, arch, install_channel, new_install, active_minutes) " +
          "VALUES (?1, ?2, '2.1.0', 'latest', 'darwin', 'arm64', 'npm-global', 0, 15)",
        )
        .bind(recentDay, "b".repeat(64))
        .run();

      const oldHour = formatBucketHour(NOW - 3 * HOUR_MS);
      const twoHoursAgo = formatBucketHour(NOW - 2 * HOUR_MS);
      const oneHourAgo = formatBucketHour(NOW - 1 * HOUR_MS);
      const currentHour = formatBucketHour(NOW);

      for (const bucket of [oldHour, twoHoursAgo, oneHourAgo, currentHour]) {
        await h.db
          .prepare("INSERT INTO rate_limits (bucket_hour, ip_hash, hits) VALUES (?1, ?2, 5)")
          .bind(bucket, "c".repeat(64))
          .run();
      }

      const pruneRes = await pruneCollectorTables(h.db, NOW);
      expect(pruneRes.deletedInstalls).toBe(1);
      expect(pruneRes.deletedRateLimits).toBe(2);

      // Verify scheduled handler also runs cleanly
      let waited = false;
      await handleCollectorScheduled(
        { scheduledTime: NOW, cron: "15 * * * *" },
        h.env,
        {
          waitUntil(promise) {
            waited = true;
            void promise;
          },
          passThroughOnException() {},
        },
      );
      expect(waited).toBe(true);

      const remainingInstalls = h.sqlite
        .query("SELECT day FROM daily_installs ORDER BY day ASC")
        .all() as Array<{ day: string }>;
      expect(remainingInstalls).toEqual([{ day: recentDay }]);

      const remainingRates = h.sqlite
        .query("SELECT bucket_hour FROM rate_limits ORDER BY bucket_hour ASC")
        .all() as Array<{ bucket_hour: string }>;
      expect(remainingRates).toEqual([
        { bucket_hour: oneHourAgo },
        { bucket_hour: currentHour },
      ]);
    } finally {
      h.close();
    }
  });

  test("aborts streaming bodies exceeding 16 KiB before reading full stream and rejects malformed Content-Length", async () => {
    const h = createInMemoryD1("stream-salt");
    try {
      for (const badLength of ["-1", "abc", "12.5", ""]) {
        const badHeaderReq = new Request("https://telemetry.opencodex.me/v1/events", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": badLength,
          },
          body: "{}",
        });
        const res = await handleCollectorFetch(badHeaderReq, h.env, undefined, NOW);
        expect(res.status).toBe(400);
      }

      let pulledChunks = 0;
      let streamCancelled = false;
      const chunkSize = 4096;
      const totalChunks = 50; // 200 KiB total if fully buffered
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulledChunks += 1;
          if (pulledChunks > totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
        },
        cancel() {
          streamCancelled = true;
        },
      });

      // Lying small Content-Length (or chunked stream) must still abort as soon as > 16 KiB is read.
      const lyingReq = new Request("https://telemetry.opencodex.me/v1/events", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "content-length": "64",
        },
        body: stream,
        duplex: "half",
      } as RequestInit);

      const res413 = await handleCollectorFetch(lyingReq, h.env, undefined, NOW);
      expect(res413.status).toBe(413);
      expect(pulledChunks).toBeLessThanOrEqual(6);
      expect(streamCancelled).toBe(true);

      // Chunked stream with no Content-Length header must also abort as soon as > 16 KiB is read.
      let chunkedPulled = 0;
      let chunkedCancelled = false;
      const chunkedStream = new ReadableStream<Uint8Array>({
        pull(controller) {
          chunkedPulled += 1;
          if (chunkedPulled > totalChunks) {
            controller.close();
            return;
          }
          controller.enqueue(new Uint8Array(chunkSize).fill(0x62));
        },
        cancel() {
          chunkedCancelled = true;
        },
      });
      const chunkedReq = new Request("https://telemetry.opencodex.me/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: chunkedStream,
        duplex: "half",
      } as RequestInit);
      const res413Chunked = await handleCollectorFetch(chunkedReq, h.env, undefined, NOW);
      expect(res413Chunked.status).toBe(413);
      expect(chunkedPulled).toBeLessThanOrEqual(6);
      expect(chunkedCancelled).toBe(true);
    } finally {
      h.close();
    }
  });

  test("fails closed with 503 when RATE_LIMIT_SALT is missing or empty and delimits IP hash components", async () => {
    const h = createInMemoryD1("");
    try {
      const day = "2026-11-06";
      const payload = buildTelemetryPayloadV1({
        aggregate: makeAggregate(day),
        installDayHash: computeInstallDayHash("11111111-2222-4333-8444-555555555555", day),
        newInstall: false,
        version: "2.41.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
        now: NOW,
      });

      const resEmpty = await handleCollectorFetch(
        postEventRequest(JSON.stringify(payload), { origin: "https://opencodex.me" }),
        { DB: h.db, RATE_LIMIT_SALT: "   " },
        undefined,
        NOW,
      );
      expect(resEmpty.status).toBe(503);
      expect(resEmpty.headers.get("access-control-allow-origin")).toBe("https://opencodex.me");
      expect(await resEmpty.json()).toEqual({
        ok: false,
        error: "collector rate-limit salt is not configured",
      });

      const resMissing = await handleCollectorFetch(
        postEventRequest(JSON.stringify(payload)),
        { DB: h.db } as unknown as CollectorEnv,
        undefined,
        NOW,
      );
      expect(resMissing.status).toBe(503);

      const rateCount = h.sqlite.query("SELECT COUNT(*) AS n FROM rate_limits").get() as { n: number };
      const installCount = h.sqlite.query("SELECT COUNT(*) AS n FROM daily_installs").get() as { n: number };
      expect(rateCount.n).toBe(0);
      expect(installCount.n).toBe(0);

      // Delimiter check: shifting characters across salt/ip/bucketHour boundaries must not collide.
      const hashA = await computeHourlyIpHash("saltA", "1.2.3.4", "2026-11-07T12");
      const hashB = await computeHourlyIpHash("salt", "A1.2.3.4", "2026-11-07T12");
      const hashC = await computeHourlyIpHash("salt", "1.2.3.4", "2026-11-07T120");
      const hashD = await computeHourlyIpHash("salt", "01.2.3.4", "2026-11-07T12");
      expect(hashA).not.toBe(hashB);
      expect(hashC).not.toBe(hashD);
    } finally {
      h.close();
    }
  });

  test("rolls back daily_installs and rollups atomically on batch failure and succeeds on retry without leaking D1 errors", async () => {
    const h = createInMemoryD1("atomic-salt");
    try {
      const day = "2026-11-06";
      const payload = buildTelemetryPayloadV1({
        aggregate: makeAggregate(day),
        installDayHash: computeInstallDayHash("aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb", day),
        newInstall: true,
        version: "2.41.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
        now: NOW,
      });

      // Inject a failure on daily_errors inside the rollup transaction.
      h.sqlite.exec(
        "CREATE TRIGGER fail_daily_errors BEFORE INSERT ON daily_errors " +
        "BEGIN SELECT RAISE(ABORT, 'secret_internal_d1_error_detail'); END;",
      );

      const failedRes = await handleCollectorFetch(
        postEventRequest(JSON.stringify(payload), {
          ip: "198.51.100.200",
          origin: "https://opencodex.me",
        }),
        h.env,
        undefined,
        NOW,
      );
      expect(failedRes.status).toBe(500);
      expect(failedRes.headers.get("access-control-allow-origin")).toBe("https://opencodex.me");
      const failedBody = await failedRes.text();
      expect(failedBody).not.toContain("secret_internal_d1_error_detail");
      expect(JSON.parse(failedBody)).toEqual({ ok: false, error: "internal error" });

      // Neither daily_installs nor any rollup table may have committed rows.
      for (const table of ["daily_installs", "daily_totals", "daily_models", "daily_errors"] as const) {
        const count = h.sqlite.query("SELECT COUNT(*) AS n FROM " + table).get() as { n: number };
        expect(count.n).toBe(0);
      }

      // Remove trigger and retry the exact same report: must succeed with deduplicated: false.
      h.sqlite.exec("DROP TRIGGER fail_daily_errors;");
      const retryRes = await handleCollectorFetch(
        postEventRequest(JSON.stringify(payload), {
          ip: "198.51.100.200",
          origin: "https://opencodex.me",
        }),
        h.env,
        undefined,
        NOW,
      );
      expect(retryRes.status).toBe(200);
      expect(await retryRes.json()).toEqual({ ok: true, deduplicated: false });

      const installs = h.sqlite.query("SELECT COUNT(*) AS n FROM daily_installs").get() as { n: number };
      const totals = h.sqlite.query("SELECT reports FROM daily_totals WHERE day = ?1").get(day) as { reports: number };
      expect(installs.n).toBe(1);
      expect(totals.reports).toBe(1);
    } finally {
      h.close();
    }
  });

  test("enforces per-report aggregate ceilings, version length cap, versions LIMIT 50, and MAX_SAFE_INTEGER clamping", async () => {
    const h = createInMemoryD1("bounds-salt");
    try {
      const day = "2026-11-06";
      const valid = buildTelemetryPayloadV1({
        aggregate: makeAggregate(day),
        installDayHash: computeInstallDayHash("cccccccc-1111-4222-8333-dddddddddddd", day),
        newInstall: false,
        version: "2.41.0",
        os: "linux",
        arch: "x64",
        installChannel: "standalone",
        now: NOW,
      });

      // 1. Model row with 0 requests but positive tokens -> 400
      const zeroReqWithTokens = {
        ...valid,
        models: [
          {
            providerKind: "openai",
            modelFamily: "gpt-5",
            requests: 0,
            inputTokens: 100,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        ],
      };
      expect(
        (await handleCollectorFetch(postEventRequest(JSON.stringify(zeroReqWithTokens)), h.env, undefined, NOW)).status,
      ).toBe(400);

      // 2. Aggregate report tokens > 1_000_000_000_000 across buckets/rows -> 400
      const overAggregateTokens = {
        ...valid,
        models: [
          {
            providerKind: "openai",
            modelFamily: "gpt-5",
            requests: 1,
            inputTokens: 600_000_000_000,
            cacheReadTokens: 600_000_000_000,
            cacheWriteTokens: 0,
            outputTokens: 0,
            reasoningTokens: 0,
          },
        ],
      };
      expect(
        (await handleCollectorFetch(postEventRequest(JSON.stringify(overAggregateTokens)), h.env, undefined, NOW)).status,
      ).toBe(400);

      // 3. Aggregate requests > 10_000_000 -> 400
      const overAggregateRequests = {
        ...valid,
        requests: {
          completed: 6_000_000,
          failed: 5_000_000,
          incomplete: 0,
          aborted: 0,
        },
      };
      expect(
        (await handleCollectorFetch(postEventRequest(JSON.stringify(overAggregateRequests)), h.env, undefined, NOW)).status,
      ).toBe(400);

      const overModelRequests = {
        ...valid,
        models: [
          { ...valid.models[0]!, providerKind: "openai", modelFamily: "gpt-5", requests: 6_000_000 },
          { ...valid.models[0]!, providerKind: "anthropic", modelFamily: "claude-opus", requests: 5_000_000 },
        ],
      };
      expect(
        (await handleCollectorFetch(postEventRequest(JSON.stringify(overModelRequests)), h.env, undefined, NOW)).status,
      ).toBe(400);

      const overErrorCounts = {
        ...valid,
        errors: {
          "rate-limit": 6_000_000,
          "empty-output": 5_000_000,
        },
      };
      expect(
        (await handleCollectorFetch(postEventRequest(JSON.stringify(overErrorCounts)), h.env, undefined, NOW)).status,
      ).toBe(400);

      // 4. env.version longer than 32 chars -> 400
      const longVersion = {
        ...valid,
        env: {
          ...valid.env,
          version: "1.0." + "9".repeat(35),
        },
      };
      expect(
        (await handleCollectorFetch(postEventRequest(JSON.stringify(longVersion)), h.env, undefined, NOW)).status,
      ).toBe(400);

      // 5. Seed near-MAX_SAFE_INTEGER counters in daily_totals and daily_models, then ingest another report
      // and verify counters clamp to Number.MAX_SAFE_INTEGER without overflowing SQLite 64-bit INTEGER.
      const nearMax = Number.MAX_SAFE_INTEGER - 10;
      h.sqlite
        .query(
          "INSERT INTO daily_totals (day, reports, new_installs, active_minutes, completed, failed, incomplete, aborted, input, cache_read, cache_write, output, reasoning) " +
          "VALUES (?1, 1, 1, 1, ?2, 0, 0, 0, ?2, ?2, ?2, ?2, ?2)",
        )
        .run(day, nearMax);
      h.sqlite
        .query(
          "INSERT INTO daily_models (day, provider_kind, model_family, installs, requests, input, cache_read, cache_write, output, reasoning) " +
          "VALUES (?1, 'claude-subscription', 'claude-opus', 10, ?2, ?2, ?2, ?2, ?2, ?2)",
        )
        .run(day, nearMax);
      h.sqlite.query("INSERT INTO daily_provider_installs (day, provider_kind, installs) VALUES (?1, 'claude-subscription', 10)").run(day);
      h.sqlite.query("INSERT INTO daily_family_installs (day, model_family, installs) VALUES (?1, 'claude-opus', 10)").run(day);

      const clampRes = await handleCollectorFetch(
        postEventRequest(JSON.stringify(valid), { ip: "198.51.100.201" }),
        h.env,
        undefined,
        NOW,
      );
      expect(clampRes.status).toBe(200);

      // Also seed 60 distinct versions (>= 10 installs each) in daily_installs to verify LIMIT 50 in /v1/stats.
      for (let i = 0; i < 60; i++) {
        for (let j = 0; j < 10; j++) {
          h.sqlite
            .query(
              "INSERT INTO daily_installs (day, install_day_hash, version, release_channel, os, arch, install_channel, new_install, active_minutes) " +
              "VALUES (?1, ?2, ?3, 'latest', 'linux', 'x64', 'standalone', 0, 1)",
            )
            .run(day, `${i.toString(16).padStart(32, "0")}${j.toString(16).padStart(32, "0")}`, "2.0." + String(i));
        }
      }

      const statsRes = await handleCollectorFetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d"),
        h.env,
        undefined,
        NOW,
      );
      expect(statsRes.status).toBe(200);
      const stats = (await statsRes.json()) as TelemetryStatsV1;
      expect(stats.totals.tokens.input).toBe(Number.MAX_SAFE_INTEGER);
      expect(stats.totals.requests).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
      expect(stats.daily[0]?.tokens).toBe(Number.MAX_SAFE_INTEGER);
      expect(stats.providers[0]?.tokens).toBe(Number.MAX_SAFE_INTEGER);
      expect(stats.models[0]?.tokens).toBe(Number.MAX_SAFE_INTEGER);
      expect(stats.versions).toHaveLength(50);
    } finally {
      h.close();
    }
  });

  test("enforces exact N-day UTC range boundaries aligned with heatmap and caches /v1/stats in one D1 batch", async () => {
    const h = createInMemoryD1("range-cache-salt");
    try {
      // NOW is 2026-11-07T12:30:00Z -> today = 2026-11-07.
      // For 7d: [2026-11-01 (today - 6d), 2026-11-07 (today)].
      // 2026-10-31 (today - 7d) and 2026-11-08 (today + 1d) must both be excluded from 7d.
      const boundaryDays = [
        { day: "2026-10-31", ip: "10.1.0.1" }, // today - 7d (outside 7d, inside 30d)
        { day: "2026-11-01", ip: "10.1.0.2" }, // today - 6d (inside 7d)
        { day: "2026-11-07", ip: "10.1.0.3" }, // today (inside 7d)
        { day: "2026-11-08", ip: "10.1.0.4" }, // today + 1d (accepted on ingest for clock skew, excluded from stats ranges <= today)
      ];

      for (const { day, ip } of boundaryDays) {
        const payload = buildTelemetryPayloadV1({
          aggregate: makeAggregate(day),
          installDayHash: computeInstallDayHash("eeeeeeee-1111-4222-8333-ffffffffffff", day),
          newInstall: false,
          version: "2.41.0",
          os: "darwin",
          arch: "arm64",
          installChannel: "npm-global",
          now: NOW,
        });
        const res = await handleCollectorFetch(
          postEventRequest(JSON.stringify(payload), { ip }),
          h.env,
          undefined,
          NOW,
        );
        expect(res.status).toBe(200);
      }

      const batchCountBeforeStats = h.batchCalls.length;
      const stats7dRes = await handleCollectorFetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d&_=1"),
        h.env,
        undefined,
        NOW,
      );
      expect(stats7dRes.status).toBe(200);
      const stats7d = (await stats7dRes.json()) as TelemetryStatsV1;
      expect(stats7d.daily.map(d => d.day)).toEqual(["2026-11-01", "2026-11-07"]);
      expect(stats7d.totals.activeInstalls).toBe(2);
      expect(stats7d.heatmap.filter(d => d.activeInstalls > 0).map(d => d.day)).toEqual([
        "2026-10-31",
        "2026-11-01",
        "2026-11-07",
      ]);

      // Stats query must execute in a single D1 batch call.
      expect(h.batchCalls.length).toBe(batchCountBeforeStats + 1);

      // Cache-busted repeat request within 300s TTL must be served from Worker cache without hitting D1.
      const cachedRes = await handleCollectorFetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d&_=cachebust2"),
        h.env,
        undefined,
        NOW + 30_000,
      );
      expect(cachedRes.status).toBe(200);
      expect(h.batchCalls.length).toBe(batchCountBeforeStats + 1);
      expect(await cachedRes.json()).toEqual(stats7d);

      // Advancing past the 300s TTL expires the cached entry and triggers a fresh D1 batch.
      const expiredRes = await handleCollectorFetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d&_=afterTtl"),
        h.env,
        undefined,
        NOW + 300_001,
      );
      expect(expiredRes.status).toBe(200);
      expect(h.batchCalls.length).toBe(batchCountBeforeStats + 2);

      // Explicit bypassCache option skips the cache even within the TTL window.
      const bypassRes = await handleStats(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d"),
        h.env,
        NOW + 300_010,
        { bypassCache: true },
      );
      expect(bypassRes.status).toBe(200);
      expect(h.batchCalls.length).toBe(batchCountBeforeStats + 3);

      // When caches.default is available and in-isolate memory is cleared, edge cache serves the canonical range key.
      const edgeStore = new Map<string, Response>();
      const prevCaches = (globalThis as { caches?: unknown }).caches;
      (globalThis as { caches?: unknown }).caches = {
        default: {
          async match(req: Request): Promise<Response | undefined> {
            return edgeStore.get(req.url)?.clone();
          },
          async put(req: Request, res: Response): Promise<void> {
            edgeStore.set(req.url, res.clone());
          },
        },
      };
      try {
        clearStatsCache();
        const populateEdge = await handleCollectorFetch(
          new Request("https://telemetry.opencodex.me/v1/stats?range=30d&utm=1"),
          h.env,
          undefined,
          NOW,
        );
        expect(populateEdge.status).toBe(200);
        expect(edgeStore.has("https://telemetry.opencodex.me/v1/stats?range=30d")).toBe(true);
        const batchesAfterPopulate = h.batchCalls.length;

        clearStatsCache();
        const fromEdge = await handleCollectorFetch(
          new Request("https://telemetry.opencodex.me/v1/stats?range=30d&utm=2"),
          h.env,
          undefined,
          NOW + 5_000,
        );
        expect(fromEdge.status).toBe(200);
        expect(h.batchCalls.length).toBe(batchesAfterPopulate);
      } finally {
        (globalThis as { caches?: unknown }).caches = prevCaches;
        clearStatsCache();
      }
    } finally {
      h.close();
    }
  });

  test("applies the 10-install cohort threshold per day, folds single-valued dimensions into a per-day 'other', and keeps totals/daily/heatmap unchanged", async () => {
    const h = createInMemoryD1("cohort-salt");
    try {
      const day1 = "2026-11-05";
      const day2 = "2026-11-06";

      // Verify schema.sql migration-safe DEFAULT 0 on daily_models.installs and daily_errors.installs
      h.sqlite
        .query(
          "INSERT INTO daily_models (day, provider_kind, model_family, requests, input, cache_read, cache_write, output, reasoning) " +
          "VALUES ('2026-10-01', 'openai', 'gpt-5', 1, 10, 0, 0, 5, 0)",
        )
        .run();
      h.sqlite
        .query("INSERT INTO daily_errors (day, cause, count) VALUES ('2026-10-01', 'rate-limit', 1)")
        .run();
      const defaultModelRow = h.sqlite
        .query("SELECT installs FROM daily_models WHERE day = '2026-10-01'")
        .get() as { installs: number };
      const defaultErrorRow = h.sqlite
        .query("SELECT installs FROM daily_errors WHERE day = '2026-10-01'")
        .get() as { installs: number };
      expect(defaultModelRow.installs).toBe(0);
      expect(defaultErrorRow.installs).toBe(0);

      const ingestCustom = async (opts: {
        day: string;
        count: number;
        prefix: string;
        version: string;
        os: "darwin" | "linux" | "win32";
        arch: "arm64" | "x64";
        installChannel: "npm-global" | "standalone" | "desktop" | "docker";
        newInstallCount?: number;
        providerKind: "anthropic" | "openai" | "google" | "xai";
        modelFamily: "claude-opus" | "gpt-5" | "gemini-3" | "grok";
        requests: number;
        inputTokens: number;
        errorCause: "rate-limit" | "empty-output" | "client-cancelled" | "upstream-fault";
        errorCount: number;
      }) => {
        for (let i = 0; i < opts.count; i++) {
          const uuid = `${opts.prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
          const payload = buildTelemetryPayloadV1({
            aggregate: {
              day: opts.day,
              activeMinutes: 5,
              requests: {
                completed: opts.requests,
                failed: opts.errorCount,
                incomplete: 0,
                aborted: 0,
              },
              models: [
                {
                  providerKind: opts.providerKind,
                  modelFamily: opts.modelFamily,
                  requests: opts.requests,
                  inputTokens: opts.inputTokens,
                  cacheReadTokens: 0,
                  cacheWriteTokens: 0,
                  outputTokens: 0,
                  reasoningTokens: 0,
                },
              ],
              errors: {
                [opts.errorCause]: opts.errorCount,
              },
            },
            installDayHash: computeInstallDayHash(uuid, opts.day),
            newInstall: i < (opts.newInstallCount ?? 0),
            version: opts.version,
            os: opts.os,
            arch: opts.arch,
            installChannel: opts.installChannel,
            now: NOW,
          });
          const res = await handleCollectorFetch(
            postEventRequest(JSON.stringify(payload), { ip: `198.18.${opts.prefix.slice(-2)}.${i + 1}` }),
            h.env,
            undefined,
            NOW,
          );
          expect(res.status).toBe(200);
        }
      };

      // Day 1:
      // - Major cohort (12 installs >= 10): anthropic / claude-opus / 2.41.0 / darwin-arm64 / npm-global / rate-limit
      // - Two small cohorts (6 + 5 installs, each < 10 on the day):
      //   * 6 installs: openai / gpt-5 / 2.40.0 / linux-x64 / standalone / empty-output
      //   * 5 installs: google / gemini-3 / 2.39.0 / win32-x64 / desktop / client-cancelled
      // - Multi-day cohort (5 installs on day1 + 5 installs on day2: 10 install-days in the range, < 10 on each day):
      //   * 5 installs on day1: xai / grok / 2.38.0 / linux-arm64 / docker / upstream-fault
      await ingestCustom({
        day: day1,
        count: 12,
        prefix: "aaaa0001",
        version: "2.41.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
        newInstallCount: 3,
        providerKind: "anthropic",
        modelFamily: "claude-opus",
        requests: 10,
        inputTokens: 1000,
        errorCause: "rate-limit",
        errorCount: 2,
      });
      await ingestCustom({
        day: day1,
        count: 6,
        prefix: "aaaa0002",
        version: "2.40.0",
        os: "linux",
        arch: "x64",
        installChannel: "standalone",
        newInstallCount: 2,
        providerKind: "openai",
        modelFamily: "gpt-5",
        requests: 5,
        inputTokens: 500,
        errorCause: "empty-output",
        errorCount: 3,
      });
      await ingestCustom({
        day: day1,
        count: 5,
        prefix: "aaaa0003",
        version: "2.39.0",
        os: "win32",
        arch: "x64",
        installChannel: "desktop",
        newInstallCount: 1,
        providerKind: "google",
        modelFamily: "gemini-3",
        requests: 4,
        inputTokens: 400,
        errorCause: "client-cancelled",
        errorCount: 1,
      });
      await ingestCustom({
        day: day1,
        count: 5,
        prefix: "aaaa0004",
        version: "2.38.0",
        os: "linux",
        arch: "arm64",
        installChannel: "docker",
        newInstallCount: 1,
        providerKind: "xai",
        modelFamily: "grok",
        requests: 2,
        inputTokens: 200,
        errorCause: "upstream-fault",
        errorCount: 1,
      });

      // Day 2: 5 more installs of the xai/grok cohort. Its 10 install-days over the range must not
      // publish it: the threshold applies per day, and neither day reaches 10.
      await ingestCustom({
        day: day2,
        count: 5,
        prefix: "aaaa0005",
        version: "2.38.0",
        os: "linux",
        arch: "arm64",
        installChannel: "docker",
        newInstallCount: 1,
        providerKind: "xai",
        modelFamily: "grok",
        requests: 2,
        inputTokens: 200,
        errorCause: "upstream-fault",
        errorCount: 1,
      });

      const resFolded = await handleCollectorFetch(
        new Request("https://telemetry.opencodex.me/v1/stats?range=7d"),
        h.env,
        undefined,
        NOW,
      );
      expect(resFolded.status).toBe(200);
      const statsFolded = (await resFolded.json()) as TelemetryStatsV1;

      // Total install-days = 28 (day1) + 5 (day2) = 33; avgDailyActiveInstalls = round((33 / 7) * 10) / 10 = 4.7
      expect(statsFolded.totals.activeInstalls).toBe(33);
      expect(statsFolded.totals.avgDailyActiveInstalls).toBe(4.7);
      expect(statsFolded.daily.map(d => ({ day: d.day, activeInstalls: d.activeInstalls }))).toEqual([
        { day: day1, activeInstalls: 28 },
        { day: day2, activeInstalls: 5 },
      ]);

      // Range breakdowns keep only (day, key) rows with >= 10 distinct installs: anthropic on day1.
      // Provider, family and error rows below the threshold are dropped, never folded, because a
      // bucket of several multi-valued rows could count one install more than once.
      expect(statsFolded.providers).toEqual([
        { providerKind: "anthropic", requests: 120, tokens: 12000 },
      ]);
      expect(statsFolded.models).toEqual([
        { modelFamily: "claude-opus", requests: 120, tokens: 12000 },
      ]);
      // Single-valued dimensions fold per day: day1's openai (6) + google (5) + xai (5) = 16 distinct
      // installs form day1's 'other'; day2's 5 xai installs stay below 10 and are dropped.
      expect(statsFolded.versions).toEqual([
        { version: "other", installs: 16, newInstalls: 4 },
        { version: "2.41.0", installs: 12, newInstalls: 3 },
      ]);
      expect(statsFolded.platforms).toEqual([
        { os: "other", arch: "other", installs: 16 },
        { os: "darwin", arch: "arm64", installs: 12 },
      ]);
      expect(statsFolded.channels).toEqual([
        { installChannel: "other", installs: 16, newInstalls: 4 },
        { installChannel: "npm-global", installs: 12, newInstalls: 3 },
      ]);
      expect(statsFolded.errors).toEqual([
        { cause: "rate-limit", count: 24 },
      ]);
      expect(statsFolded.dailyByProvider).toEqual([
        { day: day1, providerKind: "anthropic", requests: 120, tokens: 12000 },
      ]);

      // Now test dropping a single-valued day's 'other' below 10 in a fresh DB:
      const hDrop = createInMemoryD1("drop-salt");
      try {
        // 12 installs of anthropic + 4 installs of openai + 5 installs of google -> 'other' has 9 < 10 -> dropped!
        await hDrop.db
          .prepare(
            "INSERT INTO daily_totals (day, reports, new_installs, active_minutes, completed, failed, incomplete, aborted, input, cache_read, cache_write, output, reasoning) " +
            "VALUES (?1, 21, 2, 105, 160, 15, 0, 0, 16000, 0, 0, 0, 0)",
          )
          .bind(day1)
          .run();
        await hDrop.db
          .prepare(
            "INSERT INTO daily_models (day, provider_kind, model_family, installs, requests, input, cache_read, cache_write, output, reasoning) " +
            "VALUES (?1, 'anthropic', 'claude-opus', 12, 120, 12000, 0, 0, 0, 0), (?1, 'openai', 'gpt-5', 4, 20, 2000, 0, 0, 0, 0), (?1, 'google', 'gemini-3', 5, 20, 2000, 0, 0, 0, 0)",
          )
          .bind(day1)
          .run();
        await hDrop.db
          .prepare(
            "INSERT INTO daily_provider_installs (day, provider_kind, installs) " +
            "VALUES (?1, 'anthropic', 12), (?1, 'openai', 4), (?1, 'google', 5)",
          )
          .bind(day1)
          .run();
        await hDrop.db
          .prepare(
            "INSERT INTO daily_family_installs (day, model_family, installs) " +
            "VALUES (?1, 'claude-opus', 12), (?1, 'gpt-5', 4), (?1, 'gemini-3', 5)",
          )
          .bind(day1)
          .run();
        await hDrop.db
          .prepare(
            "INSERT INTO daily_errors (day, cause, installs, count) " +
            "VALUES (?1, 'rate-limit', 12, 24), (?1, 'empty-output', 4, 8), (?1, 'client-cancelled', 5, 5)",
          )
          .bind(day1)
          .run();
        for (let i = 0; i < 21; i++) {
          const isMajor = i < 12;
          const isOpenai = i >= 12 && i < 16;
          await hDrop.db
            .prepare(
              "INSERT INTO daily_installs (day, install_day_hash, version, release_channel, os, arch, install_channel, new_install, active_minutes) " +
              "VALUES (?1, ?2, ?3, 'latest', ?4, ?5, ?6, 0, 5)",
            )
            .bind(
              day1,
              i.toString(16).padStart(64, "0"),
              isMajor ? "2.41.0" : isOpenai ? "2.40.0" : "2.39.0",
              isMajor ? "darwin" : isOpenai ? "linux" : "win32",
              isMajor ? "arm64" : "x64",
              isMajor ? "npm-global" : isOpenai ? "standalone" : "desktop",
            )
            .run();
        }

        const resDropped = await handleCollectorFetch(
          new Request("https://telemetry.opencodex.me/v1/stats?range=7d"),
          hDrop.env,
          undefined,
          NOW,
        );
        expect(resDropped.status).toBe(200);
        const statsDropped = (await resDropped.json()) as TelemetryStatsV1;

        // Totals, daily, heatmap, and outcomes stay unfiltered (all 21 reports counted).
        expect(statsDropped.totals.activeInstalls).toBe(21);
        expect(statsDropped.totals.avgDailyActiveInstalls).toBe(3);
        expect(statsDropped.totals.requests).toBe(175);
        expect(statsDropped.daily[0]?.activeInstalls).toBe(21);
        expect(statsDropped.heatmap.find(d => d.day === day1)?.activeInstalls).toBe(21);

        // Every breakdown drops the small rows; the single-valued 'other' (4 + 5 = 9 < 10) is dropped too.
        expect(statsDropped.providers).toEqual([{ providerKind: "anthropic", requests: 120, tokens: 12000 }]);
        expect(statsDropped.models).toEqual([{ modelFamily: "claude-opus", requests: 120, tokens: 12000 }]);
        expect(statsDropped.versions).toEqual([{ version: "2.41.0", installs: 12, newInstalls: 0 }]);
        expect(statsDropped.platforms).toEqual([{ os: "darwin", arch: "arm64", installs: 12 }]);
        expect(statsDropped.channels).toEqual([{ installChannel: "npm-global", installs: 12, newInstalls: 0 }]);
        expect(statsDropped.errors).toEqual([{ cause: "rate-limit", count: 24 }]);
        expect(statsDropped.dailyByProvider).toEqual([
          { day: day1, providerKind: "anthropic", requests: 120, tokens: 12000 },
        ]);

        // A native 'other' provider/family is an ordinary key: published when its own distinct
        // count reaches 10 on the day, and never merged with the dropped small rows.
        await hDrop.db
          .prepare(
            "INSERT INTO daily_models (day, provider_kind, model_family, installs, requests, input, cache_read, cache_write, output, reasoning) " +
            "VALUES (?1, 'other', 'other', 10, 30, 3000, 0, 0, 0, 0)",
          )
          .bind(day1)
          .run();
        hDrop.sqlite.query("INSERT INTO daily_provider_installs (day, provider_kind, installs) VALUES (?1, 'other', 10)").run(day1);
        hDrop.sqlite.query("INSERT INTO daily_family_installs (day, model_family, installs) VALUES (?1, 'other', 10)").run(day1);
        const resMergedOther = await handleStats(
          new Request("https://telemetry.opencodex.me/v1/stats?range=7d"),
          hDrop.env,
          NOW,
          { bypassCache: true },
        );
        const statsMergedOther = (await resMergedOther.json()) as TelemetryStatsV1;
        expect(statsMergedOther.providers).toEqual([
          { providerKind: "anthropic", requests: 120, tokens: 12000 },
          { providerKind: "other", requests: 30, tokens: 3000 },
        ]);
        expect(statsMergedOther.models).toEqual([
          { modelFamily: "claude-opus", requests: 120, tokens: 12000 },
          { modelFamily: "other", requests: 30, tokens: 3000 },
        ]);
        expect(statsMergedOther.dailyByProvider).toEqual([
          { day: day1, providerKind: "anthropic", requests: 120, tokens: 12000 },
          { day: day1, providerKind: "other", requests: 30, tokens: 3000 },
        ]);
      } finally {
        hDrop.close();
      }
    } finally {
      h.close();
    }
  });
});
