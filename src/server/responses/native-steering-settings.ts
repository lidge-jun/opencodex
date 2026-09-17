import { REASONING_SUMMARY_DELIVERY_VALUES } from "../../types/wire";
import { nativeResponseRecord as record } from "./native-response-json";

type Frame = Record<string, unknown>;
/** Only generation settings may change without selecting a new route or tool surface. */
export const STEERING_MUTABLE_SETTINGS = ["reasoning", "text", "max_output_tokens", "stream_options"] as const;
export const isSteeringMutableSetting = (key: string): boolean =>
  (STEERING_MUTABLE_SETTINGS as readonly string[]).includes(key);

/** Bound nested structured-output schemas before fingerprinting or copying them. */
function boundedJson(value: unknown): boolean {
  const pending = [{ value, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const current = pending.pop()!;
    if (++nodes > 20_000 || current.depth > 64) return false;
    if (current.value && typeof current.value === "object") {
      for (const value of Object.values(current.value)) pending.push({ value, depth: current.depth + 1 });
    }
  }
  return true;
}
const only = (value: Frame, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const optionalEnum = (value: unknown, choices: readonly string[]) => value === undefined || value === null
  || (typeof value === "string" && choices.includes(value));

/** Reject malformed overrides rather than treating them as omitted settings. */
export function validSteeringSettings(frame: Frame): boolean {
  for (const key of STEERING_MUTABLE_SETTINGS) {
    if (!Object.hasOwn(frame, key)) continue;
    const value = frame[key];
    if (!boundedJson(value)) return false;
    if (value === null) continue;
    if (key === "max_output_tokens") {
      if (!Number.isSafeInteger(value) || (value as number) < 1) return false;
      continue;
    }
    if (!record(value)) return false;
    if (key === "reasoning") {
      if (!only(value, ["effort", "summary", "generate_summary"])
        || !optionalEnum(value.effort, ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"])
        || !optionalEnum(value.summary, ["auto", "concise", "detailed", "none"])
        || !optionalEnum(value.generate_summary, ["auto", "concise", "detailed", "none"])) return false;
    } else if (key === "stream_options") {
      if (!only(value, ["reasoning_summary_delivery", "include_usage", "include_obfuscation"])
        || !optionalEnum(value.reasoning_summary_delivery, REASONING_SUMMARY_DELIVERY_VALUES)
        || [value.include_usage, value.include_obfuscation].some(item => item !== undefined && typeof item !== "boolean")) return false;
    } else {
      if (!only(value, ["format", "verbosity"]) || !optionalEnum(value.verbosity, ["low", "medium", "high"])) return false;
      if (value.format === undefined || value.format === null) continue;
      const format = value.format;
      if (!record(format)) return false;
      if (format.type === "text" || format.type === "json_object") {
        if (!only(format, ["type"])) return false;
      } else if (format.type === "json_schema") {
        if (!only(format, ["type", "name", "schema", "strict", "description"])
          || typeof format.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(format.name)
          || !record(format.schema)
          || (format.strict != null && typeof format.strict !== "boolean")
          || (format.description !== undefined && typeof format.description !== "string")) return false;
      } else return false;
    }
  }
  return true;
}

/** Overlay only validated generation keys on the current, already authorized wire settings. */
export function mergeSteeringContinuation(base: Frame, frame: Frame): Frame {
  const outgoing: Frame = { ...base, input: frame.input, previous_response_id: frame.previous_response_id };
  for (const key of STEERING_MUTABLE_SETTINGS) {
    if (!Object.hasOwn(frame, key)) continue;
    if (frame[key] === undefined) delete outgoing[key];
    else outgoing[key] = frame[key];
  }
  return outgoing;
}
