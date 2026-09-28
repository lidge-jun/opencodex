/**
 * Recognise an oversized Devin history behind Cognition's opaque refusal.
 *
 * Measured live on swe-1-6 (200k context): a 1.2 MB or 3 MB history is refused
 * after ~11s with `invalid_argument` and no output, the same code a bad tool
 * schema gets. Passed through as a plain 400, Codex never learns its context is
 * full and never compacts, so every later turn dead-ends the same way. Only a
 * request large against the model's window is reclassified; a small request
 * with the same code stays an ordinary 400.
 *
 * Boundary, binary-searched live on swe-1-6 (200k catalog window, 8192 output):
 * accepted at 199,186 prompt tokens of prose and 200,345 of JSON, refused at
 * ~203k of either. Raising the output cap to 32000 did not move it (195,571
 * input tokens still accepted), so the window is not reduced by the output
 * reservation and the threshold is the window itself.
 */
import type { AdapterEvent } from "../../types";
import type { ChatHistoryItem, ToolDef } from "./cloud-direct";
import { prepareToolDescriptionForCognition } from "./cloud-direct/chat";

/**
 * Share of the window the estimate must reach. Characters per real token ran
 * from 1.33 (Korean) through 2.31 (JSON) and 4.23 (source code) to 5.53
 * (prose), so no character ratio separates "over the window" from "60% of it".
 * The word-piece count below read 1.00x to 1.54x of the real count on those
 * samples: at 0.95 every sample at the window is caught and none at 60% is.
 */
const WINDOW_SHARE = 0.95;
/** One token per short letter run, 1-3 digit group, or other visible character. */
const WORD_PIECE = /[A-Z]?[a-z]{1,8}|[A-Z]{1,8}(?![a-z])|\d{1,3}|\S/g;
/** Text size that counts as oversized when the model's window is unknown. */
const UNKNOWN_WINDOW_CHARS = 512 * 1024;

export const DEVIN_CONTEXT_OVERFLOW_MESSAGE =
  "Devin rejected this turn and its history is at or past the model's context window. Compact the conversation or start a new session.";

/** Text the model would tokenize; image bytes are excluded so a screenshot cannot look like a long history. */
function requestText(messages: ChatHistoryItem[], tools: ToolDef[] | undefined): string {
  const parts: string[] = [];
  for (const m of messages) {
    if (typeof m.content === "string") parts.push(m.content);
    else for (const p of m.content) if (p.type === "text") parts.push(p.text);
    for (const call of m.tool_calls ?? []) parts.push(call.arguments);
    if (m.thinking) parts.push(m.thinking);
  }
  for (const tool of tools ?? []) parts.push(prepareToolDescriptionForCognition(tool.description ?? ""), JSON.stringify(tool.parameters ?? {}));
  return parts.join("\n");
}

export function isDevinHistoryOverflow(input: {
  code: string | undefined;
  producedOutput: boolean;
  contextWindow: number | undefined;
  messages: ChatHistoryItem[];
  tools: ToolDef[] | undefined;
}): boolean {
  if (input.code !== "invalid_argument" || input.producedOutput) return false;
  const text = requestText(input.messages, input.tools);
  if (!input.contextWindow) return text.length >= UNKNOWN_WINDOW_CHARS;
  let pieces = 0;
  for (const _ of text.matchAll(WORD_PIECE)) pieces++;
  return pieces >= input.contextWindow * WINDOW_SHARE;
}

/** Same terminal shape the Kiro adapter uses, which Codex reads as "context full, compact". */
export function devinContextOverflowEvent(): Extract<AdapterEvent, { type: "error" }> {
  return {
    type: "error",
    message: DEVIN_CONTEXT_OVERFLOW_MESSAGE,
    status: 400,
    errorType: "invalid_request_error",
    code: "context_length_exceeded",
    retryable: false,
  };
}
