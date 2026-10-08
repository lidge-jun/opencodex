import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";
import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
import type { AnthropicAccountPoolConfig } from "../../../src/types/anthropic-account-pool";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(() => { f?.dispose(); });
function pool(instance: AnthropicInstanceId): AnthropicAccountPoolConfig {
  return instance === "anthropic" ? f.config.anthropicAccountPool! : f.config.providers.anthropic2!.anthropicAccountPool!;
}
function usage(instance: AnthropicInstanceId, slot: number, percent: number): void {
  f.quota.setCachedProviderAccountQuotaForTests(instance, f.ids[slot]!, {
    updatedAt: Date.now(), fiveHourPercent: percent, weeklyPercent: percent,
  });
}
for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  const other = instance === "anthropic" ? "anthropic2" : "anthropic";
  describe(`${instance}: one shared pool policy engine`, () => {
    test("quota strategy uses own thresholds and never reads the equal-ID sibling's quota", () => {
      pool(instance).autoSwitchThreshold = 40;
      pool(other).autoSwitchThreshold = 90;
      usage(instance, 0, 55); usage(instance, 1, 15);
      usage(other, 0, 10); usage(other, 1, 80);
      expect(f.routing.anthropicRoutingFor(instance).resolveAnthropicAccountForSession("fresh", f.config).accountId).toBe(f.ids[1]);
      expect(f.routing.anthropicRoutingFor(other).resolveAnthropicAccountForSession("fresh", f.config).accountId).toBe(f.ids[0]);
    });
    test.each(["five-hour", "weekly", "max-utilization"] as const)("quota window %s reads only the selected instance", window => {
      Object.assign(pool(instance), { autoSwitchThreshold: 1, quotaWindow: window });
      const values = [{ fiveHourPercent: 20, weeklyPercent: 80 }, { fiveHourPercent: 60, weeklyPercent: 10 }];
      for (const [slot, value] of values.entries()) {
        f.quota.setCachedProviderAccountQuotaForTests(instance, f.ids[slot]!, { ...value, updatedAt: Date.now() });
        f.quota.setCachedProviderAccountQuotaForTests(other, f.ids[slot]!, { fiveHourPercent: 100 - value.fiveHourPercent, weeklyPercent: 100 - value.weeklyPercent, updatedAt: Date.now() });
      }
      expect(f.routing.anthropicRoutingFor(instance).resolveAnthropicAccountForSession("window", f.config).accountId).toBe(window === "five-hour" ? f.ids[0] : f.ids[1]);
    });
    test("round-robin cursor and sticky session are independent", async () => {
      for (const target of [instance, other]) Object.assign(pool(target), { strategy: "round-robin", stickyLimit: 1 });
      expect((await f.admit(instance, "first")).selection.accountId).toBe(f.ids[0]);
      expect((await f.admit(instance, "second")).selection.accountId).toBe(f.ids[1]);
      expect((await f.admit(other, "first")).selection.accountId).toBe(f.ids[0]);
      expect((await f.admit(instance, "first")).selection).toMatchObject({ accountId: f.ids[0], reason: "affinity" });
    });
    test("fill-first advances above its own inherited threshold; concrete zero preserves active", async () => {
      Object.assign(pool(instance), { strategy: "fill-first", autoSwitchThreshold: 30 });
      usage(instance, 0, 70); usage(instance, 1, 10);
      const own = f.routing.anthropicRoutingFor(instance);
      expect(own.resolveAnthropicAccountForSession("threshold", f.config).accountId).toBe(f.ids[1]);
      await f.store.setAnthropicAccountThresholdForInstance(instance, f.ids[0], 0);
      expect(own.resolveAnthropicAccountForSession("zero", f.config).accountId).toBe(f.ids[0]);
      const thresholds = await import("../../../src/oauth/anthropic-account-threshold");
      const row = f.store.getAccountSet(instance)!.accounts.find(account => account.id === f.ids[0])!;
      expect(thresholds.effectiveAnthropicAccountThresholdForInstance(instance, f.config, row)).toBe(0);
      expect(thresholds.effectiveAnthropicAccountThresholdForInstance(other, f.config)).toBe(80);
    });
    test("model rules preserve declared order and strict/fallback stay inside this instance", async () => {
      pool(instance).strategy = "round-robin";
      pool(instance).routes = [{ name: "fixture-route", match: "claude-sonnet-*", accounts: [f.ids[1]], fallback: false }];
      const { resolveAnthropicModelRouteForInstance } = await import("../../../src/oauth/anthropic-model-routes");
      const own = f.routing.anthropicRoutingFor(instance);
      const route = resolveAnthropicModelRouteForInstance(instance, f.config, f.model);
      expect(route.decision).toEqual({ position: 1, accounts: [f.ids[1]], fallback: false });
      expect(resolveAnthropicModelRouteForInstance(other, f.config, f.model).decision).toBeNull();
      expect((await f.admit(instance)).selection.accountId).toBe(f.ids[1]);
      await f.store.setAccountPaused(instance, f.ids[1], true);
      expect(own.resolveAnthropicAccountForSession("strict", f.config, Date.now(), route.decision, f.model).accountId).toBeNull();
      pool(instance).routes[0]!.fallback = true;
      const fallback = resolveAnthropicModelRouteForInstance(instance, f.config, f.model).decision;
      expect(own.resolveAnthropicAccountForSession("fallback", f.config, Date.now(), fallback, f.model).accountId).toBe(f.ids[0]);
      const snapshot = await own.getAnthropicPoolAccessSnapshot(f.ids[0]);
      f.ledger.record({ instance, accountId: snapshot.accountId, token: snapshot.accessToken });
      expect(f.routing.anthropicRoutingFor(other).getEligibleAnthropicAccounts()).toEqual([...f.ids]);
    });
    test("healthy affinity outside a model allowlist survives a routed commit", async () => {
      const own = f.routing.anthropicRoutingFor(instance);
      own.bindAnthropicSessionAffinity(f.sessionKey, f.ids[0]);
      pool(instance).routes = [{ name: "fixture-route", match: f.model, accounts: [f.ids[1]], fallback: false }];
      expect((await f.admit(instance)).selection.accountId).toBe(f.ids[1]);
      expect(own.resolveAnthropicAccountForSession(f.sessionKey, f.config, Date.now(), null, "claude-opus-4-6")).toMatchObject({ accountId: f.ids[0], reason: "affinity" });
    });
    test("manual selection survives policy rebase, then an ABA selection invalidates the pending preference", async () => {
      const own = f.routing.anthropicRoutingFor(instance), peer = f.routing.anthropicRoutingFor(other);
      usage(instance, 0, 5); usage(instance, 1, 95);
      await f.store.setActiveAccount(instance, f.ids[1]);
      own.resetAnthropicRoutingForManualSelection(f.ids[1]);
      const generation = peer.captureAnthropicManualSelectionGeneration();
      await f.store.setAnthropicAccountThresholdForInstance(instance, f.ids[0], 25);
      expect(own.resolveAnthropicAccountForSession("manual", f.config)).toMatchObject({ accountId: f.ids[1], reason: "manual" });
      await f.store.setActiveAccount(instance, f.ids[0]);
      await f.store.setActiveAccount(instance, f.ids[1]);
      expect(own.resolveAnthropicAccountForSession("aba", f.config)).toMatchObject({ accountId: f.ids[0], reason: "lowest-usage" });
      expect(peer.captureAnthropicManualSelectionGeneration()).toBe(generation);
    });
    test("pool off retains active and reactive cooldown can still select the sole survivor", () => {
      pool(instance).enabled = false;
      pool(instance).strategy = "round-robin";
      usage(instance, 0, 99); usage(instance, 1, 1);
      const own = f.routing.anthropicRoutingFor(instance);
      expect(own.resolveAnthropicAccountForSession("pool-off", f.config)).toMatchObject({ accountId: f.ids[0], reason: "pool-disabled" });
      expect(own.rotateAnthropicAccountOnRefusal(f.config, f.ids[0], 403, "60")).toBe(f.ids[1]);
      expect(own.resolveAnthropicAccountForSession("after-refusal", f.config)).toMatchObject({ accountId: f.ids[1], reason: "only-eligible" });
      expect(f.routing.anthropicRoutingFor(other).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
    });
    test("all paused and all cooled have distinct local refusals, with scoped Retry-After", async () => {
      const own = f.routing.anthropicRoutingFor(instance);
      await f.store.setAccountPaused(instance, f.ids[0], true);
      await f.store.setAccountPaused(instance, f.ids[1], true);
      expect(own.resolveAnthropicAccountForSession("paused", f.config).reason).toBe("paused");
      const { OAuthAccountPausedError } = await import("../../../src/oauth");
      await expect(own.resolveAnthropicDispatchAccountId(f.config)).rejects.toBeInstanceOf(OAuthAccountPausedError);
      for (const id of f.ids) await f.store.setAccountPaused(instance, id, false);
      const now = Date.now();
      own.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "30", now);
      own.recordAnthropicAccountRefusal(f.config, f.ids[1], 403, "60", now);
      expect(own.resolveAnthropicAccountForSession("cooled", f.config, now).reason).toBe("all-cooled");
      expect(own.getAnthropicPoolRetryAfterSeconds(now)).toBe(30);
      expect(own.getAnthropicPoolRetryAfterSeconds(now, { position: 1, accounts: [f.ids[1]], fallback: false })).toBe(60);
      await expect(own.resolveAnthropicDispatchAccountId(f.config)).rejects.toBeInstanceOf(f.routing.AnthropicAccountCooldownError);
    });
    test("pool settings DTO and helper route use this instance's config", async () => {
      Object.assign(pool(instance), { autoSwitchThreshold: 23, quotaWindow: "weekly", routes: [{ name: "fixture-route", match: f.model, accounts: [f.ids[1]] }], nativeMessages: false });
      const { unifiedPoolSettingsDto, poolSettingsCapability } = await import("../../../src/oauth/pool-settings-capability");
      expect(poolSettingsCapability(instance, f.config.providers[instance])).toBe("anthropic");
      expect(unifiedPoolSettingsDto(f.config, instance, "anthropic")).toMatchObject({ provider: instance, autoSwitchThreshold: 23, quotaWindow: "weekly", nativeMessages: false });
      expect(unifiedPoolSettingsDto(f.config, other, "anthropic")).toMatchObject({ provider: other, autoSwitchThreshold: 80, quotaWindow: "five-hour", nativeMessages: true });
      const token = await f.routing.getAnthropicSidecarAccessTokenForInstance(instance, f.model, f.config);
      f.ledger.record({ instance, accountId: f.ids[1], token });
      expect(f.ledger.sends).toHaveLength(1);
    });
    test("marked endpoint overrides retain pool behavior without creating a new config authority", async () => {
      f.config.providers[instance]!.baseUrl = "https://operator-override.example.test";
      expect((await f.admit(instance)).snapshot?.provider).toBe(instance);
      expect(f.routing.anthropicRoutingFor(instance).hasAnthropicFailoverQuorum()).toBe(true);
    });
  });
}

test("legacy A wrappers retain their names and resolve only A", async () => {
  f.routing.anthropicRoutingFor("anthropic2").bindAnthropicSessionAffinity(f.sessionKey, f.ids[1]);
  f.routing.bindAnthropicSessionAffinity(f.sessionKey, f.ids[0]);
  expect(f.routing.resolveAnthropicAccountForSession(f.sessionKey, f.config).accountId).toBe(f.ids[0]);
  expect((await f.routing.getAnthropicPoolAccessSnapshot(f.ids[0])).provider).toBe("anthropic");
  expect(f.routing.anthropicAccountPoolConfig(f.config)).toBe(f.config.anthropicAccountPool!);
});
