import { randomUUID } from "node:crypto";
import type { RequestSendObserver } from "../../lib/request-execution-budget";
import { sharedSpendLedger, sharedSpendPolicy, type SpendReservationLedger, type SpendScopes, type SpendSeed, type SpendReservationProof, type SpendAdmissionPolicy } from "../../lib/spend-reservation-ledger";
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

export interface SpendTargetIdentity extends SpendScopes { readonly targetKey?: string }
export interface RequestSpendReporter {
  start(seed: SpendSeed, ordinal: number): void;
  rebindTarget(target: SpendTargetIdentity, ordinal: number): boolean;
  report(sends: number): void;
  close(): void;
}

export interface RequestSpendTracker extends RequestSendObserver, RequestSpendSettlement {
  /** Dispatches this request lost to a ledger ceiling. Zero on every ordinary request. */
  readonly refusals: number;
  readonly enforced: boolean;
  ensureSeed(target: SpendTargetIdentity, prepaidProof?: SpendReservationProof): SpendSeed | undefined;
  beginReporter(): RequestSpendReporter;
  reportFromSeed(seed: SpendSeed, ordinal: number): void;
  requestFinalSettlement(usage: TerminalSpendUsage | undefined): void;
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
  > & Partial<Pick<RequestLogContext, "localTerminalReason" | "terminalSource" | "errorCode" | "spendRefusalDetail">>,
  rootId: string | undefined,
  injected?: SpendReservationLedger,
): RequestSpendTracker {
  // Resolved on the first CHARGE, not when the request is built. The shared ledger opens a
  // journal under the OpenCodex home, and a request that never dispatches -- refused at
  // admission, answered locally, cancelled before its first send -- has no business creating
  // one. It also means the home in effect at dispatch is the one that gets written.
  let ledgerRef: SpendReservationLedger | undefined = injected;
  const ledger = (): SpendReservationLedger => (ledgerRef ??= sharedSpendLedger());
  let admissionPolicy: SpendAdmissionPolicy | undefined;
  let initialEnforced: boolean | undefined;
  // Outstanding entries; exact dispatch reports move their reservation to the end.
  const live: string[] = [];
  const pendingDispatch = new Set<string>();
  let refusals = 0;
  let resolved = false;
  let terminalProcessed = false;
  let seededAccounting = false;
  let finalRequested = false;
  let finalUsage: TerminalSpendUsage | undefined;
  let reporters = 0;
  const seeds = new Map<string, { seed: SpendSeed; started: boolean; reported: boolean }>();
  // Abandoned capabilities retain cleanup ownership, never admission lookup.
  const retiredSeeds = new Set<SpendSeed>();
  const resolvedSendIds = new Set<string>();
  const completedSeeds = new Set<SpendSeed>();
  const physical = new Map<number, { seed: SpendSeed; sendId?: string; reportPending?: boolean; reportComplete?: boolean; estimate?: { inputTokens: number; outputCeilingTokens: number } }>();
  const selectedScopes = (target: SpendTargetIdentity = {}): SpendScopes => ({
    ...(rootId !== undefined ? { rootId } : {}),
    ...(target.identityId ?? logCtx.accountLogLabel ? { identityId: target.identityId ?? logCtx.accountLogLabel } : {}),
    ...(target.poolId ?? logCtx.spendPoolId ?? logCtx.provider ? { poolId: target.poolId ?? logCtx.spendPoolId ?? logCtx.provider } : {}),
  });
  const applicable = (scopes: SpendScopes): boolean => {
    if (initialEnforced !== undefined) return initialEnforced;
    const policy = admissionPolicy ?? ledgerRef?.policy ?? sharedSpendPolicy();
    return (scopes.rootId !== undefined && policy.root.maxTokens !== undefined)
      || (scopes.identityId !== undefined && policy.identity.maxTokens !== undefined)
      || (scopes.poolId !== undefined && policy.pool.maxTokens !== undefined);
  };
  const estimates = () => ({ inputTokens: logCtx.spendInputEstimateTokens ?? logCtx.usageLogInputTokens ?? 0,
    outputCeilingTokens: logCtx.spendOutputCeilingTokens ?? 0 });
  const seedState = (seed: SpendSeed) => [...seeds.values()].find(state => state.seed === seed);
  const cleanupRetiredSeeds = (): boolean => {
    for (const seed of retiredSeeds) if (ledger().finishSeed(seed, tracker)) retiredSeeds.delete(seed);
    return retiredSeeds.size === 0;
  };
  const tryFinalizeSeeds = (): boolean => {
    retryPhysicalReports();
    // All starts are booked before producers close. Ordinal, never callback order, owns usage.
    const entries = [...physical.entries()].sort((a, b) => a[0] - b[0]);
    const terminal = entries.at(-1)?.[1].sendId;
    const ids: string[] = [];
    for (const [, entry] of entries) {
      if (!entry.sendId) return false;
      const reported = entry.sendId === terminal && (typeof finalUsage?.inputTokens === "number" || typeof finalUsage?.outputTokens === "number");
      if (!resolvedSendIds.has(entry.sendId)) {
        const ok = reported ? ledger().settle(entry.sendId, { inputTokens: finalUsage?.inputTokens ?? 0, outputTokens: finalUsage?.outputTokens ?? 0 })
          : ledger().markLost(entry.sendId);
        if (!ok) return false;
        resolvedSendIds.add(entry.sendId);
      }
      ids.push(entry.sendId);
    }
    for (const state of seeds.values()) if (!state.started && !completedSeeds.has(state.seed)) {
      if (!resolvedSendIds.has(state.seed.sendId) && !ledger().abandon(state.seed.sendId)) return false;
      resolvedSendIds.add(state.seed.sendId);
      ids.push(state.seed.sendId);
    }
    if (!cleanupRetiredSeeds()) return false;
    if (!ledger().forgetResolved(ids, tracker)) return false;
    for (const state of seeds.values()) if (!completedSeeds.has(state.seed)) {
      if (!ledger().finishSeed(state.seed, tracker)) return false;
      completedSeeds.add(state.seed);
    }
    resolved = true;
    return true;
  };
  const retryPhysicalReports = (): void => {
    for (const [ordinal, entry] of physical) if (entry.reportPending && !entry.reportComplete) tracker.reportFromSeed(entry.seed, ordinal);
  };
  const deferCleanup = (): void => ledger().deferCleanup(tracker, () => {
    if (resolved) return true;
    retryPhysicalReports();
    if (finalRequested && reporters === 0) return tryFinalizeSeeds();
    return cleanupRetiredSeeds() && reporters === 0;
  });
  const finalizeSeeds = (): void => {
    if (!finalRequested || reporters !== 0 || resolved || !seededAccounting) return;
    // Own terminal retry before an append can throw; propagation must not orphan the debt.
    deferCleanup();
    if (!tryFinalizeSeeds()) {
      // Failed durable cleanup remains owned by this ledger until later activity retries it.
      deferCleanup();
    }
  };
  const retireSeed = (key: string, seed: SpendSeed): boolean => {
    if (!resolvedSendIds.has(seed.sendId) && !ledger().abandon(seed.sendId)) return false;
    resolvedSendIds.add(seed.sendId);
    seeds.delete(key);
    const index = live.indexOf(seed.sendId);
    if (index >= 0) live.splice(index, 1);
    pendingDispatch.delete(seed.sendId);
    // Keep cleanup owned even if finishSeed throws after durable abandonment.
    retiredSeeds.add(seed);
    deferCleanup();
    if (ledger().finishSeed(seed, tracker)) retiredSeeds.delete(seed);
    return true;
  };
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
  const refusal = (denial: import("../../lib/spend-reservation-ledger").SpendDenial): void => {
        refusals += 1;
        // Preserve the PR's explicit unresolved-history refusal and its distinct operator code.
        if (denial.reason === "pool-history-unresolved") {
          const summary = workflowDenialSummary("workflow-pool-history-unresolved");
          markLocalRequestLogRefusal(logCtx, summary.code);
          logCtx.errorCode = summary.code;
          recordWorkflowRefusalEvent(rootId, "workflow-pool-history-unresolved", Date.now());
          return;
        }
        const reason: WorkflowDenial = denial.reason === "duplicate-send-id"
          ? "workflow-send-replayed"
          : denial.reason === "reserve-not-durable" || denial.reason === "journal-corrupt"
            ? "workflow-spend-undurable"
            : denial.reason === "tracking-capacity-exhausted"
              ? "workflow-tracking-exhausted"
              : "workflow-spend-exhausted";
        const detail = denial.reason === "spend-limit-exceeded"
          ? {
            scope: denial.scope,
            limit: denial.limit,
            projected: denial.projected,
            ...(denial.includesUnboundPoolHistory ? { includesUnboundPoolHistory: true } : {}),
          }
          : undefined;
        const summary = workflowDenialSummary(reason, detail);
        markLocalRequestLogRefusal(logCtx, summary.code);
        logCtx.errorCode = summary.code;
        if (detail?.includesUnboundPoolHistory) logCtx.spendRefusalDetail = detail;
        recordWorkflowRefusalEvent(rootId, reason, Date.now(), detail);
        return;
  };
  const tracker: RequestSpendTracker = {
    startRequest(target) {
      if (admissionPolicy) return;
      const policy = ledgerRef?.policy ?? sharedSpendPolicy();
      admissionPolicy = Object.freeze({ root: Object.freeze({ ...policy.root }), identity: Object.freeze({ ...policy.identity }), pool: Object.freeze({ ...policy.pool }) });
      initialEnforced = applicable(selectedScopes(target));
      if (!initialEnforced) admissionPolicy = Object.freeze({ root: Object.freeze({}), identity: Object.freeze({}), pool: Object.freeze({}) });
    },
    get enforced(): boolean { return applicable(selectedScopes()); },
    get policyStarted(): boolean { return admissionPolicy !== undefined; },
    get spendAdmissionPolicy(): SpendAdmissionPolicy | undefined { return admissionPolicy; },
    ensureSeed(target, prepaidProof) {
      tracker.startRequest?.(target);
      if (resolved || finalRequested && reporters === 0) return undefined;
      const scopes = selectedScopes(target);
      if (!applicable(scopes)) return undefined;
      const key = JSON.stringify([scopes.rootId, scopes.identityId, scopes.poolId, target.targetKey]);
      const existing = seeds.get(key);
      if (existing) return existing.seed;
      if (prepaidProof?.ledger === ledger()) {
        const prepaid = [...seeds.entries()].find(([, state]) => state.seed.sendId === prepaidProof.sendId);
        if (prepaid && !prepaid[1].started) {
          // The proof was reserved against the selected scopes by this tracker.
          const oldIdentity = JSON.parse(prepaid[0]) as Array<string | undefined>;
          if (oldIdentity[0] === (scopes.rootId ?? null) && oldIdentity[1] === (scopes.identityId ?? null) && oldIdentity[2] === (scopes.poolId ?? null)) {
            seeds.delete(prepaid[0]); seeds.set(key, prepaid[1]); return prepaid[1].seed;
          }
        }
      }
      if (target.targetKey === undefined) {
        const same = [...seeds.entries()].find(([candidate]) => {
          const identity = JSON.parse(candidate) as Array<string | undefined>;
          return identity[0] === (scopes.rootId ?? null) && identity[1] === (scopes.identityId ?? null) && identity[2] === (scopes.poolId ?? null);
        });
        if (same) return same[1].seed;
      }
      // Rebind an unused provisional anchor before selection changes. Dispatched anchors stay live.
      for (const [oldKey, state] of seeds) if (!state.started) {
        if (!retireSeed(oldKey, state.seed)) return undefined;
      }
      // Exact prepaid proofs originate from this tracker and are found above; foreign receipts
      // cannot enroll arbitrary scopes. Normal reservation remains the only initial admission.
      if (prepaidProof && prepaidProof.ledger !== ledger()) return undefined;
      const decision = ledger().reserveSeed({ sendId: randomUUID(), scopes, ...estimates(), admissionPolicy }, tracker);
      if (!decision.reserved) {
        // Use the established denial mapping without making another reservation.
        refusal(decision.denial);
        return undefined;
      }
      seededAccounting = true;
      seeds.set(key, { seed: decision.seed, started: false, reported: false });
      return decision.seed;
    },
    beginReporter() {
      if (resolved || finalRequested && reporters === 0) throw new Error("Spend reporter registered after final closure");
      deferCleanup();
      const lease = ledger().registerReporter(tracker);
      reporters++;
      let closed = false;
      let reported = 0;
      const starts: Array<{ seed: SpendSeed; ordinal: number }> = [];
      return {
        start(seed, ordinal) {
          if (closed || !seedState(seed) || physical.has(ordinal)) throw new Error("Invalid spend reporter start");
          const state = seedState(seed)!;
          state.started = true;
          starts.push({ seed, ordinal });
          physical.set(ordinal, { seed });

        },
        rebindTarget(target, ordinal) {
          const entry = physical.get(ordinal);
          const owned = starts.find(start => start.ordinal === ordinal);
          if (closed || !entry || !owned || entry.sendId) throw new Error("Invalid spend reporter rebind");
          const old = seedState(entry.seed)!;
          // A helper start is provisional until selection reaches the executor. If this is
          // the first start on its seed, abandon/rebind at NORMAL capacity before the wire.
          physical.delete(ordinal);
          old.started = [...physical.values()].some(start => start.seed === old.seed);
          const seed = tracker.ensureSeed(target);
          if (!seed) { starts.splice(starts.indexOf(owned), 1); return false; }
          physical.set(ordinal, { seed });
          owned.seed = seed;
          seedState(seed)!.started = true;
          return true;
        },
        report(sends) {
          if (closed) return;
          const count = Number.isFinite(sends) ? Math.max(0, Math.trunc(sends)) : 0;
          // Own the whole reported batch before the first append can interrupt its cursor.
          for (const start of starts.slice(reported, reported + count)) physical.get(start.ordinal)!.reportPending = true;
          for (let i = 0; i < count && reported < starts.length; i++) {
            const entry = starts[reported]!;
            tracker.reportFromSeed(entry.seed, entry.ordinal);
            reported++;
          }
        },
        close() {
          if (closed) return;
          // Cancellation still books every claimed start conservatively.
          try { this.report(starts.length - reported); }
          finally {
            closed = true;
            reporters--;
            try { lease.close(); } finally { finalizeSeeds(); }
          }
        },
      };
    },
    reportFromSeed(seed, ordinal) {
      const entry = physical.get(ordinal);
      const state = seedState(seed);
      if (!entry || entry.seed !== seed || entry.reportComplete || !state) return;
      entry.reportPending = true;
      const firstOrdinal = [...physical.entries()].filter(([, send]) => send.seed === seed).map(([order]) => order).sort((a, b) => a - b)[0];
      const sendId = entry.sendId ??= ordinal === firstOrdinal ? seed.sendId : randomUUID();
      const estimate = entry.estimate ??= estimates();
      if (sendId !== seed.sendId && !ledger().reserveReportedFromSeed(seed, { sendId, ...estimate })) {
        throw new Error("Already-sent spend could not be persisted");
      }
      state.reported = true;
      if (!ledger().markDispatched(sendId)) throw new Error("Already-sent spend dispatch could not be persisted");
      entry.reportComplete = true;
    },
    requestFinalSettlement(usage) {
      if (!finalRequested) { finalRequested = true; finalUsage = usage; }
      finalizeSeeds();
    },
    charge(options?: Parameters<RequestSendObserver["charge"]>[0]): boolean {
      tracker.startRequest?.();
      // A send that has already left is RECORDED, never refused: the tokens are spent, and a
      // booking the ledger drops is a booking the ceiling can never see. This is the reporting
      // transports' path -- the passthrough ladder reports through `onSendsConsumed` after the
      // fetch -- so without it a root ceiling on the canonical Codex path would sit one send
      // short of its limit forever and refuse nothing.
      const alreadySent = options?.alreadySent === true;
      if (!alreadySent && tracker.enforced) {
        const seed = tracker.ensureSeed({ targetKey: options?.targetKey });
        if (!seed) return false;
        options?.onReserved?.({ ledger: ledger(), sendId: seed.sendId });
        return true;
      }
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
      const policy = admissionPolicy!;
      const enforced = (scopes.rootId !== undefined && policy.root.maxTokens !== undefined)
        || (scopes.identityId !== undefined && policy.identity.maxTokens !== undefined)
        || (scopes.poolId !== undefined && policy.pool.maxTokens !== undefined);
      const decision = bookedLedger.reserve({
        sendId,
        scopes,
        admissionPolicy,
        inputTokens: logCtx.spendInputEstimateTokens ?? logCtx.usageLogInputTokens ?? 0,
        outputCeilingTokens: logCtx.spendOutputCeilingTokens ?? 0,
        ...(alreadySent ? { alreadySent: true } : {}),
      });
      if (!decision.reserved) {
        // An applicable ceiling cannot authorize an unbooked send, including when tracking
        // capacity is full. Unconfigured/nonapplicable requests remain observe-only, and a
        // physical send reported after dispatch cannot be refused retroactively.
        if (alreadySent || !enforced) return true;
        refusal(decision.denial);
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
      if (seededAccounting && proof.ledger === ledgerRef) return;
      if (proof.ledger !== ledgerRef || !pendingDispatch.has(proof.sendId)) return;
      ledger().markDispatched(proof.sendId);
      pendingDispatch.delete(proof.sendId);
      // Terminal usage follows dispatch/report order, not reservation order.
      const index = live.indexOf(proof.sendId);
      if (index >= 0) live.push(...live.splice(index, 1));
    },
    refund(proof): void {
      if (proof && proof.ledger === ledgerRef && seededAccounting) {
        const match = [...seeds.entries()].find(([, state]) => state.seed.sendId === proof.sendId);
        if (match && !match[1].started) retireSeed(match[0], match[1].seed);
        return;
      }
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
      if (seededAccounting) { tracker.requestFinalSettlement(usage); return; }
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
  return tracker;
}

/**
 * Give a request a spend tracker and hand back the observer its budget reports through.
 *
 * The tracker is parked on the log context because `addFinalRequestLog` is the one seam every
 * request passes exactly once, whatever transport served it and however it ended, and it is
 * where the terminal usage is already known.
 */
const trackerRequests = new WeakMap<RequestSpendTracker, Pick<Request, "headers">>();

export function attachRequestSpendTracker(
  req: Pick<Request, "headers">,
  logCtx: RequestLogContext,
  ledger?: SpendReservationLedger,
): RequestSpendTracker {
  const existing = logCtx.spendTracker as RequestSpendTracker | undefined;
  if (existing && trackerRequests.get(existing) === req) return existing;
  const rootId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const tracker = ledger === undefined
    ? createRequestSpendTracker(logCtx, rootId)
    : createRequestSpendTracker(logCtx, rootId, ledger);
  logCtx.spendTracker = tracker;
  trackerRequests.set(tracker, req);
  return tracker;
}
