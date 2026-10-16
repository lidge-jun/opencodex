/**
 * Closed provenance and replay gating for unforced store:false client tool call responses.
 *
 * An unforced store:false response is cached exclusively to allow the client to send a matching
 * function/custom tool output continuation on the next turn. Normal replay, text continuation, or
 * mismatched output without a matching pending call fails replay and requires the client to
 * supply the full conversation.
 */

export function hasPendingClientToolCall(output: readonly unknown[]): boolean {
  return output.some(item =>
    !!item && typeof item === "object" && clientToolOutputType((item as { type?: unknown }).type) !== undefined,
  );
}

export function allowsUnforcedStoreFalseReplay(
  stored: readonly unknown[],
  providerOutputStart: number | undefined,
  clientInput: readonly unknown[],
  carried: number,
): boolean {
  if (typeof providerOutputStart !== "number" || !Number.isSafeInteger(providerOutputStart)
    || providerOutputStart < 0 || providerOutputStart > stored.length) return false;
  const anchor = providerOutputStart;
  const pendingCallIds = new Map<string, string>();
  for (const item of stored.slice(anchor)) {
    if (item && typeof item === "object") {
      const outputType = clientToolOutputType((item as { type?: unknown }).type);
      const callId = (item as { call_id?: unknown }).call_id;
      if (outputType && typeof callId === "string" && callId) pendingCallIds.set(callId, outputType);
    }
  }
  for (let i = 0; i < carried; i++) {
    const item = clientInput[i];
    if (item && typeof item === "object") {
      const callId = (item as { call_id?: unknown }).call_id;
      if (typeof callId === "string" && pendingCallIds.get(callId) === (item as { type?: unknown }).type) pendingCallIds.delete(callId);
    }
  }
  return clientInput.slice(carried).some(item => {
    if (item && typeof item === "object") {
      const callId = (item as { call_id?: unknown }).call_id;
      return typeof callId === "string" && pendingCallIds.has(callId)
        && pendingCallIds.get(callId) === (item as { type?: unknown }).type;
    }
    return false;
  });
}

/** Closed call/output pairs supported by the client-owned continuation path. */
function clientToolOutputType(type: unknown): string | undefined {
  if (type === "function_call") return "function_call_output";
  if (type === "custom_tool_call") return "custom_tool_call_output";
  return undefined;
}
