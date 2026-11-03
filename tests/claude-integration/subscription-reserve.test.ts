import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyTraffic, currentWeeklyObservation, decideReserve, observeWeeklyHeaders, readReservePolicy, resetReserveStateForTests,
} from "../../src/claude/subscription-reserve";

let home: string;
let previous: string | undefined;
beforeEach(() => {
  previous = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-reserve-"));
  process.env.OPENCODEX_HOME = home;
  resetReserveStateForTests();
});
afterEach(() => {
  if (previous === undefined) delete process.env.OPENCODEX_HOME; else process.env.OPENCODEX_HOME = previous;
  rmSync(home, { recursive: true, force: true });
  resetReserveStateForTests();
});

const headers = (utilization: string, reset?: number) => new Headers({
  "anthropic-ratelimit-unified-7d-utilization": utilization,
  ...(reset ? { "anthropic-ratelimit-unified-7d-reset": String(reset) } : {}),
});

test("policy is disabled without a file and never downgrades", () => {
  observeWeeklyHeaders(headers("0.95"));
  expect(readReservePolicy().enabled).toBe(false);
  expect(decideReserve("background").action).toBe("allow");
});

test("soft and hard tiers downgrade background only, with a reason", () => {
  writeFileSync(join(home, "subscription-reserve.json"), JSON.stringify({ enabled: true, targets: ["provider-b/model-y"] }));
  observeWeeklyHeaders(headers("0.55"));
  expect(decideReserve("background").action).toBe("allow");
  observeWeeklyHeaders(headers("0.61"));
  const soft = decideReserve("background");
  expect(soft).toMatchObject({ action: "downgrade", tier: "soft", target: "provider-b/model-y" });
  expect(soft.reason).toContain("61%");
  expect(decideReserve("interactive").action).toBe("allow");
  observeWeeklyHeaders(headers("0.83"));
  expect(decideReserve("background")).toMatchObject({ action: "downgrade", tier: "hard" });
  expect(decideReserve("interactive").action).toBe("allow");
});

test("an enabled policy without targets never downgrades", () => {
  writeFileSync(join(home, "subscription-reserve.json"), JSON.stringify({ enabled: true }));
  observeWeeklyHeaders(headers("0.95"));
  expect(readReservePolicy()).toMatchObject({ enabled: true, targets: [] });
  expect(decideReserve("background").action).toBe("allow");
});

test("the observation survives a restart and expires at the window reset", () => {
  const now = Date.now();
  observeWeeklyHeaders(headers("0.7", Math.floor(now / 1000) + 3600), now);
  resetReserveStateForTests();
  expect(currentWeeklyObservation(now)?.utilization).toBe(0.7);
  expect(currentWeeklyObservation(now + 2 * 3600_000)).toBeUndefined();
});

test("traffic classes use explicit header, haiku model and tiny probes", () => {
  expect(classifyTraffic(new Headers({ "x-ocx-priority": "background" }), { model: "claude-opus-5-5" })).toBe("background");
  expect(classifyTraffic(new Headers(), { model: "claude-haiku-5-5" })).toBe("background");
  expect(classifyTraffic(new Headers(), { model: "claude-sonnet-5-5", max_tokens: 1 })).toBe("background");
  expect(classifyTraffic(new Headers(), { model: "claude-sonnet-5-5", max_tokens: 1, tools: [{}] })).toBe("interactive");
  expect(classifyTraffic(new Headers(), { model: "claude-opus-5-5", max_tokens: 64000 })).toBe("interactive");
});
