import { describe, expect, test } from "bun:test";
import { handleCollectorFetch } from "../../services/telemetry-collector/src/index";
import {
  MAX_REPORTS_PER_HOUR,
  computeHourlyIpHash,
  formatBucketHour,
} from "../../services/telemetry-collector/src/ingest";
import { clearStatsCache, handleStats } from "../../services/telemetry-collector/src/stats";
import type { TelemetryStatsV1 } from "../../services/telemetry-collector/src/types";
import type {
  TelemetryArch,
  TelemetryFailureCause,
  TelemetryInstallChannel,
  TelemetryModelFamily,
  TelemetryOs,
  TelemetryProviderKind,
} from "../../src/telemetry/contract";
import { computeInstallDayHash } from "../../src/telemetry/install-id";
import { buildTelemetryPayloadV1 } from "../../src/telemetry/payload";
import { createInMemoryD1, postEventRequest, type InMemoryD1Harness } from "../helpers/telemetry-collector-d1";

// Small-cohort protection (D15) and rate-limit keying (D16) of the telemetry collector.
// The cohort threshold must hold per (day, key) on a count of DISTINCT installs, so one
// install can never pass it alone by reporting on many days or through many rows.

const NOW = Date.parse("2026-11-07T12:30:00.000Z");
const DAY_MS = 86_400_000;

interface ReportSpec {
  day: string;
  installUuid: string;
  models: Array<{ providerKind: TelemetryProviderKind; modelFamily: TelemetryModelFamily; requests: number; inputTokens: number }>;
  errors?: Partial<Record<TelemetryFailureCause, number>>;
  version?: string;
  os?: TelemetryOs;
  arch?: TelemetryArch;
  installChannel?: TelemetryInstallChannel;
  ip?: string;
}

function uuidFor(prefix: string, i: number): string {
  return `${prefix}-0000-4000-8000-${String(i).padStart(12, "0")}`;
}

function buildReport(spec: ReportSpec): string {
  const now = Date.parse(`${spec.day}T12:00:00.000Z`);
  const failed = Object.values(spec.errors ?? {}).reduce((sum, n) => sum + (n ?? 0), 0);
  const completed = spec.models.reduce((sum, row) => sum + row.requests, 0);
  const payload = buildTelemetryPayloadV1({
    aggregate: {
      day: spec.day,
      activeMinutes: 5,
      requests: { completed, failed, incomplete: 0, aborted: 0 },
      models: spec.models.map(row => ({
        providerKind: row.providerKind,
        modelFamily: row.modelFamily,
        requests: row.requests,
        inputTokens: row.inputTokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      })),
      errors: spec.errors ?? {},
    },
    installDayHash: computeInstallDayHash(spec.installUuid, spec.day),
    newInstall: false,
    version: spec.version ?? "2.41.0",
    os: spec.os ?? "darwin",
    arch: spec.arch ?? "arm64",
    installChannel: spec.installChannel ?? "npm-global",
    now,
  });
  return JSON.stringify(payload);
}

async function ingest(h: InMemoryD1Harness, spec: ReportSpec): Promise<void> {
  const now = Date.parse(`${spec.day}T12:00:00.000Z`);
  const res = await handleCollectorFetch(
    postEventRequest(buildReport(spec), { ip: spec.ip ?? "192.0.2.10" }),
    h.env,
    undefined,
    now,
  );
  expect(res.status).toBe(200);
}

async function stats(h: InMemoryD1Harness, range: "7d" | "30d"): Promise<TelemetryStatsV1> {
  const res = await handleStats(
    new Request(`https://telemetry.opencodex.me/v1/stats?range=${range}`),
    h.env,
    NOW,
    { bypassCache: true },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as TelemetryStatsV1;
}

function dayOffset(offset: number): string {
  return new Date(Date.parse("2026-11-07T00:00:00.000Z") - offset * DAY_MS).toISOString().slice(0, 10);
}

const TWELVE_FAMILIES: TelemetryModelFamily[] = [
  "gpt-6", "gpt-5", "gpt-4", "o-series", "codex", "claude-opus",
  "claude-sonnet", "claude-haiku", "gemini-3", "gemini-2", "grok", "deepseek",
];
const TWELVE_PROVIDERS: TelemetryProviderKind[] = [
  "openai", "chatgpt", "anthropic", "claude-subscription", "google", "vertex",
  "xai", "deepseek", "moonshot", "qwen", "zai", "minimax",
];

describe("telemetry collector small-cohort protection", () => {
  test("one install reporting on 12 days of a range never appears as its own breakdown row", async () => {
    const h = createInMemoryD1("cohort-range-salt");
    try {
      // A genuine cohort: 10 distinct installs on one day.
      for (let i = 0; i < 10; i++) {
        await ingest(h, {
          day: dayOffset(1),
          installUuid: uuidFor("c0000001", i),
          models: [{ providerKind: "anthropic", modelFamily: "claude-opus", requests: 10, inputTokens: 1000 }],
          errors: { "rate-limit": 1 },
        });
      }
      // One install (e.g. the only kiro user) reporting on 12 different days of the 30d range.
      for (let d = 0; d < 12; d++) {
        await ingest(h, {
          day: dayOffset(8 + d),
          installUuid: uuidFor("c0000002", 0),
          models: [{ providerKind: "kiro", modelFamily: "claude-sonnet", requests: 7, inputTokens: 777 }],
          errors: { "empty-output": 2 },
          version: "2.40.0",
          os: "linux",
          arch: "x64",
          installChannel: "standalone",
        });
      }

      const s = await stats(h, "30d");
      // Totals stay unfolded by design.
      expect(s.totals.activeInstalls).toBe(22);
      expect(s.totals.requests).toBe(10 * 11 + 12 * 9);

      expect(s.providers).toEqual([{ providerKind: "anthropic", requests: 100, tokens: 10000 }]);
      expect(s.models).toEqual([{ modelFamily: "claude-opus", requests: 100, tokens: 10000 }]);
      expect(s.errors).toEqual([{ cause: "rate-limit", count: 10 }]);
      expect(s.versions).toEqual([{ version: "2.41.0", installs: 10, newInstalls: 0 }]);
      expect(s.platforms).toEqual([{ os: "darwin", arch: "arm64", installs: 10 }]);
      expect(s.channels).toEqual([{ installChannel: "npm-global", installs: 10, newInstalls: 0 }]);
      expect(s.dailyByProvider).toEqual([
        { day: dayOffset(1), providerKind: "anthropic", requests: 100, tokens: 10000 },
      ]);
      const published = JSON.stringify({ ...s, heatmap: [], daily: [] });
      for (const leaked of ["kiro", "claude-sonnet", "2.40.0", "standalone", "empty-output", "\"other\""]) {
        expect(published).not.toContain(leaked);
      }
    } finally {
      h.close();
    }
  });

  test("one install using 12 model families through one provider in one day does not publish that provider-day", async () => {
    const h = createInMemoryD1("cohort-families-salt");
    try {
      await ingest(h, {
        day: dayOffset(1),
        installUuid: uuidFor("c0000003", 0),
        models: TWELVE_FAMILIES.map(modelFamily => ({ providerKind: "openrouter", modelFamily, requests: 3, inputTokens: 300 })),
      });
      const s = await stats(h, "7d");
      expect(s.dailyByProvider).toEqual([]);
      expect(s.providers).toEqual([]);
      expect(s.models).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("one install using one model family through 12 providers in one day does not publish that family", async () => {
    const h = createInMemoryD1("cohort-providers-salt");
    try {
      await ingest(h, {
        day: dayOffset(1),
        installUuid: uuidFor("c0000004", 0),
        models: TWELVE_PROVIDERS.map(providerKind => ({ providerKind, modelFamily: "claude-opus", requests: 3, inputTokens: 300 })),
      });
      const s = await stats(h, "7d");
      expect(s.models).toEqual([]);
      expect(s.providers).toEqual([]);
      expect(s.dailyByProvider).toEqual([]);
    } finally {
      h.close();
    }
  });

  test("a genuine cohort of 10 distinct installs on one day is published, counted once per install", async () => {
    const h = createInMemoryD1("cohort-genuine-salt");
    try {
      // Day A: 10 distinct installs through openrouter, each with a different family.
      for (let i = 0; i < 10; i++) {
        await ingest(h, {
          day: dayOffset(1),
          installUuid: uuidFor("c0000005", i),
          models: [{ providerKind: "openrouter", modelFamily: TWELVE_FAMILIES[i]!, requests: 3, inputTokens: 300 }],
        });
      }
      // Day B: 10 distinct installs using claude-opus, each through a different provider.
      for (let i = 0; i < 10; i++) {
        await ingest(h, {
          day: dayOffset(2),
          installUuid: uuidFor("c0000006", i),
          models: [{ providerKind: TWELVE_PROVIDERS[i]!, modelFamily: "claude-opus", requests: 2, inputTokens: 200 }],
        });
      }
      // A re-sent day is deduplicated and must not raise the distinct counts.
      await ingest(h, {
        day: dayOffset(1),
        installUuid: uuidFor("c0000005", 0),
        models: [{ providerKind: "openrouter", modelFamily: TWELVE_FAMILIES[0]!, requests: 3, inputTokens: 300 }],
      });

      const s = await stats(h, "7d");
      expect(s.dailyByProvider).toEqual([
        { day: dayOffset(1), providerKind: "openrouter", requests: 30, tokens: 3000 },
      ]);
      expect(s.providers).toEqual([{ providerKind: "openrouter", requests: 30, tokens: 3000 }]);
      // Day A's lone claude-opus install is below the threshold on its own day and is not added.
      expect(s.models).toEqual([{ modelFamily: "claude-opus", requests: 20, tokens: 2000 }]);
      expect(s.versions).toEqual([{ version: "2.41.0", installs: 20, newInstalls: 0 }]);
    } finally {
      h.close();
    }
  });

  test("single-valued dimensions fold into a per-day 'other'; multi-valued folds are not published", async () => {
    const h = createInMemoryD1("cohort-other-salt");
    try {
      const causes: TelemetryFailureCause[] = [
        "transport-unsent", "transport-ambiguous", "upstream-declined", "rate-limit", "quota-exhausted",
        "credential-rejected", "policy-refusal", "parameter-rejected", "payload-too-large", "upstream-fault",
      ];
      // 10 distinct installs on one day, each with its own version, provider, family and error cause.
      for (let i = 0; i < 10; i++) {
        await ingest(h, {
          day: dayOffset(1),
          installUuid: uuidFor("c0000007", i),
          models: [{ providerKind: TWELVE_PROVIDERS[i]!, modelFamily: TWELVE_FAMILIES[i]!, requests: 1, inputTokens: 100 }],
          errors: { [causes[i]!]: 1 },
          version: `2.3${i}.0`,
        });
      }
      // 5 + 5 installs of one version on two days: neither day reaches the threshold.
      for (const offset of [2, 3]) {
        for (let i = 0; i < 5; i++) {
          await ingest(h, {
            day: dayOffset(offset),
            installUuid: uuidFor(`c00000${offset}8`, i),
            models: [{ providerKind: "anthropic", modelFamily: "claude-opus", requests: 1, inputTokens: 100 }],
            version: "2.29.0",
          });
        }
      }

      const s = await stats(h, "7d");
      expect(s.versions).toEqual([{ version: "other", installs: 10, newInstalls: 0 }]);
      expect(s.platforms).toEqual([{ os: "darwin", arch: "arm64", installs: 10 }]);
      expect(s.channels).toEqual([{ installChannel: "npm-global", installs: 10, newInstalls: 0 }]);
      expect(s.providers).toEqual([]);
      expect(s.models).toEqual([]);
      expect(s.errors).toEqual([]);
      expect(s.dailyByProvider).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe("telemetry collector rate-limit key", () => {
  const DAY = "2026-11-06";

  async function post(h: InMemoryD1Harness, headers: Record<string, string>): Promise<number> {
    const body = buildReport({
      day: DAY,
      installUuid: uuidFor("d0000001", 0),
      models: [{ providerKind: "anthropic", modelFamily: "claude-opus", requests: 1, inputTokens: 100 }],
    });
    const res = await handleCollectorFetch(
      new Request("https://telemetry.opencodex.me/v1/events", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
      }),
      h.env,
      undefined,
      NOW,
    );
    return res.status;
  }

  test("IPv6 addresses in one /64 share the hourly limit and different /64s do not", async () => {
    const h = createInMemoryD1("ipv6-salt");
    try {
      for (let i = 0; i < MAX_REPORTS_PER_HOUR; i++) {
        expect(await post(h, { "cf-connecting-ip": `2001:db8:abcd:12:${(i + 1).toString(16)}::1` })).toBe(200);
      }
      // Same /64 written uncompressed and upper-case.
      expect(await post(h, { "cf-connecting-ip": "2001:0DB8:ABCD:0012:FFFF:FFFF:FFFF:FFFF" })).toBe(429);
      expect(await post(h, { "cf-connecting-ip": "2001:db8:abcd:12::" })).toBe(429);
      // A neighbouring /64 has its own budget.
      expect(await post(h, { "cf-connecting-ip": "2001:db8:abcd:13::1" })).toBe(200);
    } finally {
      h.close();
    }
  });

  test("compressed IPv6 forms resolve to the same /64, including '::'", async () => {
    const h = createInMemoryD1("ipv6-compressed-salt");
    try {
      for (let i = 0; i < MAX_REPORTS_PER_HOUR; i++) {
        expect(await post(h, { "cf-connecting-ip": `2001:db8:0:0:${(i + 1).toString(16)}::` })).toBe(200);
      }
      expect(await post(h, { "cf-connecting-ip": "2001:db8::1" })).toBe(429);
      expect(await post(h, { "cf-connecting-ip": "2001:db8:0000:0000:0000:0000:0000:0002" })).toBe(429);
      expect(await post(h, { "cf-connecting-ip": "::" })).toBe(200);
      expect(await post(h, { "cf-connecting-ip": "::1" })).toBe(200);
    } finally {
      h.close();
    }
  });

  test("IPv4-mapped IPv6 shares the IPv4 bucket and IPv4 addresses stay per address", async () => {
    const h = createInMemoryD1("ipv4-mapped-salt");
    try {
      for (let i = 0; i < MAX_REPORTS_PER_HOUR; i++) {
        expect(await post(h, { "cf-connecting-ip": "203.0.113.5" })).toBe(200);
      }
      expect(await post(h, { "cf-connecting-ip": "::ffff:203.0.113.5" })).toBe(429);
      expect(await post(h, { "cf-connecting-ip": "::FFFF:cb00:7105" })).toBe(429);
      expect(await post(h, { "cf-connecting-ip": "203.0.113.6" })).toBe(200);

      const bucketHour = formatBucketHour(NOW);
      const rows = h.sqlite.query("SELECT ip_hash, hits FROM rate_limits ORDER BY hits DESC").all() as Array<{ ip_hash: string; hits: number }>;
      expect(rows[0]).toEqual({
        ip_hash: await computeHourlyIpHash("ipv4-mapped-salt", "203.0.113.5", bucketHour),
        hits: MAX_REPORTS_PER_HOUR,
      });
    } finally {
      h.close();
    }
  });

  test("x-forwarded-for is ignored: without cf-connecting-ip every request shares one fixed bucket", async () => {
    const h = createInMemoryD1("xff-salt");
    try {
      for (let i = 0; i < MAX_REPORTS_PER_HOUR; i++) {
        expect(await post(h, { "x-forwarded-for": `198.51.100.${i % 250}, 10.0.0.1` })).toBe(200);
      }
      expect(await post(h, { "x-forwarded-for": "198.51.100.251" })).toBe(429);
      expect(await post(h, {})).toBe(429);

      // With cf-connecting-ip present, x-forwarded-for does not change the key either.
      expect(await post(h, { "cf-connecting-ip": "192.0.2.1", "x-forwarded-for": "198.51.100.7" })).toBe(200);
      const bucketHour = formatBucketHour(NOW);
      const keyed = h.sqlite
        .query("SELECT hits FROM rate_limits WHERE ip_hash = ?1")
        .get(await computeHourlyIpHash("xff-salt", "192.0.2.1", bucketHour)) as { hits: number } | null;
      expect(keyed?.hits).toBe(1);
      const total = h.sqlite.query("SELECT COUNT(*) AS n FROM rate_limits").get() as { n: number };
      expect(total.n).toBe(2);
    } finally {
      h.close();
    }
  });
});
describe("telemetry collector review round 2 regressions", () => {
  test("five installs each using two model families through one provider do not publish that provider", async () => {
    const h = createInMemoryD1("cohort-two-families-salt");
    try {
      for (let i = 0; i < 5; i++) {
        await ingest(h, {
          day: dayOffset(1),
          installUuid: uuidFor("e0000001", i),
          models: [
            { providerKind: "anthropic", modelFamily: "claude-opus", requests: 4, inputTokens: 400 },
            { providerKind: "anthropic", modelFamily: "claude-sonnet", requests: 6, inputTokens: 600 },
          ],
        });
      }
      const s = await stats(h, "7d");
      // 5 distinct installs, not 10: anthropic never reaches the threshold on that day.
      expect(s.dailyByProvider).toEqual([]);
      expect(s.providers).toEqual([]);
      expect(s.models).toEqual([]);
      expect(h.sqlite.query("SELECT provider_kind, installs FROM daily_provider_installs").all()).toEqual([
        { provider_kind: "anthropic", installs: 5 },
      ]);
    } finally {
      h.close();
    }
  });

  test("the versions limit folds its tail into 'other' instead of dropping the 'other' row", async () => {
    const h = createInMemoryD1("versions-limit-salt");
    try {
      const day = dayOffset(1);
      const insert = h.sqlite.query(
        "INSERT INTO daily_installs (day, install_day_hash, version, release_channel, os, arch, install_channel, new_install, active_minutes) " +
        "VALUES (?1, ?2, ?3, 'latest', 'linux', 'x64', 'standalone', ?4, 1)",
      );
      let n = 0;
      const hash = () => (n++).toString(16).padStart(64, "0");
      // 60 versions with 11 installs each pass the threshold on their own.
      for (let v = 0; v < 60; v++) {
        for (let j = 0; j < 11; j++) insert.run(day, hash(), `2.0.${v}`, j === 0 ? 1 : 0);
      }
      // 10 versions with 1 install each fold into the day's 'other' (10 distinct installs).
      for (let v = 0; v < 10; v++) insert.run(day, hash(), `1.0.${v}`, 0);

      const s = await stats(h, "7d");
      expect(s.versions).toHaveLength(50);
      expect(s.versions.filter(row => row.version !== "other").every(row => row.installs === 11)).toBe(true);
      // 'other' = the folded day bucket (10) + the 11 named versions beyond the limit (11 x 11).
      expect(s.versions.find(row => row.version === "other")).toEqual({ version: "other", installs: 131, newInstalls: 11 });
      expect(s.versions.reduce((sum, row) => sum + row.installs, 0)).toBe(60 * 11 + 10);
    } finally {
      h.close();
    }
  });

  test("an edge-cache hit keeps the entry's original age in the isolate cache", async () => {
    const h = createInMemoryD1("edge-age-salt");
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
    const get = async (at: number): Promise<TelemetryStatsV1> => {
      const res = await handleStats(new Request("https://telemetry.opencodex.me/v1/stats?range=7d"), h.env, at);
      expect(res.status).toBe(200);
      return (await res.json()) as TelemetryStatsV1;
    };
    const addReports = (reports: number) => h.sqlite
      .query("INSERT INTO daily_totals (day, reports) VALUES (?1, ?2) ON CONFLICT(day) DO UPDATE SET reports = reports + ?2")
      .run(dayOffset(1), reports);
    try {
      clearStatsCache();
      addReports(3);
      expect((await get(NOW)).totals.activeInstalls).toBe(3);

      // A fresh isolate reads the 4-minute-old edge entry.
      clearStatsCache();
      addReports(4);
      expect((await get(NOW + 240_000)).totals.activeInstalls).toBe(3);

      // The edge entry expires 5 minutes after it was built; the isolate copy must expire with it
      // instead of living another 5 minutes from the moment it was read.
      edgeStore.clear();
      expect((await get(NOW + 360_000)).totals.activeInstalls).toBe(7);
    } finally {
      (globalThis as { caches?: unknown }).caches = prevCaches;
      clearStatsCache();
      h.close();
    }
  });
});
