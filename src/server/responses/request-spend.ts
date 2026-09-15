import { randomUUID } from "node:crypto";
import type { RequestSendObserver } from "../../lib/request-execution-budget";
import { sharedSpendLedger, type SpendReservationLedger } from "../../lib/spend-reservation-ledger";
import type { RequestLogContext } from "../request-log";

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
    "provider" | "accountLogLabel" | "usageLogInputTokens" | "spendOutputCeilingTokens"
  >,
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
    charge(): boolean {
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
        inputTokens: logCtx.usageLogInputTokens ?? 0,
        outputCeilingTokens: logCtx.spendOutputCeilingTokens ?? 0,
      });
      if (!decision.reserved) {
        refusals += 1;
        // Only an operator's configured ceiling refuses a dispatch. Every other denial --
        // capacity, durability, a journal this process could not prove complete -- means the
        // ledger cannot ACCOUNT for this send, which is not a reason to refuse one. An
        // unconfigured install keeps the count caps it already had and is not newly refused,
        // and a degraded ledger must not become an outage.
        return decision.denial.reason !== "spend-limit-exceeded";
      }
      live.push(sendId);
      confirmOlderSends();
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
      resolved = true;
      const terminal = live.pop();
      if (terminal !== undefined) {
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
      }
      for (const sendId of live.splice(0)) ledger().markLost(sendId);
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
