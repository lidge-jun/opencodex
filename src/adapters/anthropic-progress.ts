import type { ProviderAdapter } from "./base";
import type { AdapterEvent } from "../types";
import { releaseTranslatedEvent, retainTranslatedEvent, type TranslatorBudget } from "../lib/translator-budget";

/** `display: updates` is the ONLY discriminator: signatures remain opaque.
 * https://platform.claude.com/docs/en/build-with-claude/thinking#progress-updates
 * Buffer one signed block so the visible copy and its replay carrier are atomic.
 */
async function* progressEvents(source: AsyncIterable<AdapterEvent>, budget: TranslatorBudget): AsyncGenerator<AdapterEvent> {
  let thinking: string | undefined;
  let signature: string | undefined;
  let retainedBytes = 0;
  const replace = (text: string | undefined, sig: string | undefined) => {
    const bytes = Buffer.byteLength(text ?? "") + Buffer.byteLength(sig ?? "");
    const reservation = budget.reserveTransient(bytes, { kind: "reasoning" });
    reservation.commitRetained();
    budget.releaseRetained(retainedBytes, { kind: "reasoning" });
    retainedBytes = bytes;
    thinking = text;
    signature = sig;
  };
  function* flush(): Generator<AdapterEvent> {
    if (thinking === undefined && signature === undefined) return;
    if (thinking && signature) {
      yield { type: "text_delta", text: thinking, phase: "commentary", anthropicThinkingSignature: signature };
    } else {
      if (thinking !== undefined) yield { type: "thinking_delta", thinking };
      if (signature !== undefined) yield { type: "thinking_signature", signature };
    }
    replace(undefined, undefined);
  }
  try {
    for await (const event of source) {
      if (event.type === "heartbeat") { yield event; continue; }
      if (signature !== undefined && event.type !== "thinking_signature") yield* flush();
      if (event.type === "thinking_delta") {
        const bytes = Buffer.byteLength(thinking ?? "") + Buffer.byteLength(event.thinking) + Buffer.byteLength(signature ?? "");
        const reservation = budget.reserveTransient(bytes, { kind: "reasoning" });
        try {
          thinking = (thinking ?? "") + event.thinking;
          reservation.commitRetained();
          budget.releaseRetained(retainedBytes, { kind: "reasoning" });
          retainedBytes = bytes;
        } catch (error) { reservation.release(); throw error; }
      }
      else if (event.type === "thinking_signature") replace(thinking, event.signature);
      else { yield* flush(); yield event; }
    }
    yield* flush();
  } finally {
    budget.releaseRetained(retainedBytes, { kind: "reasoning" });
  }
}

/** Each routed request owns its adapter; activation follows its built request's display mode. */
export function withAnthropicProgressUpdates(adapter: ProviderAdapter, enabled: () => boolean): ProviderAdapter {
  return {
    ...adapter,
    async *parseStream(response, budget, tier) {
      const source = adapter.parseStream(response, budget, tier);
      if (enabled()) yield* progressEvents(source, budget);
      else yield* source;
    },
    async parseResponse(response, budget, tier) {
      const events = await adapter.parseResponse!(response, budget, tier);
      if (!enabled()) return events;
      const result: AdapterEvent[] = [];
      try {
        async function* source() { yield* events; }
        for await (const event of progressEvents(source(), budget)) {
          const copy = { ...event };
          retainTranslatedEvent(copy, budget, result.at(-1));
          result.push(copy);
        }
        for (const event of events) releaseTranslatedEvent(event, budget);
        return result;
      } catch (error) {
        for (const event of events) releaseTranslatedEvent(event, budget);
        for (const event of result) releaseTranslatedEvent(event, budget);
        throw error;
      }
    },
  };
}
