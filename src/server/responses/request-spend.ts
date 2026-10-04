import { randomUUID } from "node:crypto";
import type { RequestSendObserver } from "../../lib/request-execution-budget";
import { sharedSpendLedger, type SpendReservationLedger, type SpendScopes } from "../../lib/spend-reservation-ledger";
import { SpendLedgerOwnerError } from "../../lib/spend-ledger-owner";
import { markLocalRequestLogRefusal, type RequestLogContext } from "../request-log";
import { recordWorkflowRefusalEvent, workflowDenialSummary, type WorkflowDenial } from "../../lib/workflow-budget";

/** The terminal usage a request reported, in the only two fields the ledger books. */
export interface TerminalSpendUsage {
  inputTokens?: number;
  outputTokens?: number;
}

/** Settles one request's durable spend entries once its terminal usage is known. */
export interface RequestSpendSettlement {
  settle(usage: TerminalSpendUsage | undefined): void;
}

export interface RequestSpendTracker extends RequestSendObserver, RequestSpendSettlement {
  /** Dispatches this request lost to a ledger ceiling. Zero on every ordinary request. */
  readonly refusals: number;
}

/**
 * One request's entries in the durable spend ledger (#4707).
 *
 * The ledger has had the whole reserve/dispatch/settle vocabulary since #4546 and no production
 * caller: `spend-ledger.jsonl` was never created by ordinary traffic, and the ceilings the
 * feature advertised stayed process-local and count-only, resetting on restart. This is the
 * caller.
 *
 * It books one entry per physical send by observing the request's own send counter rather than
 * by being called from each dispatch site. That counter moves exactly once per physical send,
 * so one entry per increment is one entry per send -- and a dispatch path added later cannot
 * forget to book, which is how the previous wiring attempt ended up with no caller at all.
 *
 * Settlement follows what the request actually learned. The terminal usage belongs to the LAST
 * send that left, so that one settles with the real figure. Every earlier send failed without
 * reporting usage of its own and may still have been billed, so it becomes unresolved spend
 * rather than free. A request that ends with no usage at all -- a cancel, a lost stream --
 * leaves all of them unresolved, which is the conservative answer this ledger exists to give.
 */
export function createRequestSpendTracker(
  logCtx: Pick<
    RequestLogContext,
    "provider" | "accountLogLabel" | "usageLogInputTokens" | "spendOutputCeilingTokens" | "spendInputEstimateTokens" | "spendPoolId"
  > & Partial<Pick<RequestLogContext, "localTerminalReason" | "terminalSource" | "errorCode">>,
  rootId: string | undefined,
  injected?: SpendReservationLedger,
): RequestSpendTracker {
  // Resolved on the first CHARGE, not when the request is built. The shared ledger opens a
  // journal under the OpenCodex home, and a request that never dispatches -- refused at
  // admission, answered locally, cancelled before its first send -- has no business creating
  // one. It also means the home in effect at dispatch is the one that gets written.
  let ledgerRef: SpendReservationLedger | undefined = injected;
  const ledger = (): SpendReservationLedger => (ledgerRef ??= sharedSpendLedger());
  // Outstanding entries; exact dispatch reports move their reservation to the end.
  const live: string[] = [];
  const pendingDispatch = new Set<string>();
  let refusals = 0;
  let resolved = false;
  let terminalProcessed = false;
  /**
   * Confirm the sends this request has already moved past.
   *
   * Legacy direct charges infer dispatch from a later send. Exact budget reservations wait
   * for their own dispatch/report instead: reserving B does not prove that A left, and A
   * must remain refundable if B reports first. The newest direct charge stays open.
   * A crash resolves every surviving reservation as unresolved spend regardless of this mark,
   * because a journal that lost its tail cannot prove a send never left.
   */
  const confirmOlderSends = (): void => {
    for (const sendId of live.slice(0, -1)) {
      if (!pendingDispatch.has(sendId)) ledger().markDispatched(sendId);
    }
  };
  return {
    charge(options?: Parameters<RequestSendObserver["charge"]>[0]): boolean {
      // A send that has already left is RECORDED, never refused: the tokens are spent, and a
      // booking the ledger drops is a booking the ceiling can never see. This is the reporting
      // transports' path -- the passthrough ladder reports through `onSendsConsumed` after the
      // fetch -- so without it a root ceiling on the canonical Codex path would sit one send
      // short of its limit forever and refuse nothing.
      const alreadySent = options?.alreadySent === true;
      const sendId = randomUUID();
      const bookedLedger = ledger();
      const scopes: SpendScopes = {
        ...(rootId !== undefined ? { rootId } : {}),
        // Already the privacy-safe label the request log uses, and the ledger aliases it
        // again on the way to disk. A raw credential never reaches either.
        ...(logCtx.accountLogLabel !== undefined ? { identityId: logCtx.accountLogLabel } : {}),
        ...((logCtx.spendPoolId ?? logCtx.provider) !== undefined
          ? { poolId: logCtx.spendPoolId ?? logCtx.provider }
          : {}),
      };
      const policy = bookedLedger.policy;
      const enforced = (scopes.rootId !== undefined && policy.root.maxTokens !== undefined)
        || (scopes.identityId !== undefined && policy.identity.maxTokens !== undefined)
        || (scopes.poolId !== undefined && policy.pool.maxTokens !== undefined);
      const decision = bookedLedger.reserve({
        sendId,
        scopes,
        inputTokens: logCtx.spendInputEstimateTokens ?? logCtx.usageLogInputTokens ?? 0,
        outputCeilingTokens: logCtx.spendOutputCeilingTokens ?? 0,
        ...(alreadySent ? { alreadySent: true } : {}),
      });
      if (!decision.reserved) {
        // An applicable ceiling cannot authorize an unbooked send, including when tracking
        // capacity is full. Unconfigured/nonapplicable requests remain observe-only, and a
        // physical send reported after dispatch cannot be refused retroactively.
        if (alreadySent || !enforced) return true;
        refusals += 1;
        const denial = decision.denial;
        // Preserve the PR's explicit unresolved-history refusal and its distinct operator code.
        if (denial.reason === "pool-history-unresolved") {
          const summary = workflowDenialSummary("workflow-pool-history-unresolved");
          markLocalRequestLogRefusal(logCtx, summary.code);
          logCtx.errorCode = summary.code;
          recordWorkflowRefusalEvent(rootId, "workflow-pool-history-unresolved", Date.now());
          return false;
        }
        const reason: WorkflowDenial = denial.reason === "duplicate-send-id"
          ? "workflow-send-replayed"
          : denial.reason === "reserve-not-durable" || denial.reason === "journal-corrupt"
            ? "workflow-spend-undurable"
            : denial.reason === "tracking-capacity-exhausted"
              ? "workflow-tracking-exhausted"
              : "workflow-spend-exhausted";
        const detail = denial.reason === "spend-limit-exceeded"
          ? { scope: denial.scope, limit: denial.limit, projected: denial.projected } : undefined;
        const summary = workflowDenialSummary(reason, detail);
        markLocalRequestLogRefusal(logCtx, summary.code);
        logCtx.errorCode = summary.code;
        recordWorkflowRefusalEvent(rootId, reason, Date.now(), detail);
        return false;
      }
      if (!alreadySent) options?.onReserved?.({ ledger: bookedLedger, sendId });
      live.push(sendId);
      if (options?.deferDispatch) pendingDispatch.add(sendId);
      else confirmOlderSends();
      // It has already left, so the reservation cannot be handed back for free: from here only
      // a settlement or unresolved spend is honest about it.
      if (alreadySent) ledger().markDispatched(sendId);
      return true;
    },
    dispatch(proof): void {
      if (proof.ledger !== ledgerRef || !pendingDispatch.has(proof.sendId)) return;
      ledger().markDispatched(proof.sendId);
      pendingDispatch.delete(proof.sendId);
      // Terminal usage follows dispatch/report order, not reservation order.
      const index = live.indexOf(proof.sendId);
      if (index >= 0) live.push(...live.splice(index, 1));
    },
    refund(proof): void {
      // null is an exact budget reservation that obtained no durable booking.
      if (proof === null || (proof && proof.ledger !== ledgerRef)) return;
      const index = proof ? live.indexOf(proof.sendId) : live.length - 1;
      if (index < 0) return;
      const [sendId] = live.splice(index, 1);
      if (sendId === undefined) return;
      pendingDispatch.delete(sendId);
      // Undispatched, so this returns the tokens. If the send was already confirmed by a later
      // one, `abandon` refuses and unresolved is the only honest outcome left.
      if (!ledger().abandon(sendId)) ledger().markLost(sendId);
    },
    settle(usage: TerminalSpendUsage | undefined): void {
      if (resolved) return;
      try {
        if (!terminalProcessed && live.length > 0) {
          const terminal = live[live.length - 1] as string;
          const reported = typeof usage?.inputTokens === "number" || typeof usage?.outputTokens === "number";
          if (reported) {
            ledger().settle(terminal, {
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
            });
          } else {
            // The response never reported usage. It may still have been billed.
            ledger().markLost(terminal);
          }
          live.pop();
          terminalProcessed = true;
        }
        while (live.length > 0) {
          ledger().markLost(live[live.length - 1] as string);
          live.pop();
        }
        resolved = true;
      } catch (error) {
        // A deferred final log may arrive after server.stop released this ledger's lease.
        // Only that ended ownership can discard sends already reserved by this tracker.
        if (live.length === 0 || !(error instanceof SpendLedgerOwnerError)
          || error.code !== "SPEND_LEDGER_OWNER_NOT_HELD") throw error;
        live.length = 0;
        resolved = true;
      }
    },
    get refusals(): number { return refusals; },
  };
}

/**
 * Give a request a spend tracker and hand back the observer its budget reports through.
 *
 * The tracker is parked on the log context because `addFinalRequestLog` is the one seam every
 * request passes exactly once, whatever transport served it and however it ended, and it is
 * where the terminal usage is already known.
 */
export function attachRequestSpendTracker(
  req: Pick<Request, "headers">,
  logCtx: RequestLogContext,
  ledger?: SpendReservationLedger,
): RequestSendObserver {
  const rootId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const tracker = ledger === undefined
    ? createRequestSpendTracker(logCtx, rootId)
    : createRequestSpendTracker(logCtx, rootId, ledger);
  logCtx.spendTracker = tracker;
  return tracker;
}
