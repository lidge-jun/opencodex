/**
 * The background recovery worker issues the fresh usage read that lifts a 429 quota cooldown
 * (#6989) without waiting for the dashboard, `ocx account refresh` or a reset admitted through
 * this proxy. A read that keeps the cooldown backs off; a lifted or replaced refusal forgets it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
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

test("a read that still shows a rejected window full keeps the cooldown and backs off", async () => {
  const routing = f.routing.anthropicRoutingFor("anthropic");
  const id = f.ids[0];
  const start = Date.now();
  coolForDays("anthropic", id, 4, start);
  const counter = usage(0, 100);

  await runAnthropicCooldownRecoveryProbes(f.config, start);
  expect(counter.reads).toBe(1);
  expect(routing.getAnthropicAccountHealthSnapshot(id)).toMatchObject({ cooldownSource: "retry-after" });

  // The next sweep inside the backoff sends nothing; the one after it reads again.
  await runAnthropicCooldownRecoveryProbes(f.config, Date.now());
  expect(counter.reads).toBe(1);
  await runAnthropicCooldownRecoveryProbes(f.config, Date.now() + ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MIN_MS + 1);
  expect(counter.reads).toBe(2);
  // Each retained read doubles the wait, up to the cap.
  await runAnthropicCooldownRecoveryProbes(f.config, Date.now() + ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MIN_MS + 1);
  expect(counter.reads).toBe(2);
  await runAnthropicCooldownRecoveryProbes(f.config, Date.now() + ANTHROPIC_COOLDOWN_RECOVERY_PROBE_MAX_MS + 1);
  expect(counter.reads).toBe(3);
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
