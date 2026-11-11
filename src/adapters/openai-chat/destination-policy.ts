import { isCanonicalMistralChat } from "../../providers/mistral-transport";
import { configuredReasoningEfforts, resolveEffortAtOrBelow } from "../../reasoning-effort";
import type { OcxProviderConfig } from "../../types";

const MISTRAL_CHAT_POLICY = {
  rename: { max_completion_tokens: "max_tokens" },
  omit: ["user", "store", "thinking", "include_reasoning", "reasoning", "top_k"],
  /** Replayed inside message history by reasoning-capable Chat clients; Mistral's schema rejects them. */
  omitMessageFields: ["reasoning_content"],
} as const;

/** Final wire projection shared by native and translated Chat; caller objects are not mutated. */
export function applyChatDestinationPolicy(body: Record<string, unknown>, provider: OcxProviderConfig): void {
  if (!isCanonicalMistralChat(provider)) return;
  for (const [source, target] of Object.entries(MISTRAL_CHAT_POLICY.rename)) {
    if ((body[target] === undefined || body[target] === null) && body[source] !== undefined) body[target] = body[source];
    delete body[source];
  }
  for (const field of MISTRAL_CHAT_POLICY.omit) delete body[field];
  const messages = body.messages;
  if (Array.isArray(messages)) {
    let sanitized: unknown[] | undefined;
    for (let index = 0; index < messages.length; index++) {
      const message = messages[index];
      if (message === null || typeof message !== "object" || Array.isArray(message)) continue;
      const record = message as Record<string, unknown>;
      if (!MISTRAL_CHAT_POLICY.omitMessageFields.some((field) => field in record)) continue;
      const copy = { ...record };
      for (const field of MISTRAL_CHAT_POLICY.omitMessageFields) delete copy[field];
      (sanitized ??= [...messages])[index] = copy;
    }
    if (sanitized) body.messages = sanitized;
  }
}

/** Native Chat normally preserves effort spelling; Mistral requires its declared model ladder. */
export function mistralNativeChatEffort(provider: OcxProviderConfig, modelId: string, effort: string): string | undefined {
  if (!isCanonicalMistralChat(provider) || effort === "none") return effort;
  const supported = configuredReasoningEfforts(provider, modelId);
  return supported === undefined ? effort : resolveEffortAtOrBelow(effort, supported);
}
