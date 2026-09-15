/**
 * Root-workflow admission: a finite budget above the logical request (#4546).
 *
 * The per-request send budget bounds how many times ONE request reaches upstream. It cannot
 * bound how many requests a fan-out makes. A worker that spawns seven hundred children, each
 * of which sends exactly once, never violates a per-request cap and still spends the account.
 * That is the second half of the #4546 incident and it needs a ceiling of its own.
 *
 * The unit is the root workflow -- the user-visible task -- identified by the parent thread
 * header when the client supplies one. A retry is not a new user task and gets no new
 * allowance; a genuinely new top-level request does.
 *
 * Two caps intersect here. The COUNT caps (concurrency, distinct children, physical sends)
 * are process-local and in-memory. The TOKEN cap is the durable spend-reservation ledger in
 * spend-reservation-ledger.ts: when the caller supplies a spend request, admission also
 * reserves input + enforceable output ceiling against the root, identity and pool scopes,
 * and that accounting survives a restart. The count caps alone remain the guarantee for a
 * second process sharing the pool; the durable ledger's single-process topology is stated
 * in that module's header and applies here unchanged.
 */

import {
  sharedSpendLedger,
  type SpendReservationLedger,
  type SpendScope,
  type SpendUsage,
} from "./spend-reservation-ledger";

export interface WorkflowBudgetPolicy {
  /** Children admitted concurrently under one root. */
  readonly maxConcurrentChildren: number;
  /** Physical model sends charged to one root INSIDE {@link WorkflowBudgetPolicy.windowMs}. */
  readonly maxPhysicalSends: number;
  /** Distinct children one root may have inside the same window. */
  readonly maxDistinctChildren: number;
  /**
   * The interval both counts are measured over.
   *
   * These were lifetime totals, and a lifetime total is the wrong instrument. The cap was
   * written against a fan-out that sends once per child seven hundred times, which is a RATE;
   * a running total cannot tell that from an ordinary session spread over an afternoon and
   * refuses both. Because the root id is the caller thread, for Codex that made the ceiling a
   * session expiry: a session reaching it was refused for the rest of the process even after
   * going idle for hours, and the only cure was restarting the proxy.
   *
   * Omitted means {@link WORKFLOW_DEFAULT_WINDOW_MS}. A count inside a window is never larger
   * than the same count over a lifetime, so windowing can only ever admit more for identical
   * traffic -- no install sees a refusal it would not have seen before.
   */
  readonly windowMs?: number;
  /**
   * Concurrency slots a fan-out may never take. An interactive turn arriving into a saturated
   * root still gets admitted; without this a worker burst starves the conversation it serves.
   */
  readonly interactiveReserve: number;
  /**
   * Roots tracked at once, as a hard bound rather than a hint. At the ceiling one idle,
   * under-limit root is evicted to make room; when no root may be forgotten safely the new
   * root is REFUSED with `workflow-tracking-exhausted`. Admitting it anyway is what made a
   * caller minting new ids able to grow this map past the number written here.
   */
  readonly maxTrackedRoots: number;
}

/**
 * Ten minutes. Long enough that the burst this ceiling was written against -- seven hundred
 * sends in a minute -- is still refused several times over, and short enough that an ordinary
 * session, which averages far less than a send every two seconds, never approaches it.
 */
export const WORKFLOW_DEFAULT_WINDOW_MS = 10 * 60_000;

export const DEFAULT_WORKFLOW_BUDGET_POLICY: WorkflowBudgetPolicy = {
  maxConcurrentChildren: 8,
  maxPhysicalSends: 256,
  maxDistinctChildren: 64,
  interactiveReserve: 1,
  maxTrackedRoots: 512,
  windowMs: WORKFLOW_DEFAULT_WINDOW_MS,
};

/** Fixed ring size. Ten minutes over twelve slots gives fifty-second granularity. */
const WORKFLOW_WINDOW_SLOTS = 12;

function workflowWindowMs(policy: WorkflowBudgetPolicy): number {
  const declared = policy.windowMs;
  return declared !== undefined && Number.isFinite(declared) && declared > 0
    ? declared
    : WORKFLOW_DEFAULT_WINDOW_MS;
}

/**
 * Slot size for one root's own window.
 *
 * The geometry is read off the state rather than off whatever policy the current caller
 * happens to hold. Two callers may legitimately pass different policies for the same root --
 * the ceiling numbers are the caller's business -- but if they also disagreed about
 * `windowMs`, the slot ids one of them wrote would be on a scale the other cannot read, and
 * charging with a long window while reading with a short one makes every stored slot look
 * ancient and the ceiling never fire at all.
 */
function windowSlotMs(windowMs: number): number {
  return Math.max(1, Math.ceil(windowMs / WORKFLOW_WINDOW_SLOTS));
}

/**
 * Add sends to the ring, resetting a slot whose turn has come round again.
 *
 * A ring rather than a list of timestamps because the storage has to be bounded: a root that
 * sends forever would otherwise grow forever, and this ledger exists to bound a fan-out.
 */
function recordWindowedSends(state: WorkflowState, now: number, sends: number): void {
  const slotMs = windowSlotMs(state.windowMs);
  const slot = Math.floor(now / slotMs);
  const index = ((slot % WORKFLOW_WINDOW_SLOTS) + WORKFLOW_WINDOW_SLOTS) % WORKFLOW_WINDOW_SLOTS;
  if (state.sendSlotAt[index] !== slot) {
    state.sendSlotAt[index] = slot;
    state.sendSlotCount[index] = 0;
  }
  state.sendSlotCount[index] = (state.sendSlotCount[index] ?? 0) + sends;
}

/** Sends inside the window. A slot older than the window contributes nothing. */
function windowedSends(state: WorkflowState, now: number): number {
  const slotMs = windowSlotMs(state.windowMs);
  const oldest = Math.floor(now / slotMs) - (WORKFLOW_WINDOW_SLOTS - 1);
  let total = 0;
  for (let index = 0; index < WORKFLOW_WINDOW_SLOTS; index += 1) {
    if ((state.sendSlotAt[index] ?? Number.NEGATIVE_INFINITY) >= oldest) {
      total += state.sendSlotCount[index] ?? 0;
    }
  }
  return total;
}

/**
 * Forget children last seen before the window opened, and report how many remain.
 *
 * Pruning on read keeps the map bounded without a timer: every admission pays for the children
 * it can still see, and a root that goes quiet is cleaned up the next time it speaks.
 */
function windowedChildren(state: WorkflowState, now: number): number {
  const cutoff = now - state.windowMs;
  for (const [childId, lastSeenMs] of state.children) {
    if (lastSeenMs <= cutoff) state.children.delete(childId);
  }
  return state.children.size;
}

export type WorkflowDenial =
  | "workflow-concurrency-exhausted"
  | "workflow-sends-exhausted"
  | "workflow-children-exhausted"
  | "workflow-spend-exhausted"
  /**
   * The root table is full and every entry is active or exhausted, so admitting this root
   * would mean evicting one whose ceiling has already fired. Refusing is the honest answer:
   * `maxTrackedRoots` is a bound, and inserting anyway made it a suggestion.
   */
  | "workflow-tracking-exhausted"
  /** This send id was already reserved once; a repeat buys no second dispatch. */
  | "workflow-send-replayed"
  /** The reservation could not be made durable, and a configured ceiling requires it. */
  | "workflow-spend-undurable";

/**
 * The sentence an operator reads, plus the machine-readable name of the ceiling that fired.
 *
 * All four count denials used to share one sentence about a "concurrent-work limit", which was
 * accurate for exactly one of them. Worse, the wire cannot carry the distinction on its own:
 * `classifyError` rewrites every 429 to `rate_limit_error` / `rate_limit_exceeded`, so the body
 * of a refusal this proxy made is shaped exactly like a provider rate limit. Each sentence
 * therefore says which ceiling fired AND that no provider was contacted, because that is the
 * first thing an operator needs and the only place left to put it.
 */
export function workflowDenialSummary(reason: WorkflowDenial): { code: string; message: string } {
  switch (reason) {
    case "workflow-sends-exhausted":
      return {
        code: "workflow_sends_exhausted",
        message: "This proxy refused the request locally: the task reached its send ceiling for"
          + " the current window, so no provider was contacted. The window rolls forward on its"
          + " own; work already in flight settles as it finishes.",
      };
    case "workflow-children-exhausted":
      return {
        code: "workflow_children_exhausted",
        message: "This proxy refused the request locally: the task reached its ceiling on"
          + " distinct child threads for the current window, so no provider was contacted."
          + " A child that goes quiet ages out of the count.",
      };
    case "workflow-concurrency-exhausted":
      return {
        code: "workflow_concurrency_exhausted",
        message: "This proxy refused the request locally: the task has no free concurrency slot,"
          + " so no provider was contacted. Slots are released as the turns holding them finish.",
      };
    case "workflow-spend-exhausted":
      return {
        code: "workflow_spend_exhausted",
        message: "This proxy refused the request locally: the task reached a configured token"
          + " ceiling, so no provider was contacted.",
      };
    case "workflow-tracking-exhausted":
      return {
        code: "workflow_tracking_exhausted",
        message: "This proxy refused the request locally: it is already tracking as many tasks as"
          + " it may, and every one of them is busy or over its own ceiling, so no provider was"
          + " contacted.",
      };
    case "workflow-send-replayed":
      return {
        code: "workflow_send_replayed",
        message: "This proxy refused the request locally: this send was already reserved once, and"
          + " a repeat buys no second dispatch.",
      };
    case "workflow-spend-undurable":
      return {
        code: "workflow_spend_undurable",
        message: "This proxy refused the request locally: the token reservation could not be made"
          + " durable and a configured ceiling requires it, so no provider was contacted.",
      };
  }
}

/**
 * Response header naming the ceiling that refused, on a refusal this proxy made itself.
 *
 * It exists because the body cannot carry it: `classifyError` rewrites every 429 to
 * `rate_limit_error` / `rate_limit_exceeded`, so a local refusal and a provider rate limit are
 * byte-identical in shape. Changing that classification would change how every client retries,
 * so the name goes beside the body instead. No upstream sets this header, which is precisely
 * what makes its presence conclusive.
 */
export const WORKFLOW_LOCAL_REFUSAL_HEADER = "x-opencodex-local-refusal";

export type WorkflowBudgetEventKind = "refused" | "cleared";

export interface WorkflowBudgetEvent {
  readonly at: number;
  readonly kind: WorkflowBudgetEventKind;
  readonly rootId: string;
  /** The ceiling that fired. Present for `refused`, absent for `cleared`. */
  readonly reason?: WorkflowDenial;
  /** Windowed sends at the moment of the event. */
  readonly sends: number;
  /** Windowed distinct children at the moment of the event. */
  readonly children: number;
}

/**
 * How many events are kept. Small on purpose: this is an operator's recent-history view, not an
 * audit log, and it lives in the same process memory the ceilings do.
 */
export const WORKFLOW_EVENT_CAPACITY = 64;

const budgetEvents: WorkflowBudgetEvent[] = [];

/**
 * Record a local budget decision.
 *
 * This exists because the refusal has nowhere else to go. The HTTP admission check runs before
 * the body is parsed, so there is no model, no provider and no request-log context to attach to;
 * writing a usage row there would mean inventing both. Every entry here is by construction a
 * decision this proxy made without contacting anyone, which is a stronger statement than a flag
 * on a row shared with upstream results.
 */
function recordBudgetEvent(event: WorkflowBudgetEvent): void {
  budgetEvents.push(event);
  while (budgetEvents.length > WORKFLOW_EVENT_CAPACITY) budgetEvents.shift();
}

/** Newest first. `limit` is clamped to what is actually kept. */
export function listWorkflowBudgetEvents(limit: number = WORKFLOW_EVENT_CAPACITY): WorkflowBudgetEvent[] {
  const wanted = Number.isFinite(limit) && limit > 0
    ? Math.min(Math.floor(limit), WORKFLOW_EVENT_CAPACITY)
    : 0;
  if (wanted === 0) return [];
  return budgetEvents.slice(-wanted).reverse();
}

/**
 * Record a refusal decided outside `admitWorkflowTurn`.
 *
 * The pre-dispatch ceiling check in the responses path is a second refusal, taken after
 * admission already succeeded, so nothing in this module sees it. Without this it was the one
 * refusal an operator could hit that left no event behind.
 */
export function recordWorkflowRefusalEvent(
  rootId: string | undefined,
  reason: WorkflowDenial,
  now: number = Date.now(),
): void {
  if (!rootId) return;
  const state = roots.get(rootId);
  recordBudgetEvent({
    at: now,
    kind: "refused",
    rootId,
    reason,
    sends: state ? windowedSends(state, now) : 0,
    children: state ? windowedChildren(state, now) : 0,
  });
}

export type WorkflowLane = "interactive" | "worker";

export interface WorkflowAdmission {
  readonly rootId: string;
  /**
   * The request is about to leave for upstream. Call this at the dispatch boundary: until it
   * runs, releasing the lease costs nothing, and after it a missing usage frame is booked as
   * unresolved spend.
   */
  markDispatched(): void;
  release(): void;
}

export type WorkflowDecision =
  | { admitted: true; lease: WorkflowAdmission }
  | {
      admitted: false;
      reason: WorkflowDenial;
      rootId: string;
      /** Which spend scope refused, when the denial came from the token ledger. */
      spendScope?: SpendScope;
    };

/**
 * Token reservation attached to an admission. `outputCeilingTokens` is the ENFORCEABLE
 * ceiling -- the caller's max_output_tokens or the model's documented cap, never an
 * optimistic estimate and never shrunk by a cache-hit expectation. Omitting `spend`
 * entirely keeps the historical count-only admission, which is also what an unconfigured
 * install gets: token accounting is observed by default and refuses nothing until an
 * operator sets real limits.
 */
export interface WorkflowSpendRequest {
  /** Stable id of the physical send; settlement is idempotent on this key. */
  readonly sendId: string;
  readonly identityId?: string;
  readonly poolId?: string;
  readonly inputTokens: number;
  readonly outputCeilingTokens: number;
}

interface WorkflowState {
  active: number;
  /** Lifetime total, kept for diagnostics only. The ceiling reads the window instead. */
  sends: number;
  /** Ring of per-slot send counts; sendSlotAt[i] names the slot that bucket holds. */
  sendSlotCount: number[];
  sendSlotAt: number[];
  /** Child id to the last time it was admitted, so a child that stops ages out of the count. */
  children: Map<string, number>;
  lastSeenMs: number;
  /** Window this root's ring and child map are measured over, fixed when the root appeared. */
  windowMs: number;
}

function newWorkflowState(now: number, policy: WorkflowBudgetPolicy): WorkflowState {
  return {
    active: 0,
    sends: 0,
    sendSlotCount: new Array<number>(WORKFLOW_WINDOW_SLOTS).fill(0),
    sendSlotAt: new Array<number>(WORKFLOW_WINDOW_SLOTS).fill(Number.NEGATIVE_INFINITY),
    children: new Map<string, number>(),
    lastSeenMs: now,
    windowMs: workflowWindowMs(policy),
  };
}

const roots = new Map<string, WorkflowState>();

/**
 * Evict the oldest root that is safe to forget, and report whether one was found.
 *
 * The return value is the point. An earlier version returned void and the caller inserted
 * the new root regardless, so `maxTrackedRoots` bounded nothing whenever every candidate
 * was active or exhausted -- which is precisely the fan-out this file exists to bound.
 */
function evictOneRoot(
  policy: WorkflowBudgetPolicy,
  spendLedger?: SpendReservationLedger,
  now: number = Date.now(),
): boolean {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, state] of roots) {
    // An active root is never evicted: dropping it would hand its fan-out a fresh allowance,
    // which is the exact laundering this ledger exists to prevent. The same holds for an
    // EXHAUSTED-but-idle root -- count-exhausted or spend-exhausted -- because recreating it
    // fresh under the same id resets the very ceiling that already fired.
    if (state.active > 0) continue;
    if (windowedSends(state, now) >= policy.maxPhysicalSends) continue;
    if (spendLedger?.exhausted("root", key) === true) continue;
    if (state.lastSeenMs < oldestAt) { oldestAt = state.lastSeenMs; oldestKey = key; }
  }
  if (oldestKey === undefined) return false;
  roots.delete(oldestKey);
  return true;
}

/**
 * Admit one turn under a root workflow.
 *
 * `childId` distinguishes the members of a fan-out; omit it for the root's own turns.
 * An interactive lane may use the reserved slots a worker lane may not.
 *
 * When `spend` is given, admission also reserves its tokens on the spend ledger -- at the
 * root, identity and pool scopes at once -- before a concurrency slot is taken. A turn
 * released without settlement is resolved by whether it was ever DISPATCHED: an undispatched
 * turn gives its tokens back, and a dispatched one keeps them as unresolved spend, because a
 * send whose usage never arrived may still have been billed. Call `lease.markDispatched()`
 * at the point the request leaves for upstream; without it, admission followed by a local
 * validation or routing failure would book spend that never happened.
 */
export function admitWorkflowTurn(
  rootId: string | undefined,
  lane: WorkflowLane,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  childId?: string,
  now: number = Date.now(),
  spend?: WorkflowSpendRequest,
  spendLedger?: SpendReservationLedger,
): WorkflowDecision | undefined {
  if (!rootId) return undefined;
  // An explicit ledger is consulted even without a spend request, so root eviction can
  // still see spend-exhausted entries. With neither, no token tracking is in play.
  const ledger = spendLedger ?? (spend ? sharedSpendLedger() : undefined);
  let state = roots.get(rootId);
  // Every refusal below goes on the record through this one seam. Recording at each return
  // site instead of at the HTTP caller is what makes the record complete: the spend denials
  // are decided inside the ledger branch and never surface as a distinct reason to the caller
  // that formats the response.
  const refuse = (reason: WorkflowDenial, spendScope?: SpendScope): WorkflowDecision => {
    const current = roots.get(rootId);
    recordBudgetEvent({
      at: now,
      kind: "refused",
      rootId,
      reason,
      sends: current ? windowedSends(current, now) : 0,
      children: current ? windowedChildren(current, now) : 0,
    });
    return { admitted: false, reason, rootId, ...(spendScope ? { spendScope } : {}) };
  };
  if (!state) {
    if (roots.size >= policy.maxTrackedRoots && !evictOneRoot(policy, ledger, now)) {
      // Nothing may be forgotten, so the new root is refused instead of admitted over the
      // bound. The alternative -- evicting an exhausted root -- resets the ceiling that
      // already fired, and a caller minting fresh ids would get unlimited budget from it.
      return refuse("workflow-tracking-exhausted");
    }
    state = newWorkflowState(now, policy);
    roots.set(rootId, state);
  }
  state.lastSeenMs = now;

  if (windowedSends(state, now) >= policy.maxPhysicalSends) {
    return refuse("workflow-sends-exhausted");
  }
  if (childId !== undefined && !state.children.has(childId)
    && windowedChildren(state, now) >= policy.maxDistinctChildren) {
    return refuse("workflow-children-exhausted");
  }
  const ceiling = lane === "worker"
    ? Math.max(0, policy.maxConcurrentChildren - policy.interactiveReserve)
    : policy.maxConcurrentChildren;
  if (state.active >= ceiling) {
    return refuse("workflow-concurrency-exhausted");
  }

  if (spend && ledger) {
    const decision = ledger.reserve({
      sendId: spend.sendId,
      scopes: { rootId, identityId: spend.identityId, poolId: spend.poolId },
      inputTokens: spend.inputTokens,
      outputCeilingTokens: spend.outputCeilingTokens,
      at: now,
    });
    if (!decision.reserved) {
      const denial = decision.denial;
      // Every ledger refusal denies a DISPATCH. A duplicate send id and an undurable
      // reservation are reported as themselves rather than folded into "exhausted", because
      // an operator reading a 429 needs to know which of the three happened.
      const reason: WorkflowDenial = denial.reason === "duplicate-send-id"
        ? "workflow-send-replayed"
        : denial.reason === "reserve-not-durable" || denial.reason === "journal-corrupt"
          ? "workflow-spend-undurable"
          : denial.reason === "tracking-capacity-exhausted"
            ? "workflow-tracking-exhausted"
            : "workflow-spend-exhausted";
      return refuse(
        reason,
        denial.reason === "spend-limit-exceeded" ? denial.scope : undefined,
      );
    }
  }

  state.active += 1;
  if (childId !== undefined) state.children.set(childId, now);
  let released = false;
  return {
    admitted: true,
    lease: {
      rootId,
      markDispatched(): void {
        if (spend && ledger) ledger.markDispatched(spend.sendId);
      },
      release(): void {
        if (released) return;
        released = true;
        const current = roots.get(rootId);
        if (current) {
          current.active = Math.max(0, current.active - 1);
          // Eviction ordering only; no ceiling reads lastSeenMs, so the wall clock is the
          // right source here and a caller does not need to inject one.
          current.lastSeenMs = Date.now();
        }
        // Which of the two applies depends on whether the send ever left this process.
        // `abandon` succeeds only while the reservation is undispatched -- a turn refused by
        // local validation or routing releases its tokens and books nothing, because
        // inventing debt the account never incurred breaks the budget in the other
        // direction. Once dispatched, abandon refuses and markLost keeps the cost as
        // unresolved spend, since a send whose usage frame never arrived may still have been
        // billed. Both are no-ops once settleWorkflowSpend already ran.
        if (spend && ledger && !ledger.abandon(spend.sendId)) ledger.markLost(spend.sendId);
      },
    },
  };
}

/**
 * Charge physical sends to a root. Called from the send budget's own accounting so a retry
 * inside one request counts toward the workflow total, not only the request total.
 */
export function chargeWorkflowSends(
  rootId: string | undefined,
  sends: number,
  now: number = Date.now(),
): void {
  if (!rootId || sends <= 0) return;
  const state = roots.get(rootId);
  if (!state) return;
  state.sends += sends;
  // Geometry comes off the root itself, so no caller can charge on one scale and read on
  // another. This function does not take a policy at all any more: it has no ceiling to
  // compare, and the only thing a policy could have supplied here was that scale.
  recordWindowedSends(state, now, sends);
  state.lastSeenMs = now;
}

/**
 * Settle a send's reservation with the usage the response actually reported. Idempotent
 * per send id -- a second call returns false and books nothing. When the usage frame was
 * lost, call this never and let the lease's release move the reservation to unresolved
 * spend, or call the ledger's markLost directly.
 */
export function settleWorkflowSpend(
  sendId: string,
  usage: SpendUsage,
  spendLedger?: SpendReservationLedger,
): boolean {
  return (spendLedger ?? sharedSpendLedger()).settle(sendId, usage);
}

/**
 * Record that the send left for upstream.
 *
 * This is the line between "may be released for free" and "may have been billed". Admission
 * alone is not dispatch: a turn can be admitted and then fail request validation, provider
 * routing, or a local guard without a single byte reaching a model. Booking those as spend
 * invents debt the account never incurred, so the reservation only becomes unresolvable
 * after this call.
 */
export function dispatchWorkflowSpend(sendId: string, spendLedger?: SpendReservationLedger): boolean {
  return (spendLedger ?? sharedSpendLedger()).markDispatched(sendId);
}

/**
 * Give a reservation back because the send never happened. Refused once dispatched, where
 * settle or markLost is the only honest outcome.
 */
export function abandonWorkflowSpend(sendId: string, spendLedger?: SpendReservationLedger): boolean {
  return (spendLedger ?? sharedSpendLedger()).abandon(sendId);
}

/**
 * Whether this root has already spent its whole physical-send ceiling.
 *
 * Separate from `admitWorkflowTurn` so a caller can refuse before dispatch without taking a
 * concurrency slot it would have to remember to release.
 */
export function workflowSendCeilingReached(
  rootId: string | undefined,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  now: number = Date.now(),
): boolean {
  if (!rootId) return false;
  const state = roots.get(rootId);
  return state !== undefined && windowedSends(state, now) >= policy.maxPhysicalSends;
}

export interface WorkflowBudgetSnapshot {
  active: number;
  /** Sends inside the window. This is the number the ceiling compares. */
  sends: number;
  /** Children inside the window, which is likewise what the ceiling compares. */
  children: number;
  /** Everything the root has ever sent, for diagnostics; no ceiling reads it. */
  lifetimeSends: number;
  windowMs: number;
  maxPhysicalSends: number;
  maxDistinctChildren: number;
}

export function workflowBudgetSnapshot(
  rootId: string,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  now: number = Date.now(),
): WorkflowBudgetSnapshot | undefined {
  const state = roots.get(rootId);
  if (!state) return undefined;
  return {
    active: state.active,
    sends: windowedSends(state, now),
    children: windowedChildren(state, now),
    lifetimeSends: state.sends,
    windowMs: state.windowMs,
    maxPhysicalSends: policy.maxPhysicalSends,
    maxDistinctChildren: policy.maxDistinctChildren,
  };
}

/**
 * Roots this process is currently tracking, most recently active first.
 *
 * Bounded by `limit` because `maxTrackedRoots` is 512 and an operator asking what is going on
 * wants the busy end of that, not a dump.
 */
export function listTrackedWorkflowRoots(
  limit = 64,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  now: number = Date.now(),
): Array<{ rootId: string } & WorkflowBudgetSnapshot> {
  const wanted = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 0;
  if (wanted === 0) return [];
  return [...roots.entries()]
    .sort((left, right) => right[1].lastSeenMs - left[1].lastSeenMs)
    .slice(0, wanted)
    .flatMap(([rootId]) => {
      const snapshot = workflowBudgetSnapshot(rootId, policy, now);
      return snapshot ? [{ rootId, ...snapshot }] : [];
    });
}

/**
 * Clear ONE root's windowed count ceilings, and report what they were.
 *
 * Three things are deliberately left alone. `active` belongs to turns still in flight, and
 * zeroing it would let their releases drive the count negative and hand out concurrency slots
 * that are already taken. The spend ledger is a token budget an operator did not ask to
 * forgive, and a count ceiling is not a licence to reset it. `sends` -- the lifetime total --
 * survives too, so the record of what this root actually did cannot be laundered by clearing
 * it; only the ceilings move.
 *
 * Returns the snapshot taken immediately before the clear, so the caller can put on the record
 * what it forgave, or `undefined` when the root is not tracked at all.
 */
export function clearWorkflowBudgetForRoot(
  rootId: string,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  now: number = Date.now(),
): WorkflowBudgetSnapshot | undefined {
  const state = roots.get(rootId);
  if (!state) return undefined;
  const before = workflowBudgetSnapshot(rootId, policy, now);
  state.sendSlotCount.fill(0);
  state.sendSlotAt.fill(Number.NEGATIVE_INFINITY);
  state.children.clear();
  state.lastSeenMs = now;
  recordBudgetEvent({
    at: now,
    kind: "cleared",
    rootId,
    sends: before?.sends ?? 0,
    children: before?.children ?? 0,
  });
  return before;
}

/** Test seam. Production never clears a live ledger: that would reset a spent budget. */
export function resetWorkflowBudgetsForTest(): void {
  roots.clear();
  budgetEvents.length = 0;
}
