import { isCanonicalMistralChat } from "../../providers/mistral-transport";
import { configuredReasoningEfforts, resolveEffortAtOrBelow } from "../../reasoning-effort";
import type { OcxProviderConfig } from "../../types";

const MISTRAL_CHAT_POLICY = {
  rename: { max_completion_tokens: "max_tokens" },
  omit: ["user", "store", "thinking", "include_reasoning", "reasoning", "top_k"],
} as const;

/** Final wire projection shared by native and translated Chat; caller objects are not mutated. */
export function applyChatDestinationPolicy(body: Record<string, unknown>, provider: OcxProviderConfig): void {
  if (!isCanonicalMistralChat(provider)) return;
  for (const [source, target] of Object.entries(MISTRAL_CHAT_POLICY.rename)) {
    if ((body[target] === undefined || body[target] === null) && body[source] !== undefined) body[target] = body[source];
    delete body[source];
  }
  for (const field of MISTRAL_CHAT_POLICY.omit) delete body[field];
}

/** Native Chat normally preserves effort spelling; Mistral requires its declared model ladder. */
export function mistralNativeChatEffort(provider: OcxProviderConfig, modelId: string, effort: string): string | undefined {
  if (!isCanonicalMistralChat(provider) || effort === "none") return effort;
  const supported = configuredReasoningEfforts(provider, modelId);
  return supported === undefined ? effort : resolveEffortAtOrBelow(effort, supported);
}
