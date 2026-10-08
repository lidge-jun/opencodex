import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createAnthropicInstanceFixture, INSTANCE_FIXTURE_INSTANCES, anthropicInstanceBarrier,
  type AnthropicInstanceFixture,
} from "../../helpers/anthropic-instance-fixture";
import type { AnthropicInstanceId } from "../../../src/providers/anthropic-instance-id";
import type { GenerationContext } from "../../../src/lib/state-store-sweeper";

let f: AnthropicInstanceFixture;
let cache: typeof import("../../../src/providers/quota/account-cache");
let recovery: typeof import("../../../src/providers/quota/anthropic-cooldown-recovery");
let refusal: typeof import("../../../src/oauth/anthropic-account-refusal");
let familyHeaders: typeof import("../../../src/providers/quota/anthropic-family-headers");
let sweeper: typeof import("../../../src/lib/state-store-sweeper");
let retry: typeof import("../../../src/lib/upstream-retry");

beforeEach(async () => {
  // The shared fixture creates every configured root before importing runtime owners.
  f = await createAnthropicInstanceFixture();
  [cache, recovery, refusal, familyHeaders, sweeper, retry] = await Promise.all([
    import("../../../src/providers/quota/account-cache"),
    import("../../../src/providers/quota/anthropic-cooldown-recovery"),
    import("../../../src/oauth/anthropic-account-refusal"),
    import("../../../src/providers/quota/anthropic-family-headers"),
    import("../../../src/lib/state-store-sweeper"),
    import("../../../src/lib/upstream-retry"),
  ]);
  cache.clearAccountQuotaCache();
  cache.resetProviderQuotaReconcileStateForTests();
  await f.seed();
});

afterEach(() => {
  for (const instance of INSTANCE_FIXTURE_INSTANCES) recovery.anthropicCooldownRecoveryFor(instance).setAnthropicQuotaAfterSettlementForTests(undefined);
  // Cancel persistence while the isolated home is still installed, including fixture cleanup writes.
  cache.clearAccountQuotaCache();
  cache.resetProviderQuotaReconcileStateForTests();
  f.dispose();
  // dispose's provider-only clears schedule writes; the all-cache clear only cancels them.
  cache.clearAccountQuotaCache();
});

function sibling(instance: AnthropicInstanceId): AnthropicInstanceId {
  return instance === "anthropic" ? "anthropic2" : "anthropic";
}
function context(keys?: ReadonlySet<string>): GenerationContext {
  return {
    generation: sweeper.captureConfigGeneration() + 100,
    providerNames: new Set(INSTANCE_FIXTURE_INSTANCES),
    oauthAccountKeys: keys ?? new Set(INSTANCE_FIXTURE_INSTANCES.flatMap(instance =>
      f.store.getAccountSet(instance)!.accounts.map(row => cache.accountCacheKey(instance, row.id)))),
    comboIds: new Set(), comboTargets: new Set(), codexAccountIds: new Set(), configRoots: new Set(),
  };
}
function reconcile(ctx: GenerationContext): void {
  f.modelQuota.reconcileAllAnthropicFamilyQuota(ctx);
  f.ratePolicy.reconcileAllAnthropicRatePauses(ctx);
  recovery.reconcileAllAnthropicCooldownGenerations(ctx);
  cache.reconcileProviderAccountQuotaRows(ctx);
  f.routing.reconcileAnthropicRoutingState(ctx, f.config);
}
function familyWindow(now: number) {
  return [{ label: "Fable", scope: "model" as const, percent: 100, rejected: true as const, resetAt: now + 60_000 }];
}
function sharedRejection(resetAt = Date.now() + 60_000): Headers {
  return new Headers({
    "anthropic-ratelimit-unified-5h-status": "rejected",
    "anthropic-ratelimit-unified-5h-reset": String(Math.floor(resetAt / 1000)),
  });
}
function responseFor(instance: AnthropicInstanceId, status: number, headers = new Headers()): Response {
  const credential = f.store.getAccountCredential(instance, f.ids[0])!;
  const response = Response.json({ error: { type: "permission_error", message: "Your account does not have an active subscription." } }, { status, headers });
  refusal.bindAnthropicRefusalCredential(response, {
    provider: instance, accountId: f.ids[0], accessToken: credential.access,
    generation: f.store.credentialGeneration(credential),
  });
  return response;
}

describe("Anthropic quota namespace isolation", () => {
  for (const instance of INSTANCE_FIXTURE_INSTANCES) {
    test(`${instance}: family evidence, lease, pause and health do not affect the equal-ID sibling`, () => {
      const other = sibling(instance);
      const id = f.ids[0];
      const now = Date.now();
      const own = f.modelQuota.anthropicModelQuotaFor(instance);
      const foreign = f.modelQuota.anthropicModelQuotaFor(other);
      const otherGeneration = foreign.anthropicFamilyQuotaGeneration(id);
      own.observeAnthropicFamilyQuota(id, familyWindow(now), now);
      f.ratePolicy.anthropicRatePolicyFor(instance).pauseAnthropicRateAdmission(id, now + 30_000);
      f.routing.anthropicRoutingFor(instance).recordAnthropicAccountRefusal(f.config, id, 429, null, now, sharedRejection());
      expect(own.anthropicFamilyRejected(id, "claude-fable-5")).toBe(true);
      expect(own.claimAnthropicFamilyRevalidation(id, "claude-fable-5")).toBeNull();
      expect(own.anthropicFamilyRejected(id, f.model)).toBe(false);
      expect(foreign.anthropicFamilyRejected(id, "claude-fable-5")).toBe(false);
      expect(foreign.anthropicFamilyQuotaGeneration(id)).toBe(otherGeneration);
      expect(f.ratePolicy.anthropicRatePolicyFor(other).anthropicRatePauseUntil(id)).toBeUndefined();
      expect(f.routing.anthropicRoutingFor(other).getAnthropicAccountHealthSnapshot(id)).toBeNull();
      expect(f.routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("reset-derived");

      // Equal expired observations each acquire their own lease. Releasing one leaves the other busy.
      own.observeAnthropicFamilyQuota(id, familyWindow(now - 120_000), now - 120_000);
      foreign.observeAnthropicFamilyQuota(id, familyWindow(now - 120_000), now - 120_000);
      const release = own.claimAnthropicFamilyRevalidation(id, "claude-fable-5", now)!;
      const foreignRelease = foreign.claimAnthropicFamilyRevalidation(id, "claude-fable-5", now)!;
      expect(typeof release).toBe("function"); expect(typeof foreignRelease).toBe("function");
      release();
      expect(foreign.claimAnthropicFamilyRevalidation(id, "claude-fable-5", now)).toBeNull();
      foreignRelease();
    });

    test(`${instance}: headers attribute actual physical sends to their instance and keep the probe clock`, async () => {
      const { snapshot } = await f.admit(instance);
      expect(snapshot?.provider).toBe(instance);
      f.ledger.record({ instance, accountId: snapshot!.accountId, token: snapshot!.accessToken });
      const headers = new Headers({
        "anthropic-ratelimit-unified-5h-utilization": "0.21",
        "anthropic-ratelimit-unified-7d_oi-status": "rejected",
      });
      f.quota.recordAnthropicAccountQuotaFromHeadersForInstance(instance, snapshot!.accountId, headers,
        sweeper.captureConfigGeneration(), 429, "claude-fable-5");
      expect(f.quota.getCachedProviderAccountQuota(instance, f.ids[0])?.fiveHourPercent).toBe(21);
      expect(cache.accountQuotaCache.get(cache.accountCacheKey(instance, f.ids[0]))?.ts).toBe(0);
      expect(f.quota.getCachedProviderAccountQuota(sibling(instance), f.ids[0])).toBeNull();
      expect(f.modelQuota.anthropicModelQuotaFor(instance).anthropicFamilyRejected(f.ids[0], "claude-fable-5")).toBe(true);
      f.ledger.assertNoCrossSend();
    });

    test(`${instance}: an older config generation still writes a live key but cannot revive a retired key`, () => {
      const other = sibling(instance);
      const ctx = context(new Set(f.ids.map(id => cache.accountCacheKey(other, id))));
      cache.reconcileProviderAccountQuotaRows(ctx);
      const headers = new Headers({ "anthropic-ratelimit-unified-5h-utilization": "0.37" });
      cache.recordAnthropicAccountQuotaFromHeadersForInstance(instance, f.ids[0], headers, ctx.generation - 1);
      cache.recordAnthropicAccountQuotaFromHeadersForInstance(other, f.ids[0], headers, ctx.generation - 1);
      expect(f.quota.getCachedProviderAccountQuota(instance, f.ids[0])).toBeNull();
      expect(f.quota.getCachedProviderAccountQuota(other, f.ids[0])?.fiveHourPercent).toBe(37);
    });

    test(`${instance}: foreign provider, bearer, generation and UUID refusals do nothing`, async () => {
      const own = f.store.getAccountCredential(instance, f.ids[0])!;
      const foreign = f.store.getAccountCredential(sibling(instance), f.ids[0])!;
      for (const status of [403, 429]) for (const mismatch of ["provider", "bearer", "generation", "uuid"] as const) {
        const response = Response.json({ error: { type: "permission_error", message: "Your account does not have an active subscription." } },
          { status, headers: sharedRejection() });
        const snapshot = { provider: mismatch === "provider" ? sibling(instance) : instance, accountId: f.ids[0],
          accessToken: mismatch === "bearer" ? foreign.access : own.access,
          generation: mismatch === "generation" ? f.store.credentialGeneration(foreign) : f.store.credentialGeneration(own) };
        if (mismatch === "uuid") refusal.bindAnthropicRefusalCredential(response, snapshot, "synthetic-wrong-uuid");
        else refusal.bindAnthropicRefusalCredential(response, snapshot);
        expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
          config: f.config, accountId: f.ids[0], canRetry: true, requestKey: {},
        })).toBeNull();
      }
      for (const pool of INSTANCE_FIXTURE_INSTANCES) {
        expect(f.routing.anthropicRoutingFor(pool).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
        expect(f.ratePolicy.anthropicRatePolicyFor(pool).anthropicRatePauseUntil(f.ids[0])).toBeUndefined();
      }
    });

    test(`${instance}: legitimate pool-off recovery stays in the selected instance`, async () => {
      const policy = structuredClone(f.config);
      if (instance === "anthropic") policy.anthropicAccountPool = { enabled: false };
      else policy.providers.anthropic2!.anthropicAccountPool = { enabled: false };
      const response = responseFor(instance, 403);
      const next = await refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
        config: policy, accountId: f.ids[0], canRetry: true, model: f.model,
      });
      expect(next).toBe(f.ids[1]);
      const snapshot = await f.routing.anthropicRoutingFor(instance).getAnthropicPoolAccessSnapshot(next!);
      f.ledger.record({ instance, accountId: next!, token: snapshot.accessToken });
      expect(f.routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(f.ids[0])?.cooldownSource).toBe("default");
      expect(f.routing.anthropicRoutingFor(sibling(instance)).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
      f.ledger.assertNoCrossSend();
    });

    test(`${instance}: late entitlement refusal cannot cool a replacement credential`, async () => {
      const started = anthropicInstanceBarrier();
      const finish = anthropicInstanceBarrier();
      const original = f.store.getAccountCredential(instance, f.ids[0])!;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          started.release(); await finish.wait;
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ error: {
            type: "permission_error", message: "Your account does not have an active subscription.",
          } })));
          controller.close();
        },
      });
      const response = new Response(body, { status: 403 });
      refusal.bindAnthropicRefusalCredential(response, {
        provider: instance, accountId: f.ids[0], accessToken: original.access,
        generation: f.store.credentialGeneration(original),
      }, original.accountId);
      const pending = refusal.rotateAnthropicAccountOnResponseForInstance(instance, response, {
        config: f.config, accountId: f.ids[0], canRetry: true,
      });
      await started.wait;
      await f.store.saveAccountCredential(instance, f.ids[0], { ...original,
        access: `synthetic-${instance}-replaced-access`, refresh: `synthetic-${instance}-replaced-refresh`,
        anthropicIdentity: undefined,
      });
      finish.release();
      expect(await pending).toBeNull();
      for (const pool of INSTANCE_FIXTURE_INSTANCES) expect(f.routing.anthropicRoutingFor(pool).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
    });

    test(`${instance}: remove/re-add of the identical credential retires an unobserved probe`, async () => {
      const own = recovery.anthropicCooldownRecoveryFor(instance);
      const family = f.modelQuota.anthropicModelQuotaFor(instance);
      const id = f.ids[0];
      const original = structuredClone(f.store.getAccountSet(instance)!.accounts[0]!);
      const probe = await own.captureAnthropicCooldownRecoveryProbe(id, original.credential.access);
      expect(probe?.requiresFreshDispatch).toBe(false);
      const generation = own.anthropicCooldownGeneration(id);
      const familyGeneration = family.anthropicFamilyQuotaGeneration(id);
      const other = recovery.anthropicCooldownRecoveryFor(sibling(instance));
      const otherGeneration = other.anthropicCooldownGeneration(id);
      await f.store.mutateStore(auth => {
        auth[instance]!.accounts = auth[instance]!.accounts.filter(row => row.id !== id);
        auth[instance]!.activeAccountId = f.ids[1];
      });
      reconcile(context());
      await f.store.mutateStore(auth => { auth[instance]!.accounts.unshift(original); });
      expect(own.anthropicCooldownGeneration(id)).toBeGreaterThan(generation);
      expect(family.anthropicFamilyQuotaGeneration(id)).toBeGreaterThan(familyGeneration);
      expect(probe?.isCurrent()).toBe(false);
      expect(probe?.isCurrentFamily()).toBe(false);
      expect(probe?.settle({ fiveHourPercent: 0, updatedAt: Date.now() })).toBe("superseded");
      expect(other.anthropicCooldownGeneration(id)).toBe(otherGeneration);
    });

    test(`${instance}: clear retires zero-evidence probes and old leases cannot release replacement observations`, async () => {
      const id = f.ids[0];
      const own = recovery.anthropicCooldownRecoveryFor(instance);
      const family = f.modelQuota.anthropicModelQuotaFor(instance);
      const probe = await own.captureAnthropicCooldownRecoveryProbe(id, f.store.getAccountCredential(instance, id)!.access);
      const generation = own.anthropicCooldownGeneration(id);
      own.clearAnthropicCooldownGenerations();
      family.clearAnthropicFamilyQuota();
      expect(own.anthropicCooldownGeneration(id)).toBeGreaterThan(generation);
      expect(probe?.isCurrent()).toBe(false);
      expect(probe?.isCurrentFamily()).toBe(false);

      const now = Date.now();
      family.observeAnthropicFamilyQuota(id, familyWindow(now - 120_000), now - 120_000);
      const oldRelease = family.claimAnthropicFamilyRevalidation(id, "claude-fable-5", now)!;
      family.clearAnthropicFamilyQuota();
      family.observeAnthropicFamilyQuota(id, familyWindow(now - 120_000), now - 120_000);
      const release = family.claimAnthropicFamilyRevalidation(id, "claude-fable-5", now)!;
      oldRelease();
      expect(family.claimAnthropicFamilyRevalidation(id, "claude-fable-5", now)).toBeNull();
      release();
    });

    test(`${instance}: authoritative usage recovery and publication belong only to its cooldown`, async () => {
      const other = sibling(instance);
      const id = f.ids[0];
      const now = Date.now();
      for (const pool of INSTANCE_FIXTURE_INSTANCES) {
        f.routing.anthropicRoutingFor(pool).recordAnthropicAccountRefusal(f.config, id, 429, null, now, sharedRejection());
        f.modelQuota.anthropicModelQuotaFor(pool).observeAnthropicFamilyQuota(id, familyWindow(now), now);
      }
      const foreignGeneration = recovery.anthropicCooldownRecoveryFor(other).anthropicCooldownGeneration(id);
      const foreignClaim = f.routing.anthropicRoutingFor(other).captureAnthropicCooldownRecovery(id)!;
      const ownClaim = f.routing.anthropicRoutingFor(instance).captureAnthropicCooldownRecovery(id)!;
      // Only instance differs: a numeric coincidence must not confer claim ownership.
      expect(f.routing.anthropicRoutingFor(instance).settleAnthropicCooldownRecovery({ ...ownClaim, instance: other },
        { fiveHourPercent: 10, updatedAt: Date.now() })).toBe("superseded");
      expect(f.routing.anthropicRoutingFor(instance).settleAnthropicCooldownRecovery(foreignClaim,
        { fiveHourPercent: 10, updatedAt: Date.now() })).toBe("superseded");
      const token = f.store.getAccountCredential(instance, id)!.access;
      const result = await recovery.anthropicCooldownRecoveryFor(instance).probeAnthropicQuotaWithRecovery(id, token,
        async fresh => {
          expect(fresh).toBe(true);
          return familyHeaders.markAnthropicFamilyEnumeration({ fiveHourPercent: 10, updatedAt: Date.now() }, true);
        }, () => true);
      expect(result?.instance).toBe(instance);
      expect(result?.isCurrent()).toBe(true);
      expect(f.routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(id)).toBeNull();
      expect(f.modelQuota.anthropicModelQuotaFor(instance).anthropicFamilyRejected(id, "claude-fable-5")).toBe(false);
      expect(f.routing.anthropicRoutingFor(other).getAnthropicAccountHealthSnapshot(id)?.cooldownSource).toBe("reset-derived");
      expect(f.modelQuota.anthropicModelQuotaFor(other).anthropicFamilyRejected(id, "claude-fable-5")).toBe(true);
      expect(recovery.anthropicCooldownRecoveryFor(other).anthropicCooldownGeneration(id)).toBe(foreignGeneration);
    });

    test(`${instance}: late usage after a newer 429 or cache clear cannot publish`, async () => {
      const id = f.ids[0];
      const own = recovery.anthropicCooldownRecoveryFor(instance);
      const token = f.store.getAccountCredential(instance, id)!.access;
      for (const invalidation of ["429", "clear"] as const) {
        const started = anthropicInstanceBarrier();
        const finish = anthropicInstanceBarrier();
        const pending = own.probeAnthropicQuotaWithRecovery(id, token, async () => {
          started.release(); await finish.wait;
          return { fiveHourPercent: 0, updatedAt: Date.now() };
        }, () => true);
        // Attach rejection handling before releasing the deterministic fake upstream.
        const rejected = expect(pending).rejects.toBeInstanceOf(recovery.AnthropicQuotaProbeOwnershipError);
        await started.wait;
        if (invalidation === "429") f.routing.anthropicRoutingFor(instance).recordAnthropicAccountRefusal(f.config, id, 429, null, Date.now(), sharedRejection());
        else cache.clearAccountQuotaCache(instance);
        finish.release();
        await rejected;
      }
    });

    test(`${instance}: newer family evidence survives an older authoritative usage recovery`, async () => {
      const id = f.ids[0];
      const facade = f.routing.anthropicRoutingFor(instance);
      facade.recordAnthropicAccountRefusal(f.config, id, 429, null, Date.now(), sharedRejection());
      const started = anthropicInstanceBarrier();
      const finish = anthropicInstanceBarrier();
      const pending = recovery.anthropicCooldownRecoveryFor(instance).probeAnthropicQuotaWithRecovery(id,
        f.store.getAccountCredential(instance, id)!.access, async () => {
          started.release(); await finish.wait;
          return familyHeaders.markAnthropicFamilyEnumeration({ fiveHourPercent: 12, updatedAt: Date.now() }, true);
        }, () => true);
      await started.wait;
      cache.recordAnthropicAccountQuotaFromHeadersForInstance(instance, id,
        new Headers({ "anthropic-ratelimit-unified-7d_oi-status": "rejected" }),
        sweeper.captureConfigGeneration(), 429, "claude-fable-5");
      finish.release();
      const result = await pending;
      expect(result?.isCurrent()).toBe(true);
      expect(result?.quota.customWindows).toMatchObject([{ label: "Fable", percent: 100, rejected: true }]);
      expect(f.modelQuota.anthropicModelQuotaFor(instance).anthropicFamilyRejected(id, "claude-fable-5")).toBe(true);
      expect(facade.getAnthropicAccountHealthSnapshot(id)).toBeNull();
      expect(f.quota.getCachedProviderAccountQuota(sibling(instance), id)).toBeNull();
    });
  }

  test("instance cache clearing preserves a sibling's pending publication and namespaces flight keys", async () => {
    const id = f.ids[0];
    const a = recovery.anthropicCooldownRecoveryFor("anthropic");
    const b = recovery.anthropicCooldownRecoveryFor("anthropic2");
    expect(a.anthropicCooldownFlightKey("same-base", id)).not.toBe(b.anthropicCooldownFlightKey("same-base", id));
    const probe = await a.captureAnthropicCooldownRecoveryProbe(id, f.store.getAccountCredential("anthropic", id)!.access);
    const legacyEpoch = cache.explicitAccountEpoch;
    cache.clearAccountQuotaCache("anthropic2");
    expect(cache.explicitAccountEpoch).toBe(legacyEpoch);
    expect(probe?.isCurrent()).toBe(true);
  });

  test("renewing the same instance's bearer preserves the pre-refresh flight and fences credential-scoped keys", async () => {
    for (const instance of INSTANCE_FIXTURE_INSTANCES) {
      const id = f.ids[0];
      const own = recovery.anthropicCooldownRecoveryFor(instance);
      const credential = f.store.getAccountCredential(instance, id)!;
      const key = own.anthropicCooldownFlightKey("pre-refresh", id);
      const credentialKey = own.anthropicCredentialQuotaFlightKey("pre-refresh", id);
      const probe = await own.captureAnthropicCooldownRecoveryProbe(id, credential.access);
      const until = Date.now() + 30_000;
      f.ratePolicy.anthropicRatePolicyFor(instance).pauseAnthropicRateAdmission(id, until);
      f.ratePolicy.anthropicRatePolicyFor(sibling(instance)).pauseAnthropicRateAdmission(id, until + 10_000);
      await f.store.saveAccountCredential(instance, id, { ...credential,
        access: `synthetic-${instance}-renewed-access`, refresh: `synthetic-${instance}-renewed-refresh`,
        expires: Date.now() + 3_600_000, anthropicIdentity: undefined,
      });
      expect(own.anthropicCooldownFlightKey("pre-refresh", id)).toBe(key);
      expect(own.anthropicCredentialQuotaFlightKey("pre-refresh", id)).not.toBe(credentialKey);
      expect(probe?.isCurrent()).toBe(false);
      expect(f.ratePolicy.anthropicRatePolicyFor(instance).anthropicRatePauseUntil(id)).toBeUndefined();
      expect(f.ratePolicy.anthropicRatePolicyFor(sibling(instance)).anthropicRatePauseUntil(id)).toBe(until + 10_000);
      const renewed = await own.probeAnthropicQuotaWithRecovery(id, `synthetic-${instance}-renewed-access`,
        async () => ({ fiveHourPercent: 23, updatedAt: Date.now() }), () => true);
      expect(renewed?.isCurrent()).toBe(true);
    }
  });

  test("retry allowance is independent per instance even with the same logical request key", async () => {
    const requestKey = {};
    // Deterministically finish inline waits; no timing-dependent synchronization.
    const timers = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
      queueMicrotask(callback);
      return 0;
    }) as typeof setTimeout);
    try {
      for (const instance of INSTANCE_FIXTURE_INSTANCES) {
        expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, responseFor(instance, 429), {
          config: f.config, accountId: f.ids[0], canRetry: true, requestKey,
        })).toBe(f.ids[0]);
        expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, responseFor(instance, 429), {
          config: f.config, accountId: f.ids[0], canRetry: true, requestKey,
        })).toBeNull();
      }
    } finally { timers.mockRestore(); }
  });

  test("cancellation, ambiguous send and exhausted replay budget remain terminal", async () => {
    for (const instance of INSTANCE_FIXTURE_INSTANCES) {
      const abort = new AbortController(); abort.abort();
      const aborted = responseFor(instance, 429, sharedRejection());
      expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, aborted, {
        config: f.config, accountId: f.ids[0], canRetry: true, signal: abort.signal,
      })).toBeNull();
      const ambiguous = responseFor(instance, 429, sharedRejection());
      retry.markResponseNonReplayable(ambiguous);
      expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, ambiguous, {
        config: f.config, accountId: f.ids[0], canRetry: true,
      })).toBeNull();
      expect(f.routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(f.ids[0])).toBeNull();
      expect(await refusal.rotateAnthropicAccountOnResponseForInstance(instance, responseFor(instance, 403), {
        config: f.config, accountId: f.ids[0], canRetry: false,
      })).toBeNull();
      expect(f.routing.anthropicRoutingFor(instance).getAnthropicAccountHealthSnapshot(f.ids[0])).not.toBeNull();
    }
    expect(f.ledger.sends).toHaveLength(0);
  });

  test("both disk namespaces hydrate/normalize without extending the active probe clock", () => {
    const now = Date.now();
    cache.clearAccountQuotaCache();
    writeFileSync(join(f.paths.OPENCODEX_HOME, "provider-account-quota-cache.json"), JSON.stringify({ version: 1, rows: {
      [cache.accountCacheKey("anthropic", f.ids[0])]: { fiveHourPercent: 81, fiveHourResetAt: now - 1, weeklyPercent: 42, updatedAt: now },
      [cache.accountCacheKey("anthropic2", f.ids[0])]: { fiveHourPercent: 93, fiveHourResetAt: now - 1, weeklyPercent: 17, updatedAt: now },
    } }));
    cache.hydrateAccountQuotaCache();
    expect(f.quota.getCachedProviderAccountQuota("anthropic", f.ids[0])).toMatchObject({ weeklyPercent: 42 });
    expect(f.quota.getCachedProviderAccountQuota("anthropic2", f.ids[0])).toMatchObject({ weeklyPercent: 17 });
    for (const instance of INSTANCE_FIXTURE_INSTANCES) {
      expect(f.quota.getCachedProviderAccountQuota(instance, f.ids[0])?.fiveHourPercent).toBeUndefined();
      expect(cache.accountQuotaCache.get(cache.accountCacheKey(instance, f.ids[0]))?.ts).toBe(0);
    }
    expect(cache.sweepExpiredProviderAccountQuotaRows(now)).toBe(0);
  });
});
