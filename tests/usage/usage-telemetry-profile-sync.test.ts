import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DailyTelemetryAggregate } from "../../src/telemetry/aggregate";
import { setProfileClientOverridesForTests } from "../../src/telemetry/profile/client";
import { telemetryProfilePath } from "../../src/telemetry/profile/paths";
import {
  buildProfileStatusSnapshot,
  connectTelemetryProfile,
  disconnectTelemetryProfile,
  resetProfileServiceCachesForTests,
} from "../../src/telemetry/profile/service";
import { deleteTelemetryProfileFile, readTelemetryProfileFile, writeTelemetryProfileState } from "../../src/telemetry/profile/state";
import { buildProfileDay, runProfileTick } from "../../src/telemetry/profile/sync";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { repoPath } from "../helpers/repo-root";

const SECRET = "ocxp_" + "A".repeat(43);
const CONNECT_AT = Date.parse("2026-11-05T10:00:00.000Z");
const DAY_MS = 86_400_000;

interface Call { method: string; url: string; headers: Record<string, string>; body: unknown }

function aggregate(day: string, rows: Array<[string, string, number, number]>): DailyTelemetryAggregate {
  return {
    day,
    activeMinutes: 42,
    requests: { completed: 5, failed: 1, incomplete: 0, aborted: 0 },
    errors: { "upstream-5xx": 1 },
    models: rows.map(([providerKind, modelFamily, requests, tokens]) => ({
      providerKind,
      modelFamily,
      requests,
      inputTokens: tokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    })) as DailyTelemetryAggregate["models"],
  };
}

describe("opt-in public profile: client sync", () => {
  let home: string;
  let calls: Call[];
  let respond: (call: Call) => Response;
  const prevHome = process.env.OPENCODEX_HOME;
  const env = {} as Record<string, string | undefined>;

  function writeConfig(telemetry: Record<string, unknown> | undefined): void {
    writeFileSync(join(home, "config.json"), JSON.stringify({
      port: 10100,
      defaultProvider: "openai",
      providers: { openai: { adapter: "openai-responses", baseUrl: "https://chatgpt.com/backend-api/codex", authMode: "forward" } },
      ...(telemetry ? { telemetry } : {}),
    }, null, 2));
  }

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "ocx-profile-sync-"));
    process.env.OPENCODEX_HOME = home;
    resetProfileServiceCachesForTests();
    writeConfig({ decision: "accepted", decidedAt: "2026-10-01T00:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" });
    calls = [];
    respond = call => call.method === "POST" && call.url.endsWith("/v1/profiles")
      ? Response.json({ ok: true, profile: { handle: "jun", displayName: "Jun", avatar: "blue" }, secret: SECRET }, { status: 201 })
      : Response.json({ ok: true });
    setProfileClientOverridesForTests({
      baseUrl: "https://collector.test",
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const call: Call = {
          method: init?.method ?? "GET",
          url: String(input),
          headers: Object.fromEntries(new Headers(init?.headers).entries()),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        };
        calls.push(call);
        return respond(call);
      }) as typeof fetch,
    });
  });

  afterEach(() => {
    setProfileClientOverridesForTests(null);
    if (prevHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = prevHome;
    removeTreeWithRetry(home);
  });

  const connect = () => connectTelemetryProfile({ handle: "Jun", displayName: "Jun", avatar: "blue" }, { configDir: home, env, now: CONNECT_AT });

  test("a profile day carries only totals and model-family sums", () => {
    const built = buildProfileDay(aggregate("2026-11-06", [["anthropic", "claude-opus", 2, 100], ["openrouter", "claude-opus", 1, 10], ["openai", "gpt-6", 3, 5]]));
    expect(built).toEqual({
      schemaVersion: 1,
      day: "2026-11-06",
      requests: 6,
      tokens: { input: 115, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 },
      families: [{ family: "claude-opus", requests: 3, tokens: 110 }, { family: "gpt-6", requests: 3, tokens: 5 }],
    });
    expect(buildProfileDay(aggregate("2026-11-06", []))).toBeNull();
  });

  test("connecting needs anonymous telemetry on and sends nothing otherwise", async () => {
    writeConfig({ decision: "declined", decidedAt: "2026-10-01T00:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" });
    await expect(connect()).rejects.toMatchObject({ code: "telemetry_off" });
    writeConfig({ decision: "accepted", decidedAt: "2026-10-01T00:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" });
    await expect(connectTelemetryProfile({ handle: "jun", displayName: "Jun", avatar: "blue" }, { configDir: home, env: { OCX_TELEMETRY: "0" }, now: CONNECT_AT }))
      .rejects.toMatchObject({ code: "telemetry_off" });
    expect(calls).toHaveLength(0);
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
  });

  test("connecting stores the secret privately and leaves anonymous telemetry untouched", async () => {
    const configBefore = readFileSync(join(home, "config.json"), "utf8");
    const profile = await connect();
    expect(profile).not.toHaveProperty("secret");
    expect(JSON.stringify(profile)).not.toContain(SECRET);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBeUndefined();
    expect(Object.keys(calls[0]!.body as object).sort()).toEqual(["avatar", "displayName", "handle", "schemaVersion"]);
    const file = readTelemetryProfileFile(home).state!;
    expect(file.secret).toBe(SECRET);
    expect(file.connectedDay).toBe("2026-11-05");
    if (process.platform !== "win32") expect(statSync(telemetryProfilePath(home)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(configBefore);
    expect(existsSync(join(home, "telemetry-id.json"))).toBe(false);
    expect(existsSync(join(home, "telemetry-state.json"))).toBe(false);
    await expect(connect()).rejects.toMatchObject({ code: "already_connected" });
    const snapshot = await buildProfileStatusSnapshot({ configDir: home, env, now: CONNECT_AT });
    expect(JSON.stringify(snapshot)).not.toContain(SECRET);
  });

  test("never backfills: the connect day and earlier are never sent, later days once each", async () => {
    await connect();
    calls.length = 0;
    const aggregateDay = async (day: string) => aggregate(day, [["anthropic", "claude-sonnet", 2, 40]]);
    const sameDay = await runProfileTick({ configDir: home, env, now: CONNECT_AT + 3_600_000, aggregateDay });
    expect(sameDay.sent).toBe(false);
    const nextDay = await runProfileTick({ configDir: home, env, now: CONNECT_AT + 2 * DAY_MS, aggregateDay });
    expect(nextDay).toMatchObject({ sent: true, day: "2026-11-06" });
    const sent = calls.find(call => call.url.endsWith("/v1/profiles/me/days"))!;
    expect(sent.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(Object.keys(sent.body as object).sort()).toEqual(["day", "families", "requests", "schemaVersion", "tokens"]);
    const serialized = JSON.stringify(sent.body);
    for (const forbidden of ["installDayHash", "batchId", "installId", "providerKind", "anthropic", "activeMinutes", "errors"]) {
      expect(serialized).not.toContain(forbidden);
    }
    const again = await runProfileTick({ configDir: home, env, now: CONNECT_AT + 2 * DAY_MS + 60_000, aggregateDay });
    expect(again.sent).toBe(false);
    expect(calls.filter(call => call.url.endsWith("/v1/profiles/me/days"))).toHaveLength(1);
  });

  test("anonymous telemetry off pauses sending without touching the profile", async () => {
    await connect();
    const before = readFileSync(telemetryProfilePath(home), "utf8");
    calls.length = 0;
    const aggregateDay = async (day: string) => aggregate(day, [["openai", "gpt-6", 1, 1]]);
    writeConfig({ decision: "declined", decidedAt: "2026-11-05T11:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" });
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 2 * DAY_MS, aggregateDay })).toMatchObject({ sent: false, reason: "telemetry-off" });
    writeConfig({ decision: "accepted", decidedAt: "2026-10-01T00:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" });
    expect(await runProfileTick({ configDir: home, env: { DO_NOT_TRACK: "1" }, now: CONNECT_AT + 2 * DAY_MS, aggregateDay })).toMatchObject({ sent: false, reason: "telemetry-off" });
    expect(calls).toHaveLength(0);
    expect(readFileSync(telemetryProfilePath(home), "utf8")).toBe(before);
  });

  test("an unreachable collector leaves the deletion pending, and a later tick deletes even with telemetry off", async () => {
    await connect();
    respond = () => new Response("down", { status: 502 });
    expect(await disconnectTelemetryProfile({ configDir: home, now: CONNECT_AT })).toMatchObject({ status: "deletion_pending" });
    expect(readTelemetryProfileFile(home).state?.pendingDelete).toBe(true);
    writeConfig({ decision: "declined", decidedAt: "2026-11-05T11:00:00.000Z", noticeShownAt: "2026-10-01T00:00:00.000Z" });
    respond = () => Response.json({ ok: true, deleted: true });
    const tick = await runProfileTick({ configDir: home, env: { OCX_TELEMETRY: "0" }, now: CONNECT_AT + DAY_MS });
    expect(tick).toMatchObject({ deleted: true, reason: "deleted" });
    const deletes = calls.filter(call => call.method === "DELETE");
    expect(deletes.at(-1)!.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
  });

  test("a secret the collector no longer knows stops sending until reconnect", async () => {
    await connect();
    respond = () => Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    const aggregateDay = async (day: string) => aggregate(day, [["openai", "gpt-6", 1, 1]]);
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 2 * DAY_MS, aggregateDay })).toMatchObject({ reason: "revoked" });
    expect(readTelemetryProfileFile(home).state?.revoked).toBe(true);
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 3 * DAY_MS, aggregateDay })).toMatchObject({ sent: false, reason: "revoked" });
  });

  test("a disconnect that lands while a day is being sent stays pending, and a completed one is not undone", async () => {
    await connect();
    const aggregateDay = async (day: string) => aggregate(day, [["openai", "gpt-6", 1, 1]]);
    // The disconnect cannot reach the collector and lands while the submission is in flight.
    respond = call => {
      if (call.url.endsWith("/v1/profiles/me/days")) {
        const state = readTelemetryProfileFile(home).state!;
        writeTelemetryProfileState({ ...state, pendingDelete: true }, home);
        return Response.json({ ok: true, deduplicated: false });
      }
      return new Response("down", { status: 502 });
    };
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 2 * DAY_MS, aggregateDay })).toMatchObject({ sent: true });
    expect(readTelemetryProfileFile(home).state?.pendingDelete).toBe(true);

    // A disconnect that completed (file removed) while a day was in flight is not resurrected.
    deleteTelemetryProfileFile(home);
    respond = call => {
      if (call.method === "POST" && call.url.endsWith("/v1/profiles")) {
        return Response.json({ ok: true, profile: { handle: "jun", displayName: "Jun", avatar: "blue" }, secret: SECRET }, { status: 201 });
      }
      if (call.url.endsWith("/v1/profiles/me/days")) {
        deleteTelemetryProfileFile(home);
        return Response.json({ ok: true, deduplicated: false });
      }
      return Response.json({ ok: true });
    };
    await connect();
    await runProfileTick({ configDir: home, env, now: CONNECT_AT + 3 * DAY_MS, aggregateDay });
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
  });

  test("the collector's creation day is the floor, and a refused day never blocks newer ones", async () => {
    // The client clock is behind: it is still 2026-11-05 here, the collector already says 2026-11-06.
    respond = call => call.method === "POST" && call.url.endsWith("/v1/profiles")
      ? Response.json({ ok: true, profile: { handle: "jun", displayName: "Jun", avatar: "blue" }, createdDay: "2026-11-06", secret: SECRET }, { status: 201 })
      : Response.json({ ok: true });
    await connect();
    expect(readTelemetryProfileFile(home).state?.connectedDay).toBe("2026-11-06");

    // A day the collector refuses for good (400) is set aside, so the next day still goes out.
    const aggregateDay = async (day: string) => aggregate(day, [["openai", "gpt-6", 1, 1]]);
    respond = call => call.url.endsWith("/v1/profiles/me/days") && (call.body as { day: string }).day === "2026-11-07"
      ? Response.json({ ok: false, error: "nope" }, { status: 400 })
      : Response.json({ ok: true, deduplicated: false });
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 4 * DAY_MS, aggregateDay })).toMatchObject({ day: "2026-11-07", reason: "refused" });
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 4 * DAY_MS + 1000, aggregateDay })).toMatchObject({ sent: true, day: "2026-11-08" });
  });

  test("a collector creation day earlier than the client's day keeps the client's day as the floor", async () => {
    // The client clock is ahead: it is 2026-11-05 here, the collector created the profile on 2026-11-04.
    respond = call => call.method === "POST" && call.url.endsWith("/v1/profiles")
      ? Response.json({ ok: true, profile: { handle: "jun", displayName: "Jun", avatar: "blue" }, createdDay: "2026-11-04", secret: SECRET }, { status: 201 })
      : Response.json({ ok: true, deduplicated: false });
    await connect();
    expect(readTelemetryProfileFile(home).state?.connectedDay).toBe("2026-11-05");
    const aggregateDay = async (day: string) => aggregate(day, [["openai", "gpt-6", 1, 1]]);
    // The first day offered is strictly after both days, so the collector accepts it.
    expect(await runProfileTick({ configDir: home, env, now: CONNECT_AT + 2 * DAY_MS, aggregateDay })).toMatchObject({ sent: true, day: "2026-11-06" });
  });

  test("an unreadable profile file can always be cleared with disconnect", async () => {
    writeFileSync(telemetryProfilePath(home), "{ not json");
    await expect(connect()).rejects.toMatchObject({ code: "profile_unreadable" });
    await expect(connect()).rejects.toThrow("ocx telemetry profile disconnect");
    expect(await disconnectTelemetryProfile({ configDir: home, now: CONNECT_AT })).toMatchObject({ status: "local_removed" });
    expect(existsSync(telemetryProfilePath(home))).toBe(false);
    expect(calls).toHaveLength(0);
    await connect();
  });

  test("disconnect never reports success while the secret file is still on disk", async () => {
    await connect();
    // The server deletes the profile, but the local file has been swapped for a directory.
    respond = call => {
      if (call.method === "DELETE") {
        unlinkSync(telemetryProfilePath(home));
        mkdirSync(telemetryProfilePath(home));
        return Response.json({ ok: true, deleted: true });
      }
      return Response.json({ ok: true });
    };
    const outcome = await disconnectTelemetryProfile({ configDir: home, now: CONNECT_AT });
    expect(outcome.status).toBe("deletion_pending");
  });

  test("profile modules never reach the anonymous install identity", () => {
    const dir = repoPath("src", "telemetry", "profile");
    for (const name of readdirSync(dir)) {
      const source = readFileSync(join(dir, name), "utf8");
      expect(source).not.toMatch(/from\s+["'][^"']*\/(install-id|payload|sender)["']/);
      for (const forbidden of ["installDayHash", "batchId", "installId", "telemetry-id", "computeInstallDayHash"]) {
        expect({ name, found: source.includes(forbidden) }).toEqual({ name, found: false });
      }
    }
  });
});

