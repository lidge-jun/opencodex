import { randomUUID } from "node:crypto";
import type { RequestSendObserver } from "../../lib/request-execution-budget";
import { sharedSpendLedger, type SpendReservationLedger } from "../../lib/spend-reservation-ledger";
import { SpendLedgerOwnerError } from "../../lib/spend-ledger-owner";
import { markLocalRequestLogRefusal, type RequestLogContext } from "../request-log";
import { recordWorkflowRefusalEvent, workflowDenialSummary } from "../../lib/workflow-budget";

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
    "provider" | "accountLogLabel" | "usageLogInputTokens" | "spendOutputCeilingTokens" | "spendInputEstimateTokens"
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
  // Every send this request still owes the ledger an answer for, oldest first.
  const live: string[] = [];
  let refusals = 0;
  let resolved = false;
  let terminalProcessed = false;
  /**
   * Confirm the sends this request has already moved past.
   *
   * A booking is only marked dispatched once a LATER send exists, because that later send
   * proves the earlier one left. The newest booking stays open until it is settled, so a
   * reservation the budget hands back -- a rotation that found no alternate, a rebuild
   * abandoned before the wire -- can still be released for free while this process is alive.
   * A crash resolves every surviving reservation as unresolved spend regardless of this mark,
   * because a journal that lost its tail cannot prove a send never left.
   */
  const confirmOlderSends = (): void => {
    for (let index = 0; index < live.length - 1; index += 1) ledger().markDispatched(live[index] as string);
  };
  return {
    charge(options?: { alreadySent?: boolean }): boolean {
      // A send that has already left is RECORDED, never refused: the tokens are spent, and a
      // booking the ledger drops is a booking the ceiling can never see. This is the reporting
      // transports' path -- the passthrough ladder reports through `onSendsConsumed` after the
      // fetch -- so without it a root ceiling on the canonical Codex path would sit one send
      // short of its limit forever and refuse nothing.
      const alreadySent = options?.alreadySent === true;
      const sendId = randomUUID();
      const decision = ledger().reserve({
        sendId,
        scopes: {
          ...(rootId !== undefined ? { rootId } : {}),
          // Already the privacy-safe label the request log uses, and the ledger aliases it
          // again on the way to disk. A raw credential never reaches either.
          ...(logCtx.accountLogLabel !== undefined ? { identityId: logCtx.accountLogLabel } : {}),
          ...(logCtx.provider !== undefined ? { poolId: logCtx.provider } : {}),
        },
        inputTokens: logCtx.spendInputEstimateTokens ?? logCtx.usageLogInputTokens ?? 0,
        outputCeilingTokens: logCtx.spendOutputCeilingTokens ?? 0,
        ...(alreadySent ? { alreadySent: true } : {}),
      });
      if (!decision.reserved) {
        refusals += 1;
        const denial = decision.denial;
        // A ceiling refuses, and so does a ledger that cannot make the reservation durable
        // under one. That second case is the whole reason this store is on disk: admitting a
        // send whose record a restart would forget is how an exhausted budget comes back with
        // a fresh allowance, and the ledger raises those two denials ONLY when a limit is
        // configured -- so an install that configured nothing is still never refused here.
        // Capacity and a duplicate send id stay permissive: they say the ledger cannot account
        // for this send, which is a degradation to report, not an outage to cause.
        if (denial.reason === "reserve-not-durable" || denial.reason === "journal-corrupt") {
          return alreadySent;
        }
        if (denial.reason !== "spend-limit-exceeded") return true;
        // This send is refused, and the dispatch path that asked will report an exhausted send
        // budget -- from there, that is all it can see. The row is where an operator actually
        // looks, so the ceiling is named on it here: a locally assigned code wins in
        // addFinalRequestLog, so the request that CROSSED the ceiling reads as a spend refusal
        // rather than as the ordinary budget exhaustion it would otherwise be indistinguishable
        // from. The event ring gets the same pair so /api/workflow-budget agrees with the row.
        const detail = { scope: denial.scope, limit: denial.limit, projected: denial.projected };
        const summary = workflowDenialSummary("workflow-spend-exhausted", detail);
        markLocalRequestLogRefusal(logCtx, summary.code);
        logCtx.errorCode = summary.code;
        recordWorkflowRefusalEvent(rootId, "workflow-spend-exhausted", Date.now(), detail);
        return false;
      }
      live.push(sendId);
      confirmOlderSends();
      // It has already left, so the reservation cannot be handed back for free: from here only
      // a settlement or unresolved spend is honest about it.
      if (alreadySent) ledger().markDispatched(sendId);
      return true;
    },
    refund(): void {
      const sendId = live.pop();
      if (sendId === undefined) return;
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
