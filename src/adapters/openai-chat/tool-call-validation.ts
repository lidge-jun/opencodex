import { debugProviderDiagnostic } from "../../lib/debug";
import { isDebugEnabled } from "../../lib/debug-settings";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

type InvalidToolCallReason =
  | "tool_calls_not_array"
  | "tool_call_not_object"
  | "tool_call_id_invalid"
  | "tool_call_function_not_object"
  | "tool_call_function_name_invalid"
  | "tool_call_function_name_blank"
  | "tool_call_function_arguments_invalid";

export type InvalidToolCallDiagnostic = {
  reason: InvalidToolCallReason;
  callIndex?: number;
  valueType: string;
};

type InvalidFieldShape =
  | {
      kind: "object";
      knownKeys: string[];
      knownFieldTypes: Record<string, string>;
      hasUnknownKeys: boolean;
    }
  | {
      kind: "array";
      length: number;
    };

const SAFE_TOOL_CALL_SHAPE_KEYS = [
  "name",
  "type",
  "value",
  "function",
  "arguments",
  "id",
  "index",
] as const;
const SAFE_TOOL_CALL_SHAPE_KEY_SET = new Set<string>(SAFE_TOOL_CALL_SHAPE_KEYS);

function structuralValueType(value: unknown): string {
  return value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
}

function invalidToolCallField(rawToolCalls: unknown, diagnostic: InvalidToolCallDiagnostic): unknown {
  if (diagnostic.reason === "tool_calls_not_array") return rawToolCalls;
  if (!Array.isArray(rawToolCalls) || diagnostic.callIndex === undefined) return undefined;

  const rawToolCall = rawToolCalls[diagnostic.callIndex];
  if (diagnostic.reason === "tool_call_not_object") return rawToolCall;
  if (!isRecord(rawToolCall)) return undefined;
  if (diagnostic.reason === "tool_call_function_not_object") return rawToolCall.function;

  const rawFunction = rawToolCall.function;
  switch (diagnostic.reason) {
    case "tool_call_id_invalid":
      return rawToolCall.id;
    case "tool_call_function_name_invalid":
      return isRecord(rawFunction) ? rawFunction.name : undefined;
    case "tool_call_function_arguments_invalid":
      return isRecord(rawFunction) ? rawFunction.arguments : undefined;
    default:
      return undefined;
  }
}

function fingerprintInvalidField(value: unknown): InvalidFieldShape | undefined {
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (!isRecord(value)) return undefined;

  const knownKeys: string[] = [];
  const knownFieldTypes: Record<string, string> = {};
  for (const key of SAFE_TOOL_CALL_SHAPE_KEYS) {
    if (!Object.hasOwn(value, key)) continue;
    knownKeys.push(key);
    knownFieldTypes[key] = structuralValueType(value[key]);
  }

  let hasUnknownKeys = false;
  for (const key of Object.keys(value)) {
    if (!SAFE_TOOL_CALL_SHAPE_KEY_SET.has(key)) {
      hasUnknownKeys = true;
      break;
    }
  }
  return { kind: "object", knownKeys, knownFieldTypes, hasUnknownKeys };
}

/**
 * Streamed string fields are absent when null or undefined (#1731): OpenAI-compatible
 * streamers repeat already-sent `id`/`name`/`arguments` as null on continuation deltas.
 * The accumulator and this diagnostic share this predicate so they cannot disagree about
 * which delta was the invalid one.
 */
export function isInvalidStreamStringField(value: unknown): boolean {
  return value != null && typeof value !== "string";
}

/**
 * Explain only the rejected wire shape, never its values. This diagnostic exists so provider
 * compatibility can be tightened from evidence without retaining tool arguments or credentials.
 */
export function diagnoseInvalidToolCalls(
  rawToolCalls: unknown,
  mode: "stream" | "response",
): InvalidToolCallDiagnostic | undefined {
  if (!Array.isArray(rawToolCalls)) {
    return { reason: "tool_calls_not_array", valueType: rawToolCalls === null ? "null" : typeof rawToolCalls };
  }
  for (let callIndex = 0; callIndex < rawToolCalls.length; callIndex++) {
    const rawToolCall = rawToolCalls[callIndex];
    if (!isRecord(rawToolCall)) {
      return {
        reason: "tool_call_not_object",
        callIndex,
        valueType: rawToolCall === null ? "null" : Array.isArray(rawToolCall) ? "array" : typeof rawToolCall,
      };
    }
    if (mode === "stream") {
      // The streamed path validates the pieces it is about to store (#1531): a present
      // `function` must be a record, and a present `name`/`arguments`/`id` must be a string.
      // Blank names are caught later at flush, not here, so they are not diagnosed on this
      // branch. Describe exactly that boundary rather than tightening compatibility in a
      // diagnostic change.
      // #1731: "present" means the same thing here as in the accumulator — null and undefined
      // are both absent, because some OpenAI-compatible streamers repeat already-sent fields
      // as null on continuation deltas. A separate predicate here would diagnose accepted
      // padding as the failure and point compatibility work at the wrong delta.
      const streamFunction = (rawToolCall as { function?: unknown }).function;
      if (streamFunction !== undefined && streamFunction !== null) {
        if (!isRecord(streamFunction)) {
          return {
            reason: "tool_call_function_not_object",
            callIndex,
            valueType: Array.isArray(streamFunction) ? "array" : typeof streamFunction,
          };
        }
        if (isInvalidStreamStringField(streamFunction.name)) {
          return { reason: "tool_call_function_name_invalid", callIndex, valueType: typeof streamFunction.name };
        }
        if (isInvalidStreamStringField(streamFunction.arguments)) {
          return { reason: "tool_call_function_arguments_invalid", callIndex, valueType: typeof streamFunction.arguments };
        }
      }
      if (isInvalidStreamStringField(rawToolCall.id)) {
        return { reason: "tool_call_id_invalid", callIndex, valueType: typeof rawToolCall.id };
      }
      continue;
    }
    // Precedence must mirror the buffered validator below, or a payload with more than one
    // problem is reported under the wrong reason and sends compatibility work after the wrong
    // shape. That validator checks the `function` container first (`!isRecord(rawToolCall) ||
    // !isRecord(rawToolCall.function)`), then id/name/arguments types together, and only then
    // the blank name.
    if (!isRecord(rawToolCall.function)) {
      return {
        reason: "tool_call_function_not_object",
        callIndex,
        valueType: rawToolCall.function === null ? "null" : Array.isArray(rawToolCall.function) ? "array" : typeof rawToolCall.function,
      };
    }
    if (typeof rawToolCall.id !== "string") {
      return { reason: "tool_call_id_invalid", callIndex, valueType: typeof rawToolCall.id };
    }
    if (typeof rawToolCall.function.name !== "string") {
      return { reason: "tool_call_function_name_invalid", callIndex, valueType: typeof rawToolCall.function.name };
    }
    if (typeof rawToolCall.function.arguments !== "string") {
      return { reason: "tool_call_function_arguments_invalid", callIndex, valueType: typeof rawToolCall.function.arguments };
    }
    // Last, matching the validator: #1531 also rejects a blank or whitespace-only name here,
    // because such a call cannot select a dispatch target. Reporting it as `name_invalid`
    // would claim a type problem for a correctly-typed value, so it gets its own code.
    if (rawToolCall.function.name.trim().length === 0) {
      return { reason: "tool_call_function_name_blank", callIndex, valueType: "string" };
    }
  }
  return undefined;
}

export function logInvalidToolCalls(
  mode: "stream" | "response",
  rawToolCalls: unknown,
  diagnosticOverride?: InvalidToolCallDiagnostic,
): void {
  if (!isDebugEnabled()) return;
  const diagnostic = diagnosticOverride ?? diagnoseInvalidToolCalls(rawToolCalls, mode);
  if (!diagnostic) return;
  const fieldShape = fingerprintInvalidField(invalidToolCallField(rawToolCalls, diagnostic));
  debugProviderDiagnostic("openai-chat", "invalid-tool-calls", {
    mode,
    ...diagnostic,
    ...(fieldShape ? { fieldShape } : {}),
  });
}
