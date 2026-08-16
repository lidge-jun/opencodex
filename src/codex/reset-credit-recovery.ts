import type {
  CodexPreStreamRejection,
  CodexResetEligibleExhaustionCode,
} from "./quota-rejection";
import { isValidCodexAccountId, MAIN_CODEX_ACCOUNT_ID } from "./account-id";

export type CodexResetCreditRecoveryGeneration = Readonly<{
  accountId: string;
  credentialGeneration: number;
  exhaustionGeneration: number;
}>;

export type CodexResetCreditRevalidationResult =
  | Readonly<{
    kind: "eligible";
    accountId: string;
    credentialGeneration: number;
    exhaustionGeneration: number;
    availableCredits: number;
  }>
  | { kind: "stale-generation" }
  | { kind: "no-credit" };

export type CodexResetCreditConsumeCode =
  | "reset"
  | "already_redeemed"
  | "nothing_to_reset"
  | "no_credit";

declare const CODEX_RESERVED_OPERATION_ID_BRAND: unique symbol;

/** An operation id whose durable reservation was validated by the operation ledger. */
export type CodexReservedOperationId = string & {
  readonly [CODEX_RESERVED_OPERATION_ID_BRAND]: true;
};

export const CODEX_RESET_CREDIT_OPERATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isCodexResetCreditOperationId(value: unknown): value is string {
  return typeof value === "string" && CODEX_RESET_CREDIT_OPERATION_ID_PATTERN.test(value);
}

export type CodexResetCreditRecoveryAuthorization = Readonly<{
  enabled: boolean;
  /**
   * Live commitment guard; checked initially, before dispatch, and on completion.
   * Once it reports true, the adapter must keep reporting true for this turn.
   */
  isOutputExposed: () => boolean;
  rejection: CodexPreStreamRejection;
}>;

export type CodexResetCreditDispatchOutcome =
  | Readonly<{ kind: "refresh-required"; code: "reset" | "already_redeemed" }>
  | Readonly<{ kind: "stopped"; code: "nothing_to_reset" | "no_credit" }>
  | Readonly<{
    kind: "ambiguous";
    reason: "consume-failed" | "consume-timeout" | "invalid-outcome";
    operationId: string;
  }>;

export type CodexResetCreditRecoveryResult =
  | CodexResetCreditDispatchOutcome
  | Readonly<{
    kind: "not-dispatched";
    reason:
      | "disabled"
      | "output-already-exposed"
      | "ineligible-rejection"
      | "cancelled-before-dispatch"
      | "stale-generation"
      | "no-credit-after-revalidate"
      | "revalidation-failed"
      | "invalid-revalidation"
      | "coordination-mismatch"
      | "recovery-state-capacity"
      | "operation-expired-before-dispatch";
  }>
  | Readonly<{
    kind: "detached";
    reason: "cancelled-after-dispatch" | "output-exposed-after-dispatch";
    outcome: CodexResetCreditDispatchOutcome;
  }>;

export interface CodexResetCreditLogicalTurn {
  readonly operationId: string;
}

export type CodexResetCreditRecoveryCapacity = Readonly<{
  /** Outstanding adapter executions, including timed-out work that has not settled. */
  activeFlights: number;
  trackedAccounts: number;
}>;

export type CodexResetCreditRecoveryDependencies = {
  /**
   * Stable process-wide identity for one adapter contract. Coordinators may
   * share a generation flight only when this identity and every executable
   * dependency are identical.
   */
  coordinationScope: object;
  /** Revalidates both the supplied generations and current credit availability. */
  revalidate: (
    generation: CodexResetCreditRecoveryGeneration,
    signal: AbortSignal,
  ) => Promise<unknown>;
  /**
   * Dispatches one irreversible consume operation. The normalized result must
   * echo the supplied operationId so already_redeemed is generation-bound.
   * Revalidation and consume adapters must settle promptly when their signal
   * aborts; JavaScript cannot forcibly stop an adapter that ignores it.
   */
  consume: (input: {
    generation: CodexResetCreditRecoveryGeneration;
    operationId: string;
    signal: AbortSignal;
  }) => Promise<unknown>;
  /** Shared shutdown signal; callers may add a request/client signal per turn. */
  lifecycleSignal?: AbortSignal;
  /** Total revalidation plus consume deadline. Defaults to 10 seconds. */
  operationTimeoutMs?: number;
  /** Bounded consume transport attempts using the same operationId. Defaults to 2. */
  maxConsumeAttempts?: number;
  /** Count-only operational signal; account and operation identifiers are omitted. */
  onCapacitySaturated?: (capacity: CodexResetCreditRecoveryCapacity) => void;
};

type LogicalTurnState = {
  attempt?: Promise<CodexResetCreditRecoveryResult>;
};

type OutputGuardRegistration = Readonly<{
  guard: () => boolean;
}>;

type RecoveryFlight = {
  generation: CodexResetCreditRecoveryGeneration;
  operationId: string;
  contract: RecoveryContract;
  activeWaiters: number;
  dispatchStarted: boolean;
  expired: boolean;
  finished: boolean;
  executionSettled: boolean;
  discardedForTests: boolean;
  preDispatchAbort: AbortController;
  operationAbort: AbortController;
  outputGuards: Set<OutputGuardRegistration>;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  executionPromise?: Promise<Awaited<RecoveryFlight["promise"]>>;
  resetForTestsResolve?: (result: Awaited<RecoveryFlight["promise"]>) => void;
  promise: Promise<CodexResetCreditDispatchOutcome | Extract<
    CodexResetCreditRecoveryResult,
    { kind: "not-dispatched" }
  >>;
};

type RecoveryContract = Readonly<{
  coordinationScope: object;
  revalidate: CodexResetCreditRecoveryDependencies["revalidate"];
  consume: CodexResetCreditRecoveryDependencies["consume"];
  lifecycleSignal?: AbortSignal;
  operationTimeoutMs: number;
  maxConsumeAttempts: number;
}>;

type TerminalGeneration = {
  generation: CodexResetCreditRecoveryGeneration;
  outcome: CodexResetCreditDispatchOutcome;
  contract: RecoveryContract;
};

const DEFAULT_OPERATION_TIMEOUT_MS = 10_000;
export const MAX_OPERATION_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_CONSUME_ATTEMPTS = 2;
export const MAX_TRACKED_RECOVERY_ACCOUNTS = 128;
export const MAX_TRACKED_RECOVERY_FLIGHTS = 128;
export const MAX_TRACKED_RECOVERY_WAITERS_PER_FLIGHT = 128;
const RESET_PROCESS_STATE_FOR_TESTS = Symbol("reset-credit-recovery-process-state-for-tests");
const OPERATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ADD_EVENT_LISTENER = EventTarget.prototype.addEventListener;
const REMOVE_EVENT_LISTENER = EventTarget.prototype.removeEventListener;

function freezeResult<T extends CodexResetCreditRecoveryResult>(result: T): T {
  return Object.freeze(result);
}

const CANCELLED_BEFORE_DISPATCH = freezeResult({
  kind: "not-dispatched",
  reason: "cancelled-before-dispatch",
} as const);

const CONSUME_CODES: ReadonlySet<string> = new Set([
  "reset",
  "already_redeemed",
  "nothing_to_reset",
  "no_credit",
]);

const RESET_ELIGIBLE_CODES = {
  usage_limit_exceeded: true,
  insufficient_quota: true,
} as const satisfies Record<CodexResetEligibleExhaustionCode, true>;

export function snapshotCodexResetCreditRecoveryGeneration(
  input: unknown,
): CodexResetCreditRecoveryGeneration {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("generation must be an object");
  }
  const value = input as Record<string, unknown>;
  const hasOwn = Object.prototype.hasOwnProperty;
  if (!hasOwn.call(value, "accountId")
    || !hasOwn.call(value, "credentialGeneration")
    || !hasOwn.call(value, "exhaustionGeneration")) {
    throw new TypeError("generation fields must be own properties");
  }
  const accountId = value.accountId;
  const credentialGeneration = value.credentialGeneration;
  const exhaustionGeneration = value.exhaustionGeneration;
  if (accountId !== MAIN_CODEX_ACCOUNT_ID && !isValidCodexAccountId(accountId)) {
    throw new TypeError("accountId must be the main sentinel or a canonical pool-account id");
  }
  if (!Number.isSafeInteger(credentialGeneration) || Number(credentialGeneration) < 0) {
    throw new TypeError("credentialGeneration must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(exhaustionGeneration) || Number(exhaustionGeneration) < 0) {
    throw new TypeError("exhaustionGeneration must be a non-negative safe integer");
  }
  return Object.freeze({
    accountId,
    credentialGeneration: credentialGeneration as number,
    exhaustionGeneration: exhaustionGeneration as number,
  });
}

function snapshotRequestSignal(input: unknown): AbortSignal | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("options must be an object");
  }
  const signal = (input as { signal?: unknown }).signal;
  if (signal !== undefined && !(signal instanceof AbortSignal)) {
    throw new TypeError("options.signal must be an AbortSignal");
  }
  return signal;
}

function generationKey(generation: CodexResetCreditRecoveryGeneration): string {
  return JSON.stringify([
    generation.accountId,
    generation.credentialGeneration,
    generation.exhaustionGeneration,
  ]);
}

function compareGenerationOrder(
  left: CodexResetCreditRecoveryGeneration,
  right: CodexResetCreditRecoveryGeneration,
): -1 | 0 | 1 {
  if (left.credentialGeneration !== right.credentialGeneration) {
    return left.credentialGeneration < right.credentialGeneration ? -1 : 1;
  }
  if (left.exhaustionGeneration !== right.exhaustionGeneration) {
    return left.exhaustionGeneration < right.exhaustionGeneration ? -1 : 1;
  }
  return 0;
}

export const compareCodexResetCreditRecoveryGenerationOrder = compareGenerationOrder;

function authorizedResetRejection(authorization: CodexResetCreditRecoveryAuthorization): boolean {
  const hasOwn = Object.prototype.hasOwnProperty;
  if (!hasOwn.call(authorization, "enabled")
    || !hasOwn.call(authorization, "rejection")) {
    return false;
  }
  const rejection = authorization.rejection as unknown;
  if (!rejection || typeof rejection !== "object" || Array.isArray(rejection)) return false;
  const value = rejection as Record<string, unknown>;
  if (!hasOwn.call(value, "status")
    || !hasOwn.call(value, "kind")
    || !hasOwn.call(value, "resetCreditEligible")
    || !hasOwn.call(value, "semanticCode")) {
    return false;
  }
  return authorization.enabled === true
    && (value.status === 429 || value.status === 402)
    && value.kind === "reset-eligible-exhaustion"
    && value.resetCreditEligible === true
    && typeof value.semanticCode === "string"
    && Object.hasOwn(RESET_ELIGIBLE_CODES, value.semanticCode);
}

function ownStringField(input: unknown, field: string): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  if (!Object.prototype.hasOwnProperty.call(input, field)) return undefined;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

function revalidationKind(
  input: unknown,
  expected: CodexResetCreditRecoveryGeneration,
): CodexResetCreditRevalidationResult["kind"] | undefined {
  const kind = ownStringField(input, "kind");
  if (kind === "stale-generation" || kind === "no-credit") return kind;
  if (kind !== "eligible" || !input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const hasOwn = Object.prototype.hasOwnProperty;
  if (!hasOwn.call(value, "accountId")
    || !hasOwn.call(value, "credentialGeneration")
    || !hasOwn.call(value, "exhaustionGeneration")
    || !hasOwn.call(value, "availableCredits")) {
    return undefined;
  }
  const availableCredits = value.availableCredits;
  return value.accountId === expected.accountId
    && value.credentialGeneration === expected.credentialGeneration
    && value.exhaustionGeneration === expected.exhaustionGeneration
    && typeof availableCredits === "number"
    && Number.isSafeInteger(availableCredits)
    && availableCredits > 0
    ? "eligible"
    : undefined;
}

function outputIsExposed(guard: () => boolean): boolean {
  try {
    return guard() !== false;
  } catch {
    return true;
  }
}

function hasLiveUnexposedGuard(flight: RecoveryFlight): boolean {
  // Set iteration also visits registrations appended by a re-entrant guard.
  // A one-time snapshot could strand a newly joined, still-live waiter.
  // Bound those live additions so a guard cannot extend this synchronous loop
  // forever. Exhaustion fails closed before the irreversible dispatch.
  let remainingVisits = flight.outputGuards.size * 2 + 1;
  for (const registration of flight.outputGuards) {
    if (remainingVisits <= 0) return false;
    remainingVisits -= 1;
    if (outputIsExposed(registration.guard)) continue;
    // A guard may synchronously abort and unregister its own waiter. Its stale
    // return value must not authorize a different, already-exposed waiter.
    if (flight.outputGuards.has(registration)) return true;
  }
  return false;
}

function expireRecoveryFlight(flight: RecoveryFlight): void {
  flight.expired = true;
  if (flight.dispatchStarted) flight.operationAbort.abort();
  else flight.preDispatchAbort.abort();
}

function recoveryDeadlineExpired(flight: RecoveryFlight, deadlineAt: number): boolean {
  if (!flight.expired && performance.now() < deadlineAt) return false;
  expireRecoveryFlight(flight);
  return true;
}

function recoveryContractsMatch(left: RecoveryContract, right: RecoveryContract): boolean {
  return left.coordinationScope === right.coordinationScope
    && left.revalidate === right.revalidate
    && left.consume === right.consume
    && left.lifecycleSignal === right.lifecycleSignal
    && left.operationTimeoutMs === right.operationTimeoutMs
    && left.maxConsumeAttempts === right.maxConsumeAttempts;
}

function consumeCode(
  input: unknown,
  expectedOperationId: string,
): CodexResetCreditConsumeCode | undefined {
  const code = ownStringField(input, "code");
  const operationId = ownStringField(input, "operationId");
  return code && CONSUME_CODES.has(code) && operationId === expectedOperationId
    ? code as CodexResetCreditConsumeCode
    : undefined;
}

function mapConsumeOutcome(
  input: unknown,
  operationId: string,
): CodexResetCreditDispatchOutcome {
  const code = consumeCode(input, operationId);
  if (code === "reset" || code === "already_redeemed") {
    // Replay is not authorized here. The caller must first refresh authoritative
    // quota state and separately prove that its replay capsule is still valid.
    return freezeResult({ kind: "refresh-required", code });
  }
  if (code === "nothing_to_reset" || code === "no_credit") {
    return freezeResult({ kind: "stopped", code });
  }
  return freezeResult({ kind: "ambiguous", reason: "invalid-outcome", operationId });
}

function notDispatched(
  reason: Extract<CodexResetCreditRecoveryResult, { kind: "not-dispatched" }>["reason"],
): Extract<CodexResetCreditRecoveryResult, { kind: "not-dispatched" }> {
  return freezeResult({ kind: "not-dispatched", reason });
}

function isDispatchOutcome(
  result: CodexResetCreditRecoveryResult,
): result is CodexResetCreditDispatchOutcome {
  return result.kind === "refresh-required"
    || result.kind === "stopped"
    || result.kind === "ambiguous";
}

/**
 * Proves reset-credit trigger, single-flight, idempotency, cancellation, and
 * one-per-turn invariants without owning account selection, HTTP, or replay.
 *
 * Flight and terminal-generation registries are process-shared so independent
 * request handlers cannot bypass the account/generation fence. This foundation
 * is intentionally process-local; durable crash recovery belongs to the future
 * HTTP adapter that persists and reuses the same operation identity. A future
 * adapter for the main sentinel must advance or invalidate credentialGeneration
 * whenever the physical ChatGPT identity changes.
 *
 * Terminal fences intentionally remain for the process lifetime. Time- or
 * LRU-based eviction could re-authorize an uncertain irreversible consume. A
 * runtime adapter must replace this bounded map with a durable generation-aware
 * ledger before supporting more accounts; only an authoritative idempotency and
 * replay-window contract may define safe retirement. Timed-out adapter work is
 * retired from the public flight registry so its waiters settle, but remains in
 * the orphan registry until the adapter settles. It still counts toward both
 * MAX_TRACKED_RECOVERY_FLIGHTS and MAX_TRACKED_RECOVERY_ACCOUNTS, so an
 * abort-ignoring adapter withholds admission instead of allowing unbounded work.
 */
export class CodexResetCreditRecoveryCoordinator {
  private static readonly activeFlights = new Map<string, RecoveryFlight>();
  /** Public flight promises that still participate in admission capacity. */
  private static readonly allFlights = new Set<RecoveryFlight>();
  /** Bounded bookkeeping for adapter executions that outlive public deadlines. */
  private static readonly orphanedFlights = new Set<RecoveryFlight>();
  private static readonly terminalByAccount = new Map<string, TerminalGeneration>();

  private readonly logicalTurns = new WeakMap<CodexResetCreditLogicalTurn, LogicalTurnState>();
  private readonly operationTimeoutMs: number;
  private readonly maxConsumeAttempts: number;
  private readonly contract: RecoveryContract;
  private readonly onCapacitySaturated?: CodexResetCreditRecoveryDependencies["onCapacitySaturated"];

  constructor(dependencies: CodexResetCreditRecoveryDependencies) {
    const coordinationScope = dependencies.coordinationScope;
    if (coordinationScope === null
      || (typeof coordinationScope !== "object"
        && typeof coordinationScope !== "function")) {
      throw new TypeError("coordinationScope must be a stable object identity");
    }
    const revalidate = dependencies.revalidate;
    const consume = dependencies.consume;
    if (typeof revalidate !== "function") {
      throw new TypeError("revalidate must be a function");
    }
    if (typeof consume !== "function") {
      throw new TypeError("consume must be a function");
    }
    const lifecycleSignal = dependencies.lifecycleSignal;
    if (lifecycleSignal !== undefined && !(lifecycleSignal instanceof AbortSignal)) {
      throw new TypeError("lifecycleSignal must be an AbortSignal");
    }
    this.operationTimeoutMs = dependencies.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    this.maxConsumeAttempts = dependencies.maxConsumeAttempts ?? DEFAULT_MAX_CONSUME_ATTEMPTS;
    if (!Number.isSafeInteger(this.operationTimeoutMs)
      || this.operationTimeoutMs <= 0
      || this.operationTimeoutMs > MAX_OPERATION_TIMEOUT_MS) {
      throw new TypeError("operationTimeoutMs must be an integer from 1 to 60000");
    }
    if (!Number.isSafeInteger(this.maxConsumeAttempts)
      || this.maxConsumeAttempts < 1
      || this.maxConsumeAttempts > 3) {
      throw new TypeError("maxConsumeAttempts must be an integer from 1 to 3");
    }
    this.contract = Object.freeze({
      coordinationScope,
      revalidate,
      consume,
      lifecycleSignal,
      operationTimeoutMs: this.operationTimeoutMs,
      maxConsumeAttempts: this.maxConsumeAttempts,
    });
    this.onCapacitySaturated = dependencies.onCapacitySaturated;
  }

  createLogicalTurn(): CodexResetCreditLogicalTurn {
    const operationId = crypto.randomUUID();
    if (!OPERATION_ID_PATTERN.test(operationId)) {
      throw new TypeError("operationId must be an RFC 4122 version 4 UUID");
    }
    const turn = Object.freeze({ operationId });
    this.logicalTurns.set(turn, {});
    return turn;
  }

  recover(
    turn: CodexResetCreditLogicalTurn,
    generation: CodexResetCreditRecoveryGeneration,
    authorization: CodexResetCreditRecoveryAuthorization,
    options: { signal?: AbortSignal } = {},
  ): Promise<CodexResetCreditRecoveryResult> {
    const turnState = this.logicalTurns.get(turn);
    if (!turnState) throw new TypeError("logical turn was not created by this coordinator");
    if (turnState.attempt) return turnState.attempt;

    let resolveAttempt!: (result: CodexResetCreditRecoveryResult) => void;
    let rejectAttempt!: (reason?: unknown) => void;
    const attempt = new Promise<CodexResetCreditRecoveryResult>((resolve, reject) => {
      resolveAttempt = resolve;
      rejectAttempt = reject;
    });
    // Reserve the logical turn before reading caller-supplied option or generation
    // accessors or invoking an output guard. A synchronous re-entry must observe this
    // exact promise instead of creating a second flight with the same operation identity.
    turnState.attempt = attempt;
    let generationSnapshot: CodexResetCreditRecoveryGeneration;
    let requestSignal: AbortSignal | undefined;
    try {
      requestSignal = snapshotRequestSignal(options);
      generationSnapshot = snapshotCodexResetCreditRecoveryGeneration(generation);
    } catch (error) {
      rejectAttempt(error);
      return attempt;
    }
    try {
      void this.startReservedAttempt(
        turn,
        generationSnapshot,
        authorization,
        requestSignal,
      ).then(resolveAttempt, rejectAttempt);
    } catch (error) {
      rejectAttempt(error);
    }
    return attempt;
  }

  private startReservedAttempt(
    turn: CodexResetCreditLogicalTurn,
    generationSnapshot: CodexResetCreditRecoveryGeneration,
    authorization: CodexResetCreditRecoveryAuthorization,
    requestSignal: AbortSignal | undefined,
  ): Promise<CodexResetCreditRecoveryResult> {
    if (authorization.enabled !== true) {
      return Promise.resolve(notDispatched("disabled"));
    }
    if (outputIsExposed(authorization.isOutputExposed)) {
      return Promise.resolve(notDispatched("output-already-exposed"));
    }
    if (!authorizedResetRejection(authorization)) {
      return Promise.resolve(notDispatched("ineligible-rejection"));
    }

    const signals = this.recoverySignals(requestSignal);
    if (signals.some(signal => signal.aborted)) {
      return Promise.resolve(CANCELLED_BEFORE_DISPATCH);
    }

    const key = generationKey(generationSnapshot);
    const terminal = CodexResetCreditRecoveryCoordinator.terminalByAccount.get(
      generationSnapshot.accountId,
    );
    if (terminal) {
      if (!recoveryContractsMatch(terminal.contract, this.contract)) {
        return Promise.resolve(notDispatched("coordination-mismatch"));
      }
      const order = compareGenerationOrder(generationSnapshot, terminal.generation);
      if (order === 0) {
        return this.resolveTerminalOutcome(
          terminal.outcome,
          signals,
          authorization.isOutputExposed,
        );
      }
      if (order < 0) {
        return Promise.resolve(notDispatched("stale-generation"));
      }
    }

    let flight = CodexResetCreditRecoveryCoordinator.activeFlights.get(key);
    if (flight && !recoveryContractsMatch(flight.contract, this.contract)) {
      return Promise.resolve(notDispatched("coordination-mismatch"));
    }
    if (flight
      && !flight.dispatchStarted
      && (flight.preDispatchAbort.signal.aborted || flight.activeWaiters === 0)) {
      return Promise.resolve(CANCELLED_BEFORE_DISPATCH);
    }
    if (!flight) {
      if (!this.hasFlightCapacity(
        generationSnapshot.accountId,
      )) {
        return Promise.resolve(notDispatched("recovery-state-capacity"));
      }
      flight = this.createFlight(key, generationSnapshot, turn.operationId);
      CodexResetCreditRecoveryCoordinator.activeFlights.set(key, flight);
    }
    if (flight.activeWaiters >= MAX_TRACKED_RECOVERY_WAITERS_PER_FLIGHT) {
      this.reportCapacitySaturated(this.trackedCapacity());
      return Promise.resolve(notDispatched("recovery-state-capacity"));
    }

    return this.joinFlight(flight, signals, authorization.isOutputExposed);
  }

  /** Exposes no flight contents; intended for deterministic cleanup tests. */
  activeFlightCountForTests(): number {
    return CodexResetCreditRecoveryCoordinator.allFlights.size;
  }

  terminalGenerationCountForTests(): number {
    return CodexResetCreditRecoveryCoordinator.terminalByAccount.size;
  }

  async waitForIdleForTests(): Promise<void> {
    for (;;) {
      const flights = [...new Set([
        ...CodexResetCreditRecoveryCoordinator.allFlights,
        ...CodexResetCreditRecoveryCoordinator.orphanedFlights,
      ])];
      if (flights.length === 0) return;
      await Promise.allSettled(flights.flatMap(flight => [
        flight.promise,
        ...(flight.executionPromise ? [flight.executionPromise] : []),
      ]));
    }
  }

  static async [RESET_PROCESS_STATE_FOR_TESTS](): Promise<void> {
    if (process.env.OCX_TEST_HOME_GUARD !== "1") {
      throw new Error("resetProcessStateForTests is available only under the repository test preload");
    }
    const flights = [...new Set([...this.allFlights, ...this.orphanedFlights])];
    for (const flight of flights) {
      flight.discardedForTests = true;
      flight.expired = true;
      if (flight.deadlineTimer !== undefined) {
        clearTimeout(flight.deadlineTimer);
        flight.deadlineTimer = undefined;
      }
      flight.preDispatchAbort.abort();
      flight.operationAbort.abort();
      flight.resetForTestsResolve?.(flight.dispatchStarted
        ? freezeResult({
          kind: "ambiguous",
          reason: "consume-timeout",
          operationId: flight.operationId,
        })
        : CANCELLED_BEFORE_DISPATCH);
    }
    this.activeFlights.clear();
    this.terminalByAccount.clear();
    await Promise.allSettled(flights.map(flight => flight.promise));
    // An adapter may ignore its abort signal forever. Test reset must detach
    // that handled execution after marking it discarded instead of hanging the
    // entire suite; waitForIdleForTests drains every retained execution.
    await Promise.resolve();
    for (const flight of flights) {
      this.allFlights.delete(flight);
      this.orphanedFlights.delete(flight);
    }
    this.activeFlights.clear();
    this.terminalByAccount.clear();
  }

  private static retireFlightWhenSettled(flight: RecoveryFlight): void {
    if (!flight.finished) return;
    this.allFlights.delete(flight);
    if (flight.executionSettled) this.orphanedFlights.delete(flight);
    else this.orphanedFlights.add(flight);
  }

  private trackedCapacity(): {
    outstandingExecutions: number;
    trackedAccounts: Set<string>;
  } {
    const outstandingFlights = new Set([
      ...CodexResetCreditRecoveryCoordinator.allFlights,
      ...CodexResetCreditRecoveryCoordinator.orphanedFlights,
    ]);
    const trackedAccounts = new Set(
      CodexResetCreditRecoveryCoordinator.terminalByAccount.keys(),
    );
    for (const flight of outstandingFlights) {
      trackedAccounts.add(flight.generation.accountId);
    }
    return { outstandingExecutions: outstandingFlights.size, trackedAccounts };
  }

  private reportCapacitySaturated(capacity: {
    outstandingExecutions: number;
    trackedAccounts: Set<string>;
  }): void {
    try {
      this.onCapacitySaturated?.(Object.freeze({
        activeFlights: capacity.outstandingExecutions,
        trackedAccounts: capacity.trackedAccounts.size,
      }));
    } catch {
      // Operational reporting must never weaken the fail-closed capacity result.
    }
  }

  private hasFlightCapacity(accountId: string): boolean {
    const capacity = this.trackedCapacity();
    const allowed = capacity.outstandingExecutions < MAX_TRACKED_RECOVERY_FLIGHTS
      && (capacity.trackedAccounts.has(accountId)
        || capacity.trackedAccounts.size < MAX_TRACKED_RECOVERY_ACCOUNTS);
    if (!allowed) this.reportCapacitySaturated(capacity);
    return allowed;
  }

  private recoverySignals(requestSignal?: AbortSignal): AbortSignal[] {
    return [...new Set(
      [requestSignal, this.contract.lifecycleSignal]
        .filter((signal): signal is AbortSignal => signal !== undefined),
    )];
  }

  private resolveTerminalOutcome(
    outcome: CodexResetCreditDispatchOutcome,
    signals: readonly AbortSignal[],
    outputGuard: () => boolean,
  ): Promise<CodexResetCreditRecoveryResult> {
    return Promise.resolve().then(() => {
      if (signals.some(signal => signal.aborted)) {
        return freezeResult({
          kind: "detached",
          reason: "cancelled-after-dispatch",
          outcome,
        } as const);
      }
      const outputExposed = outputIsExposed(outputGuard);
      if (signals.some(signal => signal.aborted)) {
        return freezeResult({
          kind: "detached",
          reason: "cancelled-after-dispatch",
          outcome,
        } as const);
      }
      if (outputExposed) {
        return freezeResult({
          kind: "detached",
          reason: "output-exposed-after-dispatch",
          outcome,
        } as const);
      }
      return outcome;
    });
  }

  private createFlight(
    key: string,
    generation: CodexResetCreditRecoveryGeneration,
    operationId: string,
  ): RecoveryFlight {
    const flight: RecoveryFlight = {
      generation: Object.freeze({ ...generation }),
      operationId,
      contract: this.contract,
      activeWaiters: 0,
      dispatchStarted: false,
      expired: false,
      finished: false,
      executionSettled: false,
      discardedForTests: false,
      preDispatchAbort: new AbortController(),
      operationAbort: new AbortController(),
      outputGuards: new Set(),
      promise: undefined as unknown as RecoveryFlight["promise"],
    };
    CodexResetCreditRecoveryCoordinator.allFlights.add(flight);

    // Start on the next microtask so the creating caller joins before
    // revalidation can observe the active-waiter count.
    flight.promise = Promise.resolve()
      .then(() => this.runFlightWithDeadline(flight))
      .catch(() => (
        flight.dispatchStarted
          ? freezeResult({
            kind: "ambiguous",
            reason: "consume-failed",
            operationId: flight.operationId,
          } as const)
          : notDispatched("revalidation-failed")
      ))
      .then(result => {
        if (!flight.discardedForTests && isDispatchOutcome(result)) {
          const current = CodexResetCreditRecoveryCoordinator.terminalByAccount.get(
            flight.generation.accountId,
          );
          if (!current || compareGenerationOrder(flight.generation, current.generation) > 0) {
            CodexResetCreditRecoveryCoordinator.terminalByAccount.set(
              flight.generation.accountId,
              { generation: flight.generation, outcome: result, contract: flight.contract },
            );
          }
        }
        return result;
      })
      .finally(() => {
        flight.finished = true;
        CodexResetCreditRecoveryCoordinator.retireFlightWhenSettled(flight);
        if (CodexResetCreditRecoveryCoordinator.activeFlights.get(key) === flight) {
          CodexResetCreditRecoveryCoordinator.activeFlights.delete(key);
        }
      });
    return flight;
  }

  private async runFlightWithDeadline(
    flight: RecoveryFlight,
  ): Promise<Awaited<RecoveryFlight["promise"]>> {
    if (flight.discardedForTests) {
      flight.executionSettled = true;
      return CANCELLED_BEFORE_DISPATCH;
    }
    const deadlineAt = performance.now() + flight.contract.operationTimeoutMs;
    const execution = this.runFlight(flight, deadlineAt);
    flight.executionPromise = execution;
    void execution.then(
      () => {
        flight.executionSettled = true;
        CodexResetCreditRecoveryCoordinator.retireFlightWhenSettled(flight);
      },
      () => {
        flight.executionSettled = true;
        CodexResetCreditRecoveryCoordinator.retireFlightWhenSettled(flight);
      },
    );
    const deadline = new Promise<Awaited<RecoveryFlight["promise"]>>(resolve => {
      flight.deadlineTimer = setTimeout(() => {
        expireRecoveryFlight(flight);
        if (!flight.dispatchStarted) {
          resolve(notDispatched("operation-expired-before-dispatch"));
          return;
        }
        resolve(freezeResult({
          kind: "ambiguous",
          reason: "consume-timeout",
          operationId: flight.operationId,
        }));
      }, Math.max(0, deadlineAt - performance.now()));
    });
    const resetForTests = new Promise<Awaited<RecoveryFlight["promise"]>>(resolve => {
      flight.resetForTestsResolve = resolve;
    });

    try {
      return await Promise.race([execution, deadline, resetForTests]);
    } finally {
      if (flight.deadlineTimer !== undefined) {
        clearTimeout(flight.deadlineTimer);
        flight.deadlineTimer = undefined;
      }
      flight.resetForTestsResolve = undefined;
    }
  }

  private async runFlight(
    flight: RecoveryFlight,
    deadlineAt: number,
  ): Promise<Awaited<RecoveryFlight["promise"]>> {
    if (flight.preDispatchAbort.signal.aborted || flight.activeWaiters === 0) {
      return CANCELLED_BEFORE_DISPATCH;
    }
    let revalidation: unknown;
    try {
      revalidation = await flight.contract.revalidate(
        flight.generation,
        flight.preDispatchAbort.signal,
      );
    } catch {
      if (flight.preDispatchAbort.signal.aborted && flight.activeWaiters === 0) {
        return CANCELLED_BEFORE_DISPATCH;
      }
      if (recoveryDeadlineExpired(flight, deadlineAt)) {
        return notDispatched("operation-expired-before-dispatch");
      }
      return notDispatched("revalidation-failed");
    }

    if (flight.preDispatchAbort.signal.aborted || flight.activeWaiters === 0) {
      return CANCELLED_BEFORE_DISPATCH;
    }

    const kind = revalidationKind(revalidation, flight.generation);
    if (kind === "stale-generation") return notDispatched("stale-generation");
    if (kind === "no-credit") return notDispatched("no-credit-after-revalidate");
    if (kind !== "eligible") return notDispatched("invalid-revalidation");

    if (!hasLiveUnexposedGuard(flight)) {
      return notDispatched("output-already-exposed");
    }
    if (recoveryDeadlineExpired(flight, deadlineAt)) {
      return notDispatched("operation-expired-before-dispatch");
    }
    if (flight.preDispatchAbort.signal.aborted || flight.activeWaiters === 0) {
      return CANCELLED_BEFORE_DISPATCH;
    }

    // No await is allowed between this final commitment check and marking the
    // irreversible dispatch. That closes the last pre-dispatch cancellation race.
    flight.dispatchStarted = true;
    for (let attempt = 1; attempt <= flight.contract.maxConsumeAttempts; attempt += 1) {
      if (recoveryDeadlineExpired(flight, deadlineAt)) {
        return freezeResult({
          kind: "ambiguous",
          reason: "consume-timeout",
          operationId: flight.operationId,
        });
      }
      try {
        const outcome = await flight.contract.consume({
          generation: flight.generation,
          operationId: flight.operationId,
          signal: flight.operationAbort.signal,
        });
        const mappedOutcome = mapConsumeOutcome(outcome, flight.operationId);
        if (recoveryDeadlineExpired(flight, deadlineAt)) {
          return freezeResult({
            kind: "ambiguous",
            reason: "consume-timeout",
            operationId: flight.operationId,
          });
        }
        return mappedOutcome;
      } catch {
        if (recoveryDeadlineExpired(flight, deadlineAt)) {
          return freezeResult({
            kind: "ambiguous",
            reason: "consume-timeout",
            operationId: flight.operationId,
          });
        }
        if (attempt === flight.contract.maxConsumeAttempts) {
          return freezeResult({
            kind: "ambiguous",
            reason: "consume-failed",
            operationId: flight.operationId,
          });
        }
      }
    }

    return freezeResult({
      kind: "ambiguous",
      reason: "consume-failed",
      operationId: flight.operationId,
    });
  }

  private joinFlight(
    flight: RecoveryFlight,
    signals: readonly AbortSignal[],
    outputGuard: () => boolean,
  ): Promise<CodexResetCreditRecoveryResult> {
    flight.activeWaiters += 1;
    const outputGuardRegistration = Object.freeze({ guard: outputGuard });
    flight.outputGuards.add(outputGuardRegistration);

    return new Promise((resolve, reject) => {
      let settled = false;
      let counted = true;
      let detachedAfterDispatch = false;
      const registeredSignals: AbortSignal[] = [];

      const releasePreDispatchWaiter = () => {
        if (!counted) return;
        counted = false;
        if (flight.dispatchStarted) return;
        flight.activeWaiters = Math.max(0, flight.activeWaiters - 1);
        flight.outputGuards.delete(outputGuardRegistration);
        if (flight.activeWaiters === 0 && !flight.finished) {
          flight.preDispatchAbort.abort();
        }
      };

      const removeAbortListeners = () => {
        for (const signal of registeredSignals) {
          try {
            REMOVE_EVENT_LISTENER.call(signal, "abort", onAbort);
          } catch {
            // Waiter state still rolls back if a caller overrides EventTarget methods.
          }
        }
        registeredSignals.length = 0;
      };

      const finish = (result: Awaited<RecoveryFlight["promise"]>) => {
        if (settled) return;
        settled = true;
        if (!flight.dispatchStarted) releasePreDispatchWaiter();
        if (isDispatchOutcome(result)) {
          const outputExposed = outputIsExposed(outputGuard);
          const cancelled = detachedAfterDispatch
            || signals.some(signal => signal.aborted);
          removeAbortListeners();
          if (!cancelled && !outputExposed) {
            resolve(result);
            return;
          }
          resolve(freezeResult({
            kind: "detached",
            reason: cancelled
              ? "cancelled-after-dispatch"
              : "output-exposed-after-dispatch",
            outcome: result,
          }));
          return;
        }
        removeAbortListeners();
        resolve(result);
      };

      const onAbort = () => {
        if (flight.dispatchStarted) {
          detachedAfterDispatch = true;
          return;
        }
        releasePreDispatchWaiter();
        finish(CANCELLED_BEFORE_DISPATCH);
      };

      try {
        for (const signal of signals) {
          registeredSignals.push(signal);
          ADD_EVENT_LISTENER.call(signal, "abort", onAbort, { once: true });
        }
      } catch (error) {
        settled = true;
        releasePreDispatchWaiter();
        removeAbortListeners();
        reject(error);
        return;
      }
      if (signals.some(signal => signal.aborted)) onAbort();
      void flight.promise.then(finish, () => {
        finish(flight.dispatchStarted
          ? freezeResult({
            kind: "ambiguous",
            reason: "consume-failed",
            operationId: flight.operationId,
          })
          : notDispatched("revalidation-failed"));
      });
    });
  }
}

/** @internal Test-support entry point; unavailable without the repository preload. */
export async function resetCodexResetCreditRecoveryProcessStateForTests(): Promise<void> {
  await CodexResetCreditRecoveryCoordinator[RESET_PROCESS_STATE_FOR_TESTS]();
}
