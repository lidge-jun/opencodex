/**
 * Experimental correlation of a model POST with one already-validated tool result.
 * This is not authentication and does not establish that all model sends use a
 * particular gateway. Callers must bind both expected values to the owned turn.
 */
export function matchesMuseContinuationSend(value: unknown, expected: { callId: string; output: string }): boolean {
  if (!expected.callId || Buffer.byteLength(expected.callId) > 512 || typeof expected.output !== "string" ||
      Buffer.byteLength(expected.output) > 4 * 1024 * 1024 || !value || typeof value !== "object" || Array.isArray(value)) return false;
  const input = (value as { input?: unknown }).input;
  if (!Array.isArray(input) || input.length > 16_384) return false;
  let call = -1, result = -1;
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (!item || typeof item !== "object" || Array.isArray(item) || item.call_id !== expected.callId) continue;
    if (item.type === "function_call") {
      if (call !== -1) return false;
      call = i;
    } else if (item.type === "function_call_output") {
      if (result !== -1 || item.output !== expected.output) return false;
      result = i;
    }
  }
  return call >= 0 && result > call;
}
