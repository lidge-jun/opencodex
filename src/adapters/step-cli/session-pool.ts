import { StepCliSession, StepSessionError, type StepSessionDeps, type StepSessionEvent, type StepSessionHandlers, type StepSessionOptions } from "./session";

/** Conversation identity the client echoes back through `providerState`. */
export interface StepConversationRef {
  sessionId: string;
  /** Process-local key; never a credential, only a proxy-internal handle. */
  handle: string;
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
  heldToolFrameId: string | undefined;
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
export class StepSessionPool {
  readonly #entries = new Map<string, PoolEntry>();
  readonly #options: StepSessionPoolOptions;
  readonly #deps: StepSessionDeps;
  readonly #handlers: StepSessionHandlers;
  readonly #sweepMs: number;
  #sweep: ReturnType<typeof setInterval> | undefined;
  #handleSeq = 0;

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

  /** Open a session for a conversation. */
  async open(ref: StepConversationRef): Promise<StepCliSession> {
    const existing = this.get(ref);
    if (existing) return existing;
    const session = await StepCliSession.open(this.#options.buildOptions(), this.#handlers, this.#deps);
    session.onExit(() => {
      if (this.#entries.get(ref.handle)?.session === session) this.#entries.delete(ref.handle);
    });
    this.#entries.set(ref.handle, { ref, session, heldToolFrameId: undefined });
    this.#ensureSweep();
    return session;
  }

  /**
   * Remember which reverse request the next client request must answer.
   *
   * The result arrives in a later HTTP request, so the frame has to outlive the turn that produced
   * it. Storing only its id keeps the session's own hold timer authoritative.
   */
  rememberHeldTool(ref: StepConversationRef, frameId: string | undefined): void {
    const entry = this.#entries.get(ref.handle);
    if (entry) entry.heldToolFrameId = frameId;
  }

  /** Consume the remembered hold, so one tool result can never be delivered twice. */
  takeHeldTool(ref: StepConversationRef): string | undefined {
    const entry = this.#entries.get(ref.handle);
    if (!entry) return undefined;
    const held = entry.heldToolFrameId;
    entry.heldToolFrameId = undefined;
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
          this.#entries.delete(entry.ref.handle);
          void entry.session.close();
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

  async closeAll(): Promise<void> {
    this.#stopSweep();
    const entries = [...this.#entries.values()];
    this.#entries.clear();
    await Promise.all(entries.map(entry => entry.session.close()));
  }
}

export { StepSessionError };
export type { StepSessionEvent, StepSessionHandlers };
