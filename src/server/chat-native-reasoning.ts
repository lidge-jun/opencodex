import type { OcxProviderConfig, OcxReasoningReplayScopeRef } from "../types";
import type { TranslatorBudget } from "../lib/translator-budget";
import { chatReasoningReplayPolicy, isChatRecord } from "../adapters/openai-chat/reasoning-replay";
import { bindReasoningReplayScope, reasoningReplayDestinationIdentity,
  reasoningReplayKeyCredentialIdentity, rememberReasoningForCall } from "../responses/reasoning-replay-cache";
import { reasoningReplayConversationIdFromResponsesRequest, sessionIdHeaderFromRequest } from "./request-log-conversation";

type Rec = Record<string, unknown>;

export function nativeChatReplayScope(headers: Headers): OcxReasoningReplayScopeRef | undefined {
  const clientThreadId = reasoningReplayConversationIdFromResponsesRequest({
    threadIdHeader: headers.get("thread-id"), sessionIdHeader: sessionIdHeaderFromRequest(headers),
  });
  return clientThreadId ? { clientThreadId } : undefined;
}

/** Rebind before EVERY build: a key rotation must not retrieve another credential's reasoning. */
export function bindNativeChatReplayScope(
  scope: OcxReasoningReplayScopeRef | undefined,
  provider: OcxProviderConfig,
  providerName: string,
  modelId: string,
): void {
  const providerDestinationIdentity = reasoningReplayDestinationIdentity(provider.baseUrl);
  const credentialIdentity = reasoningReplayKeyCredentialIdentity(provider);
  bindReasoningReplayScope(scope, providerDestinationIdentity && credentialIdentity ? {
    providerName, modelId, adapterName: "openai-chat",
    providerDestinationIdentity, credentialIdentity,
  } : undefined);
}

/** Observe the native wire, never translate it or retain tool arguments/content. */
export function nativeChatReasoningCapture(
  provider: OcxProviderConfig,
  modelId: string,
  scope: OcxReasoningReplayScopeRef | undefined,
  budget: TranslatorBudget,
) {
  const choices = new Map<number, { text: string; calls: Map<number, string> }>();
  const accounting = { kind: "retained_collectors" as const };
  // This optional fallback cannot retain more than the cache it feeds (256 KiB / 64 calls).
  const maxBytes = 256 * 1024;
  let bytes = 0;
  let callCount = 0;
  let disabled = !scope?.current || !chatReasoningReplayPolicy(provider, modelId).preserve;
  const discard = () => {
    budget.releaseRetained(bytes, accounting);
    bytes = 0;
    choices.clear();
    disabled = true;
  };
  const remember = (text: string, calls: Iterable<string>) => {
    for (const id of calls) rememberReasoningForCall(id, text, scope);
  };
  const observe = (value: Rec) => {
    if (disabled || !Array.isArray(value.choices)) return;
    for (const [ordinal, raw] of value.choices.entries()) {
      if (!isChatRecord(raw) || !isChatRecord(raw.delta)) continue;
      const index = typeof raw.index === "number" ? raw.index : ordinal;
      if (!choices.has(index)) {
        if (choices.size >= 64) { discard(); return; }
        choices.set(index, { text: "", calls: new Map() });
      }
      const state = choices.get(index)!;
      const delta = raw.delta;
      const append = (previous: string, fragment: string): string | undefined => {
        const added = Buffer.byteLength(fragment) * 2;
        if (bytes + added > maxBytes) { discard(); return undefined; }
        // Account the new retained fragment before concatenation; the transient reservation
        // covers the old string while its replacement is allocated.
        const reservation = budget.reserveTransient(Buffer.byteLength(previous) * 2, accounting);
        try {
          budget.chargeRetained(added, accounting);
          bytes += added;
          return previous + fragment;
        } finally { reservation.release(); }
      };
      if (typeof delta.reasoning_content === "string" && delta.reasoning_content.length > 0) {
        const text = append(state.text, delta.reasoning_content);
        if (text === undefined) return;
        state.text = text;
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const [toolOrdinal, tool] of delta.tool_calls.entries()) {
          if (!isChatRecord(tool) || typeof tool.id !== "string" || tool.id.length === 0) continue;
          const toolIndex = typeof tool.index === "number" ? tool.index : toolOrdinal;
          if (!state.calls.has(toolIndex)) {
            if (callCount >= 64) { discard(); return; }
            callCount += 1;
          }
          const previous = state.calls.get(toolIndex) ?? "";
          if (previous === tool.id) continue;
          const id = append(previous, tool.id);
          if (id === undefined) return;
          state.calls.set(toolIndex, id);
        }
      }
      // The completed choice is valid even if a caller dispatches its tool before [DONE].
      if (typeof raw.finish_reason === "string" && raw.finish_reason.length > 0) {
        remember(state.text, state.calls.values());
      }
    }
  };
  return {
    observe,
    finish(success: boolean) {
      if (success && !disabled) {
        for (const state of choices.values()) remember(state.text, state.calls.values());
      }
      discard();
    },
    json(value: Rec) {
      if (disabled || !Array.isArray(value.choices)) return;
      for (const choice of value.choices) {
        if (!isChatRecord(choice) || !isChatRecord(choice.message)) continue;
        const message = choice.message;
        if (typeof message.reasoning_content !== "string" || !Array.isArray(message.tool_calls)) continue;
        remember(message.reasoning_content, message.tool_calls.filter(isChatRecord)
          .flatMap(tool => typeof tool.id === "string" ? [tool.id] : []));
      }
    },
  };
}
