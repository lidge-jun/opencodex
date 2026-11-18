import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { handleCollectorFetch } from "../../services/telemetry-collector/src/index";
import { computeHourlyIpHash, formatBucketHour } from "../../services/telemetry-collector/src/ingest";
import { pruneCollectorTables } from "../../services/telemetry-collector/src/prune";
import { parseProfileRankV1 } from "../../src/telemetry/profile/contract";
import { createInMemoryD1, type InMemoryD1Harness } from "../helpers/telemetry-collector-d1";

const DAY_MS = 86_400_000;
const NOW = Date.parse("2026-11-09T12:00:00.000Z");
const CREATED = NOW - 5 * DAY_MS; // 2026-11-04
const BASE = "https://telemetry.opencodex.me";
const PROFILE_TABLES = ["profiles", "profile_days", "profile_day_families", "profile_rate_limits"] as const;

let h: InMemoryD1Harness;

beforeEach(() => {
  h = createInMemoryD1("unit-salt-secret");
});

afterEach(() => h.close());

function send(path: string, init: { method?: string; body?: unknown; secret?: string; ip?: string; origin?: string } = {}, now = NOW) {
  const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "203.0.113.7" };
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (init.secret) headers.authorization = `Bearer ${init.secret}`;
  if (init.origin) headers.origin = init.origin;
  return handleCollectorFetch(
    new Request(`${BASE}${path}`, { method: init.method ?? "GET", headers, ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}) }),
    h.env,
    undefined,
    now,
  );
}

async function create(handle: string, ip = "203.0.113.7", now = CREATED): Promise<string> {
  const res = await send("/v1/profiles", { method: "POST", ip, body: { schemaVersion: 1, handle, displayName: handle.toUpperCase(), avatar: "teal" } }, now);
  expect(res.status).toBe(201);
  return ((await res.json()) as { secret: string }).secret;
}

function dayBody(day: string, requests: number, tokens: number, family = "claude-opus") {
  return { schemaVersion: 1, day, requests, tokens: { input: tokens, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 }, families: [{ family, requests, tokens }] };
}

async function submit(secret: string, day: string, requests: number, tokens: number) {
  return send("/v1/profiles/me/days", { method: "POST", secret, body: dayBody(day, requests, tokens) });
}

function dumpProfileTables(): string {
  return JSON.stringify(PROFILE_TABLES.map(table => h.sqlite.query(`SELECT * FROM ${table}`).all()));
}

describe("telemetry collector: opt-in profiles", () => {
  test("creating returns a one-time secret and stores only its hash, never the client address", async () => {
    const res = await send("/v1/profiles", { method: "POST", body: { schemaVersion: 1, handle: "Jun", displayName: "Jun", avatar: "teal" } }, CREATED);
    expect(res.status).toBe(201);
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { secret: string; profile: unknown; createdDay: string };
    expect(body.secret).toMatch(/^ocxp_[A-Za-z0-9_-]{43}$/);
    expect(body.createdDay).toBe("2026-11-04");
    expect(body.profile).toEqual({ handle: "jun", displayName: "Jun", avatar: "teal" });
    const dump = dumpProfileTables();
    expect(dump).not.toContain(body.secret);
    expect(dump).not.toContain("203.0.113.7");
    const anonymousHash = await computeHourlyIpHash("unit-salt-secret", "203.0.113.7", formatBucketHour(CREATED));
    expect(dump).not.toContain(anonymousHash);
  });

  test("handles are unique, validated and reserved names are refused", async () => {
    await create("jun");
    const dup = await send("/v1/profiles", { method: "POST", ip: "198.51.100.1", body: { schemaVersion: 1, handle: "JUN", displayName: "x", avatar: "red" } }, CREATED);
    expect(dup.status).toBe(409);
    for (const body of [
      { schemaVersion: 1, handle: "admin", displayName: "x", avatar: "red" },
      { schemaVersion: 1, handle: "ok-name", displayName: "x", avatar: "https://a/b.png" },
      { schemaVersion: 1, handle: "ok-name", displayName: "x", avatar: "red", email: "a@b.c" },
    ]) {
      expect((await send("/v1/profiles", { method: "POST", ip: "198.51.100.2", body }, CREATED)).status).toBe(400);
    }
  });

  test("profile creation is rate limited per client address with Retry-After", async () => {
    for (let i = 0; i < 5; i++) await create(`user${i}x`, "192.0.2.10");
    const limited = await send("/v1/profiles", { method: "POST", ip: "192.0.2.10", body: { schemaVersion: 1, handle: "user9x", displayName: "x", avatar: "red" } }, CREATED);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    await create("other-ip", "192.0.2.11");
  });

  test("submissions need the secret, refuse backfill and inconsistent totals, and the first write wins", async () => {
    const secret = await create("jun");
    expect((await send("/v1/profiles/me/days", { method: "POST", body: dayBody("2026-11-06", 1, 1) })).status).toBe(401);
    expect((await submit("ocxp_" + "Z".repeat(43), "2026-11-06", 1, 1)).status).toBe(401);
    expect((await submit(secret, "2026-11-04", 1, 1)).status).toBe(400);
    expect((await submit(secret, "2026-11-09", 1, 1)).status).toBe(400);
    const bad = await send("/v1/profiles/me/days", { method: "POST", secret, body: { ...dayBody("2026-11-06", 2, 10), requests: 3 } });
    expect(bad.status).toBe(400);
    const first = await submit(secret, "2026-11-06", 2, 10);
    expect(await first.json()).toEqual({ ok: true, deduplicated: false });
    const again = await submit(secret, "2026-11-06", 900, 9_000_000);
    expect(await again.json()).toEqual({ ok: true, deduplicated: true });
    expect(h.sqlite.query("SELECT requests, tokens FROM profile_days").all()).toEqual([{ requests: 2, tokens: 10 }]);
    expect(h.sqlite.query("SELECT family, requests, tokens FROM profile_day_families").all()).toEqual([{ family: "claude-opus", requests: 2, tokens: 10 }]);
  });

  test("ranks use RANK() among non-hidden profiles with usage; ties share a rank; no usage ranks null", async () => {
    const a = await create("alpha", "192.0.2.1");
    const b = await create("bravo", "192.0.2.2");
    const c = await create("charlie", "192.0.2.3");
    const idle = await create("idle", "192.0.2.4");
    await submit(a, "2026-11-08", 5, 500);
    await submit(b, "2026-11-08", 9, 500);
    await submit(c, "2026-11-08", 1, 100);
    await submit(c, "2026-11-05", 1, 10_000);
    const me = await send("/v1/profiles/me", { secret: c });
    expect(me.headers.get("cache-control")).toBe("no-store");
    const own = (await me.json()) as { periods: Record<string, { rank: number | null; of: number; tokens: number }>; hidden: boolean; families: unknown };
    expect(own.periods.day).toEqual({ rank: 3, of: 3, tokens: 100, requests: 1 });
    expect(own.periods.week).toEqual({ rank: 1, of: 3, tokens: 10_100, requests: 2 });
    expect(own.hidden).toBe(false);
    expect(own.families).toEqual([{ family: "claude-opus", requests: 2, tokens: 10_100 }]);
    const tied = (await (await send("/v1/profiles/me", { secret: b })).json()) as { periods: Record<string, { rank: number }> };
    expect(tied.periods.day.rank).toBe(1);
    // The proxy's parser accepts exactly what the collector returns, and keeps only documented fields.
    const parsedOwn = parseProfileRankV1(own);
    expect(parsedOwn?.periods.week).toEqual({ rank: 1, of: 3, tokens: 10_100, requests: 2 });
    expect(parsedOwn).not.toHaveProperty("hidden");
    const idleRank = (await (await send("/v1/profiles/me", { secret: idle })).json()) as { periods: Record<string, { rank: number | null; of: number }> };
    expect(idleRank.periods.month).toEqual({ rank: null, of: 3, tokens: 0, requests: 0 });

    const board = await send("/v1/leaderboard?period=day&metric=tokens");
    expect(board.headers.get("x-robots-tag")).toBe("noindex");
    const parsed = (await board.json()) as { total: number; entries: Array<Record<string, unknown>> };
    expect(parsed.total).toBe(3);
    expect(parsed.entries.map(entry => [entry.rank, entry.handle])).toEqual([[1, "alpha"], [1, "bravo"], [3, "charlie"]]);
    for (const entry of parsed.entries) expect(Object.keys(entry).sort()).toEqual(["avatar", "displayName", "handle", "rank", "requests", "tokens"]);
    const byRequests = (await (await send("/v1/leaderboard?period=day&metric=requests")).json()) as { entries: Array<{ handle: string }> };
    expect(byRequests.entries.map(entry => entry.handle)).toEqual(["bravo", "alpha", "charlie"]);
    expect((await send("/v1/leaderboard?period=year")).status).toBe(400);
    expect((await send("/v1/leaderboard?limit=101")).status).toBe(400);
  });

  test("hidden profiles leave every public read and every ranked set", async () => {
    const a = await create("alpha", "192.0.2.1");
    const b = await create("bravo", "192.0.2.2");
    await submit(a, "2026-11-08", 1, 50);
    await submit(b, "2026-11-08", 1, 10);
    h.sqlite.query("UPDATE profiles SET hidden = 1 WHERE handle = 'alpha'").run();
    const board = (await (await send("/v1/leaderboard?period=day")).json()) as { total: number; entries: Array<{ handle: string; rank: number }> };
    expect(board.entries).toEqual([expect.objectContaining({ handle: "bravo", rank: 1 })]);
    expect(board.total).toBe(1);
    expect((await send("/v1/profiles/by-handle/alpha")).status).toBe(404);
    const own = (await (await send("/v1/profiles/me", { secret: a })).json()) as { hidden: boolean; periods: Record<string, { rank: number | null }> };
    expect(own.hidden).toBe(true);
    expect(own.periods.day.rank).toBeNull();
    const pub = await send("/v1/profiles/by-handle/bravo");
    expect(pub.status).toBe(200);
    const pubBody = (await pub.json()) as Record<string, unknown>;
    expect(Object.keys(pubBody).sort()).toEqual(["families", "metric", "ok", "periods", "profile"]);
    expect(JSON.stringify(pubBody)).not.toMatch(/created|last_submit|hidden|secret|"id"/);
  });

  test("deleting removes the profile and every submitted row; the secret stops working", async () => {
    const secret = await create("jun");
    const other = await create("keep", "192.0.2.9");
    await submit(secret, "2026-11-06", 2, 10);
    await submit(other, "2026-11-06", 2, 10);
    const res = await send("/v1/profiles/me", { method: "DELETE", secret });
    expect(await res.json()).toEqual({ ok: true, deleted: true });
    const remaining = JSON.stringify(["profiles", "profile_days", "profile_day_families"].map(t => h.sqlite.query(`SELECT * FROM ${t}`).all()));
    expect(remaining).not.toContain("jun");
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM profile_days").get()).toEqual({ n: 1 });
    expect((await send("/v1/profiles/me", { method: "DELETE", secret })).status).toBe(401);
    expect((await submit(secret, "2026-11-07", 1, 1)).status).toBe(401);
  });

  test("hiding a profile takes effect on the very next leaderboard read", async () => {
    const a = await create("alpha", "192.0.2.1");
    await submit(a, "2026-11-08", 1, 50);
    const first = (await (await send("/v1/leaderboard?period=day")).json()) as { total: number };
    expect(first.total).toBe(1);
    h.sqlite.query("UPDATE profiles SET hidden = 1 WHERE handle = 'alpha'").run();
    const res = await send("/v1/leaderboard?period=day");
    expect(((await res.json()) as { total: number }).total).toBe(0);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
  });

  test("a cached leaderboard never outlives its UTC day window", async () => {
    const secret = await create("alpha", "192.0.2.1", NOW - 6 * DAY_MS);
    await submit(secret, "2026-11-08", 1, 10);
    const lateNight = Date.parse("2026-11-09T23:59:00.000Z");
    const before = (await (await send("/v1/leaderboard?period=day", {}, lateNight)).json()) as { to: string; total: number };
    expect(before.to).toBe("2026-11-08");
    const afterMidnight = Date.parse("2026-11-10T00:01:00.000Z");
    const after = (await (await send("/v1/leaderboard?period=day", {}, afterMidnight)).json()) as { to: string; total: number };
    expect(after.to).toBe("2026-11-09");
    expect(after.total).toBe(0);
  });

  test("bearer and write routes are never preflighted; public reads are", async () => {
    for (const path of ["/v1/profiles", "/v1/profiles/me", "/v1/profiles/me/days"]) {
      const res = await send(path, { method: "OPTIONS", origin: "https://opencodex.me" });
      expect(res.status).toBe(405);
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const pre = await send("/v1/leaderboard", { method: "OPTIONS", origin: "https://opencodex.me" });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toBe("content-type");
  });

  test("pruning removes squatted handles, stale profiles, old rows and old rate-limit buckets", async () => {
    const squat = await create("squatter", "192.0.2.1", NOW - 20 * DAY_MS);
    const active = await create("active", "192.0.2.2", CREATED);
    void squat;
    await submit(active, "2026-11-06", 1, 1);
    const result = await pruneCollectorTables(h.db, NOW + 3 * 3_600_000);
    expect(result.deletedProfiles).toBe(1);
    expect(h.sqlite.query("SELECT handle FROM profiles").all()).toEqual([{ handle: "active" }]);
    expect(h.sqlite.query("SELECT COUNT(*) AS n FROM profile_rate_limits").get()).toEqual({ n: 0 });
  });
});

