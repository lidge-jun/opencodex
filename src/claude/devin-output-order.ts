import type { AdapterEvent } from "../types";
import {
  isTranslatorBudgetExceededError,
  releaseTranslatedEvent,
  retainTranslatedEvent,
  type TranslatorBudget,
} from "../lib/translator-budget";

/**
 * Cognition signs reasoning after text/tools. Claude Code treats a trailing empty
 * thinking block as its final result, so Messages needs reasoning before content.
 * Consume after raw-event preflight and drain on demand, avoiding a queue burst.
 */
export async function* orderDevinMessagesOutput(
  source: AsyncIterable<AdapterEvent>,
  budget: TranslatorBudget,
  signal: AbortSignal,
  abortProducer: () => void,
): AsyncGenerator<AdapterEvent> {
  const held: Array<AdapterEvent | undefined> = [];
  let cancelled = signal.aborted;
  let terminalDelivered = false;
  let delivering: AdapterEvent | undefined;
  const release = () => {
    for (const event of held) if (event) releaseTranslatedEvent(event, budget);
    held.length = 0;
    if (delivering) releaseTranslatedEvent(delivering, budget);
  };
  const cancel = () => { cancelled = true; release(); };
  signal.addEventListener("abort", cancel, { once: true });
  const cancelledTerminal = (event: AdapterEvent): AdapterEvent => {
    if (event.type !== "done" && event.type !== "incomplete") return event;
    return { type: "error", status: 499, message: "client closed request", retryable: false,
      ...(event.usage ? { usage: event.usage } : {}) };
  };
  async function* drain() {
    for (let index = 0; index < held.length && !cancelled; index++) {
      delivering = held[index];
      held[index] = undefined;
      try {
        if (delivering) {
          terminalDelivered = delivering.type === "done" || delivering.type === "error" || delivering.type === "incomplete";
          yield delivering;
        }
      }
      finally {
        if (delivering) releaseTranslatedEvent(delivering, budget);
        delivering = undefined;
      }
    }
    held.length = 0;
  }
  try {
    for await (const event of source) {
      const terminal = event.type === "done" || event.type === "error" || event.type === "incomplete";
      if (cancelled) {
        // The adapter's cancellation terminal retains its measured usage. Client
        // stream cancellation instead returns this iterator and stops consumption.
        if (terminal) { yield cancelledTerminal(event); return; }
        continue;
      }
      if (event.type === "heartbeat" || event.type === "thinking_delta"
        || event.type === "thinking_signature" || event.type === "redacted_thinking"
        || event.type === "reasoning_raw_delta" || event.type === "kiro_redacted_reasoning") {
        yield event;
        continue;
      }
      // Retention owns a snapshot, including nested usage, so later producer or
      // consumer mutations cannot change the bytes measured by the budget.
      const copy = structuredClone(event);
      try {
        retainTranslatedEvent(copy, budget, held.at(-1));
        held.push(copy);
      } catch (error) {
        if (!isTranslatorBudgetExceededError(error)) throw error;
        release();
        // Stop only the producer: aborting the request signal here would let the
        // hosted-search loop replace the typed overflow with a client-cancel error.
        abortProducer();
        yield { type: "error", status: 413, errorType: "request_too_large",
          code: "translation_buffer_limit", message: error.message };
        return;
      }
      if (terminal) {
        yield* drain();
        if (cancelled && !terminalDelivered) yield cancelledTerminal(event);
        return;
      }
      // Raw preflight already observed real output; feed the stream watchdog while
      // the answer waits for its signature. Original heartbeats stay verbatim.
      yield { type: "heartbeat" };
    }
    if (!cancelled) yield* drain();
  } finally {
    signal.removeEventListener("abort", cancel);
    release();
  }
}
