import { nativeResponseRecord as injectionRecord } from "./native-response-json";
export { nativeResponseRecord as injectionRecord, nativeResponseFingerprint as injectionFingerprint } from "./native-response-json";
import { CODEX_WS_ID_MAX_BYTES } from "./codex-ws-correlation";
import { NativeSteeringError } from "./native-steering";

export type InjectionFrame = Record<string, unknown>;
export type FunctionResult = { type: "function_call_output"; call_id: string; output: string };
export const MAX_NATIVE_INJECTIONS = 32;
export const MAX_NATIVE_INJECTION_BYTES = 8 * 1024 * 1024;
export const MAX_NATIVE_INJECTION_CALLS = 1024;
export const NATIVE_INJECTION_ACK_MS = 90_000;
export const NATIVE_INJECTION_TOOL_MS = 30 * 60_000;

/** Bound identities and exclude control characters, without changing their spelling. */
export function injectionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= CODEX_WS_ID_MAX_BYTES
    && !/[\u0000-\u001f\u007f]/.test(value);
}
/** Throw only fixed, content-free errors, never tool output or caller identifiers. */
export function injectionError(code: string, message: string): never {
  throw new NativeSteeringError(code, message);
}
/** First-version contract: nonempty arrays of string-valued, client-owned function results. */
export function injectionResults(value: unknown): FunctionResult[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_NATIVE_INJECTION_CALLS) {
    injectionError("invalid_injection", "Supply a bounded, nonempty array of saved function results.");
  }
  const seen = new Set<string>();
  for (const item of value) {
    if (!injectionRecord(item) || item.type !== "function_call_output" || !injectionId(item.call_id)
      || typeof item.output !== "string" || Object.keys(item).some(key => !["type", "call_id", "output"].includes(key))) {
      injectionError("invalid_injection", "Only function_call_output with call_id and string output is supported; no messages or hosted-tool results.");
    }
    if (seen.has(item.call_id)) injectionError("duplicate_injection", "A function result must occur exactly once.");
    seen.add(item.call_id);
  }
  return value as FunctionResult[];
}
/** Detect explicit multi-agent opt-in without inferring it from the model name. */
export function isInjectionRequest(frame: InjectionFrame): boolean {
  return injectionRecord(frame.multi_agent) && frame.multi_agent.enabled === true;
}
