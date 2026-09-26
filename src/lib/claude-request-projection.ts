/**
 * Project a Messages request body onto the content a settled route actually serializes.
 *
 * `estimateClaudeRequestTokens` measures the caller's body as JSON. That is exactly right for the
 * Anthropic-native wire, where a replayed `thinking` block — signature included — is forwarded
 * verbatim. A routed wire may serialize far less, and on the Chat wire it does: replayed thinking
 * becomes an optional `reasoning_content` string, the signature is never sent at all
 * (`src/adapters/openai-chat/messages.ts` has no `signature` reference), and the text is dropped
 * outright unless the model is on the provider's `preserveReasoningContentModels` list.
 *
 * The gap that opens is not a rounding error. On a captured 260-message Claude Code turn, replayed
 * thinking blocks were 78.8% of the body's JSON characters and 56.7% of those characters were
 * base64 signatures — bytes that are not prompt text under any tokenizer. Counting them made the
 * published `message_start.usage.input_tokens` 3.28x the count the upstream actually reported
 * (#4857 + the Paseo context meter it feeds), well past the >2x drift bound this estimator is held
 * to (devlog 260711_claude_inbound 040 §3).
 *
 * The projection is therefore applied to the ESTIMATE only. The body the caller sent is never
 * rewritten; this is a measurement that describes the route, not a transformation of the request.
 */

/** Which replayed reasoning blocks and fields a wire serializes. */
export interface ClaudeThinkingProjection {
  /** Serialize `thinking.thinking`, the model's own replayed text. */
  text: boolean;
  /**
   * Serialize `thinking.signature`, the provider's base64 replay token. Real prompt size for
   * wires that carry it; pure overhead for wires that do not.
   */
  signature: boolean;
  /**
   * Serialize a `redacted_thinking` block, whose `data` is an opaque provider blob. It rides
   * alongside `thinking` rather than inside it: a wire can reconstruct the model's reasoning
   * without carrying the encrypted form, and the Chat wire does exactly that.
   */
  redacted: boolean;
}

/**
 * The Anthropic-native wire forwards a replayed thinking block verbatim, signature included, so
 * nothing is projected away. This is the default: an unknown route keeps the measured body.
 */
export const CLAUDE_NATIVE_THINKING: ClaudeThinkingProjection = { text: true, signature: true, redacted: true };

interface ProjectableBody {
  system?: unknown;
  messages?: unknown;
  tools?: unknown;
}

/**
 * One content block as the given wire would carry it.
 *
 * `undefined` means the wire sends nothing for it, and the caller drops the entry. A `thinking`
 * block that keeps its text but not its signature is returned as a copy rather than edited: the
 * block object is shared with the outbound request builder, which must stay untouched.
 */
function projectBlock(block: unknown, thinking: ClaudeThinkingProjection): unknown {
  if (!block || typeof block !== "object") return block;
  if (!("type" in block)) return block;
  if (block.type === "redacted_thinking") return thinking.redacted ? block : undefined;
  if (block.type !== "thinking") return block;
  if (!thinking.text) return undefined;
  if (thinking.signature || !("signature" in block)) return block;
  // Copy without the signature: the caller's block object is shared with the outbound request
  // builder, so it must never be edited in place.
  const { signature: _dropped, ...rest } = block;
  return rest;
}

/**
 * A copy of `raw` whose message content carries only the replayed thinking this route serializes.
 *
 * Pure and idempotent; the input is never mutated. Blocks are dropped only inside array-valued
 * message `content`, which is the sole protocol position a replayed thinking block occupies.
 * A message whose content array empties out is left as an empty array rather than deleted: the
 * adapter's own "nothing left to send" rule is keyed on text, tool calls and reasoning together,
 * and re-deriving it here would be a second copy of that rule to keep in sync.
 */
export function projectClaudeRequest(
  raw: ProjectableBody,
  thinking: ClaudeThinkingProjection,
): ProjectableBody {
  if (thinking.text && thinking.signature && thinking.redacted) return raw;
  if (!Array.isArray(raw.messages)) return raw;
  const messages = raw.messages as unknown[];
  return {
    ...raw,
    messages: messages.map(message => {
      if (!message || typeof message !== "object") return message;
      if (!("content" in message) || !Array.isArray(message.content)) return message;
      const content = message.content as unknown[];
      return {
        ...message,
        content: content
          .map(block => projectBlock(block, thinking))
          .filter(block => block !== undefined),
      };
    }),
  };
}
