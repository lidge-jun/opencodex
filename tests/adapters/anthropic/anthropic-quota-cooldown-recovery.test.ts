/**
 * #6989: a fresh usage read that shows every rejected window open lifts a 429 quota cooldown
 * whatever set its deadline. Anthropic sends Retry-After on a spent window too, set to that
 * window's reset, so a plan upgrade or an early window rollover used to leave the account out
 * until the old deadline or a manual clear-cooldown. Stale reads and non-quota refusals still
 * settle nothing.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f?.dispose(); });

const HOUR = 3_600_000;

function rejected(windows: readonly ("5h" | "7d")[], resetAt?: number): Headers {
  const headers = new Headers();
  for (const window of windows) {
    headers.set(`anthropic-ratelimit-unified-${window}-status`, "rejected");
    if (resetAt !== undefined) headers.set(`anthropic-ratelimit-unified-${window}-reset`, String(Math.floor(resetAt / 1000)));
  }
  return headers;
}

function usage(fiveHour: number, weekly: number): void {
  const resetsAt = new Date(Date.now() + HOUR).toISOString();
  globalThis.fetch = (async () => Response.json({
    five_hour: { utilization: fiveHour, resets_at: resetsAt },
    seven_day: { utilization: weekly, resets_at: resetsAt },
    limits: [],
  })) as typeof fetch;
}

async function freshRead(instance: "anthropic" | "anthropic2", id: string): Promise<void> {
  const { fetchAnthropicAccountQuota } = await import("../../../src/providers/quota/anthropic-account-quota");
  await fetchAnthropicAccountQuota(instance, id, true, undefined, true);
}

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  test(`${instance}: a fresh read with headroom lifts a Retry-After quota cooldown`, async () => {
    const routing = f.routing.anthropicRoutingFor(instance);
    const id = f.ids[0];
    const now = Date.now();
    // The shape from the report: a weekly refusal whose Retry-After equals the window reset.
    routing.recordAnthropicAccount429(f.config, id, String(4 * 24 * 3600), now, rejected(["5h", "7d"], now + 4 * 24 * HOUR));
    expect(routing.getAnthropicAccountHealthSnapshot(id)).toMatchObject({ cooldownSource: "retry-after" });

    usage(0, 0);
    await freshRead(instance, id);

    expect(routing.getAnthropicAccountHealthSnapshot(id)).toBeNull();
    expect(routing.getEligibleAnthropicAccounts()).toContain(id);
  });
}

test("a read that still shows one rejected window full keeps the cooldown", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const now = Date.now();
  routing.recordAnthropicAccount429(f.config, id, "86400", now, rejected(["5h", "7d"]));
  usage(0, 100);
  await freshRead("anthropic", id);
  expect(routing.getAnthropicAccountHealthSnapshot(id)).toMatchObject({ cooldownSource: "retry-after" });
});

test("a read taken before the claim is stale and settles nothing", () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const now = Date.now();
  routing.recordAnthropicAccount429(f.config, id, "86400", now, rejected(["7d"]));
  const claim = routing.captureAnthropicCooldownRecovery(id, now + 10);
  expect(claim).not.toBeNull();
  expect(routing.settleAnthropicCooldownRecovery(claim!, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now + 9 })).toBe("superseded");
  expect(routing.getAnthropicAccountHealthSnapshot(id)).not.toBeNull();
  // A newer refusal moves the generation, so the older claim cannot lift it either.
  routing.recordAnthropicAccount429(f.config, id, "86400", now + 20, rejected(["7d"]));
  expect(routing.settleAnthropicCooldownRecovery(claim!, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now + 30 })).toBe("superseded");
  expect(routing.getAnthropicAccountHealthSnapshot(id)).not.toBeNull();
});

test("a quota refusal with no usable deadline is recoverable as well", () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const now = Date.now();
  // Rejected status without a reset or Retry-After: the sixty-second default deadline.
  routing.recordAnthropicAccount429(f.config, id, null, now, rejected(["5h"]));
  expect(routing.getAnthropicAccountHealthSnapshot(id, now)).toMatchObject({ cooldownSource: "default" });
  const claim = routing.captureAnthropicCooldownRecovery(id, now + 1);
  expect(routing.settleAnthropicCooldownRecovery(claim!, { fiveHourPercent: 3, weeklyPercent: 100, updatedAt: now + 2 })).toBe("cleared");
  expect(routing.getAnthropicAccountHealthSnapshot(id, now + 3)).toBeNull();
});

test("an entitlement 403 and a refusal naming no window are never claimed", () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const now = Date.now();
  routing.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "600", now);
  routing.recordAnthropicAccount429(f.config, f.ids[1], "600", now, new Headers({ "anthropic-ratelimit-unified-status": "rejected" }));
  expect(routing.getAnthropicAccountHealthSnapshot(f.ids[1], now)).toMatchObject({ cooldownSource: "retry-after" });
  expect(routing.captureAnthropicCooldownRecovery(f.ids[0], now + 1)).toBeNull();
  expect(routing.captureAnthropicCooldownRecovery(f.ids[1], now + 1)).toBeNull();
});

test("an aggregate-only reset-derived refusal stays claimable but is always retained", () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const now = Date.now();
  routing.recordAnthropicAccount429(f.config, id, null, now, new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(Math.floor((now + HOUR) / 1000)),
  }));
  expect(routing.getAnthropicAccountHealthSnapshot(id, now)).toMatchObject({ cooldownSource: "reset-derived" });
  const claim = routing.captureAnthropicCooldownRecovery(id, now + 1);
  expect(claim).not.toBeNull();
  expect(routing.settleAnthropicCooldownRecovery(claim!, { fiveHourPercent: 0, weeklyPercent: 0, updatedAt: now + 2 })).toBe("retained");
});

test("a usage read that started before a Retry-After refusal cannot lift it", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const resetsAt = new Date(Date.now() + HOUR).toISOString();
  globalThis.fetch = (async () => {
    entered();
    await held;
    return Response.json({ five_hour: { utilization: 0, resets_at: resetsAt }, seven_day: { utilization: 0, resets_at: resetsAt }, limits: [] });
  }) as typeof fetch;
  const read = freshRead("anthropic", id);
  await started;
  routing.recordAnthropicAccount429(f.config, id, "86400", Date.now(), rejected(["7d"]));
  release();
  await read;
  expect(routing.getAnthropicAccountHealthSnapshot(id)).toMatchObject({ cooldownSource: "retry-after" });
});

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  test(`${instance}: a pool exhausted on quota is a usage limit only in its own instance`, () => {
    const routing = f.routing.anthropicRoutingFor(instance);
    const now = Date.now();
    for (const id of f.ids) routing.recordAnthropicAccount429(f.config, id, "600", now, rejected(["7d"], now + 2 * HOUR));
    const refusal = routing.anthropicPoolCooldownError(now);
    expect(refusal.usageLimit).toEqual({ resetsAt: Math.floor((now + 2 * HOUR) / 1000) * 1000 });
    expect(refusal.retryAfterSeconds).toBe(600);
    const sibling = f.routing.anthropicRoutingFor(other).anthropicPoolCooldownError(now);
    expect(sibling.usageLimit).toBeNull();
    expect(sibling.retryAfterSeconds).toBeNull();
  });
}

test("a transient hold ending with a quota hold on the same account keeps the refusal retryable", () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const now = Date.now();
  for (const id of f.ids) routing.recordAnthropicAccount429(f.config, id, "600", now, rejected(["7d"], now + 600_000));
  expect(routing.anthropicPoolCooldownError(now).usageLimit).not.toBeNull();
  f.ratePolicy.anthropicRatePolicyFor("anthropic").pauseAnthropicRateAdmission(f.ids[0], now + 600_000);
  expect(routing.anthropicPoolCooldownError(now).usageLimit).toBeNull();
});
