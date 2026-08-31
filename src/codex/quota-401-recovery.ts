import { randomUUID } from "node:crypto";
import { isCodexAccountGenerationLive, type CodexRefreshProvenance } from "./account-store";
import { QUOTA_RECOVERY_LEASE_MS } from "./quota-recovery-timing";

/**
 * One refresh-and-replay per credential lineage, for a WHAM 401 (#3019).
 *
 * A bare 401 from `backend-api/wham/usage` is what a stale-but-refreshable bearer produces
 * after a plan change, so quarantining on it tells the operator to re-authenticate an
 * account that was fine. The fix is to refresh and replay once — and `once` is the whole
 * problem, because an unbounded retry against an upstream 401 is a self-inflicted
 * credential-stuffing loop.
 *
 * ## Why a claim id rather than the lineage
 *
 * Keying the budget on the lineage cannot separate an old claimant from a later retry on
 * the same lineage: claim L, a transient failure releases L, another poll claims L, and
 * the first caller's late settlement spends the second caller's claim. The claim id makes
 * every mutation a compare-and-set on `(accountId, lineage, claimId)`, so a stale
 * completion is a no-op instead of somebody else's budget.
 *
 * ## Why `spent` never expires and `claimed` does
 *
 * Expiring a spent record would hand the same lineage another refresh, which is exactly
 * the property this module exists to hold. But a caller can be cancelled or die between
 * claim and settle, so `claimed` carries a bounded lease: an expired lease is reclaimable,
 * and is never promoted to `spent` because the refresh may not have happened.
 */

export type RecoveryRecord =
  | { state: "claimed"; lineage: number; claimId: string; expiresAt: number }
  /**
   * `terminal` marks a lineage whose refresh proved the grant is dead. It is spent AND the
   * account must keep reporting needs-reauth: without it, the next bare 401 finds the
   * budget used, reports transient, and a dead credential looks healthy.
   */
  | { state: "spent"; lineage: number; terminal?: true }
  | { state: "backoff"; lineage: number; nextAttemptAt: number };

export type ClaimResult =
  | { granted: true; claimId: string }
  | { granted: false; reason: "spent" | "in-flight" | "backoff" };

const records = new Map<string, RecoveryRecord>();

function leaseExpired(record: RecoveryRecord, now: number): boolean {
  return record.state === "claimed" && record.expiresAt <= now;
}

/**
 * Claim the one refresh this lineage is entitled to.
 *
 * A live claim blocks EVERY lineage for the account, not just its own. The refresh it
 * fences commits `G -> G+1` before the claimant can settle, so during that window a
 * `G+1` claim would otherwise be granted and the late settlement would land on nothing.
 */
export function claimQuotaRecovery(
  accountId: string,
  lineage: number,
  now: number = Date.now(),
): ClaimResult {
  const existing = records.get(accountId);
  if (existing && !leaseExpired(existing, now)) {
    if (existing.state === "claimed") return { granted: false, reason: "in-flight" };
    if (existing.state === "spent") {
      // Only this lineage is fenced. A different one is a new grant with its own budget.
      if (existing.lineage === lineage) return { granted: false, reason: "spent" };
    } else if (existing.lineage === lineage && existing.nextAttemptAt > now) {
      return { granted: false, reason: "backoff" };
    }
  }
  const claimId = randomUUID();
  records.set(accountId, { state: "claimed", lineage, claimId, expiresAt: now + QUOTA_RECOVERY_LEASE_MS });
  return { granted: true, claimId };
}

function heldClaim(accountId: string, claimId: string): Extract<RecoveryRecord, { state: "claimed" }> | null {
  const existing = records.get(accountId);
  if (!existing || existing.state !== "claimed" || existing.claimId !== claimId) return null;
  return existing;
}

/**
 * Record the outcome of a claimed refresh.
 *
 * Which lineage gets fenced depends on the outcome, and getting this backwards is how a
 * fresh credential loses the recovery it is entitled to:
 *
 * - `self-refresh` and `joined-lineage` are this lineage's own attempt, so the RETURNED
 *   generation is spent. The returned one, never the rejected one: a successful token
 *   response can rotate only the refresh grant, leaving the access token byte-identical,
 *   and the credential has already moved by then.
 * - `external-replacement` means somebody else's credential is now stored. The claimed
 *   OLD lineage is spent — this caller did use its attempt — and the returned generation
 *   is left untouched so it can claim on its own next 401.
 */
export function settleQuotaRecovery(
  accountId: string,
  claimId: string,
  outcome: { provenance: CodexRefreshProvenance; generation: number },
): void {
  const held = heldClaim(accountId, claimId);
  if (!held) return; // superseded or already settled: never disturb a newer claimant
  const fenced = outcome.provenance === "external-replacement" ? held.lineage : outcome.generation;
  records.set(accountId, { state: "spent", lineage: fenced });
}

/**
 * Record a refresh that failed with proof the grant itself is dead.
 *
 * Distinct from {@link releaseQuotaRecovery}: a revoked or expired grant will not become
 * valid on the next poll, so backing off would let a later 401 report the account healthy
 * while it is not. The lineage is fenced durably and the caller quarantines.
 */
export function settleQuotaRecoveryTerminal(accountId: string, claimId: string): void {
  const held = heldClaim(accountId, claimId);
  if (!held) return;
  records.set(accountId, { state: "spent", lineage: held.lineage, terminal: true });
}

/** Did this lineage's one refresh prove the grant dead? */
export function quotaRecoveryTerminalFor(accountId: string, lineage: number): boolean {
  const record = records.get(accountId);
  return record?.state === "spent" && record.lineage === lineage && record.terminal === true;
}

/**
 * Release a claim whose refresh failed without proving anything about the credential.
 *
 * Into BACKOFF, not into eligibility: a failed quota request does not refresh the quota
 * timestamp, so successive dashboard and background polls would each issue another token
 * refresh — the loop, reopened from the other side.
 */
export function releaseQuotaRecovery(
  accountId: string,
  claimId: string,
  backoffMs: number,
  now: number = Date.now(),
): void {
  const held = heldClaim(accountId, claimId);
  if (!held) return;
  records.set(accountId, { state: "backoff", lineage: held.lineage, nextAttemptAt: now + backoffMs });
}

/**
 * Drop records for accounts that no longer exist, and fences whose credential has moved.
 *
 * A live claim is exempt. Its refresh commits the generation forward, so "the fenced
 * generation is no longer stored" is the EXPECTED state mid-flight, and removing it there
 * would let a second claim in before the first settles.
 */
export function reconcileQuotaRecovery(liveAccountIds: ReadonlySet<string>, now: number = Date.now()): number {
  let removed = 0;
  for (const [accountId, record] of [...records]) {
    if (!liveAccountIds.has(accountId)) {
      records.delete(accountId);
      removed += 1;
      continue;
    }
    if (record.state === "claimed" && !leaseExpired(record, now)) continue;
    if (!isCodexAccountGenerationLive(accountId, record.lineage)) {
      records.delete(accountId);
      removed += 1;
    }
  }
  return removed;
}

/** Drop expired backoff windows and abandoned leases. */
export function sweepExpiredQuotaRecovery(now: number = Date.now()): number {
  let removed = 0;
  for (const [accountId, record] of [...records]) {
    // A spent record is durable: expiring it would grant the same lineage another refresh.
    if (record.state === "spent") continue;
    const stale = record.state === "backoff" ? record.nextAttemptAt <= now : leaseExpired(record, now);
    if (stale) {
      records.delete(accountId);
      removed += 1;
    }
  }
  return removed;
}

export function quotaRecoveryRecordForTests(accountId: string): RecoveryRecord | undefined {
  return records.get(accountId);
}

export function resetQuotaRecoveryForTests(): void {
  records.clear();
}
