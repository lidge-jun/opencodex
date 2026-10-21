import type { AdapterEvent } from "../types";
import type { OcxErrorPayload } from "../lib/errors";
import { redactSecretString } from "../lib/redact";

/**
 * The terminal-refusal code Codex ends a turn on. It is a member of `TERMINAL_REFUSAL_CODES`
 * in `src/lib/errors.ts`, and the one that says "this prompt, as sent, is refused" without
 * claiming a specific policy family the upstream never named.
 */
const TERMINAL_REFUSAL_FAILED_CODE = "invalid_prompt";

interface TerminalRefusalFailure {
  error: OcxErrorPayload;
  last_error: OcxErrorPayload;
  retryable: false;
}

/**
 * Client-visible copy: what happened, and that resending the same context cannot help. It points
 * at a new conversation rather than a new turn, because a later turn replays the refused context.
 */
function terminalRefusalMessage(detail: string | undefined): string {
  const reason = detail?.trim() ? ` (${redactSecretString(detail.trim())})` : "";
  return `The upstream model refused this request${reason}. `
    + "Retrying with the same conversation context will not succeed; change the request or start a new conversation.";
}

/**
 * An adapter `incomplete` that is a non-retryable upstream refusal: a content filter carrying an
 * explicit `retryable: false` verdict. A filter without the verdict, an output cap, a stall and an
 * adapter EOF do not qualify. The sidecar loops read this too: a refused iteration ends the turn,
 * so a sidecar call it carried is neither run nor answered with another model request.
 */
export function isTerminalRefusalIncomplete(event: AdapterEvent | undefined): boolean {
  return event?.type === "incomplete" && event.reason === "content_filter" && event.retryable === false;
}

/**
 * `response.failed` fields for an adapter `incomplete` that is a non-retryable upstream refusal
 * (#4312), or `undefined` when the event is anything else. The Anthropic and Kiro adapters are
 * the ones that emit it today.
 *
 * codex-rs maps every `response.incomplete` to a retryable stream error and never reads
 * `incomplete_details.retryable`, so a refusal delivered that way is re-sent through the whole
 * stream retry budget. It only ends the turn on `response.failed` carrying a terminal-refusal
 * `error.code`. Only an explicit `retryable: false` content filter qualifies: a filter without
 * the verdict, an output cap, a stall and an adapter EOF stay `response.incomplete`.
 */
export function terminalRefusalFailure(
  event: Extract<AdapterEvent, { type: "incomplete" }>,
): TerminalRefusalFailure | undefined {
  if (!isTerminalRefusalIncomplete(event)) return undefined;
  const error: OcxErrorPayload = {
    type: "invalid_request_error",
    code: TERMINAL_REFUSAL_FAILED_CODE,
    message: terminalRefusalMessage(event.message),
  };
  return { error, last_error: error, retryable: false };
}
