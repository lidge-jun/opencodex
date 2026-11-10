export const STATE_SWEEP_INTERVAL_MS = 60_000;

export interface GenerationContext {
  generation: number;
  providerNames: ReadonlySet<string>;
  comboIds: ReadonlySet<string>;
  comboTargets: ReadonlySet<string>;
  codexAccountIds: ReadonlySet<string>;
  oauthAccountKeys: ReadonlySet<string>;
  configRoots: ReadonlySet<string>;
}

export interface StateStoreRegistration {
  name: string;
  sweepExpired?: (now: number) => number;
  sweepLiveness?: () => number;
  reconcileGeneration?: (context: GenerationContext) => number;
}

export interface StateSweepAfterTickRegistration {
  name: string;
  afterTick(): void;
}

export interface StateSweepResult {
  storesVisited: number;
  rowsRemoved: number;
}

export interface StateStoreSweeperOptions {
  /** Override the 60 s interval (tests only; production uses the default). */
  intervalMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

const registrations = new Map<string, StateStoreRegistration>();
interface AfterTickRegistrationNode {
  registration: StateSweepAfterTickRegistration | null;
  previous: AfterTickRegistrationNode | null;
  next: AfterTickRegistrationNode | null;
}

const afterTickRegistrations = new Map<string, AfterTickRegistrationNode>();
let configGeneration = 0;
let attemptSequence = 0;
let generationContextBuilder: (() => GenerationContext) | null = null;
let reconciliationRetryPending = false;
let interval: ReturnType<typeof setInterval> | null = null;

function logCallbackFailure(name: string): void {
  console.warn(`[state-store-sweeper] ${name} failed`);
}

export function registerStateStore(registration: StateStoreRegistration): () => void {
  registrations.set(registration.name, registration);
  return () => {
    if (registrations.get(registration.name) === registration) {
      registrations.delete(registration.name);
    }
  };
}

export function registerStateSweepAfterTick(registration: StateSweepAfterTickRegistration): () => void {
  const name = registration.name;
  const node: AfterTickRegistrationNode = {
    registration,
    previous: afterTickRegistrations.get(name) ?? null,
    next: null,
  };
  if (node.previous) node.previous.next = node;
  afterTickRegistrations.set(name, node);
  return () => {
    if (!node.registration) return;
    // Unlink even a displaced owner immediately. Tombstones in the older-owner
    // chain retain its callback (and captured config) until every newer owner exits.
    const { previous, next } = node;
    if (previous) previous.next = next;
    if (next) next.previous = previous;
    if (afterTickRegistrations.get(name) === node) {
      if (previous) afterTickRegistrations.set(name, previous);
      else afterTickRegistrations.delete(name);
    }
    // A caller can retain its idempotent detach function after invoking it.
    // Do not let that handle retain either the callback or neighboring owners.
    node.registration = null;
    node.previous = null;
    node.next = null;
  };
}

/** Test-only resource oracle: includes every reachable node, not just active callbacks. */
export function stateSweepAfterTickRegistrationCountForTests(): number {
  let count = 0;
  for (const top of afterTickRegistrations.values()) {
    let node: AfterTickRegistrationNode | null = top;
    while (node) { count += 1; node = node.previous; }
  }
  return count;
}

function runCallbacks(
  callback: (registration: StateStoreRegistration) => (() => number) | undefined,
): StateSweepResult {
  let storesVisited = 0;
  let rowsRemoved = 0;
  for (const registration of registrations.values()) {
    const invoke = callback(registration);
    if (!invoke) continue;
    storesVisited += 1;
    try {
      rowsRemoved += invoke();
    } catch {
      logCallbackFailure(registration.name);
    }
  }
  return { storesVisited, rowsRemoved };
}

export function sweepExpired(now = Date.now()): StateSweepResult {
  return runCallbacks(registration => registration.sweepExpired
    ? () => registration.sweepExpired!(now)
    : undefined);
}

export function sweepExpiredOnWrite(now = Date.now()): StateSweepResult {
  const result = sweepExpired(now);
  if (reconciliationRetryPending && generationContextBuilder) {
    try {
      reconcileStateGeneration(generationContextBuilder());
    } catch {
      // The builder reads authoritative live owners. Keep the single retry pending
      // until a later successful owner write can obtain a complete context.
    }
  }
  return result;
}

export function sweepLiveness(): StateSweepResult {
  return runCallbacks(registration => registration.sweepLiveness);
}

function runAfterTickCallbacks(): void {
  for (const { registration } of afterTickRegistrations.values()) {
    if (!registration) continue;
    try {
      registration.afterTick();
    } catch {
      logCallbackFailure(registration.name);
    }
  }
}

export function captureConfigGeneration(): number {
  return configGeneration;
}

export function setGenerationContextBuilder(build: () => GenerationContext): void {
  generationContextBuilder = build;
}

export function reconcileStateGeneration(context: GenerationContext): StateSweepResult {
  const candidateGeneration = ++attemptSequence;
  const candidateContext: GenerationContext = {
    ...context,
    generation: candidateGeneration,
  };

  let storesVisited = 0;
  let rowsRemoved = 0;
  let failed = false;
  for (const registration of registrations.values()) {
    if (!registration.reconcileGeneration) continue;
    storesVisited += 1;
    try {
      rowsRemoved += registration.reconcileGeneration(candidateContext);
    } catch {
      failed = true;
      logCallbackFailure(registration.name);
    }
  }
  if (failed) {
    reconciliationRetryPending = true;
  } else {
    configGeneration = candidateGeneration;
    reconciliationRetryPending = false;
  }
  return { storesVisited, rowsRemoved };
}

export function startStateStoreSweeper(
  options: StateStoreSweeperOptions = {},
): { stop(): void } {
  stopStateStoreSweeper();
  const now = options.now ?? Date.now;
  const ownedInterval = setInterval(() => {
    sweepExpired(now());
    sweepLiveness();
    runAfterTickCallbacks();
  }, options.intervalMs ?? STATE_SWEEP_INTERVAL_MS);
  interval = ownedInterval;
  ownedInterval.unref?.();
  return { stop() {
    // An old server owner must not stop a newer owner's replacement timer.
    if (interval === ownedInterval) stopStateStoreSweeper();
  } };
}

export function stopStateStoreSweeper(): void {
  if (!interval) return;
  clearInterval(interval);
  interval = null;
}

/** Test-only reset for module-global registrations, generation, and lifecycle state. */
export function resetStateStoreSweeperForTests(): void {
  stopStateStoreSweeper();
  registrations.clear();
  afterTickRegistrations.clear();
  configGeneration = 0;
  attemptSequence = 0;
  generationContextBuilder = null;
  reconciliationRetryPending = false;
}
