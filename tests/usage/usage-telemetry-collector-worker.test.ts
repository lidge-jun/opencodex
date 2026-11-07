import { Database } from "bun:sqlite";
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
import type {
  CollectorEnv,
  D1Database,
  D1PreparedStatement,
  D1Result,
  TelemetryStatsV1,
} from "../../services/telemetry-collector/src/types";
import { aggregateTelemetryEntriesForDay, type DailyTelemetryAggregate } from "../../src/telemetry/aggregate";
import { computeInstallDayHash } from "../../src/telemetry/install-id";
import { buildTelemetryPayloadV1 } from "../../src/telemetry/payload";
import type { PersistedUsageEntry } from "../../src/usage/log";
import { repoPath } from "../helpers/repo-root";

const NOW = Date.parse("2026-11-07T12:30:00.000Z");
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

interface InMemoryD1Harness {
  sqlite: Database;
  db: D1Database;
  env: CollectorEnv;
  batchCalls: number[];
  close: () => void;
}

function createInMemoryD1(salt = "test-rate-limit-salt"): InMemoryD1Harness {
  const sqlite = new Database(":memory:");
  const schemaSql = readFileSync(
    repoPath("services", "telemetry-collector", "schema.sql"),
    "utf8",
  );
  sqlite.exec(schemaSql);
  const batchCalls: number[] = [];

  function makeStatement(query: string, boundValues: unknown[] = []): D1PreparedStatement {
    const executeRun = <T = Record<string, unknown>>(): D1Result<T> => {
      const stmt = sqlite.query(query);
      const info = stmt.run(...(boundValues as never[]));
      return {
        success: true,
        meta: {
          changes: Number(info.changes ?? 0),
          last_row_id: Number(info.lastInsertRowid ?? 0),
          changed_db: Number(info.changes ?? 0) > 0,
        },
      };
    };

    return {
      bind(...values: unknown[]): D1PreparedStatement {
        return makeStatement(query, values);
      },
      async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        return executeRun<T>();
      },
      async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
        const stmt = sqlite.query(query);
        const results = stmt.all(...(boundValues as never[])) as T[];
        return {
          success: true,
          meta: { changes: 0 },
          results,
        };
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const stmt = sqlite.query(query);
        const row = stmt.get(...(boundValues as never[])) as Record<string, unknown> | null;
        if (!row) return null;
        if (colName !== undefined) {
          return ((row[colName] as T | undefined) ?? null);
        }
        return row as T;
      },
    };
  }

  const db: D1Database = {
    prepare(query: string): D1PreparedStatement {
      return makeStatement(query);
    },
    async batch<T = Record<string, unknown>>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      batchCalls.push(statements.length);
      const out: D1Result<T>[] = [];
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const stmt of statements) {
          out.push(await stmt.run<T>());
        }
        sqlite.exec("COMMIT");
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
      return out;
    },
  };

  return {
    sqlite,
    db,
    env: { DB: db, RATE_LIMIT_SALT: salt },
    batchCalls,
    close: () => sqlite.close(),
  };
}

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

function postEventRequest(
  body: string | Uint8Array,
  options: {
    ip?: string;
    origin?: string;
    contentType?: string;
    contentLength?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (options.contentType !== "") {
    headers.set("content-type", options.contentType ?? "application/json");
  }
  if (options.ip) {
    headers.set("cf-connecting-ip", options.ip);
  }
  if (options.origin) {
    headers.set("origin", options.origin);
  }
  if (options.contentLength) {
    headers.set("content-length", options.contentLength);
  }
  return new Request("https://telemetry.opencodex.me/v1/events", {
    method: "POST",
    headers,
    body,
  });
}

describe("telemetry collector worker + D1", () => {
  test("wrangler.toml pins placeholder D1 id 00000000-0000-0000-0000-000000000000 and cron trigger", () => {
    const wranglerToml = readFileSync(
      repoPath("services", "telemetry-collector", "wrangler.toml"),
      "utf8",
    );
    expect(wranglerToml).toContain('database_id = "00000000-0000-0000-0000-000000000000"');
    expect(wranglerToml).toContain('binding = "DB"');
    expect(wranglerToml).toContain("telemetry.opencodex.me/*");
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
      expect(h.batchCalls).toEqual([8]);

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
      // Dedup must NOT execute a second rollup batch.
      expect(h.batchCalls).toEqual([8]);

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

      // Privacy check: dump every row of every table and ensure no raw installId, batchId, or IP appears.
      const tables = ["daily_installs", "daily_totals", "daily_models", "daily_errors", "rate_limits"] as const;
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

  test("enforces 16 KiB body cap with 413 and 30/hour IP hash rate limit with 429 + Retry-After", async () => {
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

      // Send 30 valid reports from the same IP in the same hour; all 30 succeed.
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

      // 31st report in the same hour returns 429 with Retry-After.
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
      const ingestAt = async (
        dayOffset: number,
        installUuid: string,
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
        const payload = buildTelemetryPayloadV1({
          aggregate: makeAggregate(day),
          installDayHash: computeInstallDayHash(installUuid, day),
          newInstall: options.newInstall,
          version: options.version,
          os: options.os,
          arch: options.arch,
          installChannel: options.installChannel,
          now: eventNow,
        });
        const res = await handleCollectorFetch(
          postEventRequest(JSON.stringify(payload), { ip: `10.0.0.${dayOffset}` }),
          h.env,
          undefined,
          eventNow,
        );
        expect(res.status).toBe(200);
      };

      // Seed reports at 1d ago (in 7d), 20d ago (in 30d), 60d ago (in 90d), and 200d ago (in 365d)
      await ingestAt(1, "10000000-0000-4000-8000-000000000001", {
        newInstall: true,
        version: "2.41.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      });
      await ingestAt(20, "10000000-0000-4000-8000-000000000002", {
        newInstall: false,
        version: "2.40.0",
        os: "linux",
        arch: "x64",
        installChannel: "standalone",
      });
      await ingestAt(60, "10000000-0000-4000-8000-000000000003", {
        newInstall: true,
        version: "2.39.0",
        os: "win32",
        arch: "x64",
        installChannel: "desktop",
      });
      await ingestAt(200, "10000000-0000-4000-8000-000000000004", {
        newInstall: false,
        version: "2.35.0",
        os: "darwin",
        arch: "arm64",
        installChannel: "npm-global",
      });

      const expectedReportsByRange: Record<"7d" | "30d" | "90d" | "365d", number> = {
        "7d": 1,
        "30d": 2,
        "90d": 3,
        "365d": 4,
      };

      for (const [range, expectedReports] of Object.entries(expectedReportsByRange) as Array<
        ["7d" | "30d" | "90d" | "365d", number]
      >) {
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
        expect(stats.daily).toHaveLength(expectedReports);
        expect(stats.daily[0]).toMatchObject({
          activeInstalls: 1,
          activeMinutes: 3,
          requests: 4,
          failed: 1,
          tokens: 1950,
        });
        expect(stats.dailyByProvider.length).toBe(expectedReports * 4);
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
});
