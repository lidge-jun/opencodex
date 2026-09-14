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
 * This ledger is process-local and in-memory. It bounds a single proxy process honestly and
 * says nothing about a second process sharing the same account pool; that needs a shared
 * durable store and is declared out of scope rather than implied.
 */

export interface WorkflowBudgetPolicy {
  /** Children admitted concurrently under one root. */
  readonly maxConcurrentChildren: number;
  /** Physical model sends charged to one root across its whole life. */
  readonly maxPhysicalSends: number;
  /** Distinct children one root may ever create. */
  readonly maxDistinctChildren: number;
  /**
   * Concurrency slots a fan-out may never take. An interactive turn arriving into a saturated
   * root still gets admitted; without this a worker burst starves the conversation it serves.
   */
  readonly interactiveReserve: number;
  /** Roots tracked at once. Bounded so a caller minting new ids cannot grow this forever. */
  readonly maxTrackedRoots: number;
}

export const DEFAULT_WORKFLOW_BUDGET_POLICY: WorkflowBudgetPolicy = {
  maxConcurrentChildren: 8,
  maxPhysicalSends: 256,
  maxDistinctChildren: 64,
  interactiveReserve: 1,
  maxTrackedRoots: 512,
};

export type WorkflowDenial =
  | "workflow-concurrency-exhausted"
  | "workflow-sends-exhausted"
  | "workflow-children-exhausted";

export type WorkflowLane = "interactive" | "worker";

export interface WorkflowAdmission {
  readonly rootId: string;
  release(): void;
}

export type WorkflowDecision =
  | { admitted: true; lease: WorkflowAdmission }
  | { admitted: false; reason: WorkflowDenial; rootId: string };

interface WorkflowState {
  active: number;
  sends: number;
  children: Set<string>;
  lastSeenMs: number;
}

const roots = new Map<string, WorkflowState>();

function pruneOldestRoot(): void {
  let oldestKey: string | undefined;
  let oldestAt = Number.POSITIVE_INFINITY;
  for (const [key, state] of roots) {
    // An active root is never evicted: dropping it would hand its fan-out a fresh allowance,
    // which is the exact laundering this ledger exists to prevent.
    if (state.active > 0) continue;
    if (state.lastSeenMs < oldestAt) { oldestAt = state.lastSeenMs; oldestKey = key; }
  }
  if (oldestKey !== undefined) roots.delete(oldestKey);
}

/**
 * Admit one turn under a root workflow.
 *
 * `childId` distinguishes the members of a fan-out; omit it for the root's own turns.
 * An interactive lane may use the reserved slots a worker lane may not.
 */
export function admitWorkflowTurn(
  rootId: string | undefined,
  lane: WorkflowLane,
  policy: WorkflowBudgetPolicy = DEFAULT_WORKFLOW_BUDGET_POLICY,
  childId?: string,
  now: number = Date.now(),
): WorkflowDecision | undefined {
  if (!rootId) return undefined;
  let state = roots.get(rootId);
  if (!state) {
    if (roots.size >= policy.maxTrackedRoots) pruneOldestRoot();
    state = { active: 0, sends: 0, children: new Set(), lastSeenMs: now };
    roots.set(rootId, state);
  }
  state.lastSeenMs = now;

  if (state.sends >= policy.maxPhysicalSends) {
    return { admitted: false, reason: "workflow-sends-exhausted", rootId };
  }
  if (childId !== undefined && !state.children.has(childId)
    && state.children.size >= policy.maxDistinctChildren) {
    return { admitted: false, reason: "workflow-children-exhausted", rootId };
  }
  const ceiling = lane === "worker"
    ? Math.max(0, policy.maxConcurrentChildren - policy.interactiveReserve)
    : policy.maxConcurrentChildren;
  if (state.active >= ceiling) {
    return { admitted: false, reason: "workflow-concurrency-exhausted", rootId };
  }

  state.active += 1;
  if (childId !== undefined) state.children.add(childId);
  let released = false;
  return {
    admitted: true,
    lease: {
      rootId,
      release(): void {
        if (released) return;
        released = true;
        const current = roots.get(rootId);
        if (!current) return;
        current.active = Math.max(0, current.active - 1);
        current.lastSeenMs = Date.now();
      },
    },
  };
}

/**
 * Charge physical sends to a root. Called from the send budget's own accounting so a retry
 * inside one request counts toward the workflow total, not only the request total.
 */
export function chargeWorkflowSends(rootId: string | undefined, sends: number): void {
  if (!rootId || sends <= 0) return;
  const state = roots.get(rootId);
  if (!state) return;
  state.sends += sends;
  state.lastSeenMs = Date.now();
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
): boolean {
  if (!rootId) return false;
  const state = roots.get(rootId);
  return state !== undefined && state.sends >= policy.maxPhysicalSends;
}

export function workflowBudgetSnapshot(rootId: string): {

  active: number; sends: number; children: number;
} | undefined {
  const state = roots.get(rootId);
  return state ? { active: state.active, sends: state.sends, children: state.children.size } : undefined;
}

/** Test seam. Production never clears a live ledger: that would reset a spent budget. */
export function resetWorkflowBudgetsForTest(): void {
  roots.clear();
}
