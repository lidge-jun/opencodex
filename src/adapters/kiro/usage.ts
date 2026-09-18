import { estimateTokens } from "../../lib/token-estimate";
import { KIRO_MODEL_CONTEXT_WINDOWS, normalizeKiroModelId } from "../../providers/kiro-models";
import { modelRecordValue } from "../../reasoning-effort";
import { sniffImageDimensions } from "../anthropic-image-guard";
import type { KiroImage } from "../kiro-images";
import type {
  OcxContentPart,
  OcxMessage,
  OcxParsedRequest,
} from "../../types";
import type { KiroHistoryEntry } from "./wire";

export function userContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content.map(p => (p.type === "text" ? p.text : "")).filter(Boolean).join("\n");
}

export function usageContentText(content: string | OcxContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .map(p => {
      if (p.type === "text") return p.text;
      if (p.type === "image") return `[image:${p.detail ?? "auto"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}
export function serializeForUsage(value: unknown): string {
  try { return JSON.stringify(value); } catch { return String(value); }
}
export function currentTurnUsageMessages(messages: OcxMessage[]): OcxMessage[] {
  return messages.slice(messages.map(m => m.role).lastIndexOf("assistant") + 1).filter(m => m.role !== "assistant");
}
export function kiroPayloadMessages(parsed: OcxParsedRequest): OcxMessage[] {
  return parsed.context.messages;
}

export function messageUsageText(msg: OcxMessage): string {
  switch (msg.role) {
    case "user":
    case "developer":
      return usageContentText(msg.content);
    case "toolResult":
      return [
        msg.toolName,
        msg.toolCallId,
        msg.isError ? "error" : "success",
        usageContentText(msg.content),
      ].filter(Boolean).join("\n");
    case "assistant":
      return "";
  }
}

export function messageLogText(msg: OcxMessage): string {
  if (msg.role !== "assistant") return messageUsageText(msg);
  return msg.content.map(part => {
    if (part.type === "text") return part.text;
    if (part.type === "toolCall") return [part.name, part.id, serializeForUsage(part.arguments)].join("\n");
    return part.thinking;
  }).filter(Boolean).join("\n");
}

export function estimateKiroImageTokens(image: KiroImage): number {
  const dimensions = sniffImageDimensions(image.source.bytes);
  if (dimensions) {
    return Math.max(256, Math.ceil(dimensions.width * dimensions.height / 750));
  }
  const decodedBytes = Math.floor(image.source.bytes.length * 3 / 4);
  return Math.max(256, Math.ceil(decodedBytes / 512));
}

export function estimateKiroTokens(text: string, modelId?: string): number {
  return estimateTokens(text, modelId ? `kiro/${modelId}` : "kiro");
}

/** Hangul/Han/kana ranges, matching the shared estimator's own CJK classification. */
export function kiroCjkCount(text: string): number {
  let cjk = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (
      (c >= 0xac00 && c <= 0xd7a3) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)
      || (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3040 && c <= 0x30ff)
    ) cjk++;
  }
  return cjk;
}

/**
 * Token estimate for walked payload text, with the wire expansion applied to the Latin portion
 * only. Splitting here rather than inside the shared estimator keeps that module pure and
 * provider-neutral: the expansion is a fact about Kiro's wire, not about tokenization.
 */
export function estimateKiroWireTokens(text: string, modelId: string): number {
  if (!text) return 0;
  const cjk = kiroCjkCount(text);
  if (cjk === 0) return Math.ceil(estimateKiroTokens(text, modelId) * KIRO_LATIN_WIRE_EXPANSION);
  const latinTokens = estimateKiroTokens("x".repeat(text.length - cjk), modelId);
  const cjkTokens = estimateKiroTokens("\uac00".repeat(cjk), modelId);
  return Math.ceil(latinTokens * KIRO_LATIN_WIRE_EXPANSION + cjkTokens);
}

/**
 * Structural cost of one conversation entry, in tokens.
 *
 * The walker below concatenates message TEXT, but the wire carries JSON: per-entry keys
 * (`userInputMessage`, `content`, `modelId`, `origin`) and role framing. That is charged
 * upstream and is invisible to a text-only count, so without it a long conversation drifts
 * further below the real charge with every turn added — an error proportional to entry COUNT,
 * which no per-character ratio can recover.
 *
 * Regressing serialized bodies against what the walker counts, over eleven payload sizes from
 * 3 to 701 entries:
 *
 *     bodyBytes = 1.0422 * walkedChars + 66.7 * entries + 68
 *
 * 66.7 bytes at the measured 2.433 bytes per charged token is 27.4 tokens per entry. The
 * earlier value of 12 was a conservative hand-fit taken before that regression existed, and
 * being less than half the real cost is precisely why the estimate decayed with conversation
 * length: an under-charge of ~15 tokens per entry is invisible across four messages and
 * dominant across seven hundred.
 *
 * Cross-checked against 4,090 recorded requests, where real traffic averages 1,310 bytes per
 * message: 66.7 bytes is 5% of that, so this term charges framing and is not quietly absorbing
 * message content.
 */
export const KIRO_ENTRY_FRAMING_TOKENS = 27;

/**
 * Multiplier reconciling the LATIN text estimate with what the wire charges for that same text.
 *
 * The shared estimator counts Latin text at 2.8 chars/token, while the wire charges 2.433 bytes
 * per token at 1.0422 bytes per walked character — an effective 2.334 chars/token, and
 * 2.8 / 2.334 = 1.199.
 *
 * The evidence that the split between this term and `KIRO_ENTRY_FRAMING_TOKENS` is right is its
 * stability: holding framing at 27, the multiplier the charge implies stays within 1.189-1.209
 * across a 230x range of conversation sizes. A mis-specified split drifts with size, and the
 * earlier 1.12/12 pair did — its accuracy fell from 0.92 at four messages to 0.87 at seven
 * hundred.
 *
 * LATIN ONLY, deliberately. 2.433 bytes/token is a property of this traffic mix, which is Latin
 * and code. A Hangul character is three UTF-8 bytes but roughly one token, so its bytes-per-token
 * is entirely different and a Latin-derived byte rate says nothing about it. Scaling CJK by this
 * factor bills Hangul at 1.25 chars/token, against recorded ground truth that already places the
 * shared 1.5 ratio at 0.90 of the authoritative count — an over-charge that would compact Korean
 * threads early.
 *
 * This is NOT JSON escaping, despite what an earlier version of this comment claimed. Measured
 * directly, `JSON.stringify` expands prose by 1.012 (Latin) to 1.019 (Korean), nowhere near 1.2.
 * Escaping is real but small, and is already inside the byte measurement this factor comes from.
 */
export const KIRO_LATIN_WIRE_EXPANSION = 1.2;

export function estimateKiroPayloadInputTokens(payload: Record<string, unknown>, modelId: string): number {
  const conversationState = (payload as {
    conversationState?: {
      history?: KiroHistoryEntry[];
      currentMessage?: KiroHistoryEntry;
    };
  }).conversationState;
  if (!conversationState) return 0;

  const parts: string[] = [];
  let imageTokens = 0;
  const entries = [
    ...(conversationState.history ?? []),
    ...(conversationState.currentMessage ? [conversationState.currentMessage] : []),
  ];
  for (const entry of entries) {
    const user = entry.userInputMessage;
    if (user) {
      if (user.content) parts.push(user.content);
      for (const image of user.images ?? []) imageTokens += estimateKiroImageTokens(image);
      const context = user.userInputMessageContext;
      if (context?.tools?.length) parts.push(serializeForUsage(context.tools));
      if (context?.toolResults?.length) parts.push(serializeForUsage(context.toolResults));
    }
    const assistant = entry.assistantResponseMessage;
    if (assistant) {
      if (assistant.content) parts.push(assistant.content);
      if (assistant.toolUses?.length) parts.push(serializeForUsage(assistant.toolUses));
    }
  }
  return estimateKiroWireTokens(parts.join("\n"), modelId)
    + imageTokens
    + entries.length * KIRO_ENTRY_FRAMING_TOKENS;
}

export function shouldCountStablePromptOverhead(parsed: OcxParsedRequest): boolean {
  return !parsed.previousResponseId && !parsed.context.messages.some(m => m.role === "assistant");
}

export function estimateKiroInputTokens(parsed: OcxParsedRequest): number {
  const parts = currentTurnUsageMessages(parsed.context.messages)
    .map(messageUsageText)
    .filter(Boolean);

  if (shouldCountStablePromptOverhead(parsed)) {
    if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
    if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  }

  return estimateKiroTokens(parts.join("\n"), parsed.modelId);
}

export function estimateKiroLogInputTokens(parsed: OcxParsedRequest): number {
  const parts = parsed.context.messages.map(messageLogText).filter(Boolean);
  if (parsed.context.systemPrompt?.length) parts.push(...parsed.context.systemPrompt);
  if (parsed.context.tools?.length) parts.push(serializeForUsage(parsed.context.tools));
  return Math.max(estimateKiroInputTokens(parsed), estimateKiroTokens(parts.join("\n"), parsed.modelId));
}

export function kiroUpstreamContextWindow(modelId: string | undefined): number | undefined {
  if (!modelId) return undefined;
  const normalizedModelId = normalizeKiroModelId(modelId);
  if (normalizedModelId === "auto") return undefined;
  const window = modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, modelId)
    ?? modelRecordValue(KIRO_MODEL_CONTEXT_WINDOWS, normalizedModelId);
  return typeof window === "number" && Number.isFinite(window) && window > 0 ? window : undefined;
}
