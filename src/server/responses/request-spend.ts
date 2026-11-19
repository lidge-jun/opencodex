import { randomUUID } from "node:crypto";
import type { RequestSendObserver } from "../../lib/request-execution-budget";
import type { AdapterEvent } from "../../types";
import { sharedSpendLedger, sharedSpendPolicy, type SpendReservationLedger, type SpendScopes, type SpendSeed, type SpendReservationProof, type SpendAdmissionPolicy, type SpendReservationRequest } from "../../lib/spend-reservation-ledger";
import { SpendLedgerOwnerError } from "../../lib/spend-ledger-owner";
import { markLocalRequestLogRefusal, type RequestLogContext } from "../request-log";
import { chargeWorkflowSends, recordWorkflowRefusalEvent, reserveWorkflowSend, workflowDenialSummary, type WorkflowDenial, type WorkflowSpendDenialDetail } from "../../lib/workflow-budget";
import { currentWorkflowBudgetPolicy } from "../../lib/workflow-budget-config";

/** The terminal usage a request reported, in the only two fields the ledger books. */
export interface TerminalSpendUsage {
  inputTokens?: number;
  outputTokens?: number;
}

type RecordSendUsage = (usage: TerminalSpendUsage) => void;
const adapterResponseSpend = new WeakMap<Response, RecordSendUsage>();

/** Bind an image-recovery response after its retry ladder has finished reporting sends. */
export function bindAdapterResponseSpend(response: Response, record: RecordSendUsage | undefined): void {
  if (response.ok && record) adapterResponseSpend.set(response, record);
}

/** Observe raw adapter events before guards and bridges merge usage across sends. */
export function adapterResponseSpendObserver(response: Response): ((event: AdapterEvent) => void) | undefined {
  const record = adapterResponseSpend.get(response);
  if (!record) return;
  return event => {
    if ("usage" in event && event.usage && adapterResponseSpend.delete(response)) record(event.usage);
  };
}

/** Settles one request's durable spend entries once its terminal usage is known. */
export interface RequestSpendSettlement {
  settle(usage: TerminalSpendUsage | undefined): void;
  /**
   * Bind the usage a routed response reports to the routed send that is latest when its parse
   * starts. Legs run in sequence, so that send is the one that produced the response (#8902).
   */
  captureRoutedSendUsage?(): ((usage: TerminalSpendUsage) => void) | undefined;
}

export interface SpendTargetIdentity extends SpendScopes {
  readonly targetKey?: string;
  /** Helpers preserve other bookings and do not own the routed model's terminal usage. */
  readonly auxiliary?: boolean;
  readonly estimate?: { inputTokens: number; outputCeilingTokens: number };
  /**
   * The target carries its own measured estimate (explicit native continuations). Unlike an
   * auxiliary target it still owns the routed model's terminal usage; unlike an anchor
   * rebind it never retires an unrelated pending booking and is never adopted by an
   * unkeyed same-scope lookup.
   */
  readonly explicitEstimate?: boolean;
  /** An opted-in retry owns a fresh reservation using the request's estimate. */
  readonly freshRetry?: boolean;
}
export interface RequestSpendReporter {
  start(seed: SpendSeed, ordinal: number): void;
  rebindTarget(target: SpendTargetIdentity, ordinal: number): boolean;
  recordUsage(ordinal: number, usage: TerminalSpendUsage | null): void;
  report(sends: number): void;
  close(): void;
}

export interface RequestSpendTracker extends RequestSendObserver, RequestSpendSettlement {
  /** Dispatches this request lost to a ledger ceiling. Zero on every ordinary request. */
  readonly refusals: number;
  /** Latest local admission decision, paired with the monotonic refusal count. */
  readonly lastRefusal?: { readonly reason: WorkflowDenial; readonly spend?: WorkflowSpendDenialDetail };
  readonly enforced: boolean;
  ensureSeed(target: SpendTargetIdentity, prepaidProof?: SpendReservationProof): SpendSeed | undefined;
  beginReporter(): RequestSpendReporter;
  reportFromSeed(seed: SpendSeed, ordinal: number): void;
  requestFinalSettlement(usage: TerminalSpendUsage | undefined): void;
}

/** Freeze only the numeric ceilings. Accounting mode is chosen at physical spend admission. */
export function captureRequestSpendPolicy(policy: SpendAdmissionPolicy = sharedSpendPolicy()): SpendAdmissionPolicy {
  return Object.freeze({ root: Object.freeze({ ...policy.root }), identity: Object.freeze({ ...policy.identity }), pool: Object.freeze({ ...policy.pool }) });
}

/**
 * The aggregate usage left for the last routed send once the other routed sends settled their own
 * readings, so no token is booked twice. Undefined when those readings account for all of it: the
 * last send then reported nothing of its own and stays unresolved.
 */
function netOfOtherSends(total: TerminalSpendUsage | undefined, others: readonly (TerminalSpendUsage | undefined)[]): TerminalSpendUsage | undefined {
  const settled = others.filter((usage): usage is TerminalSpendUsage => usage !== undefined);
  if (!total || settled.length === 0) return total;
  const remaining = (key: keyof TerminalSpendUsage): number | undefined => typeof total[key] === "number"
    ? Math.max(0, total[key] - settled.reduce((sum, usage) => sum + (usage[key] ?? 0), 0)) : undefined;
  const inputTokens = remaining("inputTokens");
  const outputTokens = remaining("outputTokens");
  return inputTokens || outputTokens ? { inputTokens, outputTokens } : undefined;
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
 * Image-recovery receipts carry their own usage, or null if usage is unknown. A request with one
 * routed send settles it with the aggregate terminal usage. When a request makes several routed
 * sends (a terminal-guard re-ask, an empty-completion retry, a hosted-search iteration), each send
 * settles with the usage its own response reported (#8902). The last routed send falls back to the
 * aggregate net of what the other sends reported, and is left unresolved if nothing remains. Other
 * unknown sends remain unresolved at their reservation estimates.
 */
export function createRequestSpendTracker(
  logCtx: Pick<
    RequestLogContext,
    "provider" | "accountLogLabel" | "usageLogInputTokens" | "spendOutputCeilingTokens" | "spendInputEstimateTokens" | "spendPoolId"
  > & Partial<Pick<RequestLogContext, "localTerminalReason" | "terminalSource" | "errorCode" | "spendRefusalDetail">>,
  rootId: string | undefined,
  injected?: SpendReservationLedger,
  capturedPolicy?: SpendAdmissionPolicy,
): RequestSpendTracker {
  // Resolved on the first CHARGE, not when the request is built. The shared ledger opens a
  // journal under the OpenCodex home, and a request that never dispatches -- refused at
  // admission, answered locally, cancelled before its first send -- has no business creating
  // one. It also means the home in effect at dispatch is the one that gets written.
  let ledgerRef: SpendReservationLedger | undefined = injected;
  const ledger = (): SpendReservationLedger => (ledgerRef ??= sharedSpendLedger());
  let admissionPolicy: SpendAdmissionPolicy | undefined;
  const capturePolicy = (): SpendAdmissionPolicy => capturedPolicy ??= captureRequestSpendPolicy(ledgerRef?.policy);
  let initialEnforced: boolean | undefined;
  let recoveryIdentityCeiling: number | undefined;
  let prepaidSpend: WeakMap<SpendReservationProof, { identityId?: string; tokens: number; hasInputEstimate: boolean }> | undefined;
  // Outstanding entries; exact dispatch reports move their reservation to the end.
  const live: string[] = [];
  const pendingDispatch = new Set<string>();
  let refusals = 0;
  let lastRefusal: RequestSpendTracker["lastRefusal"];
  let resolved = false;
  let terminalProcessed = false;
  let seededAccounting = false;
  let finalRequested = false;
  let finalUsage: TerminalSpendUsage | undefined;
  let reporters = 0;
  const seeds = new Map<string, { seed: SpendSeed; started: boolean; reported: boolean; auxiliary: boolean; independent: boolean; retryScopes?: SpendScopes; estimate?: { inputTokens: number; outputCeilingTokens: number } }>();
  const nonTerminalSendIds = new Set<string>();
  // Abandoned capabilities retain cleanup ownership, never admission lookup.
  const retiredSeeds = new Set<SpendSeed>();
  const resolvedSendIds = new Set<string>();
  const completedSeeds = new Set<SpendSeed>();
  const physical = new Map<number, { seed: SpendSeed; sendId?: string; reportPending?: boolean; reportComplete?: boolean;
    estimate?: { inputTokens: number; outputCeilingTokens: number }; usage?: TerminalSpendUsage | null; observed?: TerminalSpendUsage }>();
  // Legacy (unseeded) sends keyed by send id: the usage each routed response reported.
  const observedLegacy = new Map<string, TerminalSpendUsage>();
  const selectedScopes = (target: SpendTargetIdentity = {}): SpendScopes => ({
    ...(rootId !== undefined ? { rootId } : {}),
    ...(target.identityId ?? logCtx.accountLogLabel ? { identityId: target.identityId ?? logCtx.accountLogLabel } : {}),
    ...(target.poolId ?? logCtx.spendPoolId ?? logCtx.provider ? { poolId: target.poolId ?? logCtx.spendPoolId ?? logCtx.provider } : {}),
  });
  const policyApplies = (policy: SpendAdmissionPolicy, scopes: SpendScopes): boolean =>
    (scopes.rootId !== undefined && policy.root.maxTokens !== undefined)
    || (scopes.identityId !== undefined && policy.identity.maxTokens !== undefined)
    || (scopes.poolId !== undefined && policy.pool.maxTokens !== undefined);
  const applicable = (scopes: SpendScopes): boolean => initialEnforced
    ?? policyApplies(admissionPolicy ?? capturedPolicy ?? ledgerRef?.policy ?? sharedSpendPolicy(), scopes);
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
    const terminal = entries.findLast(([, entry]) => entry.sendId && !nonTerminalSendIds.has(entry.sendId))?.[1].sendId;
    const routed = entries.filter(([, entry]) => entry.sendId && !nonTerminalSendIds.has(entry.sendId)).map(([, entry]) => entry);
    const perSend = routed.length > 1;
    const terminalFallback = perSend
      ? netOfOtherSends(finalUsage, routed.filter(entry => entry.sendId !== terminal && entry.usage === undefined).map(entry => entry.observed))
      : finalUsage;
    const ids: string[] = [];
    for (const [, entry] of entries) {
      if (!entry.sendId) return false;
      // Recovery pins set null at dispatch to opt this receipt out of the aggregate fallback.
      const usage = entry.usage !== undefined ? entry.usage
        : perSend && entry.observed ? entry.observed
          : entry.sendId === terminal ? terminalFallback : undefined;
      const reported = typeof usage?.inputTokens === "number" || typeof usage?.outputTokens === "number";
      if (!resolvedSendIds.has(entry.sendId)) {
        const ok = reported ? ledger().settle(entry.sendId, { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 })
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
  const refusal = (denial: import("../../lib/spend-reservation-ledger").SpendDenial, terminal = true): void => {
        refusals += 1;
        // Preserve the PR's explicit unresolved-history refusal and its distinct operator code.
        if (denial.reason === "pool-history-unresolved") {
          lastRefusal = { reason: "workflow-pool-history-unresolved" };
          const summary = workflowDenialSummary("workflow-pool-history-unresolved");
          if (terminal) { markLocalRequestLogRefusal(logCtx, summary.code); logCtx.errorCode = summary.code; }
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
        lastRefusal = { reason, ...(detail ? { spend: detail } : {}) };
        const summary = workflowDenialSummary(reason, detail);
        if (terminal) {
          markLocalRequestLogRefusal(logCtx, summary.code);
          logCtx.errorCode = summary.code;
          if (detail?.includesUnboundPoolHistory) logCtx.spendRefusalDetail = detail;
        }
        recordWorkflowRefusalEvent(rootId, reason, Date.now(), detail);
        return;
  };
  /** Record a refused root claim here, including its counter, log and event; callers must not repeat it. */
  const claimWorkflowSend = (terminal = true): boolean => {
    if (reserveWorkflowSend(rootId, currentWorkflowBudgetPolicy())) return true;
    refusals++;
    lastRefusal = { reason: "workflow-sends-exhausted" };
    const summary = workflowDenialSummary("workflow-sends-exhausted");
    if (terminal) { markLocalRequestLogRefusal(logCtx, summary.code); logCtx.errorCode = summary.code; }
    recordWorkflowRefusalEvent(rootId, "workflow-sends-exhausted");
    return false;
  };
  const reserveObservedRecovery = (request: SpendReservationRequest, proof: SpendReservationProof | undefined) => {
    const identityId = request.scopes.identityId;
    if (resolved || !identityId || !proof || proof.ledger !== ledgerRef) return undefined;
    const delta = prepaidSpend?.get(proof);
    if (!delta) return undefined;
    const bookedLedger = proof.ledger;
    try {
      const missingAccountTokens = (delta.identityId === identityId ? 0 : delta.tokens)
        + (delta.hasInputEstimate ? 0 : request.inputTokens);
      if (missingAccountTokens > 0) {
        // Keep the delta's missing account liability live through resend admission.
        // Preserve any prepaid output cap and estimate unpriced input at the full frame cost.
        const booking = bookedLedger.reserve({ sendId: randomUUID(), scopes: { identityId },
          inputTokens: missingAccountTokens, outputCeilingTokens: 0, admissionPolicy: request.admissionPolicy, alreadySent: true });
        if (!booking.reserved) return booking;
        live.push(booking.sendId);
        nonTerminalSendIds.add(booking.sendId);
        prepaidSpend?.delete(proof);
        if (!bookedLedger.markDispatched(booking.sendId) || !booking.durable) return undefined;
      }
      return bookedLedger.reserve(request);
    } catch (error) {
      if (error instanceof SpendLedgerOwnerError) return undefined;
      throw error;
    }
  };
  const tracker: RequestSpendTracker = {
    recordWorkflowSend() { chargeWorkflowSends(rootId, 1); },
    beforePhysicalSend(auxiliary = false) {
      return claimWorkflowSend(!auxiliary);
    },
    startRequest(target) {
      if (admissionPolicy) return;
      admissionPolicy = capturePolicy();
      initialEnforced = applicable(selectedScopes(target));
      if (!initialEnforced) {
        recoveryIdentityCeiling = admissionPolicy.identity.maxTokens;
        admissionPolicy = Object.freeze({ root: Object.freeze({}), identity: Object.freeze({}), pool: Object.freeze({}) });
      }
    },
    // Combo prepayment can fix observe-only accounting before its child has an identity.
    // Optional hosted work still consults the original ceilings, never the live ledger policy.
    hasCapturedSpendCeiling(target) { return policyApplies(capturePolicy(), selectedScopes(target)); },
    get enforced(): boolean { return applicable(selectedScopes()); },
    get policyStarted(): boolean { return admissionPolicy !== undefined; },
    get spendAdmissionPolicy(): SpendAdmissionPolicy | undefined { return admissionPolicy ?? capturedPolicy; },
    ensureSeed(target, prepaidProof) {
      tracker.startRequest?.(target);
      if (resolved || finalRequested && reporters === 0) return undefined;
      const scopes = selectedScopes(target);
      if (!applicable(scopes)) return undefined;
      const independent = target.explicitEstimate === true || target.freshRetry === true;
      const key = JSON.stringify([scopes.rootId, scopes.identityId, scopes.poolId, target.targetKey,
        ...(target.freshRetry ? [randomUUID()] : [])]);
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
      if (target.targetKey === undefined && !target.freshRetry) {
        const same = [...seeds.entries()].find(([candidate, candidateState]) => {
          const identity = JSON.parse(candidate) as Array<string | undefined>;
          return !candidateState.independent
            && identity[0] === (scopes.rootId ?? null) && identity[1] === (scopes.identityId ?? null) && identity[2] === (scopes.poolId ?? null);
        });
        if (same) return same[1].seed;
      }
      // Rebind an unused provisional anchor before selection changes. Dispatched anchors stay
      // live, and an independent send neither retires nor is retired by another leg:
      // both directions would destroy a booking its own reporter still owns.
      for (const [oldKey, state] of seeds) if (!state.started && !state.independent && !target.auxiliary && !independent) {
        if (!retireSeed(oldKey, state.seed)) return undefined;
      }
      // Exact prepaid proofs originate from this tracker and are found above; foreign receipts
      // cannot enroll arbitrary scopes. Normal reservation remains the only initial admission.
      if (prepaidProof && prepaidProof.ledger !== ledger()) return undefined;
      const estimate = target.freshRetry ? target.estimate ?? estimates()
        : target.auxiliary || target.explicitEstimate ? target.estimate : undefined;
      const decision = ledger().reserveSeed({ sendId: randomUUID(), scopes, ...(estimate ?? estimates()), admissionPolicy }, tracker);
      if (!decision.reserved) {
        // Use the established denial mapping without making another reservation.
        refusal(decision.denial, !target.auxiliary && !target.freshRetry);
        return undefined;
      }
      seededAccounting = true;
      seeds.set(key, { seed: decision.seed, started: false, reported: false, auxiliary: target.auxiliary === true,
        independent, estimate, ...(target.freshRetry ? { retryScopes: scopes } : {}) });
      return decision.seed;
    },
    releaseSeed(seed) {
      const entry = [...seeds.entries()].find(([, state]) => state.seed === seed);
      // A started send or another tracker's seed retains its owner and settlement duty.
      if (entry && !entry[1].started) retireSeed(entry[0], seed);
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
          if (old.retryScopes) {
            const next = selectedScopes(target);
            if (old.retryScopes.identityId === next.identityId && old.retryScopes.poolId === next.poolId) return true;
          }
          // A helper start is provisional until selection reaches the executor. If this is
          // the first start on its seed, abandon/rebind at NORMAL capacity before the wire.
          physical.delete(ordinal);
          old.started = [...physical.values()].some(start => start.seed === old.seed);
          let seed: SpendSeed | undefined;
          try {
            if (old.retryScopes) tracker.releaseSeed?.(old.seed);
            seed = tracker.ensureSeed(old.retryScopes ? { ...target, estimate: old.estimate, freshRetry: true } : target);
          } finally {
            if (!seed) starts.splice(starts.indexOf(owned), 1);
          }
          if (!seed) return false;
          physical.set(ordinal, { seed });
          owned.seed = seed;
          seedState(seed)!.started = true;
          return true;
        },
        recordUsage(ordinal, usage) {
          const entry = physical.get(ordinal);
          if (!resolved && entry && starts.some(start => start.ordinal === ordinal)) entry.usage = usage;
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
      if (state.auxiliary) nonTerminalSendIds.add(sendId);
      const estimate = entry.estimate ??= state.estimate ?? estimates();
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
    captureRoutedSendUsage() {
      if (resolved) return undefined;
      if (seededAccounting) {
        const ordinal = [...physical.entries()].filter(([, entry]) => seedState(entry.seed)?.auxiliary !== true)
          .reduce<number | undefined>((latest, [order]) => latest === undefined || order > latest ? order : latest, undefined);
        if (ordinal === undefined) return undefined;
        return usage => {
          const entry = physical.get(ordinal);
          if (!resolved && entry && entry.observed === undefined) entry.observed = usage;
        };
      }
      const sendId = live.findLast(id => !nonTerminalSendIds.has(id));
      if (sendId === undefined) return undefined;
      return usage => { if (!resolved && !observedLegacy.has(sendId)) observedLegacy.set(sendId, usage); };
    },
    charge(options?: Parameters<RequestSendObserver["charge"]>[0]): boolean {
      tracker.startRequest?.(options?.scopes);
      // A send that has already left is RECORDED, never refused: the tokens are spent, and a
      // booking the ledger drops is a booking the ceiling can never see. This is the reporting
      // transports' path -- the passthrough ladder reports through `onSendsConsumed` after the
      // fetch -- so without it a root ceiling on the canonical Codex path would sit one send
      // short of its limit forever and refuse nothing.
      const alreadySent = options?.alreadySent === true;
      if (!options?.deferDispatch && !options?.workflowAlreadyCounted) {
        if (alreadySent) chargeWorkflowSends(rootId, 1);
        else if (!claimWorkflowSend(!options?.auxiliary)) return false;
      }
      const recovery = !alreadySent && options?.incrementalRecovery;
      let estimate = options?.auxiliary && options.estimate ? options.estimate : estimates();
      const hasInputEstimate = Number.isFinite(estimate.inputTokens) && estimate.inputTokens >= 1;
      const needsRecoveryEstimate = !!recovery && !hasInputEstimate;
      if (needsRecoveryEstimate) {
        const inputTokens = recovery.inputEstimateTokens;
        if (inputTokens === undefined || !Number.isSafeInteger(inputTokens) || inputTokens < 1) return false;
        estimate = { ...estimate, inputTokens };
      }
      if (!alreadySent && tracker.enforced) {
        const seed = tracker.ensureSeed({ ...options?.scopes, targetKey: options?.targetKey,
          ...(options?.auxiliary ? { auxiliary: true, estimate: options.estimate }
            : recovery ? { explicitEstimate: true, estimate } : {}) });
        if (!seed) return false;
        options?.onReserved?.({ ledger: ledger(), sendId: seed.sendId });
        return true;
      }
      const sendId = randomUUID();
      const bookedLedger = ledger();
      const scopes: SpendScopes = options?.scopes ? selectedScopes(options.scopes) : {
        ...(rootId !== undefined ? { rootId } : {}),
        // Already the privacy-safe label the request log uses, and the ledger aliases it
        // again on the way to disk. A raw credential never reaches either.
        ...(logCtx.accountLogLabel !== undefined ? { identityId: logCtx.accountLogLabel } : {}),
        ...((logCtx.spendPoolId ?? logCtx.provider) !== undefined
          ? { poolId: logCtx.spendPoolId ?? logCtx.provider }
          : {}),
      };
      const enforceRecovery = Boolean(recovery) && recoveryIdentityCeiling !== undefined;
      const policy = enforceRecovery
        ? { ...admissionPolicy!, identity: { maxTokens: recoveryIdentityCeiling } }
        : admissionPolicy!;
      const enforced = (scopes.rootId !== undefined && policy.root.maxTokens !== undefined)
        || (scopes.identityId !== undefined && policy.identity.maxTokens !== undefined)
        || (scopes.poolId !== undefined && policy.pool.maxTokens !== undefined);
      const reservation: SpendReservationRequest = {
        sendId,
        scopes,
        admissionPolicy: policy,
        ...estimate,
        ...(alreadySent ? { alreadySent: true } : {}),
      };
      const decision = recovery && enforceRecovery
        ? reserveObservedRecovery(reservation, recovery.prepaidDelta)
        : bookedLedger.reserve(reservation);
      if (!decision) return false;
      if (!decision.reserved) {
        if (enforceRecovery) { refusal(decision.denial, false); return false; }
        // An applicable ceiling cannot authorize an unbooked send, including when tracking
        // capacity is full. Unconfigured/nonapplicable requests remain observe-only, and a
        // physical send reported after dispatch cannot be refused retroactively.
        if (alreadySent || !enforced) return true;
        refusal(decision.denial, !options?.auxiliary);
        return false;
      }
      if (!alreadySent && options?.onReserved) {
        const proof = { ledger: bookedLedger, sendId };
        if (!recovery && recoveryIdentityCeiling !== undefined && decision.durable) {
          (prepaidSpend ??= new WeakMap()).set(proof, { identityId: scopes.identityId, tokens: decision.tokens, hasInputEstimate });
        }
        options.onReserved(proof);
      }
      live.push(sendId);
      if (options?.auxiliary) nonTerminalSendIds.add(sendId);
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
          const terminalIndex = live.findLastIndex(sendId => !nonTerminalSendIds.has(sendId));
          const terminal = live[terminalIndex];
          const routed = live.filter(sendId => !nonTerminalSendIds.has(sendId));
          if (routed.length > 1 && terminal !== undefined) {
            usage = observedLegacy.get(terminal)
              ?? netOfOtherSends(usage, routed.filter(sendId => sendId !== terminal).map(sendId => observedLegacy.get(sendId)));
          }
          const reported = typeof usage?.inputTokens === "number" || typeof usage?.outputTokens === "number";
          if (terminal && reported) {
            ledger().settle(terminal, {
              inputTokens: usage?.inputTokens ?? 0,
              outputTokens: usage?.outputTokens ?? 0,
            });
          } else if (terminal) {
            // The response never reported usage. It may still have been billed.
            ledger().markLost(terminal);
          }
          if (terminalIndex >= 0) live.splice(terminalIndex, 1);
          terminalProcessed = true;
        }
        while (live.length > 0) {
          const sendId = live[live.length - 1] as string;
          const observed = observedLegacy.get(sendId);
          if (observed && !nonTerminalSendIds.has(sendId)) {
            ledger().settle(sendId, { inputTokens: observed.inputTokens ?? 0, outputTokens: observed.outputTokens ?? 0 });
          } else ledger().markLost(sendId);
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
    get lastRefusal() { return lastRefusal; },
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
  capturedPolicy?: SpendAdmissionPolicy,
): RequestSpendTracker {
  const existing = logCtx.spendTracker as RequestSpendTracker | undefined;
  if (existing && trackerRequests.get(existing) === req) return existing;
  const rootId = req.headers.get("x-codex-parent-thread-id")?.trim() || undefined;
  const tracker = createRequestSpendTracker(logCtx, rootId, ledger, capturedPolicy);
  logCtx.spendTracker = tracker;
  trackerRequests.set(tracker, req);
  return tracker;
}
