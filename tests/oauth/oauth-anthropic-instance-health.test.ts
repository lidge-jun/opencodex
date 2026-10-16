import { afterEach, beforeEach, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, type AnthropicInstanceFixture } from "../helpers/anthropic-instance-fixture";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f?.dispose(); });

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  test(`${instance}: account health projection reads only its equal-ID cooldown`, async () => {
    const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
    const now = Date.now();
    const own = f.routing.anthropicRoutingFor(instance);
    own.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "60", now);
    const ownAccount = f.store.getAccountSet(instance)!.accounts.find(row => row.id === f.ids[0])!;
    const peerAccount = f.store.getAccountSet(other)!.accounts.find(row => row.id === f.ids[0])!;
    const cooled = projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true });
    const peer = projectStoredOAuthAccountHealth(other, peerAccount, now, { observeOnly: true });
    expect(cooled.status).toBe("cooldown");
    expect(cooled).toMatchObject({ until: new Date(now + 60_000).toISOString() });
    expect(peer.status).toBe("healthy");
    own.clearAnthropicAccountCooldown(f.ids[0]);
    expect(projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true }).status).toBe("healthy");
  });
  test(`${instance}: reset-derived quota cooldown is separate from sibling rate-limit cooldown`, async () => {
    const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
    const now = Math.floor(Date.now() / 1000) * 1000;
    const headers = new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": String((now + 120_000) / 1000) });
    f.routing.anthropicRoutingFor(instance).recordAnthropicAccount429(f.config, f.ids[0], null, now, headers);
    f.routing.anthropicRoutingFor(other).recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "30", now);
    const ownAccount = f.store.getAccountSet(instance)!.accounts[0]!;
    const peerAccount = f.store.getAccountSet(other)!.accounts[0]!;
    expect(projectStoredOAuthAccountHealth(instance, ownAccount, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "quota", until: new Date(now + 120_000).toISOString() });
    expect(projectStoredOAuthAccountHealth(other, peerAccount, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "rate_limit", until: new Date(now + 30_000).toISOString() });
  });
}

test("a settled reset lifts a retry-after cooldown and replaces the cached bars", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } = await import("../../src/providers/quota/account-cache");
  const now = Date.now();
  const instance = "anthropic" as const;
  const other = "anthropic2" as const;
  const id = f.ids[0];
  const headers = new Headers({
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 86_400_000) / 1000)),
  });
  f.routing.anthropicRoutingFor(instance).recordAnthropicAccount429(f.config, id, "86400", now, headers);
  f.routing.anthropicRoutingFor(other).recordAnthropicAccount429(f.config, id, "86400", now, headers);
  setCachedProviderAccountQuotaForTests(instance, id, { fiveHourPercent: 0, weeklyPercent: 100, updatedAt: now });
  setCachedProviderAccountQuotaForTests(other, id, { fiveHourPercent: 0, weeklyPercent: 100, updatedAt: now });
  f.modelQuota.anthropicModelQuotaFor(instance).observeAnthropicFamilyQuota(id, [{
    label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: now + 86_400_000,
  }], now, true);
  const account = f.store.getAccountSet(instance)!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth(instance, account, now, { observeOnly: true })).toMatchObject({ status: "cooldown", reason: "rate_limit" });
  expect(f.modelQuota.anthropicFamilyRejected(id, "claude-fable-5", now)).toBe(true);

  const resetAt = new Date(now + 3_600_000).toISOString();
  globalThis.fetch = (async () => Response.json({
    five_hour: { utilization: 0, resets_at: resetAt },
    seven_day: { utilization: 0, resets_at: resetAt },
    seven_day_fable: { utilization: 4, resets_at: resetAt },
    limits: [],
  })) as typeof fetch;
  await admitAnthropicAccountAfterReset(instance, id, { claimedAt: now + 1, cleared: ["five_hour", "seven_day"] });

  expect(projectStoredOAuthAccountHealth(instance, account, Date.now(), { observeOnly: true }).status).toBe("healthy");
  expect(f.modelQuota.anthropicFamilyRejected(id, "claude-fable-5", Date.now())).toBe(false);
  expect(getCachedProviderAccountQuota(instance, id)).toMatchObject({ fiveHourPercent: 0, weeklyPercent: 0 });
  const peer = f.store.getAccountSet(other)!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth(other, peer, Date.now(), { observeOnly: true }).status).toBe("cooldown");
  expect(getCachedProviderAccountQuota(other, id)?.weeklyPercent).toBe(100);
});

test("a failed usage reread still leaves the reset account eligible", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const { getCachedProviderAccountQuota, setCachedProviderAccountQuotaForTests } = await import("../../src/providers/quota/account-cache");
  const now = Date.now();
  const id = f.ids[0];
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor((now + 3_600_000) / 1000)),
  });
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, "3600", now, headers);
  setCachedProviderAccountQuotaForTests("anthropic", id, { fiveHourPercent: 100, weeklyPercent: 100, updatedAt: now });
  globalThis.fetch = (async () => { throw new Error("usage endpoint down"); }) as typeof fetch;
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared: ["five_hour", "seven_day"] });
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth("anthropic", account, Date.now(), { observeOnly: true }).status).toBe("healthy");
  expect(getCachedProviderAccountQuota("anthropic", id)?.weeklyPercent).not.toBe(100);
});

test("a five-hour-only reset lifts the account cooldown without releasing a model family", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const now = Date.now();
  const id = f.ids[0];
  const headers = new Headers({
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 86_400_000) / 1000)),
  });
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, "86400", now, headers);
  f.modelQuota.anthropicModelQuotaFor("anthropic").observeAnthropicFamilyQuota(id, [{
    label: "Fable", scope: "model", percent: 100, rejected: true, resetAt: now + 86_400_000,
  }], now, true);
  globalThis.fetch = (async () => Response.json({
    five_hour: { utilization: 0, resets_at: new Date(now + 3_600_000).toISOString() },
  })) as typeof fetch;
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared: ["five_hour", "seven_day"] });
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth("anthropic", account, Date.now(), { observeOnly: true }).status).toBe("healthy");
  expect(f.modelQuota.anthropicFamilyRejected(id, "claude-fable-5", Date.now())).toBe(true);
});

test("a refusal recorded once the claim was journaled survives the reset", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const now = Date.now();
  const id = f.ids[0];
  let sends = 0;
  globalThis.fetch = (async () => { sends += 1; return Response.json({ limits: [] }); }) as typeof fetch;
  const headers = new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor((now + 3_600_000) / 1000)),
  });
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, "3600", now, headers);
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  const cleared = ["five_hour"];
  // Recorded after the claim was journaled: another request was refused while the claim was in flight.
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now - 1, cleared });
  expect(projectStoredOAuthAccountHealth("anthropic", account, now, { observeOnly: true }).status).toBe("cooldown");
  expect(sends).toBe(0);
  // A refusal in the same clock tick as the claim cannot be ordered, so it stays too.
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now, cleared });
  expect(projectStoredOAuthAccountHealth("anthropic", account, now, { observeOnly: true }).status).toBe("cooldown");
  expect(sends).toBe(0);
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared });
  expect(projectStoredOAuthAccountHealth("anthropic", account, now, { observeOnly: true }).status).toBe("healthy");
});

test("a reset lifts a quota cooldown only when its cleared windows cover the refused ones", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const now = Date.now();
  const id = f.ids[0];
  let sends = 0;
  globalThis.fetch = (async () => { sends += 1; return Response.json({ limits: [] }); }) as typeof fetch;
  const headers = new Headers({
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 86_400_000) / 1000)),
  });
  // Retry-After makes this a retry-after cooldown, which a usage reread cannot release by itself.
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, "86400", now, headers);
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  for (const cleared of [[], ["five_hour"], ["seven_day_overage_included"]]) {
    await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared });
    expect(projectStoredOAuthAccountHealth("anthropic", account, now, { observeOnly: true }).status).toBe("cooldown");
  }
  // The reread still ran each time, so the bars reflect the reset.
  expect(sends).toBe(3);
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared: ["seven_day"] });
  expect(projectStoredOAuthAccountHealth("anthropic", account, now, { observeOnly: true }).status).toBe("healthy");
});

test("a reset never lifts an entitlement refusal", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const now = Date.now();
  const id = f.ids[0];
  globalThis.fetch = (async () => Response.json({ limits: [] })) as typeof fetch;
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccountRefusal(f.config, id, 403, "3600", now);
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared: ["five_hour", "seven_day"] });
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  expect(projectStoredOAuthAccountHealth("anthropic", account, now, { observeOnly: true }).status).toBe("cooldown");
});

test("a reset reread sends its own usage request instead of joining an older one", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { fetchAnthropicAccountQuota } = await import("../../src/providers/quota/anthropic-account-quota");
  const { getCachedProviderAccountQuota } = await import("../../src/providers/quota/account-cache");
  const id = f.ids[0];
  const resetAt = new Date(Date.now() + 3_600_000).toISOString();
  const usage = (utilization: number) => Response.json({
    five_hour: { utilization, resets_at: resetAt }, seven_day: { utilization, resets_at: resetAt }, limits: [],
  });
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const olderEntered = new Promise<void>(resolve => { entered = resolve; });
  let sends = 0;
  globalThis.fetch = (async () => {
    sends += 1;
    if (sends === 1) { entered(); await held; return usage(100); }
    return usage(0);
  }) as typeof fetch;
  const older = fetchAnthropicAccountQuota("anthropic", id, true);
  try {
    await olderEntered;
    await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: Date.now(), cleared: [] });
    expect(sends).toBe(2);
    expect(getCachedProviderAccountQuota("anthropic", id)).toMatchObject({ fiveHourPercent: 0, weeklyPercent: 0 });
  } finally {
    release();
    await older;
  }
  expect(getCachedProviderAccountQuota("anthropic", id)).toMatchObject({ fiveHourPercent: 0, weeklyPercent: 0 });
});

test("an uncovered reset-derived cooldown can still be recovered by the reset reread", async () => {
  const { admitAnthropicAccountAfterReset } = await import("../../src/providers/anthropic-reset-admission");
  const { projectStoredOAuthAccountHealth } = await import("../../src/oauth/health");
  const now = Date.now();
  const id = f.ids[0];
  const resetAt = new Date(now + 86_400_000).toISOString();
  let weekly = 100;
  globalThis.fetch = (async () => Response.json({
    five_hour: { utilization: 0, resets_at: resetAt }, seven_day: { utilization: weekly, resets_at: resetAt }, limits: [],
  })) as typeof fetch;
  const headers = new Headers({
    "anthropic-ratelimit-unified-7d-status": "rejected",
    "anthropic-ratelimit-unified-7d-reset": String(Math.floor((now + 86_400_000) / 1000)),
  });
  // No Retry-After: a reset-derived cooldown, which a fresh usage reading may release.
  f.routing.anthropicRoutingFor("anthropic").recordAnthropicAccount429(f.config, id, null, now, headers);
  const account = f.store.getAccountSet("anthropic")!.accounts.find(row => row.id === id)!;
  // The grant cleared only the five-hour window, so it cannot lift the weekly refusal itself.
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared: ["five_hour"] });
  expect(projectStoredOAuthAccountHealth("anthropic", account, Date.now(), { observeOnly: true }).status).toBe("cooldown");
  // A reread proving the weekly window has headroom recovers it through the existing path.
  weekly = 0;
  await admitAnthropicAccountAfterReset("anthropic", id, { claimedAt: now + 1, cleared: ["five_hour"] });
  expect(projectStoredOAuthAccountHealth("anthropic", account, Date.now(), { observeOnly: true }).status).toBe("healthy");
});
