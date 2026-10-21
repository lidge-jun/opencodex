import { modelInList, type OcxProviderConfig, type OcxReasoningReplayScopeRef } from "../../types";
import { peekReasoningForCall } from "../../responses/reasoning-replay-cache";
import { jsonStringPartsUtf8Bytes, jsonUtf8Bytes } from "../../lib/json-byte-size";
import { isTranslatorBudgetExceededError, TranslatorBudgetExceededError } from "../../lib/translator-budget";

type Rec = Record<string, unknown>;
export const isChatRecord = (value: unknown): value is Rec =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const REASONING_CONTENT_FIELD_BYTES = Buffer.byteLength('"reasoning_content":', "utf8");

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

interface ReplayMessagePlan {
  message: Rec;
  parts: string[];
}

export interface NativeChatReasoningReplayPlan {
  /** Net byte change in the final escaped JSON object representation; may be zero or negative. */
  readonly serializedBytes: number;
  /** Whether apply() rewrites any message, independent of the net byte change. */
  readonly hasChanges: boolean;
  apply(): unknown[];
}

/** Preflight escaped replay growth before allocating the copied messages or serialized body. */
export function planNativeChatReasoningReplay(
  messages: unknown,
  provider: OcxProviderConfig,
  modelId: string,
  scope?: OcxReasoningReplayScopeRef,
  hasTools = false,
  maxSerializedBytes = Number.MAX_SAFE_INTEGER,
): NativeChatReasoningReplayPlan {
  const policy = chatReasoningReplayPolicy(provider, modelId);
  if (!policy.preserve || !Array.isArray(messages)
      || modelInList(provider.reasoningDetailsModels, modelId)) {
    return { serializedBytes: 0, hasChanges: false, apply: () => messages as unknown[] };
  }
  const plans: ReplayMessagePlan[] = [];
  let serializedBytes = 0;
  for (const message of messages) {
    if (!isChatRecord(message) || message.role !== "assistant"
        || (typeof message.reasoning_content === "string" && message.reasoning_content.length > 0)) continue;
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    // DeepSeek's tools contract covers all prior assistant turns, even plain answers.
    // Those turns have no call id for original replay; only the configured fallback applies.
    if (calls.length === 0 && !(hasTools && isDeepSeekThinkingModel(modelId))) continue;
    const cached = new Set<string>();
    for (const tool of calls) {
      if (!isChatRecord(tool) || typeof tool.id !== "string") continue;
      const text = peekReasoningForCall(tool.id, scope);
      if (text) cached.add(text);
    }
    const parts = cached.size > 0
      ? [...cached]
      : policy.placeholder ? [" "] : [];
    if (parts.length === 0) continue;

    // The envelope delta around the joined value is exact for the plain JSON the Chat
    // ingress produces: an absent or skipped key adds the reasoning_content field bytes
    // plus one separator when another field serializes, while an already-serialized key
    // ("" included) keeps its position and commas, so only the value size changes.
    const oldReasoning = message.reasoning_content;
    try {
      const envelopeDelta = oldReasoning === undefined
        ? REASONING_CONTENT_FIELD_BYTES
          + (Object.keys(message).some(key => message[key] !== undefined) ? 1 : 0)
        : -jsonUtf8Bytes(oldReasoning, Number.MAX_SAFE_INTEGER);
      const fragments: string[] = [];
      for (let index = 0; index < parts.length; index++) {
        if (index > 0) fragments.push("\n");
        fragments.push(parts[index]!);
      }
      const valueBytes = jsonStringPartsUtf8Bytes(
        fragments,
        maxSerializedBytes - serializedBytes - envelopeDelta,
      );
      const added = valueBytes + envelopeDelta;
      if (added > maxSerializedBytes - serializedBytes) {
        throw new TranslatorBudgetExceededError("request_copies", maxSerializedBytes);
      }
      serializedBytes += added;
    } catch (error) {
      // Inner measurements cap at the remaining budget; report the caller's real limit.
      if (isTranslatorBudgetExceededError(error)) {
        throw new TranslatorBudgetExceededError("request_copies", maxSerializedBytes);
      }
      throw error;
    }
    plans.push({ message, parts });
  }
  return {
    serializedBytes,
    hasChanges: plans.length > 0,
    apply: () => {
      if (plans.length === 0) return messages;
      const byMessage = new Map(plans.map(plan => [plan.message, plan.parts]));
      return (messages as unknown[]).map(message => {
        if (!isChatRecord(message)) return message;
        const parts = byMessage.get(message);
        if (!parts) return message;
        return { ...message, reasoning_content: parts.join("\n") };
      });
    },
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
  return planNativeChatReasoningReplay(messages, provider, modelId, scope, hasTools).apply();
}
