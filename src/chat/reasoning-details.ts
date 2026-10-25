/**
 * Anthropic thinking state on the Chat Completions wire, as OpenRouter-style `reasoning_details`
 * (#7429).
 *
 * Chat has no slot for a thinking block's signature, so a Chat client echoing `reasoning_content`
 * gave Claude back unsigned text, which the Anthropic adapter must drop: every tool step lost its
 * reasoning. The carrier is the one OpenRouter documents for Claude and Hermes and pi already round
 * trip: an ordered array on the assistant message, `{type: "reasoning.text", text, signature}`
 * for a signed thinking block and `{type: "reasoning.encrypted", data}` for a redacted one.
 *
 * Outbound, the entries are built from the signature and redacted payloads the provider issued,
 * never from anything this proxy computes. A signature that signs text the client never saw
 * (hidden thinking) is withheld, because pairing it with the visible text would attest to content
 * Anthropic did not sign. Inbound, the entries are read only for a single-destination first-party
 * Anthropic route (the caller decides that), only when every entry is well formed, and become the
 * same `ocxr1` envelope the Responses wire already uses; anything else falls back to plaintext.
 */
import {
  decodeReasoningEnvelope,
  encodeReasoningEnvelope,
  isLikelyRealAnthropicThinkingSignature,
  type ReasoningEnvelope,
} from "../responses/reasoning-envelope";
import type { TranslatorBudget } from "../lib/translator-budget";

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** OpenRouter's `format` for Anthropic thinking entries. */
export const ANTHROPIC_REASONING_DETAIL_FORMAT = "anthropic-claude-v1";

/**
 * One `reasoning.text` detail the inbound replay accepts as Anthropic state: Anthropic's format
 * marker or no format at all, a text the client saw, and a signature with Anthropic's spelling.
 * A client spelling the same signed block without OpenRouter's marker carries the same opaque
 * state, so the native passthrough boundary must see it too.
 */
function isAnthropicSignedReasoningText(detail: Rec): detail is Rec & { text: string; signature: string } {
  if (detail.type !== "reasoning.text") return false;
  if (detail.format !== undefined && detail.format !== ANTHROPIC_REASONING_DETAIL_FORMAT) return false;
  const signature = typeof detail.signature === "string" ? detail.signature : undefined;
  return typeof detail.text === "string" && isLikelyRealAnthropicThinkingSignature(signature);
}

/**
 * Whether a Chat body contains provider-issued Anthropic state that another provider must not
 * see: a `reasoning_details` entry carrying Anthropic's format marker, or an unmarked signed
 * `reasoning.text` entry the inbound replay would accept.
 */
export function chatBodyCarriesAnthropicReasoningState(body: Rec): boolean {
  if (!Array.isArray(body.messages)) return false;
  return body.messages.some(message => isRec(message)
    && Array.isArray(message.reasoning_details)
    && message.reasoning_details.some(detail => isRec(detail)
      && (detail.format === ANTHROPIC_REASONING_DETAIL_FORMAT || isAnthropicSignedReasoningText(detail))));
}

/** One closed reasoning item, as either outbound path sees it. */
export interface ReasoningDetailSource {
  /** The thinking text the client was shown for this item. */
  text: string;
  signature?: string;
  redacted?: readonly string[];
  /** The signature covers thinking text the client was not shown. */
  hidden?: boolean;
}

/**
 * The `reasoning_details` entries for one reasoning item, numbered from `firstIndex`. Redacted
 * blocks come first: that is the order the adapter replays them in. Empty when the item carries no
 * provider-issued state a Chat client can return.
 */
export function reasoningDetailEntries(source: ReasoningDetailSource, firstIndex: number): Rec[] {
  const entries: Rec[] = [];
  for (const data of source.redacted ?? []) {
    if (typeof data !== "string" || data.length === 0) continue;
    entries.push({
      type: "reasoning.encrypted",
      data,
      format: ANTHROPIC_REASONING_DETAIL_FORMAT,
      index: firstIndex + entries.length,
    });
  }
  if (source.hidden !== true && isLikelyRealAnthropicThinkingSignature(source.signature)) {
    entries.push({
      type: "reasoning.text",
      text: source.text,
      signature: source.signature,
      format: ANTHROPIC_REASONING_DETAIL_FORMAT,
      index: firstIndex + entries.length,
    });
  }
  return entries;
}

/** The visible text of a Responses reasoning item, read the way the parser reads it. */
export function responsesReasoningItemText(item: Rec): string {
  const pick = (parts: unknown, type: string): string => Array.isArray(parts)
    ? parts.filter((part): part is Rec => isRec(part) && part.type === type && typeof part.text === "string")
      .map(part => part.text as string).join("")
    : "";
  return pick(item.summary, "summary_text") || pick(item.content, "reasoning_text");
}

/**
 * The entries for a finished Responses reasoning item from the internal bridge. Its `ocxr1`
 * envelope holds what the provider issued. `txt` alone means the signed text was hidden; `txt`
 * with `upd` is an Opus progress update, whose signed text the client received as `content`.
 */
export function reasoningDetailEntriesForItem(item: Rec, firstIndex: number, budget?: TranslatorBudget): Rec[] {
  if (typeof item.encrypted_content !== "string") return [];
  const envelope = decodeReasoningEnvelope(item.encrypted_content, budget);
  if (!envelope || (!envelope.sig && !envelope.red)) return [];
  const progress = envelope.upd !== undefined && typeof envelope.txt === "string";
  return reasoningDetailEntries({
    text: progress ? envelope.txt! : responsesReasoningItemText(item),
    ...(envelope.sig ? { signature: envelope.sig } : {}),
    ...(envelope.red ? { redacted: envelope.red } : {}),
    hidden: !progress && envelope.txt !== undefined,
  }, firstIndex);
}

function reasoningInputItem(text: string, envelope: ReasoningEnvelope): Rec {
  return {
    type: "reasoning",
    summary: text ? [{ type: "summary_text", text }] : [],
    ...(text ? { content: [{ type: "reasoning_text", text }] } : {}),
    encrypted_content: encodeReasoningEnvelope(envelope),
  };
}

/**
 * Responses reasoning input items carrying the signatures a client returned in
 * `reasoning_details`, or `undefined` when the array is absent, empty or holds anything this
 * carrier did not issue — an unsigned or malformed signature, a summary entry, another provider's
 * encrypted format. Undefined means the caller keeps its plaintext projection unchanged.
 */
export function signedReasoningInputItems(details: unknown): Rec[] | undefined {
  if (!Array.isArray(details) || details.length === 0) return undefined;
  const items: Rec[] = [];
  let redacted: string[] = [];
  for (const raw of details) {
    if (!isRec(raw)) return undefined;
    if (raw.type === "reasoning.encrypted") {
      if (raw.format !== ANTHROPIC_REASONING_DETAIL_FORMAT || typeof raw.data !== "string" || raw.data.length === 0) {
        return undefined;
      }
      redacted.push(raw.data);
      continue;
    }
    if (!isAnthropicSignedReasoningText(raw)) return undefined;
    items.push(reasoningInputItem(raw.text, { sig: raw.signature, ...(redacted.length > 0 ? { red: redacted } : {}) }));
    redacted = [];
  }
  if (redacted.length > 0) items.push(reasoningInputItem("", { red: redacted }));
  return items;
}
