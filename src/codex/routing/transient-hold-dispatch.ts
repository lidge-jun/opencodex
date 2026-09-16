import { isCodexAccountGenerationLive } from "../account-store";
// From `../account-id`, which declares the constant and imports nothing, rather than from
// `../main-account`, which re-exports it and sits inside the routing/account-lifecycle import
// cycle. Neither reference here runs at module load, but a leaf import keeps this module out of
// that cycle entirely instead of relying on that staying true.
import { MAIN_CODEX_ACCOUNT_ID } from "../account-id";
import {
  invalidateTransientProbe,
  releaseTransientProbe,
  resolveHeldAccountDispatch,
  settleTransientProbe,
} from "../../routing/probe-lease";
import {
  CODEX_TRANSIENT_AFFINITY_HOLD_MS,
  type CodexThreadResolution,
  type ThreadAffinityEntry,
  type TransientProbeGrant,
} from "./thread-affinity";
import type { CodexUpstreamOutcomeClass, CodexUpstreamOutcomeMeta } from "./cooldown-math";

/**
 * What a request bound to a HELD account may actually do, and how its trial ends (#4701).
 *
 * The transient hold (#4546) keeps a thread's binding while its own account serves a 5xx
 * streak and detours the request to a healthy sibling. Both of the selector's hold branches
 * used to end the same way when no sibling could take it: they returned the held account as
 * `selected`, and the caller sent at an account already known to be failing. Under a
 * provider-wide 503 that is every bound request at once -- the amplification the hold exists
 * to prevent rather than cause.
 *
 * This module is the seam between the selector and the bounded answer in
 * `src/routing/probe-lease.ts`. It is separate from `./probe-lease` in this same directory,
 * which is the unrelated QUOTA-COOLDOWN lease; the two govern different domains and must never
 * settle each other's probe.
 */

/** Has a held binding waited longer than a transient failure can reasonably explain? */
export function isTransientHoldExpired(entry: ThreadAffinityEntry, now: number): boolean {
  return entry.transientHoldSince !== undefined
    && now - entry.transientHoldSince > CODEX_TRANSIENT_AFFINITY_HOLD_MS;
}

/**
 * Where a request bound to a held account goes this turn.
 *
 * {@link resolveHeldAccountDispatch} bounds the answer: one probe tests the held account, and a
 * caller with nowhere else to go is WITHHELD and told when to come back rather than sent at the
 * failure.
 *
 * A usable detour is taken BEFORE that resolver is consulted, which inverts its own probe-first
 * ordering. Deliberately: a healthy sibling is always a better answer for a live request than an
 * account carrying a failure streak, and turning the first request after a hold into the trial
 * would spend a real user's turn on it. The ordering is not what #4701 bounds -- the defect is
 * the third answer the selector used to give, "send at the failing account anyway", and that is
 * reached only when no detour exists. Recovery is still discovered there, because that is
 * exactly the case where nothing else can find out.
 *
 * The caller has already committed `transientHoldSince`/`lastUsedAt`; this decides only where
 * the request goes. A withheld answer deliberately leaves `transientDetourAccountId` alone:
 * being unable to send right now says nothing about which sibling was serving this thread.
 */
export function resolveTransientHoldDispatch(
  entry: ThreadAffinityEntry,
  detour: string | null,
  now: number,
): CodexThreadResolution {
  if (detour !== null && detour !== entry.accountId) {
    entry.transientDetourAccountId = detour;
    // Deliberately no promotion and no rebind: this is one request routing around a blip, not
    // the pool deciding where the conversation now lives.
    return { status: "selected", accountId: detour, affinity: { move: "detour", reason: "transient" } };
  }
  const dispatch = resolveHeldAccountDispatch({ boundAccountId: entry.accountId, now });
  if (dispatch.kind === "probe") {
    return {
      status: "selected",
      accountId: entry.accountId,
      affinity: { move: "held", reason: "transient" },
      // The credential generation travels with the lease so a settle can refuse an answer about
      // a credential this binding no longer has. See {@link TransientProbeGrant}.
      transientProbe: { lease: dispatch.lease, affinityGeneration: entry.generation },
    };
  }
  if (dispatch.kind === "withheld") {
    return {
      status: "withheld",
      accountId: dispatch.boundAccountId,
      retryAt: dispatch.retryAt,
      // The remembered sibling, when there is one. It is unusable right now -- that is why this
      // request is refused -- but it is what has been serving this thread, and a refusal that
      // dropped it would make the next resolve re-pick cold.
      ...(entry.transientDetourAccountId !== undefined
        ? { detourAccountId: entry.transientDetourAccountId }
        : {}),
      affinity: { move: "held", reason: "transient" },
    };
  }
  // Unreachable: no detour was handed in, so the resolver has none to hand back. Kept total
  // rather than cast away, because the cost of being wrong here is a send at a failing account.
  entry.transientDetourAccountId = dispatch.accountId;
  return { status: "selected", accountId: dispatch.accountId, affinity: { move: "detour", reason: "transient" } };
}

/** Does the credential a probe was granted against still exist at that generation? */
function transientProbeCredentialLive(accountId: string, generation: number): boolean {
  if (accountId === MAIN_CODEX_ACCOUNT_ID) return generation === 0;
  return isCodexAccountGenerationLive(accountId, generation);
}

/**
 * Conclude the half-open recovery probe this request was holding.
 *
 * Three answers, because three things can be true of a probe that just ended:
 *
 * - The credential moved under it. Its result describes an identity the binding no longer has,
 *   so the epoch is BURNED instead of settled -- invalidating makes every outstanding lease on
 *   this account stale at once, which is what stops a late answer from reviving a dead account.
 * - The answer says nothing about the account. A 3xx, a 400, or an unclassifiable status is the
 *   request's problem, not the account's, so the lease is handed back unspent and the next
 *   request may run a real trial instead of waiting out a recovery nobody observed.
 * - Otherwise it is evidence: success means recovered, everything else means still failing.
 *
 * A no-op when this request held no trial, so the outcome recorder calls it unconditionally.
 */
export function settleTransientProbeForOutcome(
  accountId: string,
  meta: Pick<CodexUpstreamOutcomeMeta, "transientProbe" | "now">,
  outcomeClass: CodexUpstreamOutcomeClass,
): void {
  const grant: TransientProbeGrant | undefined = meta.transientProbe;
  if (!grant) return;
  if (!transientProbeCredentialLive(accountId, grant.affinityGeneration)) {
    invalidateTransientProbe(accountId);
    return;
  }
  if (outcomeClass === "neutral" || outcomeClass === "caller" || outcomeClass === "unknown") {
    releaseTransientProbe(grant.lease);
    return;
  }
  settleTransientProbe(grant.lease, outcomeClass === "success" ? "recovered" : "failed", meta.now ?? Date.now());
}
