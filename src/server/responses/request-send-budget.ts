import type { ResponsesRequestContext } from "./core-options";
import { createRequestExecutionBudget, isRequestExecutionBudget } from "../../lib/request-execution-budget";
import { chargeWorkflowSends, workflowSendCeilingReached } from "../../lib/workflow-budget";
import { workflowRefusalResponse } from "../workflow-refusal";
import type { AttemptRecoveryKind } from "../../usage/log";
import { noteAttemptSend } from "../request-log";
import { TRANSIENT_RETRY_MAX_ATTEMPTS } from "../../lib/upstream-retry";
import type { SingleUseDispatchPermit, SendClass } from "../../lib/request-execution-budget";

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
   * Ordinal 1 is the send each call site already recorded through `noteAttemptSend`, so only
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
  const sendBudgetExhausted = (): boolean =>
    remainingTransientSendBudget(TRANSIENT_RETRY_MAX_ATTEMPTS) === 0;
  /**
   * A credential hop reserves the send its own replay will make, and that replay is a recovery
   * leg. The leg must SPEND the hop's reservation instead of taking a second one: the
   * final-recovery reserve is single, so a rebuild that reserved on top of a hop would be
   * refused and the request would answer with a synthetic 502 in place of the real 429 the hop
   * was recovering from.
   */
  let pendingHopPermit: SingleUseDispatchPermit | undefined;
  /**
   * How many sends a recovery leg may make, and the permit that authorises the last one.
   *
   * The base allowance is spent first. Once it is gone a recovery class may still draw the
   * single shared final-recovery reserve -- which is what keeps the validated sanitized rebuild
   * after a 5xx streak alive at four total sends -- but an account move and a rebuild cannot
   * each take one. `countedExternally` is set because these legs run through the retry helper,
   * which reports the same send again through `onSendsConsumed`.
   */
  const recoverySendAllowance = (
    cap: number,
    sendClass: SendClass,
    targetKey: string,
  ): { attempts: number; permit?: SingleUseDispatchPermit } => {
    const base = remainingTransientSendBudget(cap);
    if (base > 0) return { attempts: base };
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
    adapterSendBudget,
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
