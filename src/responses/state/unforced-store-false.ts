/**
 * Closed provenance and replay gating for unforced store:false function call responses.
 *
 * An unforced store:false response is cached exclusively to allow the client to send a matching
 * function_call_output continuation on the next turn. Normal replay, text continuation, or
 * mismatched output without a matching pending call fails replay and requires the client to
 * supply the full conversation.
 */

export function hasPendingFunctionCall(output: readonly unknown[]): boolean {
  return output.some(item =>
    !!item && typeof item === "object" && (item as { type?: unknown }).type === "function_call",
  );
}

export function allowsUnforcedStoreFalseReplay(
  stored: readonly unknown[],
  providerOutputStart: number | undefined,
  clientInput: readonly unknown[],
  carried: number,
): boolean {
  const anchor = providerOutputStart ?? 0;
  const pendingCallIds = new Set<string>();
  for (const item of stored.slice(anchor)) {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "function_call") {
      const callId = (item as { call_id?: unknown }).call_id;
      if (typeof callId === "string" && callId) pendingCallIds.add(callId);
    }
  }
  for (let i = 0; i < carried; i++) {
    const item = clientInput[i];
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "function_call_output") {
      const callId = (item as { call_id?: unknown }).call_id;
      if (typeof callId === "string") pendingCallIds.delete(callId);
    }
  }
  return clientInput.slice(carried).some(item => {
    if (item && typeof item === "object" && (item as { type?: unknown }).type === "function_call_output") {
      const callId = (item as { call_id?: unknown }).call_id;
      return typeof callId === "string" && pendingCallIds.has(callId);
    }
    return false;
  });
}
