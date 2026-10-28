import type { AdapterEvent } from "../types";
import { releaseTranslatedEvent, type TranslatorBudget } from "../lib/translator-budget";
import { isTruncatedStopReason } from "./truncated-stop-reason";

/** Keep client/hosted tool events out of a routed Anthropic summary's compaction item. */
export async function* guardCompactionSummary(
  events: AsyncIterable<AdapterEvent>,
  budget: TranslatorBudget,
): AsyncGenerator<AdapterEvent> {
  let hasText = false;
  let attemptedTool = false;
  for await (const event of events) {
    if (event.type === "text_delta" && !event.anthropicThinkingSignature) {
      hasText ||= event.text.trim().length > 0;
      yield event;
      continue;
    }
    if (event.type === "error" || event.type === "incomplete") {
      yield event;
      return;
    }
    if (event.type === "done") {
      if (!isTruncatedStopReason(event.stopReason)
        // An absent stop reason is accepted, as on every other completion path: some
        // Anthropic-compatible endpoints omit it. An explicit non-terminal reason is not.
        && (attemptedTool || !hasText
          || (event.stopReason !== undefined && event.stopReason !== "end_turn" && event.stopReason !== "stop_sequence"))) {
        releaseTranslatedEvent(event, budget);
        yield {
          type: "error", status: 502, errorType: "upstream_error",
          code: "compaction_invalid_summary", retryable: false,
          message: "Compaction requires a non-empty text summary without tool calls and a normal completion.",
          usage: event.usage,
        };
      } else {
        yield event;
      }
      return;
    }
    if (event.type === "tool_call_start" || event.type === "tool_call_delta" || event.type === "tool_call_end"
      || event.type === "web_search_call_begin" || event.type === "web_search_call_end") attemptedTool = true;
    releaseTranslatedEvent(event, budget);
    yield { type: "heartbeat" };
  }
}
