/**
 * Devin reasoning signatures across turns.
 *
 * GetChatMessage returns the turn's reasoning attestation as `delta_signature`
 * (#10) together with `delta_signature_type` (#21) in the same frame, and the
 * native client replays both on the assistant prompt as #12 and #18. Measured
 * live on swe-2-high the pair arrives AFTER the visible answer (reasoning, text,
 * then signature), so the Responses layer stores it as its own signature-only
 * reasoning item behind the thinking-text item. GPT and Gemini rows stream no
 * thinking text at all, only the signature.
 *
 * The type is carried inside the stored signature because the reasoning
 * envelope that round-trips through the client keeps a single signature string.
 * A signature stored before this prefix existed replays without a type.
 */
import type { OcxAssistantMessage } from "../../types";
import { isProviderIssuedThinkingSignature } from "../../responses/reasoning-envelope";

const TYPED_SIGNATURE_PREFIX = "devin-sig1:";

export function encodeDevinSignature(signature: string, signatureType: string | undefined): string {
  return signatureType && !signatureType.includes(":")
    ? `${TYPED_SIGNATURE_PREFIX}${signatureType}:${signature}`
    : signature;
}

export function decodeDevinSignature(stored: string): { signature: string; signatureType?: string } {
  if (!stored.startsWith(TYPED_SIGNATURE_PREFIX)) return { signature: stored };
  const rest = stored.slice(TYPED_SIGNATURE_PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon <= 0) return { signature: stored };
  return { signature: rest.slice(colon + 1), signatureType: rest.slice(0, colon) };
}

/**
 * The assistant turn's reasoning for ChatMessagePrompt #11/#12/#18.
 *
 * All of the turn's thinking text is replayed. A signature rides along only
 * when it covers exactly that text:
 * - one thinking block carrying its own issued signature (a stray
 *   signature-only block does not displace it);
 * - at most one unsigned thinking block plus exactly one signature-only block,
 *   which is how a single Devin turn arrives once its late #10 frame has been
 *   split into its own reasoning item. With no thinking block at all this is a
 *   GPT or Gemini row, where the signature is the only reasoning there is.
 * Any other mix (two signed blocks, a signed block beside unsigned text) has no
 * single attestation for the joined text, so the turn is replayed unsigned.
 *
 * `withholdAnthropic` drops an Anthropic signature and keeps the text: the
 * fallback for a Claude turn Cognition refused (see hasAnthropicSignature).
 */
export function devinAssistantReasoning(
  message: OcxAssistantMessage,
  modelId = "",
  withholdAnthropic = false,
): { thinking?: string; signature?: string; signature_type?: string } {
  const blocks = message.content.filter(
    (part): part is Extract<typeof part, { type: "thinking" }> => part.type === "thinking",
  );
  const textBlocks = blocks.filter(part => Boolean(part.thinking));
  const signatureOnly = blocks.filter(part => !part.thinking && isProviderIssuedThinkingSignature(part.signature));
  const text = textBlocks.map(part => part.thinking).join("\n");
  let stored: string | undefined;
  if (textBlocks.length === 1 && isProviderIssuedThinkingSignature(textBlocks[0]!.signature)) {
    stored = textBlocks[0]!.signature;
  } else if (textBlocks.length === 0 && signatureOnly.length === 1) {
    stored = signatureOnly[0]!.signature;
  } else if (textBlocks.length === 1 && signatureOnly.length === 1) {
    // Only the late trailer shape attests this text. The Responses parser can
    // fold reasoning around a call into one assistant message, so counting
    // blocks without checking their position can attach an unrelated signature.
    const textIndex = message.content.indexOf(textBlocks[0]!);
    if (message.content[textIndex + 1] === signatureOnly[0]) stored = signatureOnly[0]!.signature;
  }
  let decoded = stored ? decodeDevinSignature(stored) : undefined;
  if (decoded && withholdAnthropic && signatureTypeFor(decoded, modelId) === "anthropic") decoded = undefined;
  return {
    ...(text ? { thinking: text } : {}),
    ...(decoded ? { signature: decoded.signature } : {}),
    ...(decoded?.signatureType ? { signature_type: decoded.signatureType } : {}),
  };
}

/** A stored signature from before its type was recorded falls back to the model being called. */
function signatureTypeFor(decoded: { signatureType?: string }, modelId: string): string | undefined {
  return decoded.signatureType ?? (/claude/i.test(modelId) ? "anthropic" : undefined);
}

/**
 * True when the mapped history replays a Claude signature. Cognition streams
 * Claude's thinking as a summary while the signature covers the original, so
 * the pair can fail validation: live on claude-opus-5-5 a signed replay of a
 * visible-thinking turn was refused with `invalid_argument` in 5 of 6 tries and
 * a text-only one in none, while a signed replay that is accepted is what lets
 * the model recall its earlier reasoning. The adapter therefore sends the
 * signature and retries a refusal once without it.
 */
export function hasAnthropicSignature(items: ReadonlyArray<{ signature?: string; signature_type?: string }>, modelId: string): boolean {
  return items.some(item => Boolean(item.signature) && signatureTypeFor({ signatureType: item.signature_type }, modelId) === "anthropic");
}
