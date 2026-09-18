import type { ResponsesRequestContext } from "./core-options";
import { createRequestExecutionBudget, isRequestExecutionBudget } from "../../lib/request-execution-budget";
import { chargeWorkflowSends, workflowSendCeilingReached } from "../../lib/workflow-budget";
import { workflowRefusalResponse } from "../workflow-refusal";
import type { AttemptRecoveryKind } from "../../usage/log";
import { noteAttemptSend } from "../request-log";
import { TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../lib/upstream-retry";
import type {
  DispatchDecision,
  DispatchIntent,
  RequestExecutionBudget,
  SendClass,
  SingleUseDispatchPermit,
} from "../../lib/request-execution-budget";

/**
 * The transient-5xx ladder cap for ONE leg, given the provider's configured request total.
 *
 * `remainingTransientSendBudget(cap)` treats `cap` as a ceiling on what REMAINS, which is the
 * right shape for the fixed constant: every leg may ask for up to three, and the request-wide
 * base allowance is what actually bounds the total. A configured `transientRetryOn5xx.attempts`
 * is documented as the total for one request including the first send, so it has to be reduced
 * by what the request already sent before it is intersected with that allowance. Passing it
 * straight through would make it a per-leg ceiling instead, and a request configured at one send
 * could still reach upstream again on a recovery leg (#4893).
 *
 * An absent policy returns the constant unchanged, so a provider that configures nothing behaves
 * exactly as it does today at every call site.
 */
export function transientSendCapFor(
  configuredAttempts: number | undefined,
  sendsUsed: number,
): number {
  if (configuredAttempts === undefined) return TRANSIENT_RETRY_MAX_ATTEMPTS;
  return Math.max(0, configuredAttempts - Math.max(0, sendsUsed));
}

/** Owns the shared request send counter and recovery permits. */
export function createResponsesSendBudget(
  requestContext: Pick<ResponsesRequestContext, "options" | "req" | "logCtx">,
) {
  const { options, req, logCtx } = requestContext;


  // One transient-retry budget for the whole LOGICAL request, read ABOVE the passthrough branch
  // so that branch shares it too. It used to be a local declared below, which put it in the
  // temporal dead zone for the passthrough sends and left each recovery leg taking the helper's
  // fresh default of 3. It is now a holder carried on options, so a combo child inherits the
  // parent's spend instead of starting over per target -- both halves of the measured
  // amplification in #4546.
  const sendBudget = options.sendBudget ?? createRequestExecutionBudget();
  // The root workflow is the user-visible task. A per-request cap cannot bound a fan-out that
  // sends once per child seven hundred times, so every send charged to the request is charged
  // to the root as well (#4546).
  const workflowRootId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const noteTransientSends = (used: number): void => {
    const charged = Math.max(0, used);
    sendBudget.used += charged;
    chargeWorkflowSends(workflowRootId, charged);
  };
  // Refused before any dispatch, and deliberately not by evicting the root's ledger entry:
  // dropping the record to make room would hand the fan-out a fresh allowance, which is the
  // laundering this ceiling exists to stop. The client is told the task needs a new grant
  // rather than being given a synthetic upstream error.
  if (workflowSendCeilingReached(workflowRootId)) {
    // A log context exists here, unlike at HTTP admission, so the row this request writes is
    // marked synthetic rather than reading as a request that vanished with zero sends.
    return workflowRefusalResponse("workflow-sends-exhausted", logCtx, undefined, workflowRootId);
  }
  // No floor. Math.max(1, ...) meant an exhausted request still funded one send on every
  // recovery leg, so a bounded per-leg allowance never became a bounded per-request one.
  const remainingTransientSendBudget = (budget: number): number =>
    isRequestExecutionBudget(sendBudget)
      ? sendBudget.remainingBaseSends(budget)
      : Math.max(0, budget - sendBudget.used);
  // The adapter contract needs the full budget, not just the counter. options.sendBudget is
  // typed as the narrow holder so a caller that predates this can still pass one, so narrow it
  // once here rather than asserting at each adapter call site.
  const adapterSendBudget = isRequestExecutionBudget(sendBudget) ? sendBudget : undefined;
  /**
   * Records an adapter's OWN inner retries against this attempt.
   *
   * Ordinal 1 is the send each call site already recorded through `noteRoutedAttemptSend`, so only
   * the extra physical sends are added here and an adapter that does not retry internally
   * leaves its log byte-for-byte as it was. Kiro reaches roughly eighteen sends per call and
   * Cursor re-sends a whole turn, and both reported one; a count that cannot be observed
   * cannot be pinned by a regression, which is why the instrumentation precedes the cap.
   */
  const noteAdapterPhysicalSend = (
    inputTokens: number | undefined,
    send: { ordinal: number; recovery?: AttemptRecoveryKind },
  ): void => {
    if (send.ordinal <= 1) return;
    noteAttemptSend(logCtx.activeAttempt, inputTokens, send.recovery);
  };
  /**
   * Whether this request has any base send left under `cap`.
   *
   * The cap is a parameter because a lane that reads a provider's configured
   * `transientRetryOn5xx` ladder has to ask this question at the SAME cap its sends use.
   * Asking at the constant while dispatching at a configured value lets a provider with
   * headroom be told it is exhausted, and lets one configured below the constant pass this
   * check and then be refused at the send (#4893). Defaulted, so every existing caller keeps
   * the constant it already used.
   */
  const sendBudgetExhausted = (cap: number = TRANSIENT_RETRY_MAX_ATTEMPTS): boolean =>
    remainingTransientSendBudget(cap) === 0;
  /**
   * A credential hop reserves the send its own replay will make, and that replay is a recovery
   * leg. The leg must SPEND the hop's reservation instead of taking a second one: the
   * final-recovery reserve is single, so a rebuild that reserved on top of a hop would be
   * refused and the request would answer with a synthetic 502 in place of the real 429 the hop
   * was recovering from.
   */
  let pendingHopPermit: SingleUseDispatchPermit | undefined;
  /**
   * The budget an adapter's OWN dispatch ladder reserves against.
   *
   * Kiro and Cursor reserve once per physical send, and that is right: their ladders are the
   * layer that actually sends, and counting one adapter call as one send hid up to eighteen
   * upstream requests. But a credential hop has already booked the replay it is about to make,
   * and a reservation IS the charge, so an adapter that reserves again turns one physical send
   * into two charges -- and once the base allowance is spent, into a refusal that answers with
   * a synthetic error in place of the 429 the hop was recovering from (#4709).
   *
   * The hop hands its reservation down through `pendingHopPermit`, the same seam the
   * passthrough ladder already uses, and this view spends it on the adapter's FIRST
   * reservation. Every later send in that ladder is a new physical send and is charged
   * normally. A permit the adapter takes but never sends under is released through the same
   * call it would have used for a reservation of its own, so an abandoned replay is refunded
   * rather than left charged.
   */
  const adapterDispatchBudget: RequestExecutionBudget | undefined = adapterSendBudget === undefined
    ? undefined
    : adapterDispatchBudgetView(adapterSendBudget, {
      claimHopPermit: () => {
        const permit = pendingHopPermit;
        pendingHopPermit = undefined;
        return permit;
      },
    });
  /**
   * How many sends a recovery leg may make, and the permit that authorises the last one.
   *
   * The base allowance is spent first. Once it is gone a recovery class may still draw the
   * single shared final-recovery reserve -- which is what keeps the validated sanitized rebuild
   * after a 5xx streak alive at four total sends -- but an account move and a rebuild cannot
   * each take one. A caller with an exact provider total can suppress that reserve. The
   * `countedExternally` flag exists because these legs run through the retry helper, which reports
   * the same send again through `onSendsConsumed`.
   */
  const recoverySendAllowance = (
    cap: number,
    sendClass: SendClass,
    targetKey: string,
    options: { allowFinalRecoveryReserve?: boolean } = {},
  ): { attempts: number; permit?: SingleUseDispatchPermit } => {
    const base = remainingTransientSendBudget(cap);
    if (base > 0) return { attempts: base };
    // A provider-configured transient total is an exact physical-send ceiling. Once it is
    // exhausted, the request-wide recovery reserve must not silently widen it. The default stays
    // permissive so unconfigured providers retain the guarded profile's fourth recovery send.
    if (options.allowFinalRecoveryReserve === false) return { attempts: 0 };
    if (pendingHopPermit) {
      const hopPermit = pendingHopPermit;
      pendingHopPermit = undefined;
      return { attempts: 1, permit: hopPermit };
    }
    if (!isRequestExecutionBudget(sendBudget)) return { attempts: 0 };
    const decision = sendBudget.reserveDispatch({ sendClass, targetKey, countedExternally: true });
    return decision.allowed ? { attempts: 1, permit: decision.permit } : { attempts: 0 };
  };
  /**
   * One credential hop of this logical request, admitted by the INTERSECTION of two bounds.
   *
   * `GENERIC_OAUTH_MAX_FAILOVERS_PER_REQUEST` and `ANTHROPIC_POOL_MAX_FAILOVERS_PER_REQUEST`
   * stay exactly as they are: they bound rotation within one credential roster. What neither
   * can see is everything else this request already sent, so three hops layered on a spent
   * budget still reached upstream three more times. A hop now happens only when its own layer
   * cap AND the shared budget both permit it, and the smaller of the two wins.
   *
   * `countedExternally` is for the hops whose replay goes out through the retry helper, which
   * reports the same physical send through `onSendsConsumed`; the others are charged here and
   * nowhere else. A refusal is not an error: the caller keeps the real upstream response --
   * status, `Retry-After`, quota body -- because return-the-last-answer is the exhaustion
   * contract this unit settled on.
   */
  /**
   * A credential rotation inside ONE provider's roster is "auth-recovery", not
   * "account-failover". The distinction is load-bearing: "account-failover" sets
   * `isAlternateTarget` unconditionally, so under `maxAlternateTargetSends: 1` the first
   * rotation would refuse every later one AND consume the single slot a genuine cross-pool
   * move needs -- a roster whose first two accounts are both 429'd would return the 429
   * while a free third account sat unused. The roster cap bounds how far rotation walks;
   * the shared total bounds how many sends the request makes. Reserve "account-failover"
   * for a real move between pools.
   */
  const reserveCredentialHop = (
    sendClass: SendClass,
    targetKey: string,
    countedExternally = false,
  ): { allowed: boolean; permit?: SingleUseDispatchPermit } => {
    if (!isRequestExecutionBudget(sendBudget)) return { allowed: true };
    const decision = sendBudget.reserveDispatch({ sendClass, targetKey, countedExternally });
    return decision.allowed ? { allowed: true, permit: decision.permit } : { allowed: false };
  };
  /**
   * Both classes share the one reserve, so this only changes what the decision is called --
   * but a recovery event that says "repair" when a credential refresh drove it is the kind of
   * mislabelled evidence #4592 existed to stop.
   */
  const recoveryClassFor = (recovery: AttemptRecoveryKind): SendClass =>
    /401|429|oauth|rate-limit|key/.test(recovery) ? "auth-recovery" : "repair";

  return {
    workflowRootId,
    noteTransientSends,
    remainingTransientSendBudget,
    /**
     * Physical sends this logical request has already made.
     *
     * A live getter, not a snapshot: it is read once per dispatch leg to resolve a configured
     * ladder, and a value frozen at construction would answer for a request that had sent
     * nothing.
     */
    get sendsUsed(): number { return sendBudget.used; },
    adapterSendBudget,
    adapterDispatchBudget,
    noteAdapterPhysicalSend,
    sendBudgetExhausted,
    get pendingHopPermit(): SingleUseDispatchPermit | undefined {
      return pendingHopPermit;
    },
    set pendingHopPermit(value: SingleUseDispatchPermit | undefined) {
      pendingHopPermit = value;
    },
    recoverySendAllowance,
    reserveCredentialHop,
    recoveryClassFor,
  };
}

export type ResponsesSendBudget = Exclude<ReturnType<typeof createResponsesSendBudget>, Response>;

/**
 * A LIVE delegating view of one request's execution budget, with a credential hop's
 * reservation spendable through it.
 *
 * Every member forwards rather than copying. A spread of the budget would freeze `used`,
 * `reserveSpent` and the target counters at construction time, handing the adapter a budget
 * that can never read as exhausted -- the same class of defect as the fresh per-layer
 * allowances #4546 removed.
 */
function adapterDispatchBudgetView(
  budget: RequestExecutionBudget,
  hop: { claimHopPermit: () => SingleUseDispatchPermit | undefined },
): RequestExecutionBudget {
  return {
    get used(): number { return budget.used; },
    set used(next: number) { budget.used = next; },
    logicalRequestId: budget.logicalRequestId,
    policyVersion: budget.policyVersion,
    policy: budget.policy,
    get reserveSpent(): boolean { return budget.reserveSpent; },
    get alternateTargetSends(): number { return budget.alternateTargetSends; },
    get targetTransitions(): number { return budget.targetTransitions; },
    get lastTargetKey(): string | undefined { return budget.lastTargetKey; },
    remainingBaseSends: (cap: number): number => budget.remainingBaseSends(cap),
    reserveDispatch(intent: DispatchIntent): DispatchDecision {
      // A dispatch whose upstream state is unknown is refused on its own merits. A hop that
      // already paid does not make an unsafe replay safe, so that check stays with the budget.
      if (intent.replaySafe !== false) {
        const hopPermit = hop.claimHopPermit();
        // Confirmed here rather than in `use()`: the adapter reserves immediately before it
        // opens the transport, which is the same boundary the hop's own confirmation uses.
        // A permit some other leg already settled returns false, and this falls through to a
        // real reservation rather than handing the adapter a dead permit -- an adapter whose
        // `use()` fails treats the request as exhausted and stops sending entirely.
        if (hopPermit !== undefined && hopPermit.assumeCharge()) {
          let spent = false;
          return {
            allowed: true,
            permit: {
              sendClass: hopPermit.sendClass,
              use: (): boolean => {
                if (spent) return false;
                spent = true;
                return true;
              },
              assumeCharge: (): boolean => {
                if (spent) return false;
                spent = true;
                return true;
              },
              // The hop's charge is already settled and belongs to the leg that asked for it,
              // so there is nothing here to refund.
              release: (): void => {},
            },
          };
        }
      }
      return budget.reserveDispatch(intent);
    },
  };
}
