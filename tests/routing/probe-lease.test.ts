import { afterEach, describe, expect, test } from "bun:test";
import {
  canAcquireTransientProbe,
  clearTransientProbeLeasesForTests,
  configureSharedPoolBackpressure,
  createPoolBackpressureLimiter,
  invalidateTransientProbe,
  releaseTransientProbe,
  resetSharedPoolBackpressureForTests,
  resolveHeldAccountDispatch,
  settleTransientProbe,
  sharedPoolBackpressure,
  transientProbeDiagnostics,
  tryAcquireTransientProbe,
  TRANSIENT_PROBE_INTERVAL_MS,
} from "../../src/routing/probe-lease";

afterEach(() => {
  clearTransientProbeLeasesForTests();
  resetSharedPoolBackpressureForTests();
});

describe("transient probe lease", () => {
  test("a held account admits exactly one in-flight probe", () => {
    const now = 1_000_000;
    const first = tryAcquireTransientProbe("acct-a", now);
    expect(first).not.toBeNull();
    // Everyone else is refused while the holder is out.
    expect(tryAcquireTransientProbe("acct-a", now)).toBeNull();
    expect(canAcquireTransientProbe("acct-a", now)).toBe(false);
    // A different account is a different lease domain.
    expect(tryAcquireTransientProbe("acct-b", now)).not.toBeNull();
  });

  test("a settled lease frees the account after the pacing interval", () => {
    const now = 1_000_000;
    const lease = tryAcquireTransientProbe("acct-a", now)!;
    expect(settleTransientProbe(lease, "failed", now + 5)).toBe("applied");
    // Settling is not a license to probe again immediately -- the interval paces retries.
    expect(tryAcquireTransientProbe("acct-a", now + 10)).toBeNull();
    expect(tryAcquireTransientProbe("acct-a", now + TRANSIENT_PROBE_INTERVAL_MS)).not.toBeNull();
  });

  test("a late result from a replaced lease is stale and mutates nothing", () => {
    const now = 1_000_000;
    const first = tryAcquireTransientProbe("acct-a", now, { leaseMs: 100, minIntervalMs: 0 })!;
    // The first lease lapses and a second probe is issued under a new epoch.
    const second = tryAcquireTransientProbe("acct-a", now + 200, { leaseMs: 100, minIntervalMs: 0 })!;
    expect(second.generation).toBe(first.generation + 1);
    // The late answer must not overwrite the newer lease or record an outcome.
    expect(settleTransientProbe(first, "recovered", now + 250)).toBe("stale");
    const diag = transientProbeDiagnostics("acct-a", now + 250);
    expect(diag.leaseId).toBe(second.leaseId);
    expect(diag.lastOutcome).toBeUndefined();
    // The live holder still settles normally.
    expect(settleTransientProbe(second, "recovered", now + 260)).toBe("applied");
    expect(transientProbeDiagnostics("acct-a", now + 260).lastOutcome).toBe("recovered");
  });

  test("a result after the lease deadline is expired, not applied", () => {
    const now = 1_000_000;
    const lease = tryAcquireTransientProbe("acct-a", now, { leaseMs: 100 })!;
    expect(settleTransientProbe(lease, "recovered", now + 101)).toBe("expired");
  });

  test("invalidation fences the epoch so an outstanding probe cannot overwrite newer state", () => {
    const now = 1_000_000;
    const lease = tryAcquireTransientProbe("acct-a", now)!;
    // A newer failure (or a moved binding) lands through the ordinary path.
    invalidateTransientProbe("acct-a");
    expect(settleTransientProbe(lease, "recovered", now + 1)).toBe("stale");
    expect(transientProbeDiagnostics("acct-a", now + 1).held).toBe(false);
  });

  test("release hands back a probe that never reached upstream", () => {
    const now = 1_000_000;
    const lease = tryAcquireTransientProbe("acct-a", now, { minIntervalMs: 0 })!;
    releaseTransientProbe(lease);
    expect(canAcquireTransientProbe("acct-a", now, { minIntervalMs: 0 })).toBe(true);
    // Releasing someone else's lease is a no-op.
    releaseTransientProbe({ ...lease, leaseId: "forged" });
  });
});

describe("held account dispatch", () => {
  test("one caller probes while the rest keep the remembered detour", () => {
    const now = 1_000_000;
    const limiter = createPoolBackpressureLimiter();
    const first = resolveHeldAccountDispatch({
      boundAccountId: "acct-a",
      detourAccountId: "acct-b",
      now,
      backpressure: limiter,
    });
    expect(first.kind).toBe("probe");
    const second = resolveHeldAccountDispatch({
      boundAccountId: "acct-a",
      detourAccountId: "acct-b",
      now,
      backpressure: limiter,
    });
    // The detour is not forgotten during probing: a failed trial must not cost
    // the caller its working route.
    expect(second).toEqual({ kind: "detour", accountId: "acct-b" });
  });

  test("every candidate held yields a withheld outcome, never a send", () => {
    const now = 1_000_000;
    const limiter = createPoolBackpressureLimiter();
    // Spend the single probe so this caller has no trial available.
    resolveHeldAccountDispatch({ boundAccountId: "acct-a", now, backpressure: limiter });
    const outcome = resolveHeldAccountDispatch({ boundAccountId: "acct-a", now, backpressure: limiter });
    expect(outcome.kind).toBe("withheld");
    if (outcome.kind === "withheld") {
      expect(outcome.boundAccountId).toBe("acct-a");
      expect(outcome.retryAt).toBeGreaterThan(now);
    }
  });

  test("a refused probe falls back to the detour, then to withheld", () => {
    const now = 1_000_000;
    // Zero-allowance limiter: recovery budget is spent, so no probe may go out.
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000,
      maxRetryRatio: 0,
      minRecoveryAllowance: 0,
    });
    const withDetour = resolveHeldAccountDispatch({
      boundAccountId: "acct-a",
      detourAccountId: "acct-b",
      now,
      backpressure: limiter,
    });
    expect(withDetour).toEqual({ kind: "detour", accountId: "acct-b" });
    const noDetour = resolveHeldAccountDispatch({
      boundAccountId: "acct-a",
      now,
      backpressure: limiter,
    });
    expect(noDetour.kind).toBe("withheld");
  });
});

describe("pool-wide backpressure", () => {
  test("the initial send of a new request is never refused", () => {
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000,
      maxRetryRatio: 0,
      minRecoveryAllowance: 0,
    });
    // Even with a zero recovery budget, initials are recorded, not gated.
    for (let i = 0; i < 100; i++) limiter.recordInitialSend(i);
    expect(limiter.state(100).initialSends).toBe(100);
  });

  test("recovery dispatches are capped by the ratio of observed initials", () => {
    const now = 1_000_000;
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000,
      maxRetryRatio: 0.2,
      minRecoveryAllowance: 0,
    });
    for (let i = 0; i < 10; i++) limiter.recordInitialSend(now);
    // 20% of 10 initials admits exactly 2 recovery dispatches, shared by retries and probes.
    expect(limiter.tryPermitRetryDispatch(now)).toBe(true);
    expect(limiter.tryPermitProbeDispatch(now)).toBe(true);
    expect(limiter.tryPermitRetryDispatch(now)).toBe(false);
    const state = limiter.state(now);
    expect(state.recoveryDispatches).toBe(2);
    expect(state.allowance).toBe(2);
    expect(state.refusedTotal).toBe(1);
  });

  test("the floor keeps a quiet pool recoverable", () => {
    const now = 1_000_000;
    const limiter = createPoolBackpressureLimiter();
    // No initials at all: the minimum allowance still admits bounded recovery.
    expect(limiter.tryPermitProbeDispatch(now)).toBe(true);
    expect(limiter.tryPermitRetryDispatch(now)).toBe(true);
    expect(limiter.tryPermitRetryDispatch(now)).toBe(true);
    expect(limiter.tryPermitRetryDispatch(now)).toBe(false);
  });

  test("the window slides: old sends stop funding new retries", () => {
    const limiter = createPoolBackpressureLimiter({
      windowMs: 10_000,
      maxRetryRatio: 0.5,
      minRecoveryAllowance: 0,
    });
    const t0 = 1_000_000;
    for (let i = 0; i < 10; i++) limiter.recordInitialSend(t0);
    expect(limiter.tryPermitRetryDispatch(t0)).toBe(true);
    // A window later the initials have rotated out; the burst no longer funds retries.
    const t1 = t0 + 11_000;
    expect(limiter.state(t1).initialSends).toBe(0);
    expect(limiter.tryPermitRetryDispatch(t1)).toBe(false);
  });

  test("the shared limiter is configurable and reports its state", () => {
    configureSharedPoolBackpressure({ windowMs: 5_000, maxRetryRatio: 1, minRecoveryAllowance: 0 });
    const limiter = sharedPoolBackpressure();
    limiter.recordInitialSend(1_000_000);
    expect(limiter.tryPermitRetryDispatch(1_000_000)).toBe(true);
    const state = limiter.state(1_000_000);
    expect(state.windowMs).toBe(5_000);
    expect(state.ratioLimit).toBe(1);
  });
});
