import { StepCliSession, StepSessionError, type StepSessionDeps, type StepSessionEvent, type StepSessionHandlers, type StepSessionOptions } from "./session";

/** Conversation identity the client echoes back through `providerState`. */
export interface StepConversationRef {
  sessionId: string;
  /** Process-local key; never a credential, only a proxy-internal handle. */
  handle: string;
}

/**
 * The reverse request this conversation is holding, and the call it belongs to.
 *
 * The call id is kept beside the frame id because the client's next request may carry results for
 * several calls; delivering the newest result by POSITION would answer the wrong call.
 */
export interface StepHeldTool {
  readonly frameId: string;
  readonly callId: string;
  readonly queryId: string;
  readonly catalogKey: string;
}

export interface StepSessionPoolOptions {
  openCodexHome: string;
  buildOptions: () => StepSessionOptions;
  idleTimeoutMs: number;
}

interface PoolEntry {
  readonly ref: StepConversationRef;
  readonly session: StepCliSession;
  /** Reverse request the pool is currently holding for the next client request. */
  heldTool: StepHeldTool | undefined;
}

/**
 * Conversation-keyed StepCode sessions.
 *
 * The pool exists because StepCode's only durable conversation state is process memory: one process
 * serves one query at a time (`maxConcurrentQueries: 1`) and `query.input` carries text and images
 * only, so a client conversation maps onto exactly one live process. Entries are reclaimed by idle
 * timeout and on process exit, and a conversation whose process died is reported as such rather than
 * silently restarted — a restart would lose the model's view of earlier tool results, and a tool
 * result the client already delivered is not recoverable from the transcript.
 */
/**
 * The conversation bookkeeping the adapter depends on.
 *
 * Narrower than the pool itself so a test can supply a fake process and still exercise the real
 * `runTurn` path — the path that decides whether a captured call is answered, refused or abandoned.
 */
export interface StepConversationHost {
  get(ref: StepConversationRef | undefined): StepConversationSession | undefined;
  open(ref: StepConversationRef): Promise<StepConversationSession>;
  nextRef(): StepConversationRef;
  rememberHeldTool(ref: StepConversationRef, held: StepHeldTool): void;
  takeHeldTool(ref: StepConversationRef): StepHeldTool | undefined;
  closeAll(): Promise<void>;
}

/** The session surface `runTurn` uses. */
export type StepConversationSession = Pick<
  StepCliSession,
  "sessionId" | "closed" | "handshake" | "startQuery" | "sendInput" | "endInput" | "interrupt" | "close" | "resolveHeldToolResult" | "allowPermission" | "denyPermission" | "refuseToolCall"
>;

export class StepSessionPool implements StepConversationHost {
  readonly #entries = new Map<string, PoolEntry>();
  /**
   * In-flight opens, keyed by handle.
   *
   * `open` is async, so two requests for one conversation (a Codex retry, or two clients sharing a
   * handle) both miss the map and both spawn a process; the second `#entries.set` then orphans the
   * first session with a held tool call nobody can release. Coalescing on the promise makes one
   * conversation exactly one process.
   */
  readonly #opening = new Map<string, Promise<StepCliSession>>();
  /** Pending receipts and failed cleanup remain owned until shutdown observes them. */
  readonly #cleanup = new Set<Promise<void>>();
  readonly #options: StepSessionPoolOptions;
  readonly #deps: StepSessionDeps;
  readonly #handlers: StepSessionHandlers;
  readonly #sweepMs: number;
  #sweep: ReturnType<typeof setInterval> | undefined;
  #handleSeq = 0;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    options: StepSessionPoolOptions,
    handlers: StepSessionHandlers,
    deps: StepSessionDeps = {},
  ) {
    this.#options = options;
    this.#handlers = handlers;
    this.#deps = deps;
    this.#sweepMs = Math.max(1_000, Math.min(options.idleTimeoutMs, 60_000));
  }

  /** Look up a live session for a conversation, if one is still open. */
  get(ref: StepConversationRef | undefined): StepCliSession | undefined {
    if (!ref) return undefined;
    const entry = this.#entries.get(ref.handle);
    return entry && !entry.session.closed ? entry.session : undefined;
  }

  /** Open a session for a conversation, coalescing concurrent opens of the same handle. */
  async open(ref: StepConversationRef): Promise<StepCliSession> {
    if (this.#closing) throw new StepSessionError("StepCode session pool is closing.");
    const existing = this.get(ref);
    if (existing) return existing;
    if (this.#entries.has(ref.handle)) {
      throw new StepSessionError("StepCode conversation cleanup is pending or quarantined.", "step_cli_cleanup_failed");
    }
    const inFlight = this.#opening.get(ref.handle);
    if (inFlight) return inFlight;
    const opening = (async () => {
      const session = await StepCliSession.open(this.#options.buildOptions(), this.#handlers, this.#deps);
      session.onCleanup(cleanup => {
        this.#cleanup.add(cleanup);
        void cleanup.then(() => { this.#cleanup.delete(cleanup); }, () => {});
      });
      if (this.#closing) {
        await session.close();
        return session;
      }
      const entry: PoolEntry = { ref, session, heldTool: undefined };
      this.#entries.set(ref.handle, entry);
      session.onExit(() => {
        if (this.#entries.get(ref.handle) === entry) this.#entries.delete(ref.handle);
      });
      this.#ensureSweep();
      return session;
    })();
    this.#opening.set(ref.handle, opening);
    try {
      return await opening;
    } finally {
      if (this.#opening.get(ref.handle) === opening) this.#opening.delete(ref.handle);
    }
  }

  /**
   * Remember which reverse request the next client request must answer.
   *
   * The result arrives in a later HTTP request, so the frame has to outlive the turn that produced
   * it. Storing only its id keeps the session's own hold timer authoritative.
   */
  rememberHeldTool(ref: StepConversationRef, held: StepHeldTool): void {
    const entry = this.#entries.get(ref.handle);
    if (entry) entry.heldTool = held;
  }

  /** Consume the remembered hold, so one tool result can never be delivered twice. */
  takeHeldTool(ref: StepConversationRef): StepHeldTool | undefined {
    const entry = this.#entries.get(ref.handle);
    if (!entry) return undefined;
    const held = entry.heldTool;
    entry.heldTool = undefined;
    return held;
  }

  /** Mint the identity a new conversation is addressed by. */
  nextRef(): StepConversationRef {
    this.#handleSeq += 1;
    return { handle: `step_${this.#handleSeq}`, sessionId: "" };
  }

  #ensureSweep(): void {
    if (this.#sweep) return;
    this.#sweep = setInterval(() => {
      for (const entry of [...this.#entries.values()]) {
        if (entry.session.closed || entry.session.idleMs() >= this.#options.idleTimeoutMs) {
          // The exit listener releases the handle only after cleanup succeeds. Failed receipts
          // stay in #cleanup and the entry remains quarantined; never retry from every sweep.
          void entry.session.close().catch(() => {});
        }
      }
      if (this.#entries.size === 0) this.#stopSweep();
    }, this.#sweepMs);
    this.#sweep.unref?.();
  }

  #stopSweep(): void {
    if (!this.#sweep) return;
    clearInterval(this.#sweep);
    this.#sweep = undefined;
  }

  get size(): number {
    return this.#entries.size;
  }

  closeAll(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closing = true;
    this.#stopSweep();
    const opening = [...this.#opening.values()];
    const entries = [...this.#entries.values()];
    this.#closePromise = (async () => {
      const closed = await Promise.allSettled(entries.map(entry => entry.session.close()));
      // An open owns its child until it returns. Its closing branch reaps that child before
      // resolving, so shutdown cannot finish while a late open can still publish a session.
      const opened = await Promise.allSettled(opening);
      const cleanup = await Promise.allSettled([...this.#cleanup]);
      const failure = [...closed, ...opened, ...cleanup].find(result => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.#closePromise;
  }
}

export { StepSessionError };
export type { StepSessionEvent, StepSessionHandlers };
