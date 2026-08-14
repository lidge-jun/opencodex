export const TRANSLATOR_MAX_CALL_ARGUMENT_BYTES = 2 * 1024 * 1024;
export const TRANSLATOR_MAX_TURN_BYTES = 32 * 1024 * 1024;
export const TRANSLATOR_MAX_SSE_EVENT_BYTES = 32 * 1024 * 1024;
export const CURSOR_MAX_CONNECT_FRAME_BYTES = 32 * 1024 * 1024;
export const CURSOR_MAX_EFFECTIVE_CONNECT_PAYLOAD_BYTES = 16 * 1024 * 1024;
export const CURSOR_TRANSPORT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;
export const CURSOR_TRANSPORT_RESUME_BYTES = 16 * 1024 * 1024;
export const CURSOR_MAX_PENDING_FRAMES = 1024;
export const CURSOR_PENDING_FRAMES_RESUME = 512;
export const MAX_PENDING_IMAGE_FULFILLMENTS = 64;
export const MAX_PENDING_OAUTH_MUTATIONS = 128;

export type TranslatorBufferKind =
  | "tool_args"
  | "retained_collectors"
  | "live_transient"
  | "reasoning"
  | "item_ids"
  | "tool_search_sources"
  | "cursor_transport"
  | "cursor_kv"
  | "request_copies";

export type ExternallyCappedKind = "passthrough_serialization" | "mcp_payload";

export class TranslatorBudgetExceededError extends Error {
  readonly code = "translation_buffer_limit";

  constructor(readonly kind: TranslatorBufferKind, readonly limitBytes: number) {
    super(`translator ${kind} buffer exceeded ${limitBytes} bytes`);
    this.name = "TranslatorBudgetExceededError";
  }
}

export function isTranslatorBudgetExceededError(error: unknown): error is TranslatorBudgetExceededError {
  return error instanceof TranslatorBudgetExceededError
    || (error instanceof Error && (error as { code?: unknown }).code === "translation_buffer_limit");
}

export interface TranslatorBudgetSnapshot {
  currentBytes: number;
  highWaterBytes: number;
  activeCalls: number;
  overflows: number;
}

export interface TranslatorBudgetOptions {
  maxCallArgumentBytes?: number;
  maxTurnBytes?: number;
}

export interface TranslatorTransientReservation {
  commitRetained(): void;
  release(): void;
}

export interface TranslatorBudget {
  openCall(id: string): void;
  closeCall(id: string): void;
  reserveTransient(
    bytes: number,
    scope: { kind: TranslatorBufferKind; callId?: string },
  ): TranslatorTransientReservation;
  chargeRetained(delta: number, scope: { kind: TranslatorBufferKind; callId?: string }): void;
  releaseRetained(bytes: number, scope: { kind: TranslatorBufferKind; callId?: string }): void;
  observeAcceptedRequestCopy(bytes: number): () => void;
  observeExternallyCapped(kind: ExternallyCappedKind, bytes: number): () => void;
  snapshot(): TranslatorBudgetSnapshot;
  dispose(): void;
}

const retainedEventOwnership = new WeakMap<object, { budget: TranslatorBudget; bytes: number }>();

/**
 * Charge one event appended to an incrementally materialized adapter-event batch.
 * The newest event owns the closing array bracket; moving that byte from the old
 * tail keeps in-order release accounting equal to the still-retained JSON array.
 */
export function retainTranslatedEvent<T extends object>(
  event: T,
  budget: TranslatorBudget,
  previousTail?: object,
): void {
  if (retainedEventOwnership.has(event)) {
    throw new Error("translated event is already retained");
  }
  if (previousTail === event) {
    throw new Error("incremental translated event tail must be a distinct object");
  }
  const previousOwnership = previousTail === undefined
    ? undefined
    : retainedEventOwnership.get(previousTail);
  if (
    previousTail !== undefined
    && (!previousOwnership || previousOwnership.budget !== budget || previousOwnership.bytes < 2)
  ) {
    throw new Error("incremental translated event tail is not retained by this budget");
  }

  const serializedBytes = Buffer.byteLength(JSON.stringify(event));
  budget.chargeRetained(serializedBytes + (previousTail === undefined ? 2 : 1), {
    kind: "retained_collectors",
  });
  if (previousOwnership) previousOwnership.bytes -= 1;
  retainedEventOwnership.set(event, { budget, bytes: serializedBytes + 2 });
}

/**
 * Charge a materialized adapter-event batch and attach its lease to the events themselves.
 * A copied event array (for example terminal-guard collection) preserves the event objects, so
 * the response builder can consume each source lease immediately after its replacement lands.
 */
export function retainTranslatedEventBatch<T extends object>(events: T[], budget: TranslatorBudget): void {
  if (events.length === 0) return;
  const serialized = events.map(event => JSON.stringify(event));
  const totalBytes = Buffer.byteLength(`[${serialized.join(",")}]`);
  budget.chargeRetained(totalBytes, { kind: "retained_collectors" });
  for (let index = 0; index < events.length; index++) {
    const delimiterBytes = index === events.length - 1 ? 2 : 1;
    retainedEventOwnership.set(events[index]!, {
      budget,
      bytes: Buffer.byteLength(serialized[index]!) + delimiterBytes,
    });
  }
}

/** Transfer one charged adapter event to the response builder's newly materialized owner. */
export function releaseTranslatedEvent(event: object, budget: TranslatorBudget): void {
  const ownership = retainedEventOwnership.get(event);
  if (!ownership || ownership.budget !== budget) return;
  retainedEventOwnership.delete(event);
  budget.releaseRetained(ownership.bytes, { kind: "retained_collectors" });
}

const liveBudgets = new Set<Budget>();
let aggregateCurrentBytes = 0;
let aggregateActiveCalls = 0;
let aggregateHighWaterBytes = 0;
let aggregateOverflows = 0;

function normalizeBytes(bytes: number): number {
  return Number.isFinite(bytes) && bytes > 0 ? Math.floor(bytes) : 0;
}

function observeAggregate(): void {
  aggregateHighWaterBytes = Math.max(aggregateHighWaterBytes, aggregateCurrentBytes);
}

class Budget implements TranslatorBudget {
  private readonly calls = new Map<string, { logicalBytes: number; physicalBytes: number }>();
  private readonly charged = new Map<TranslatorBufferKind, number>();
  private hardChargedBytes = 0;
  private observedBytes = 0;
  private currentBytes = 0;
  private highWaterBytes = 0;
  private overflowCount = 0;
  private disposed = false;

  constructor(
    private readonly maxCallArgumentBytes: number,
    private readonly maxTurnBytes: number,
  ) {}

  private chargedBytes(): number {
    return this.hardChargedBytes;
  }

  observedCurrentBytes(): number {
    return this.currentBytes;
  }

  private changed(): void {
    const nextBytes = this.hardChargedBytes + this.observedBytes;
    aggregateCurrentBytes += nextBytes - this.currentBytes;
    this.currentBytes = nextBytes;
    this.highWaterBytes = Math.max(this.highWaterBytes, nextBytes);
    observeAggregate();
  }

  private reject(kind: TranslatorBufferKind, limitBytes: number): never {
    this.overflowCount += 1;
    aggregateOverflows += 1;
    throw new TranslatorBudgetExceededError(kind, limitBytes);
  }

  private admit(kind: TranslatorBufferKind, bytes: number): number {
    const admitted = normalizeBytes(bytes);
    if (this.chargedBytes() + admitted > this.maxTurnBytes) this.reject(kind, this.maxTurnBytes);
    return admitted;
  }

  openCall(id: string): void {
    if (!this.calls.has(id)) {
      this.calls.set(id, { logicalBytes: 0, physicalBytes: 0 });
      aggregateActiveCalls += 1;
    }
  }

  closeCall(id: string): void {
    const call = this.calls.get(id);
    if (!call) return;
    this.hardChargedBytes = Math.max(0, this.hardChargedBytes - call.physicalBytes);
    this.calls.delete(id);
    aggregateActiveCalls = Math.max(0, aggregateActiveCalls - 1);
    this.changed();
  }

  reserveTransient(
    bytes: number,
    scope: { kind: TranslatorBufferKind; callId?: string },
  ): TranslatorTransientReservation {
    const admitted = normalizeBytes(bytes);
    if (scope.callId && admitted > this.maxCallArgumentBytes) {
      this.reject("tool_args", this.maxCallArgumentBytes);
    }
    this.admit(scope.kind, admitted);
    this.charged.set(scope.kind, (this.charged.get(scope.kind) ?? 0) + admitted);
    this.hardChargedBytes += admitted;
    this.changed();
    let state: "reserved" | "committed" | "released" = "reserved";
    return {
      commitRetained: () => {
        if (state !== "reserved") return;
        state = "committed";
        if (!scope.callId) return;
        const call = this.calls.get(scope.callId) ?? { logicalBytes: 0, physicalBytes: 0 };
        this.charged.set(scope.kind, Math.max(0, (this.charged.get(scope.kind) ?? 0) - admitted));
        call.logicalBytes = admitted;
        call.physicalBytes += admitted;
        this.calls.set(scope.callId, call);
        this.changed();
      },
      release: () => {
        if (state !== "reserved") return;
        state = "released";
        this.charged.set(scope.kind, Math.max(0, (this.charged.get(scope.kind) ?? 0) - admitted));
        this.hardChargedBytes = Math.max(0, this.hardChargedBytes - admitted);
        this.changed();
      },
    };
  }

  chargeRetained(delta: number, scope: { kind: TranslatorBufferKind; callId?: string }): void {
    const admitted = normalizeBytes(delta);
    if (scope.callId) {
      const call = this.calls.get(scope.callId) ?? { logicalBytes: 0, physicalBytes: 0 };
      if (call.logicalBytes + admitted > this.maxCallArgumentBytes) {
        this.reject("tool_args", this.maxCallArgumentBytes);
      }
      this.admit(scope.kind, admitted);
      call.logicalBytes += admitted;
      call.physicalBytes += admitted;
      this.calls.set(scope.callId, call);
    } else {
      this.admit(scope.kind, admitted);
      this.charged.set(scope.kind, (this.charged.get(scope.kind) ?? 0) + admitted);
    }
    this.hardChargedBytes += admitted;
    this.changed();
  }

  releaseRetained(bytes: number, scope: { kind: TranslatorBufferKind; callId?: string }): void {
    const released = normalizeBytes(bytes);
    if (scope.callId) {
      const call = this.calls.get(scope.callId);
      if (call) {
        const actual = Math.min(released, call.physicalBytes);
        call.physicalBytes -= actual;
        this.hardChargedBytes = Math.max(0, this.hardChargedBytes - actual);
      }
    } else {
      const current = this.charged.get(scope.kind) ?? 0;
      const actual = Math.min(released, current);
      this.charged.set(scope.kind, current - actual);
      this.hardChargedBytes = Math.max(0, this.hardChargedBytes - actual);
    }
    this.changed();
  }

  private observe(bytes: number): () => void {
    const observed = normalizeBytes(bytes);
    this.observedBytes += observed;
    this.changed();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.observedBytes = Math.max(0, this.observedBytes - observed);
      this.changed();
    };
  }

  observeAcceptedRequestCopy(bytes: number): () => void {
    return this.observe(bytes);
  }

  observeExternallyCapped(_kind: ExternallyCappedKind, bytes: number): () => void {
    return this.observe(bytes);
  }

  snapshot(): TranslatorBudgetSnapshot {
    return {
      currentBytes: this.observedCurrentBytes(),
      highWaterBytes: this.highWaterBytes,
      activeCalls: this.calls.size,
      overflows: this.overflowCount,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    aggregateActiveCalls = Math.max(0, aggregateActiveCalls - this.calls.size);
    aggregateCurrentBytes = Math.max(0, aggregateCurrentBytes - this.currentBytes);
    this.calls.clear();
    this.charged.clear();
    this.hardChargedBytes = 0;
    this.observedBytes = 0;
    this.currentBytes = 0;
    liveBudgets.delete(this);
    observeAggregate();
  }
}

export function createTranslatorBudget(options: TranslatorBudgetOptions = {}): TranslatorBudget {
  const budget = new Budget(
    options.maxCallArgumentBytes ?? TRANSLATOR_MAX_CALL_ARGUMENT_BYTES,
    options.maxTurnBytes ?? TRANSLATOR_MAX_TURN_BYTES,
  );
  liveBudgets.add(budget);
  observeAggregate();
  return budget;
}

export function translatorObservedBufferSnapshot(): {
  currentBytes: number;
  highWaterBytes: number;
  active: number;
} {
  return {
    currentBytes: aggregateCurrentBytes,
    highWaterBytes: aggregateHighWaterBytes,
    active: aggregateActiveCalls,
  };
}

/** Internal diagnostics used by focused tests; never registered with app-owned memory. */
export function translatorObservedOverflowCount(): number {
  return aggregateOverflows;
}

/** Test-only: proves owned default budgets are disposed on every stream-death path. */
export function translatorLiveBudgetCountForTests(): number {
  return liveBudgets.size;
}

/** Test-only: proves no charge survives against a disposed budget (cancel race). */
export function translatorAggregateCurrentBytesForTests(): number {
  return aggregateCurrentBytes;
}

/** Clears process-wide translator diagnostics and disposes leaked test budgets. */
export function resetTranslatorAggregateForTests(): void {
  for (const budget of liveBudgets) budget.dispose();
  aggregateCurrentBytes = 0;
  aggregateActiveCalls = 0;
  aggregateHighWaterBytes = 0;
  aggregateOverflows = 0;
}

export function finalizeTranslatorBudgetResponse(response: Response, budget: TranslatorBudget): Response {
  if (!response.body) {
    budget.dispose();
    return response;
  }
  const reader = response.body.getReader();
  let finalized = false;
  const finalize = () => {
    if (finalized) return;
    finalized = true;
    budget.dispose();
  };
  return new Response(new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finalize();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        finalize();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try { await reader.cancel(reason); } finally { finalize(); }
    },
  }), { status: response.status, statusText: response.statusText, headers: response.headers });
}
