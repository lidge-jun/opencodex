import { normalizeKiroModelId } from "../../providers/kiro-models";
import type { OcxParsedRequest } from "../../types";

export type KiroReasoningMode = "native" | "emulated";

// Kiro takes a verified native effort field for these models, and each model family names it
// differently: the GPT-5.6 family's `reasoning.effort` versus the Claude-specific
// `output_config.effort`. Models absent from this table fall back to emulated thinking
// instructions.
//
// The GPT-5.6 entries are measured against the live runtime rather than inferred from the vendor
// schema: the field is accepted (HTTP 200) and the encrypted reasoning blob that comes back grows
// with the effort. On one fixed hard prompt — a primality search plus a 20-bit recurrence count —
// luna's blob measured 5,130 chars at `low`, 16,686 at `medium`, 30,670 at `high` and 48,594 at
// `max`, against 13,118 with no effort signal at all; terra's measured 34,590 and 38,106 at native
// `max` against 11,758 and 17,598 bare, two repetitions each. The channel this replaces — the
// emulated `<thinking_mode>` tag block, which was all those models used to receive — measured
// 21,202 (`low`) and 28,302 (`max`) for luna, i.e. between that model's native `medium` and
// `high`, never reaching native `max`. `gpt-5.6-sol`'s native `max` cross-checked at 30,498 on the
// same prompt. Terra's absence from this table was therefore an omission rather than a capability
// difference: what the earlier Sol-only scope recorded was not reproducible here.
export const KIRO_NATIVE_EFFORT_FIELDS: Record<string, "reasoning" | "output_config"> = {
  "gpt-5.6-sol": "reasoning",
  "gpt-5.6-terra": "reasoning",
  "gpt-5.6-luna": "reasoning",
  "claude-opus-5": "output_config",
  // 260923 preemptive (see kiro-models.ts): same Claude-specific field as Opus 5.
  "claude-opus-5.5": "output_config",
};

export const KIRO_NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// The newly enabled models have evidence for these rungs only. Keep the previous
// emulation for xhigh, and never widen their native wire when the shared ladder grows.
const KIRO_LUNA_TERRA_NATIVE_EFFORTS = new Set(["low", "medium", "high", "max"]);

export function kiroNativeEffortField(
  modelId: string,
  effort?: string,
): "reasoning" | "output_config" | undefined {
  const model = normalizeKiroModelId(modelId);
  if ((model === "gpt-5.6-luna" || model === "gpt-5.6-terra")
    && effort !== undefined && !KIRO_LUNA_TERRA_NATIVE_EFFORTS.has(effort)) return undefined;
  return KIRO_NATIVE_EFFORT_FIELDS[model];
}

export function kiroReasoningMode(modelId: string, effort?: string): KiroReasoningMode {
  return kiroNativeEffortField(modelId, effort) ? "native" : "emulated";
}

export function kiroThinkingBudget(parsed: OcxParsedRequest): number | undefined {
  const effort = parsed.options.reasoning;
  if (!effort || effort === "none") return undefined;
  const maxTokens = parsed.options.maxOutputTokens || 4096;
  const percent: Record<string, number> = {
    minimal: 0.10,
    low: 0.20,
    medium: 0.50,
    high: 0.80,
    xhigh: 0.90,
    max: 0.95,
  };
  const ratio = percent[effort];
  return ratio === undefined ? undefined : Math.max(1, Math.floor(maxTokens * ratio));
}

export function injectKiroThinkingTags(content: string, parsed: OcxParsedRequest): string {
  if (kiroReasoningMode(parsed.modelId, parsed.options.reasoning) !== "emulated") return content;
  const budget = kiroThinkingBudget(parsed);
  if (!budget) return content;
  const instruction = [
    "Think in English for better reasoning quality.",
    "Be thorough and systematic, consider edge cases, challenge assumptions, and verify reasoning before answering.",
    "After thinking, respond in the user's language.",
  ].join("\n");
  return [
    "<thinking_mode>enabled</thinking_mode>",
    `<max_thinking_length>${budget}</max_thinking_length>`,
    `<thinking_instruction>${instruction}</thinking_instruction>`,
    "",
    content,
  ].join("\n");
}

/**
 * The blob from a Kiro `reasoningContentEvent` has two possible homes on a replayed assistant
 * turn, and the wire validates the SHAPE of each rather than its content: `signature` takes the
 * emitted string verbatim, while `redactedContent` is a base64 member. The `.KTR~~…` value every
 * GPT-5.6 capture returns is NOT valid base64, which is exactly why replaying it as
 * `redactedContent` — what this proxy did before the field was measured — came back as
 * REQUEST_BODY_INVALID ("Improperly formed request").
 *
 * The blob travels as ONE opaque string: adapter event, `ocxr1:` reasoning envelope, then
 * `OcxAssistantMessage.kiroRedactedReasoning`. The field it arrived on therefore rides that same
 * string, instead of a second parallel value that could drift from it. Provider data cannot forge
 * the tag: the other channel is base64, whose alphabet has no colon.
 */
export const KIRO_REASONING_SIGNATURE_TAG = "signature:";

export function tagKiroReasoningBlob(field: "signature" | "redactedContent", data: string): string {
  return field === "signature" ? KIRO_REASONING_SIGNATURE_TAG + data : data;
}

/** The wire field a stored blob arrived on, and its untagged value. */
export function splitKiroReasoningBlob(value: string): { field: "signature" | "redactedContent"; data: string } {
  return value.startsWith(KIRO_REASONING_SIGNATURE_TAG)
    ? { field: "signature", data: value.slice(KIRO_REASONING_SIGNATURE_TAG.length) }
    : { field: "redactedContent", data: value };
}

/**
 * The `reasoningContent` object on an `assistantResponseMessage`. Exactly one member is set: the
 * wire validates the shape, so the two cannot be substituted for each other.
 */
export type KiroReasoningContent = { signature: string } | { redactedContent: string };

/** `reasoningContent` for a replayed `assistantResponseMessage`, carrying the blob verbatim. */
export function kiroReasoningContent(value: string): KiroReasoningContent {
  const { field, data } = splitKiroReasoningBlob(value);
  return field === "signature" ? { signature: data } : { redactedContent: data };
}
