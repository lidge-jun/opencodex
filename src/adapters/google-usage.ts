import type { OcxUsage } from "../types";

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Translate Gemini usageMetadata without retaining provider payload fields. */
export function usageFromGemini(usage: unknown): OcxUsage | undefined {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return undefined;
  const counters = usage as Record<string, unknown>;
  const prompt = tokenCount(counters.promptTokenCount);
  const toolPrompt = tokenCount(counters.toolUsePromptTokenCount);
  const candidates = tokenCount(counters.candidatesTokenCount);
  const thoughts = tokenCount(counters.thoughtsTokenCount);
  const cached = tokenCount(counters.cachedContentTokenCount);
  if ([prompt, toolPrompt, candidates, thoughts, cached].every(count => count === undefined)) return undefined;

  // Tool-use prompts are billed as input and thinking tokens are billed as output.
  const inputTokens = (prompt ?? 0) + (toolPrompt ?? 0);
  const outputTokens = (candidates ?? 0) + (thoughts ?? 0);
  if (!Number.isSafeInteger(inputTokens + outputTokens)) return undefined;
  return {
    inputTokens,
    outputTokens,
    ...(cached !== undefined ? { cachedInputTokens: cached } : {}),
    ...(thoughts !== undefined ? { reasoningOutputTokens: thoughts } : {}),
  };
}
