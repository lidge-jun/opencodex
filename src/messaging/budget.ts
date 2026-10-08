import { LocalMessagingError } from "./types";

/** One caller-owned deadline covers connection, discovery and submission work. */
export class MessageBudget {
  private readonly controller = new AbortController();
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly deadline: number;
  private readonly cancel: () => void;
  readonly signal = this.controller.signal;

  /** Start a monotonic deadline of at most 30 seconds and inherit optional parent cancellation. */
  constructor(timeoutMs = 30_000, private readonly parent?: AbortSignal) {
    if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
      throw new LocalMessagingError("invalid_budget", "Messaging deadline must be between 1 and 30000 milliseconds.");
    }
    this.deadline = performance.now() + timeoutMs;
    this.cancel = () => this.controller.abort(new LocalMessagingError("cancelled", "Messaging operation was cancelled."));
    this.timer = setTimeout(() => this.controller.abort(
      new LocalMessagingError("operation_timeout", "Messaging operation exceeded its deadline.")), timeoutMs);
    parent?.addEventListener("abort", this.cancel, { once: true });
    if (parent?.aborted) this.cancel();
  }

  /** Reject expired/cancelled work even before the deadline timer receives an event-loop turn. */
  throwIfEnded(): void {
    if (!this.signal.aborted && performance.now() >= this.deadline) {
      this.controller.abort(new LocalMessagingError("operation_timeout", "Messaging operation exceeded its deadline."));
    }
    if (this.signal.aborted) throw this.signal.reason;
  }

  /** Bound one stage by the remaining operation deadline, throwing if no time remains. */
  remainingMs(limit: number): number {
    this.throwIfEnded();
    return Math.max(1, Math.min(limit, Math.ceil(this.deadline - performance.now())));
  }

  /** Release timers/listeners and cancel any resources still waiting on this owned budget. */
  dispose(): void {
    clearTimeout(this.timer);
    this.parent?.removeEventListener("abort", this.cancel);
    // Disposal cannot leave another resource waiting on this budget.
    this.cancel();
  }
}
