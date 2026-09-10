import { normalizeKiroModelId } from "../../providers/kiro-models";
import type { OcxParsedRequest } from "../../types";

export type KiroReasoningMode = "native" | "emulated";

// Kiro takes a verified native effort field for these models, and each model family names it
// differently: the Sol-only `reasoning.effort` versus the Claude-specific `output_config.effort`.
// Models absent from this table fall back to emulated thinking instructions.
export const KIRO_NATIVE_EFFORT_FIELDS: Record<string, "reasoning" | "output_config"> = {
  "gpt-5.6-sol": "reasoning",
  "claude-opus-5": "output_config",
};

export const KIRO_NATIVE_EFFORTS = ["low", "medium", "high", "xhigh", "max"];

export function kiroNativeEffortField(modelId: string): "reasoning" | "output_config" | undefined {
  return KIRO_NATIVE_EFFORT_FIELDS[normalizeKiroModelId(modelId)];
}

export function kiroReasoningMode(modelId: string): KiroReasoningMode {
  return kiroNativeEffortField(modelId) ? "native" : "emulated";
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
  if (kiroReasoningMode(parsed.modelId) !== "emulated") return content;
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
