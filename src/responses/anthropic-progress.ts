import { escapeMemoryCitationMentions } from "./citation-markers";
import { encodeReasoningEnvelope, decodeReasoningEnvelope, type ReasoningEnvelope } from "./reasoning-envelope";
import type { TranslatorBudget } from "../lib/translator-budget";

/**
 * A visible update is a presentation copy of one original signed thinking block. The copy is
 * escaped for a quoted memory-citation tag; the envelope keeps the raw text so the signed payload
 * is unchanged.
 */
export function anthropicProgressItems(text: string, signature: string, budget?: TranslatorBudget, escapeVisible = true) {
  const id = `msg_${crypto.randomUUID().replaceAll("-", "")}`;
  return [
    { type: "reasoning", id: `rs_${crypto.randomUUID().replaceAll("-", "")}`, summary: [],
      encrypted_content: encodeReasoningEnvelope({ sig: signature, txt: text, upd: id }, budget) },
    { type: "message", id, role: "assistant", status: "completed", phase: "commentary",
      content: [{ type: "output_text", text: escapeVisible ? escapeMemoryCitationMentions(text) : text, annotations: [] }] },
  ];
}

/** Remove only an adjacent exact mirror. Retain edited or unrelated assistant text.
 * Some clients omit message IDs on replay; the explicit phase and exact text still bind it.
 */
export function isAnthropicProgressMirror(item: unknown, envelope: ReasoningEnvelope | null): boolean {
  if (!envelope?.upd || typeof envelope.txt !== "string" || !item || typeof item !== "object") return false;
  const msg = item as { type?: unknown; id?: unknown; role?: unknown; phase?: unknown; content?: unknown };
  if (msg.type !== "message" && msg.type !== undefined) return false;
  if (msg.role !== "assistant" || msg.phase !== "commentary" || (msg.id !== undefined && msg.id !== envelope.upd)) return false;
  if (!Array.isArray(msg.content) || msg.content.length !== 1) return false;
  const part = msg.content[0] as { type?: unknown; text?: unknown } | undefined;
  return part?.type === "output_text"
    && (part.text === envelope.txt || part.text === escapeMemoryCitationMentions(envelope.txt));
}

export function anthropicProgressEnvelope(item: unknown, budget?: TranslatorBudget): ReasoningEnvelope | null {
  if (!item || typeof item !== "object") return null;
  const raw = item as { type?: unknown; encrypted_content?: unknown };
  if (raw.type !== "reasoning" || typeof raw.encrypted_content !== "string") return null;
  const envelope = decodeReasoningEnvelope(raw.encrypted_content, budget);
  return envelope?.upd && envelope.sig && typeof envelope.txt === "string" ? envelope : null;
}
