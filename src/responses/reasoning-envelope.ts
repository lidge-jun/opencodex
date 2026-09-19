/**
 * Anthropic extended-thinking signature round-trip through Codex's `encrypted_content` slot.
 *
 * Anthropic requires the previous assistant turn's `thinking`/`redacted_thinking` blocks to be
 * replayed VERBATIM (with their signatures) while extended thinking is enabled; a signature-less
 * replay 400s ("Expected `thinking` or `redacted_thinking`, but found `tool_use`"). Codex round-trips
 * whatever `encrypted_content` a reasoning output item carries (include: reasoning.encrypted_content
 * is set whenever reasoning is on — codex-rs client.rs), so the proxy smuggles the real Anthropic
 * signature (and any redacted blocks) inside a transparent `ocxr1:` + base64(JSON) envelope.
 *
 * Native OpenAI-encrypted blobs (no ocxr1 prefix) are left untouched by the decoder, and the
 * passthrough scrub strips ocxr1 envelopes before native forwarding.
 */

import { createTranslatorBudget, type TranslatorBudget } from "../lib/translator-budget";
import { jsonUtf8Bytes } from "../lib/json-byte-size";

export const OCX_REASONING_PREFIX = "ocxr1:";

export interface ReasoningEnvelope {
  /** Anthropic thinking-block signature (signature_delta), if captured. */
  sig?: string;
  /** Raw redacted_thinking block data payloads, order preserved. */
  red?: string[];
  /**
   * Hidden thinking text (hideThinkingSummary providers): the signature signs this exact text,
   * so replay needs it even though the visible summary was suppressed.
   */
  txt?: string;
  /**
   * Kiro's reasoning blob from `reasoningContentEvent`: a KMS-encrypted value that is opaque to the
   * proxy (the GPT-5.6 family sends it as `signature`, other models as the base64
   * `redactedContent`, and the value carries a tag naming which one — see
   * src/adapters/kiro/reasoning.ts). Kiro's own CLI replays it on the matching
   * `assistantResponseMessage` to preserve model reasoning across turns, so it round-trips here the
   * same way a signature does.
   */
  krc?: string;
}

export function encodeReasoningEnvelope(envelope: ReasoningEnvelope, budget?: TranslatorBudget): string {
  const activeBudget = budget ?? createTranslatorBudget();
  try {
    const jsonBytes = jsonUtf8Bytes(envelope);
    const base64Bytes = 4 * Math.ceil(jsonBytes / 3);
    // Reserve before materialization: UTF-16 JSON, UTF-8 buffer, base64 string,
    // and the prefixed result may coexist. Returned-value ownership stays with
    // callers, whose existing retained accounting must not be charged twice here.
    const reservation = activeBudget.reserveTransient(
      Math.max(
        3 * jsonBytes + 4 * base64Bytes + 2 * OCX_REASONING_PREFIX.length,
        8 * (OCX_REASONING_PREFIX.length + base64Bytes),
      ),
      { kind: "reasoning" },
    );
    try {
      return OCX_REASONING_PREFIX + Buffer.from(JSON.stringify(envelope), "utf-8").toString("base64");
    } finally {
      reservation.release();
    }
  } finally {
    if (!budget) activeBudget.dispose();
  }
}

/**
 * Whether a thinking part's `signature` is an attestation some provider issued, rather than
 * the serialized reasoning item the parser parks in the same field.
 *
 * `src/responses/parser.ts` stores `JSON.stringify(reasoningItem)` on an UNSIGNED thinking
 * part so the opaque item survives a same-provider round trip. Every adapter that forwards a
 * signature upstream is forwarding an opaque attestation, and a provider asked to verify our
 * own parser state cannot recognize it. The predicate lives beside the envelope code that owns
 * this field's representation rather than in one adapter, because a private second copy is how
 * the side that writes the field and a side that reads it come to disagree about what it holds.
 *
 * This is a deny-list for exactly that one shape, not a guess at what an attestation looks
 * like. `src/adapters/anthropic.ts` applies a stricter allow-list on top of it, because an
 * Anthropic signature has a known base64 spelling; that shape is a fact about Anthropic's wire
 * and is not assumed of any other provider's token here.
 */
export function isProviderIssuedThinkingSignature(
  signature: string | undefined,
): signature is string {
  if (typeof signature !== "string" || signature.length === 0) return false;
  if (!signature.startsWith("{")) return true;
  try {
    const parsed: unknown = JSON.parse(signature);
    return !parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || (parsed as { type?: unknown }).type !== "reasoning";
  } catch {
    return true;
  }
}

/** Decode an ocxr1 envelope; returns null for native (OpenAI-encrypted) blobs or garbage. */
export function decodeReasoningEnvelope(encryptedContent: string, budget?: TranslatorBudget): ReasoningEnvelope | null {
  if (!encryptedContent.startsWith(OCX_REASONING_PREFIX)) return null;
  const activeBudget = budget ?? createTranslatorBudget();
  try {
    // Also bound already-encoded replay before slicing, decoding, or parsing it.
    // Eight bytes per code unit conservatively covers the string/buffer copies.
    const reservation = activeBudget.reserveTransient(8 * encryptedContent.length, { kind: "reasoning" });
    try {
      const parsed: unknown = JSON.parse(Buffer.from(encryptedContent.slice(OCX_REASONING_PREFIX.length), "base64").toString("utf-8"));
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
      const obj = parsed as { sig?: unknown; red?: unknown };
      const envelope: ReasoningEnvelope = {};
      if (typeof obj.sig === "string") envelope.sig = obj.sig;
      if (Array.isArray(obj.red)) {
        const red = obj.red.filter((r): r is string => typeof r === "string");
        if (red.length > 0) envelope.red = red;
      }
      const txt = (parsed as { txt?: unknown }).txt;
      const hasTxt = typeof txt === "string";
      if (hasTxt) envelope.txt = txt;
      const krc = (parsed as { krc?: unknown }).krc;
      if (typeof krc === "string" && krc.length > 0) envelope.krc = krc;
      return envelope.sig || envelope.red || hasTxt || envelope.krc ? envelope : null;
    } catch {
      return null;
    } finally {
      reservation.release();
    }
  } finally {
    if (!budget) activeBudget.dispose();
  }
}
