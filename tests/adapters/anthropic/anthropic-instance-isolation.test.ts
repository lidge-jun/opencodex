import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, instanceFixtureUuid, type AnthropicInstanceFixture } from "../../helpers/anthropic-instance-fixture";
import type { GenerationContext, StateStoreRegistration } from "../../../src/lib/state-store-sweeper";

let f: AnthropicInstanceFixture;
beforeEach(async () => { f = await createAnthropicInstanceFixture(); await f.seed(); });
afterEach(async () => { await f?.dispose(); });
const sibling = (instance: typeof INSTANCE_FIXTURE_INSTANCES[number]) => instance === "anthropic" ? "anthropic2" : "anthropic";

function context(keys: readonly string[]): GenerationContext {
  return { generation: 100, providerNames: new Set(INSTANCE_FIXTURE_INSTANCES), oauthAccountKeys: new Set(keys),
    comboIds: new Set(), comboTargets: new Set(), codexAccountIds: new Set(), configRoots: new Set() };
}
function quota(percent: number) { return { updatedAt: Date.now(), fiveHourPercent: percent, weeklyPercent: percent }; }

for (const instance of INSTANCE_FIXTURE_INSTANCES) {
  const other = sibling(instance);
  describe(`${instance}: equal-ID state isolation`, () => {
    test("physical credential/UUID ledger observes only the requested namespace", async () => {
      for (const target of [instance, other]) {
        const snapshot = await f.routing.anthropicRoutingFor(target).getAnthropicPoolAccessSnapshot(f.ids[0]);
        expect(snapshot.provider).toBe(target);
        f.ledger.record({ instance: target, accountId: snapshot.accountId, token: snapshot.accessToken, uuid: instanceFixtureUuid(target, 1) });
      }
      expect(f.ledger.sends).toHaveLength(2);
      f.ledger.assertNoCrossSend();
    });
    test("affinity, manual generation, preference and quorum invalidation affect only their instance", async () => {
      const own = f.routing.anthropicRoutingFor(instance), peer = f.routing.anthropicRoutingFor(other);
      own.bindAnthropicSessionAffinity(f.sessionKey, f.ids[0]);
      peer.bindAnthropicSessionAffinity(f.sessionKey, f.ids[1]);
      const peerGeneration = peer.captureAnthropicManualSelectionGeneration();
      expect(own.hasAnthropicFailoverQuorum()).toBe(true);
      expect(peer.hasAnthropicFailoverQuorum()).toBe(true);
      await f.store.setActiveAccount(instance, f.ids[1]);
      own.resetAnthropicRoutingForManualSelection(f.ids[1]);
      expect(own.resolveAnthropicAccountForSession(f.sessionKey, f.config).reason).toBe("manual");
      expect(peer.captureAnthropicManualSelectionGeneration()).toBe(peerGeneration);
      expect(peer.resolveAnthropicAccountForSession(f.sessionKey, f.config).accountId).toBe(f.ids[1]);
      expect(peer.anthropicSessionAffinitySizeForTests()).toBe(1);
      await f.store.setAccountPaused(instance, f.ids[1], true);
      expect(own.hasAnthropicFailoverQuorum()).toBe(false);
      expect(peer.hasAnthropicFailoverQuorum()).toBe(true);
    });
    test("cooldown, transient pause and model-family exclusions do not cross equal IDs", () => {
      const own = f.routing.anthropicRoutingFor(instance), peer = f.routing.anthropicRoutingFor(other);
      const now = Date.now();
      own.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "60", now);
      f.ratePolicy.anthropicRatePolicyFor(instance).pauseAnthropicRateAdmission(f.ids[1], now + 10_000);
      expect(own.getEligibleAnthropicAccounts(now)).toEqual([]);
      expect(peer.getEligibleAnthropicAccounts(now)).toEqual([...f.ids]);
      own.clearAnthropicAccountPoolState();
      f.modelQuota.anthropicModelQuotaFor(instance).observeAnthropicFamilyQuota(f.ids[0], [{ label: "Fable", percent: 100, scope: "model", rejected: true, resetAt: now + 60_000 }], now);
      expect(own.getEligibleAnthropicAccounts(now, "claude-fable-5-1")).toEqual([f.ids[1]]);
      expect(peer.getEligibleAnthropicAccounts(now, "claude-fable-5-1")).toEqual([...f.ids]);
      expect(own.getEligibleAnthropicAccounts(now, f.model)).toEqual([...f.ids]);
    });
    test("quota-aware candidate evidence is qualified and an unmarked B never receives builtin evidence", async () => {
      const { quotaEvidenceForCandidate } = await import("../../../src/routing/quota");
      f.quota.setCachedProviderAccountQuotaForTests(instance, f.ids[0], quota(25));
      f.quota.setCachedProviderAccountQuotaForTests(other, f.ids[0], quota(75));
      expect(quotaEvidenceForCandidate({ provider: instance, model: f.model, accountRef: f.ids[0] }, f.config).headroom).toBe(0.75);
      expect(quotaEvidenceForCandidate({ provider: other, model: f.model, accountRef: f.ids[0] }, f.config).headroom).toBe(0.25);
      const unmarked = structuredClone(f.config);
      delete unmarked.providers.anthropic2!.anthropicOAuthInstance;
      expect(quotaEvidenceForCandidate({ provider: "anthropic2", model: f.model, accountRef: f.ids[0] }, unmarked)).toEqual({ known: false });
      expect(quotaEvidenceForCandidate({ provider: "anthropic2", model: f.model, accountRef: f.ids[0] })).toEqual({ known: false });
    });
    test("all-bucket reconciliation retires removed claims without clearing the equal-ID sibling", async () => {
      const own = f.routing.anthropicRoutingFor(instance), peer = f.routing.anthropicRoutingFor(other);
      const now = Date.now();
      const headers = new Headers({ "anthropic-ratelimit-unified-5h-status": "rejected", "anthropic-ratelimit-unified-5h-reset": String((now + 60_000) / 1000) });
      for (const facade of [own, peer]) { facade.recordAnthropicAccount429(f.config, f.ids[0], null, now, headers); facade.bindAnthropicSessionAffinity(f.sessionKey, f.ids[0], now); }
      const claim = own.captureAnthropicCooldownRecovery(f.ids[0], now)!;
      expect(claim.instance).toBe(instance);
      expect(peer.settleAnthropicCooldownRecovery(claim, quota(1))).toBe("superseded");
      const keys = [`${instance}\0${f.ids[1]}`, ...f.ids.map(id => `${other}\0${id}`)];
      const retired = structuredClone(f.store.getAccountSet(instance)!.accounts.find(row => row.id === f.ids[0])!);
      await f.store.removeAccount(instance, f.ids[0]);
      const next = context(keys);
      expect(f.routing.reconcileAnthropicRoutingState(next, f.config)).toBeGreaterThan(0);
      const recovery = await import("../../../src/providers/quota/anthropic-cooldown-recovery");
      recovery.reconcileAllAnthropicCooldownGenerations(next);
      // Re-add the same logical ID and establish new refusal evidence; the old claim remains stale.
      await f.store.mutateStore(auth => { auth[instance]!.accounts.push(retired); });
      own.recordAnthropicAccount429(f.config, f.ids[0], null, now + 1, headers);
      expect(own.settleAnthropicCooldownRecovery(claim, { ...quota(1), updatedAt: now + 2 })).toBe("superseded");
      expect(peer.getAnthropicAccountHealthSnapshot(f.ids[0], now)).not.toBeNull();
      expect(peer.anthropicSessionAffinitySizeForTests()).toBe(1);
    });
  });
}

test("H03: a deliberately misbound B resolver is detected for token and UUID separately", async () => {
  const deliberatelyWrongResolver = f.routing.anthropicRoutingFor("anthropic");
  const wrong = await deliberatelyWrongResolver.getAnthropicPoolAccessSnapshot(f.ids[0]);
  expect(() => f.ledger.record({ instance: "anthropic2", accountId: wrong.accountId, token: wrong.accessToken, uuid: instanceFixtureUuid("anthropic", 1) })).toThrow("wrong instance");
  const correct = await f.routing.anthropicRoutingFor("anthropic2").getAnthropicPoolAccessSnapshot(f.ids[0]);
  expect(() => f.ledger.record({ instance: "anthropic2", accountId: correct.accountId, token: correct.accessToken, uuid: instanceFixtureUuid("anthropic", 1) })).toThrow("wrong instance");
  f.ledger.record({ instance: "anthropic2", accountId: correct.accountId, token: correct.accessToken, uuid: instanceFixtureUuid("anthropic2", 1) });
  expect(f.ledger.sends).toHaveLength(1);
});

test("B has no B accounts: request admission never falls back onto A or the CLI", async () => {
  await f.store.mutateStore(auth => { delete auth.anthropic2; });
  const b = f.routing.anthropicRoutingFor("anthropic2");
  expect(b.resolveAnthropicAccountForSession(f.sessionKey, f.config).accountId).toBeNull();
  await expect(b.resolveAnthropicDispatchAccountId(f.config)).rejects.toMatchObject({ provider: "anthropic2" });
  expect(f.routing.anthropicRoutingFor("anthropic").getEligibleAnthropicAccounts()).toEqual([...f.ids]);
  expect(f.ledger.sends).toHaveLength(0);
});

for (const mode of ["absent", "disabled", "unmarked", "key"] as const) {
  test(`B ${mode}: explicit runtime config refuses orphan OAuth before token resolution`, async () => {
    const config = structuredClone(f.config);
    if (mode === "absent") delete config.providers.anthropic2;
    else if (mode === "disabled") config.providers.anthropic2!.disabled = true;
    else if (mode === "unmarked") delete config.providers.anthropic2!.anthropicOAuthInstance;
    else config.providers.anthropic2!.authMode = "key";
    // Persisted fixture remains authorized: runtime authority is the explicit config, not disk.
    const b = f.routing.anthropicRoutingFor("anthropic2");
    expect(b.resolveAnthropicAccountForSession(f.sessionKey, config)).toMatchObject({ accountId: null, reason: "none" });
    await expect(b.resolveAnthropicDispatchAccountId(config)).rejects.toMatchObject({ provider: "anthropic2" });
    await expect(f.routing.getAnthropicSidecarAccessTokenForInstance("anthropic2", f.model, config)).rejects.toMatchObject({ provider: "anthropic2" });
    await expect(f.routing.getAnthropicSidecarAccessToken("anthropic2", f.model, config)).rejects.toMatchObject({ provider: "anthropic2" });
    expect(f.ledger.sends).toHaveLength(0);
  });
}

test("namespace credential API accepts an authorized explicit in-memory config despite different disk config", async () => {
  const disk = structuredClone(f.config);
  delete disk.providers.anthropic2;
  f.publishConfig(disk);
  const b = f.routing.anthropicRoutingFor("anthropic2");
  expect((await b.getAnthropicPoolAccessSnapshot(f.ids[0])).provider).toBe("anthropic2");
  expect(await b.resolveAnthropicDispatchAccountId(f.config)).toBe(f.ids[0]);
  const frozen = Object.freeze(structuredClone(f.config));
  expect(b.resolveAnthropicAccountForSession(f.sessionKey, frozen).accountId).toBe(f.ids[0]);
});

test("explicit combo targets retain both requested instances", async () => {
  const { pickComboTarget, clearComboSelectionState } = await import("../../../src/combos/resolve");
  f.config.combos = { explicit: { targets: [
    { provider: "anthropic2", model: f.model }, { provider: "anthropic", model: f.model },
  ] } };
  try {
    const first = pickComboTarget(f.config, "explicit")!;
    expect(first.target.provider).toBe("anthropic2");
    const second = pickComboTarget(f.config, "explicit", { exclude: [`anthropic2/${f.model}`] })!;
    expect(second.target.provider).toBe("anthropic");
    for (const target of [first.target, second.target]) {
      const instance = target.provider === "anthropic2" ? "anthropic2" : "anthropic";
      const snapshot = await f.routing.anthropicRoutingFor(instance).getAnthropicPoolAccessSnapshot(f.ids[0]);
      f.ledger.record({ instance, accountId: snapshot.accountId, token: snapshot.accessToken });
    }
    expect(f.ledger.sends.map(send => send.instance)).toEqual(["anthropic2", "anthropic"]);
  } finally { clearComboSelectionState("explicit"); }
});

test("management account-ref dry-run attributes B quota using explicit config", async () => {
  const { handleManagementAPI } = await import("../../../src/server/management-api");
  const { ManagementRequest } = await import("../../helpers/management-auth");
  f.quota.setCachedProviderAccountQuotaForTests("anthropic", f.ids[0], quota(80));
  f.quota.setCachedProviderAccountQuotaForTests("anthropic2", f.ids[0], quota(20));
  f.config.routingProfiles = { pools: { candidates: INSTANCE_FIXTURE_INSTANCES.map(provider => ({ provider, model: f.model })) } };
  const candidates = INSTANCE_FIXTURE_INSTANCES.map(provider => ({ provider, model: f.model, accountRef: f.ids[0] }));
  async function preview(config = f.config, supplied = true) {
    const req = new ManagementRequest("http://localhost/api/routing-profiles/dry-run", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "pools", evidence: {}, ...(supplied ? { candidates } : {}) }) });
    const response = await handleManagementAPI(req, new URL(req.url), config);
    expect(response?.status).toBe(200);
    return await response!.json() as { candidates: Array<{ provider: string; quota?: { known: boolean; headroom?: number } }> };
  }
  const bound = await preview();
  expect(bound.candidates[0]!.quota?.headroom).toBeCloseTo(0.2);
  expect(bound.candidates[1]!.quota?.headroom).toBeCloseTo(0.8);
  // Assembly runs before an exact account is bound; it must preserve unknown rather than guess the active account.
  expect((await preview(f.config, false)).candidates.map(candidate => candidate.quota)).toEqual([{ known: false }, { known: false }]);
  const { requestHistoryDb } = await import("../../../src/routing/history/indexer");
  const ownedHistory = requestHistoryDb();
  expect(ownedHistory.query("SELECT 1 AS live").get()).toEqual({ live: 1 });
  const unmarked = structuredClone(f.config);
  delete unmarked.providers.anthropic2!.anthropicOAuthInstance;
  expect((await preview(unmarked)).candidates[1]!.quota).toEqual({ known: false });
  // Exercise the real retained handle and drained root removal, including on Windows.
  await f.dispose();
  expect(() => requestHistoryDb()).toThrow("request-history index is not open");
  expect(() => ownedHistory.query("SELECT 1 AS live").get()).toThrow();
  expect(existsSync(f.home)).toBe(false);
});

test("registered all-bucket hooks retire non-admitted B state while retaining live A", async () => {
  const registrations = await import("../../../src/lib/state-store-registrations");
  const now = Date.now();
  for (const instance of INSTANCE_FIXTURE_INSTANCES) {
    const facade = f.routing.anthropicRoutingFor(instance);
    facade.recordAnthropicAccountRefusal(f.config, f.ids[0], 403, "60", now);
    facade.bindAnthropicSessionAffinity(f.sessionKey, f.ids[0], now);
    f.ratePolicy.anthropicRatePolicyFor(instance).pauseAnthropicRateAdmission(f.ids[1], now + 10_000);
    f.modelQuota.anthropicModelQuotaFor(instance).observeAnthropicFamilyQuota(f.ids[1], [{ label: "Fable", percent: 100, scope: "model", rejected: true }], now);
  }
  const config = structuredClone(f.config);
  config.providers.anthropic2!.disabled = true;
  registrations.setLiveStateStoreConfig(config);
  const generation = registrations.buildGenerationContext();
  expect([...generation.oauthAccountKeys]).toEqual(f.ids.map(id => `anthropic\0${id}`));
  for (const name of ["anthropic-routing-health", "anthropic-family-quota", "anthropic-rate-pauses", "anthropic-cooldown-generations"]) {
    const registration: StateStoreRegistration = registrations.STATE_STORE_REGISTRATIONS.find(item => item.name === name)!;
    expect(typeof registration.reconcileGeneration).toBe("function");
    registration.reconcileGeneration!(generation);
  }
  expect(f.routing.anthropicRoutingFor("anthropic2").getAnthropicAccountHealthSnapshot(f.ids[0], now)).toBeNull();
  expect(f.routing.anthropicRoutingFor("anthropic").getAnthropicAccountHealthSnapshot(f.ids[0], now)).not.toBeNull();
  expect(f.ratePolicy.anthropicRatePolicyFor("anthropic2").anthropicRatePauseUntil(f.ids[1], now)).toBeUndefined();
  expect(f.ratePolicy.anthropicRatePolicyFor("anthropic").anthropicRatePauseUntil(f.ids[1], now)).toBe(now + 10_000);
  expect(f.modelQuota.anthropicModelQuotaFor("anthropic2").anthropicFamilyRejected(f.ids[1], "claude-fable-5-1", now)).toBe(false);
  expect(f.modelQuota.anthropicModelQuotaFor("anthropic").anthropicFamilyRejected(f.ids[1], "claude-fable-5-1", now)).toBe(true);
});


test("fixture teardown cancels the quota disk debounce before fake-home restoration", async () => {
  const originalClear = globalThis.clearTimeout;
  const scheduled = spyOn(globalThis, "setTimeout");
  const cancelledAt: string[] = [];
  const cancelled = spyOn(globalThis, "clearTimeout").mockImplementation(handle => {
    cancelledAt.push(process.env.OPENCODEX_HOME ?? "");
    originalClear(handle);
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Exercise the real provider-clear persistence path, then shared cleanup cancels it.
    f.quota.clearAccountQuotaCache("anthropic2");
    expect(scheduled.mock.calls.length).toBeGreaterThan(0);
    timer = scheduled.mock.results.at(-1)!.value;
    await f.dispose();
    expect(cancelled).toHaveBeenCalledWith(timer);
    expect(cancelledAt).toContain(f.paths.OPENCODEX_HOME);
    expect(process.env.OPENCODEX_HOME).not.toBe(f.paths.OPENCODEX_HOME);
  } finally {
    if (timer !== undefined) originalClear(timer);
    scheduled.mockRestore();
    cancelled.mockRestore();
  }
});
