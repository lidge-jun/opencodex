import { describe, expect, test } from "bun:test";
import { buildRouteFlow, buildRouteSteps, summarizePool } from "../src/pages/route-live/flow-model";
import { groupRows } from "../src/pages/route-live/request-groups";
import { cacheHitPercent, parseRouteRows, readableAccountLabel, requestedOf, type RouteRow } from "../src/pages/route-live/route-rows";

const base = { timestamp: 1000, model: "m", provider: "p", status: 200, durationMs: 900 };
const row = (extra: Partial<RouteRow>): RouteRow => ({ ...base, ...extra } as RouteRow);

describe("route flow model", () => {
  test("failover across attempts is a moved outcome with the last try answering", () => {
    const flow = buildRouteFlow(row({ attempts: [
      { provider: "p", model: "m", status: 429, errorCode: "rate_limit_exceeded", accountLogLabel: "oaaaaaa" },
      { provider: "p", model: "m", status: 200, accountLogLabel: "obbbbbb" },
    ] }), { p: { obbbbbb: "Work" } });
    expect(flow.outcome.kind).toBe("moved");
    expect(flow.candidates.map(c => c.status)).toEqual(["failed", "answered"]);
    expect(flow.candidates[0]!.reasonCode).toBe("rate_limit_exceeded");
    expect(flow.candidates[1]!.displayName).toBe("Work");
    const steps = buildRouteSteps(row({ attempts: [] }), flow);
    expect(steps.filter(s => s.kind === "try").map(s => s.kind === "try" && s.moveOn)).toEqual([true, false]);
  });

  test("combo exclusions become skipped candidates with the first code, eligible ones idle", () => {
    const flow = buildRouteFlow(row({
      attempts: [{ provider: "p", model: "m", status: 200 }],
      routeDecision: { routeKind: "combo", selected: { reason: "combo-pick" }, candidates: [
        { provider: "p", model: "m", eligible: true },
        { provider: "q", model: "n", eligible: false, exclusions: [{ code: "cooldown" }, { code: "x" }] },
        { provider: "r", model: "o", eligible: true, exclusions: [{ code: "not-selected" }] },
      ] },
    }));
    expect(flow.candidates.map(c => [c.provider, c.status, c.reasonCode])).toEqual([
      ["p", "answered", undefined], ["q", "skipped", "cooldown"], ["r", "idle", undefined]]);
    expect(buildRouteSteps(row({ routeDecision: { routeKind: "combo", selected: { reason: "combo-pick" } } }), flow)
      .slice(0, 2)).toEqual([{ kind: "asked", requested: "m", combo: true }, { kind: "why", reasonCode: "combo-pick" }]);
  });

  test("roster states skip paused and cooling accounts, available ones stay idle", () => {
    const r = row({
      accountLogLabel: "oserved",
      attempts: [{ provider: "p", model: "m", status: 200, accountLogLabel: "oserved" }],
      accountRoster: { provider: "p", accounts: [
        { label: "oserved", state: "available" }, { label: "opaused", state: "paused" },
        { label: "ocool", state: "cooldown" }, { label: "ofree", state: "available" }] },
    });
    const flow = buildRouteFlow(r);
    expect(flow.candidates.map(c => [c.accountLabel, c.status, c.reasonCode])).toEqual([
      ["oserved", "answered", undefined], ["opaused", "skipped", "paused"], ["ocool", "skipped", "cooldown"], ["ofree", "idle", undefined]]);
    expect(summarizePool(r.accountRoster)).toMatchObject({ total: 4, available: 2, cooldown: 1, paused: 1, needsReauth: 0 });
  });

  test("no attempts is local when it succeeded and failed otherwise", () => {
    expect(buildRouteFlow(row({})).outcome.kind).toBe("local");
    expect(buildRouteSteps(row({}), buildRouteFlow(row({}))).at(-1)).toEqual({ kind: "none" });
    expect(buildRouteFlow(row({ status: 503, errorCode: "server_is_overloaded" })).outcome)
      .toEqual({ kind: "failed", httpStatus: 503, reasonCode: "server_is_overloaded", tries: 0 });
  });
});

describe("route rows and groups", () => {
  test("cache hit is unknown, never 0, when the row carries no cache detail", () => {
    expect(cacheHitPercent(row({ usage: { inputTokens: 100, outputTokens: 5 } }))).toBeUndefined();
    expect(cacheHitPercent(row({}))).toBeUndefined();
    expect(cacheHitPercent(row({ usage: { inputTokens: 200, outputTokens: 5, cacheReadInputTokens: 50 } }))).toBe(25);
    expect(cacheHitPercent(row({ usage: { inputTokens: 200, outputTokens: 5, cacheReadInputTokens: 0 } }))).toBe(0);
  });

  test("parseRouteRows drops malformed rows, sorts newest first, keeps valid attempts", () => {
    const rows = parseRouteRows({ logs: [
      { ...base, timestamp: 1, requestId: "a" }, { nope: true }, null,
      { ...base, timestamp: 5, requestId: "b", attempts: [{ provider: "p", model: "m", status: 200 }, "x"] },
    ] });
    expect(rows.map(r => r.requestId)).toEqual(["b", "a"]);
    expect(rows[0]!.attempts).toHaveLength(1);
  });

  test("grouping by session and key keeps aggregates and the no-session bucket", () => {
    const rows = [
      row({ requestId: "1", conversationId: "c1", apiKeyId: "k1", usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 50 },
        displayMetrics: { tokPerSecond: { kind: "value", value: 10 }, cost: { kind: "value", estimate: { cost: { total: 0.5 } } } } }),
      row({ requestId: "2", conversationId: "c1", apiKeyId: "k1", usage: { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 0 },
        displayMetrics: { tokPerSecond: { kind: "value", value: 30 }, cost: { kind: "value", estimate: { cost: { total: 0.25 } } } } }),
      row({ requestId: "3", admissionKind: "loopback" }),
    ];
    const sessions = groupRows(rows, "session");
    expect(sessions.map(g => [g.id, g.stats.count])).toEqual([["session:c1", 2], ["session:none", 1]]);
    expect(sessions[0]!.stats).toMatchObject({ tokens: 220, cacheHit: 25, tokPerSecond: 20, costUsd: 0.75 });
    expect(sessions[1]!.stats.cacheHit).toBeUndefined();
    expect(groupRows(rows, "key").map(g => g.label)).toEqual([
      { kind: "key", id: "k1" }, { kind: "admission", admission: "loopback" }]);
  });
});

describe("what the page names", () => {
  test("a combo row shows the combo the client asked for, not the alias of the target it landed on", () => {
    const combo = row({ model: "combo/steady", requestedModel: "combo/steady", requestedAlias: "mock-b/deepseek-chat",
      routeDecision: { routeKind: "combo" } } as Partial<RouteRow>);
    expect(requestedOf(combo)).toBe("combo/steady");
    expect(buildRouteFlow(combo).requested.model).toBe("combo/steady");
    expect(requestedOf(row({ requestedModel: "claude-sonnet", requestedAlias: "sonnet" } as Partial<RouteRow>))).toBe("sonnet");
  });

  test("an API-key account digest reads as its provider plus a short fingerprint", () => {
    expect(readableAccountLabel(`k${"6a46ff".padEnd(32, "0")}`, "mock-a")).toBe("mock-a #6a46ff");
    expect(readableAccountLabel("o1a2b3c", "xai")).toBe("o1a2b3c");
  });
});
