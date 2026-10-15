import { modelInList, type OcxProviderConfig, type OcxReasoningReplayScopeRef } from "../../types";
import { peekReasoningForCall } from "../../responses/reasoning-replay-cache";

type Rec = Record<string, unknown>;
export const isChatRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isDeepSeekThinkingModel = (modelId: string): boolean =>
  /(?:^|\/)deepseek-(?:v\d+(?:\.\d+)*-(?:flash|pro)|flash|pro)(?:$|[-_:])/i.test(modelId);

/** DeepSeek thinking tool replay is a model contract, independent of the gateway's name. */
export function chatReasoningReplayPolicy(provider: OcxProviderConfig, modelId: string): {
  preserve: boolean; placeholder: boolean;
} {
  // Match whole model-family tokens, including dotted versions, namespace and deployment suffixes.
  // Legacy chat/reasoner and distilled R1 models do not share the thinking tool-call contract.
  const preserve = provider.preserveReasoningContentModels === undefined
    ? isDeepSeekThinkingModel(modelId)
    : modelInList(provider.preserveReasoningContentModels, modelId);
  return {
    preserve,
    placeholder: preserve && (provider.requiresReasoningPlaceholderModels === undefined
      ? true
      : modelInList(provider.requiresReasoningPlaceholderModels, modelId)),
  };
}

/** Repair missing native history without mutating caller bodies used by retries/combo siblings. */
export function replayNativeChatReasoning(
  messages: unknown,
  provider: OcxProviderConfig,
  modelId: string,
  scope?: OcxReasoningReplayScopeRef,
  hasTools = false,
): unknown {
  const policy = chatReasoningReplayPolicy(provider, modelId);
  if (!policy.preserve || !Array.isArray(messages)
      || modelInList(provider.reasoningDetailsModels, modelId)) return messages;
  return messages.map(message => {
    if (!isChatRecord(message) || message.role !== "assistant"
        || (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0)) return message;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    // DeepSeek's tools contract covers all prior assistant turns, even plain answers.
    // Those turns have no call id for original replay; only the configured fallback applies.
    if (calls.length === 0 && !(hasTools && isDeepSeekThinkingModel(modelId))) return message;
    const cached = calls.filter(isChatRecord)
      .map(tool => typeof tool.id === "string" ? peekReasoningForCall(tool.id, scope) : undefined)
      .filter((text): text is string => typeof text === "string" && text.length > 0);
    const reasoning = cached.length > 0 ? [...new Set(cached)].join("\n") : policy.placeholder ? " " : undefined;
    return reasoning === undefined ? message : { ...message, reasoning_content: reasoning };
  });
}
