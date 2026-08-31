import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claimQuotaRecovery,
  quotaRecoveryRecordForTests,
  releaseQuotaRecovery,
  resetQuotaRecoveryForTests,
  settleQuotaRecovery,
  sweepExpiredQuotaRecovery,
} from "../src/codex/quota-401-recovery";
import {
  CODEX_REFRESH_FLIGHT_CEILING_MS,
  QUOTA_RECOVERY_LEASE_MS,
  WHAM_REQUEST_TIMEOUT_MS,
} from "../src/codex/quota-recovery-timing";

/**
 * The budget that keeps a WHAM 401 recovery from becoming a retry loop (#3019).
 *
 * These call the store directly. The rule they encode — one refresh per credential lineage,
 * and a stale completion may never spend somebody else's claim — is not observable from the
 * quota path's source text, which is where earlier attempts at this went wrong.
 */

const ACCOUNT = "acct-1";

beforeEach(() => resetQuotaRecoveryForTests());
afterEach(() => resetQuotaRecoveryForTests());

describe("claim identity", () => {
  test("a claim is granted once per lineage and refused after it is spent", () => {
    const first = claimQuotaRecovery(ACCOUNT, 7);
    expect(first.granted).toBe(true);
    if (!first.granted) return;
    settleQuotaRecovery(ACCOUNT, first.claimId, { provenance: "self-refresh", generation: 8 });

    // The refresh moved 7 -> 8, so 8 is what is fenced: a successful token response can
    // rotate only the refresh grant, so the rejected generation is already stale.
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toEqual({ state: "spent", lineage: 8 });
    expect(claimQuotaRecovery(ACCOUNT, 8)).toEqual({ granted: false, reason: "spent" });
  });

  test("a live claim blocks every other lineage, not just its own", () => {
    const held = claimQuotaRecovery(ACCOUNT, 7);
    expect(held.granted).toBe(true);
    // The refresh this claim fences commits 7 -> 8 BEFORE it can settle. Granting an 8
    // claim in that window would leave the late settlement landing on nothing, and 8
    // unspent (#3019).
    expect(claimQuotaRecovery(ACCOUNT, 8)).toEqual({ granted: false, reason: "in-flight" });
    expect(claimQuotaRecovery(ACCOUNT, 7)).toEqual({ granted: false, reason: "in-flight" });
  });

  test("a stale settlement cannot spend a later claimant's budget", () => {
    const first = claimQuotaRecovery(ACCOUNT, 7);
    expect(first.granted).toBe(true);
    if (!first.granted) return;
    releaseQuotaRecovery(ACCOUNT, first.claimId, 1_000);

    const second = claimQuotaRecovery(ACCOUNT, 7, Date.now() + 2_000);
    expect(second.granted).toBe(true);
    if (!second.granted) return;
    expect(second.claimId).not.toBe(first.claimId);

    // The first caller finally completes. Lineage alone could not tell it from the second
    // claimant, and it would have spent a budget it no longer owns.
    settleQuotaRecovery(ACCOUNT, first.claimId, { provenance: "self-refresh", generation: 8 });
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toMatchObject({ state: "claimed", claimId: second.claimId });
  });

  test("settling or releasing without a claim is a no-op", () => {
    settleQuotaRecovery(ACCOUNT, "never-issued", { provenance: "self-refresh", generation: 8 });
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toBeUndefined();
    releaseQuotaRecovery(ACCOUNT, "never-issued", 1_000);
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toBeUndefined();
  });
});

describe("settlement by outcome", () => {
  test("a joined lineage spends the returned generation, like a self-refresh", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    // Joining an in-flight refresh of the same grant IS this lineage's one attempt.
    settleQuotaRecovery(ACCOUNT, claim.claimId, { provenance: "joined-lineage", generation: 8 });
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toEqual({ state: "spent", lineage: 8 });
  });

  test("an external replacement spends the OLD lineage and leaves the new one free", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    settleQuotaRecovery(ACCOUNT, claim.claimId, { provenance: "external-replacement", generation: 9 });

    // 7 used its attempt. 9 is somebody else's fresh grant and has had none — fencing it
    // would deny the new credential the recovery this exists to grant.
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toEqual({ state: "spent", lineage: 7 });
    expect(claimQuotaRecovery(ACCOUNT, 9).granted).toBe(true);
  });

  test("external replacement with an unrotated token still frees the returned lineage", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    // rotated:false means the caller does not replay; it does not change who owes what.
    settleQuotaRecovery(ACCOUNT, claim.claimId, { provenance: "external-replacement", generation: 9 });
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toEqual({ state: "spent", lineage: 7 });
    expect(claimQuotaRecovery(ACCOUNT, 9).granted).toBe(true);
  });
});

describe("failure handling", () => {
  test("a transient failure backs off instead of restoring eligibility", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    const now = Date.now();
    releaseQuotaRecovery(ACCOUNT, claim.claimId, 60_000, now);

    // A failed quota request does not refresh the quota timestamp, so immediate polls would
    // otherwise each issue another token refresh — the loop, from the other side.
    expect(claimQuotaRecovery(ACCOUNT, 7, now + 1)).toEqual({ granted: false, reason: "backoff" });
    expect(claimQuotaRecovery(ACCOUNT, 7, now + 60_001).granted).toBe(true);
  });

  test("a new lineage is not held by the old lineage's backoff", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    const now = Date.now();
    releaseQuotaRecovery(ACCOUNT, claim.claimId, 60_000, now);
    // A replacement credential has had no attempt and no failure of its own.
    expect(claimQuotaRecovery(ACCOUNT, 8, now + 1).granted).toBe(true);
  });
});

describe("lease and sweep", () => {
  test("an abandoned lease is reclaimable but never becomes spent", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    const expired = Date.now() + QUOTA_RECOVERY_LEASE_MS + 1;

    // The caller died between claim and settle. The refresh may never have happened, so
    // promoting this to spent would deny a real attempt.
    expect(claimQuotaRecovery(ACCOUNT, 7, expired).granted).toBe(true);
    expect(quotaRecoveryRecordForTests(ACCOUNT)?.state).toBe("claimed");
  });

  test("the sweep drops leases and backoff but never a spent fence", () => {
    const claim = claimQuotaRecovery(ACCOUNT, 7);
    if (!claim.granted) throw new Error("expected a claim");
    settleQuotaRecovery(ACCOUNT, claim.claimId, { provenance: "self-refresh", generation: 8 });
    // Expiring a spent record would hand the same lineage another refresh.
    expect(sweepExpiredQuotaRecovery(Date.now() + 10 * QUOTA_RECOVERY_LEASE_MS)).toBe(0);
    expect(quotaRecoveryRecordForTests(ACCOUNT)).toEqual({ state: "spent", lineage: 8 });

    resetQuotaRecoveryForTests();
    const stale = claimQuotaRecovery("acct-2", 3);
    if (!stale.granted) throw new Error("expected a claim");
    expect(sweepExpiredQuotaRecovery(Date.now() + QUOTA_RECOVERY_LEASE_MS + 1)).toBe(1);
    expect(quotaRecoveryRecordForTests("acct-2")).toBeUndefined();
  });

  test("one record per account, so lineage churn cannot accumulate", () => {
    // Each cycle: a lineage takes a 401, refreshes once, and something external then moves
    // the credential on — a login, another lane's refresh. The record is REPLACED, not
    // appended, so 25 rounds leave exactly one row.
    let lineage = 1;
    for (let round = 0; round < 25; round += 1) {
      const claim = claimQuotaRecovery(ACCOUNT, lineage);
      if (!claim.granted) throw new Error(`expected a claim for lineage ${lineage}`);
      const refreshedTo = lineage + 1;
      settleQuotaRecovery(ACCOUNT, claim.claimId, { provenance: "self-refresh", generation: refreshedTo });
      expect(quotaRecoveryRecordForTests(ACCOUNT)).toEqual({ state: "spent", lineage: refreshedTo });
      // That lineage has spent its one attempt, and stays refused however long this runs.
      expect(claimQuotaRecovery(ACCOUNT, refreshedTo)).toEqual({ granted: false, reason: "spent" });
      lineage = refreshedTo + 1;
    }
  });
});

describe("the lease is derived from what it covers", () => {
  test("it outlasts the longest admitted flight plus both quota legs", () => {
    // Derived from the same constants the refresh and the WHAM request use, not restated:
    // a restated number is how a lease drifts shorter than the flight it fences, and a
    // lease that expires mid-refresh admits a second claim for a lineage already refreshing.
    expect(QUOTA_RECOVERY_LEASE_MS).toBeGreaterThan(CODEX_REFRESH_FLIGHT_CEILING_MS + WHAM_REQUEST_TIMEOUT_MS);
    expect(QUOTA_RECOVERY_LEASE_MS).toBe(CODEX_REFRESH_FLIGHT_CEILING_MS + WHAM_REQUEST_TIMEOUT_MS * 2);
  });
});
