import type { AdapterEvent, OcxRequestOptions } from "../types";

export interface MaxOutputCompletionOptions {
  /** Set only for an explicitly opted-in Responses inbound request. */
  completeOnMaxOutputTokens?: boolean;
  textFormat?: OcxRequestOptions["textFormat"];
  compaction?: boolean;
}

/** Track the original event stream: bridge cleanup must not erase an unfinished operation. */
export function createMaxOutputCompletion(options?: MaxOutputCompletionOptions) {
  let textOnly = options?.completeOnMaxOutputTokens === true && !options.compaction && !options.textFormat;
  let hasText = false;
  let completed = false;
  return {
    observe(event: AdapterEvent): void {
      switch (event.type) {
        case "text_delta":
          if (event.anthropicThinkingSignature !== undefined) textOnly = false;
          if (event.text.length > 0) hasText = true;
          break;
        case "heartbeat":
        case "assistant_boundary":
          break;
        case "done":
        case "incomplete": {
          const reason = event.type === "done" ? event.stopReason : event.reason;
          completed = textOnly && hasText && event.endTurn !== false
            && (event.type !== "done" || event.compactionEncryptedContent === undefined)
            && (reason === "max_tokens" || reason === "length" || reason === "max_output_tokens");
          break;
        }
        default:
          // All non-text output and unknown future operations are excluded, even if hidden or closed.
          textOnly = false;
          completed = false;
      }
    },
    get completed(): boolean { return completed; },
  };
}
