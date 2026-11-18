/**
 * The background recovery worker issues the fresh usage read that lifts a 429 quota cooldown
 * (#6989) without waiting for the dashboard, `ocx account refresh` or a reset admitted through
 * this proxy. A read that keeps the cooldown backs off; a lifted or replaced refusal forgets it.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";
import {
  ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MAX_MS,
  ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MIN_MS,
  clearAnthropicCooldownRecoveryProbeStateForTests,
  dueAnthropicCooldownRecoveryProbes,
  runAnthropicCooldownRecoveryProbes,
} from "../../../src/providers/quota/anthropic-cooldown-recovery-worker";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); clearAnthropicCooldownRecoveryProbeStateForTests(); });
afterEach(async () => { clearAnthropicCooldownRecoveryProbeStateForTests(); await f?.dispose(); });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

function rejected(windows: readonly ("5h" | "7d")[], resetAt: number): Headers {
  const headers = new Headers();
  for (const window of windows) {
    headers.set(`anthropic-ratelimit-unified-${window}-status`, "rejected");
    headers.set(`anthropic-ratelimit-unified-${window}-reset`, String(Math.floor(resetAt / 1000)));
  }
  return headers;
}

/** Fake usage endpoint; counts dispatched reads. */
function usage(fiveHour: number, weekly: number): { reads: number } {
  const counter = { reads: 0 };
  globalThis.fetch = (async () => {
    counter.reads += 1;
    const resetsAt = new Date(Date.now() + HOUR).toISOString();
    return Response.json({
      five_hour: { utilization: fiveHour, resets_at: resetsAt },
      seven_day: { utilization: weekly, resets_at: resetsAt },
      limits: [],
    });
  }) as typeof fetch;
  return counter;
}

function coolForDays(instance: "anthropic" | "anthropic2", id: string, days: number, now = Date.now()): void {
  const routing = f.routing.anthropicRoutingFor(instance);
  // The reported shape: a spent window whose Retry-After equals the window reset.
  routing.recordAnthropicAccount429(f.config, id, String(days * 24 * 3600), now, rejected(["5h", "7d"], now + days * DAY));
  expect(routing.getAnthropicAccountHealthSnapshot(id, now)).toMatchObject({ cooldownSource: "retry-after" });
}

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  test(`${instance}: the sweep lifts a Retry-After quota cooldown once upstream shows headroom`, async () => {
    const routing = f.routing.anthropicRoutingFor(instance);
    const id = f.ids[0];
    coolForDays(instance, id, 4);
    const counter = usage(0, 0);

    await runAnthropicCooldownRecoveryProbes(f.config);

    expect(counter.reads).toBe(1);
    expect(routing.getAnthropicAccountHealthSnapshot(id)).toBeNull();
    expect(routing.getEligibleAnthropicAccounts()).toContain(id);
    expect(dueAnthropicCooldownRecoveryProbes(f.config)).toEqual([]);
  });
}

test("a read that still shows a rejected window full keeps the cooldown and backs off to the cap", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  // One clock for the sweep and for settlement, so each deadline is checked on both sides.
  let clock = Date.now();
  const now = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    coolForDays("anthropic", id, 4, clock);
    const counter = usage(0, 100);
    await runAnthropicCooldownRecoveryProbes(f.config);
    expect(counter.reads).toBe(1);
    expect(routing.getAnthropicAccountHealthSnapshot(id)).toMatchObject({ cooldownSource: "retry-after" });

    // Retained reads wait MIN, 2*MIN, 4*MIN, ... and never longer than MAX.
    let delay = ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MIN_MS;
    for (let read = 2; read <= 7; read += 1) {
      const settledAt = clock;
      clock = settledAt + delay - 1;
      await runAnthropicCooldownRecoveryProbes(f.config);
      expect(counter.reads).toBe(read - 1);
      clock = settledAt + delay;
      await runAnthropicCooldownRecoveryProbes(f.config);
      expect(counter.reads).toBe(read);
      delay = Math.min(delay * 2, ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MAX_MS);
    }
    // Five doublings from one minute pass the ten-minute cap, so the last waits were capped.
    expect(delay).toBe(ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MAX_MS);
  } finally {
    now.mockRestore();
  }
});

test("a unified-rejected 429 that names no window keeps its Retry-After cooldown unread", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const now = Date.now();
  routing.recordAnthropicAccount429(f.config, f.ids[0], String(4 * 24 * 3600), now,
    new Headers({ "anthropic-ratelimit-unified-status": "rejected" }));
  expect(routing.getAnthropicAccountHealthSnapshot(f.ids[0], now)).not.toBeNull();
  const counter = usage(0, 0);
  await runAnthropicCooldownRecoveryProbes(f.config, now);
  expect(counter.reads).toBe(0);
});

test("a newer refusal replaces the earned backoff and is read on the next sweep", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const start = Date.now();
  coolForDays("anthropic", id, 4, start);
  const counter = usage(0, 100);
  await runAnthropicCooldownRecoveryProbes(f.config, start);
  expect(counter.reads).toBe(1);

  routing.recordAnthropicAccount429(f.config, id, String(4 * 24 * 3600), Date.now(), rejected(["5h", "7d"], Date.now() + 4 * DAY));
  await runAnthropicCooldownRecoveryProbes(f.config, Date.now());
  expect(counter.reads).toBe(2);
});

test("no cooled account sends nothing", async () => {
  const counter = usage(0, 0);
  await runAnthropicCooldownRecoveryProbes(f.config);
  expect(counter.reads).toBe(0);
});

test("a cooldown the sweeper reaches first is left to expire", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const now = Date.now();
  routing.recordAnthropicAccount429(f.config, id, "30", now, rejected(["5h"], now + 30_000));
  const counter = usage(0, 0);
  await runAnthropicCooldownRecoveryProbes(f.config, now);
  expect(counter.reads).toBe(0);
  expect(routing.getAnthropicAccountHealthSnapshot(id, now)).not.toBeNull();
});

test("an entitlement 403 is never read for", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const now = Date.now();
  routing.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, String(4 * 24 * 3600), now);
  const counter = usage(0, 0);
  await runAnthropicCooldownRecoveryProbes(f.config, now);
  expect(counter.reads).toBe(0);
});
test("a reset-derived 429 that names no window is never read for", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const now = Date.now();
  routing.recordAnthropicAccount429(f.config, f.ids[0], null, now, new Headers({
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String(Math.floor((now + 4 * DAY) / 1000)),
  }));
  expect(routing.getAnthropicAccountHealthSnapshot(f.ids[0], now)).toMatchObject({ cooldownSource: "reset-derived" });
  const counter = usage(0, 0);
  await runAnthropicCooldownRecoveryProbes(f.config, now);
  expect(counter.reads).toBe(0);
  expect(dueAnthropicCooldownRecoveryProbes(f.config, now)).toEqual([]);
});

test("a disabled or API-key instance is never read for", async () => {
  const id = f.ids[0];
  coolForDays("anthropic", id, 4);
  const counter = usage(0, 0);
  const provider = f.config.providers.anthropic!;
  provider.disabled = true;
  await runAnthropicCooldownRecoveryProbes(f.config);
  provider.disabled = false;
  const authMode = provider.authMode;
  provider.authMode = "key" as typeof authMode;
  await runAnthropicCooldownRecoveryProbes(f.config);
  provider.authMode = authMode;
  expect(counter.reads).toBe(0);
});

test("disabling an instance forgets its earned backoff", async () => {
  const id = f.ids[0];
  const start = Date.now();
  coolForDays("anthropic", id, 4, start);
  const counter = usage(0, 100);
  await runAnthropicCooldownRecoveryProbes(f.config, start);
  expect(counter.reads).toBe(1);
  expect(dueAnthropicCooldownRecoveryProbes(f.config, Date.now())).toEqual([]);
  const provider = f.config.providers.anthropic!;
  provider.disabled = true;
  expect(dueAnthropicCooldownRecoveryProbes(f.config, Date.now())).toEqual([]);
  provider.disabled = false;
  // Same cooldown generation, but the backoff row was pruned while the instance was off.
  expect(dueAnthropicCooldownRecoveryProbes(f.config, Date.now()).map(probe => probe.accountId)).toEqual([id]);
});
