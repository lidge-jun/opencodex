import {
  injectionError, injectionFingerprint, injectionId, injectionRecord as record,
  MAX_NATIVE_INJECTION_CALLS, type InjectionFrame as Frame,
} from "./native-injection-protocol";

export type NativeToolOutput = string | Frame[];
export type NativeToolResult = {
  type: "function_call_output" | "custom_tool_call_output";
  call_id: string;
  output: NativeToolOutput;
  id?: string;
  caller?: Frame | null;
};
export type NativeApprovalResult = {
  type: "mcp_approval_response";
  approval_request_id: string;
  approve: boolean;
  reason?: string | null;
  id?: string;
};
export type NativeSavedResult = NativeToolResult | NativeApprovalResult;
export type NativeToolRequirement = { key: string; type: NativeSavedResult["type"]; identity: string; caller: string };
export const MAX_NATIVE_RESULT_PARTS = 1024;

/** Fixed diagnostics deliberately exclude caller identifiers and saved result bodies. */
function invalid(): never {
  return injectionError("invalid_injection", "Invalid saved tool result, content part, caller or approval decision.");
}
/** Reject unknown fields rather than silently discarding them or widening the wire schema. */
function keys(value: Frame, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid();
}
/** References remain opaque: no local file reads, URL downloads or cross-account uploads. */
function source(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}
/** Validate a supplied caller while treating absent and explicit direct callers alike. */
function caller(value: unknown): string {
  if (value == null) return injectionFingerprint({ type: "direct" });
  if (!record(value)) return invalid();
  if (value.type === "direct") keys(value, ["type"]);
  else if (value.type === "program" && injectionId(value.caller_id)) keys(value, ["type", "caller_id"]);
  else return invalid();
  return injectionFingerprint(value);
}
/** Bound rich result shape without coercing it to text or fetching its content. */
function output(value: unknown): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value) || value.length > MAX_NATIVE_RESULT_PARTS) invalid();
  for (const part of value) {
    if (!record(part)) invalid();
    if (part.prompt_cache_breakpoint !== undefined) {
      if (!record(part.prompt_cache_breakpoint) || part.prompt_cache_breakpoint.mode !== "explicit") invalid();
      keys(part.prompt_cache_breakpoint, ["mode"]);
    }
    if (part.type === "input_text") {
      keys(part, ["type", "text", "prompt_cache_breakpoint"]);
      if (typeof part.text !== "string") invalid();
    } else if (part.type === "input_image") {
      keys(part, ["type", "image_url", "file_id", "detail", "prompt_cache_breakpoint"]);
      if (!["auto", "low", "high", "original"].includes(String(part.detail))) invalid();
      if (Number(source(part.image_url)) + Number(source(part.file_id)) !== 1) invalid();
      for (const key of ["image_url", "file_id"]) if (part[key] != null && !source(part[key])) invalid();
      if (part.file_id != null && !injectionId(part.file_id)) invalid();
    } else if (part.type === "input_file") {
      keys(part, ["type", "file_id", "file_url", "file_data", "filename", "detail", "prompt_cache_breakpoint"]);
      if ([part.file_id, part.file_url, part.file_data].filter(source).length !== 1) invalid();
      for (const key of ["file_id", "file_url", "file_data", "filename"]) if (part[key] != null && !source(part[key])) invalid();
      if (part.file_id != null && !injectionId(part.file_id)) invalid();
      if (part.file_data != null && !source(part.filename)) invalid();
      if (part.detail !== undefined && !["auto", "low", "high"].includes(String(part.detail))) invalid();
    } else invalid();
  }
}
/** Separate call IDs from approval IDs so identical spellings cannot authorize each other. */
export function nativeResultKey(value: NativeSavedResult): string {
  return JSON.stringify([value.type === "mcp_approval_response" ? "approval" : "call",
    value.type === "mcp_approval_response" ? value.approval_request_id : value.call_id]);
}
/** Parse the wider continuation schema; this does NOT grant response.inject support. */
export function nativeSavedResults(value: unknown): NativeSavedResult[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_NATIVE_INJECTION_CALLS) invalid();
  const seen = new Set<string>();
  for (const item of value) {
    if (!record(item) || (item.id !== undefined && !injectionId(item.id))) invalid();
    if (item.type === "mcp_approval_response") {
      keys(item, ["type", "approval_request_id", "approve", "reason", "id"]);
      if (!injectionId(item.approval_request_id) || typeof item.approve !== "boolean"
        || (item.reason != null && typeof item.reason !== "string")) invalid();
    } else {
      keys(item, ["type", "call_id", "output", "caller", "id"]);
      if (!["function_call_output", "custom_tool_call_output"].includes(String(item.type)) || !injectionId(item.call_id)) invalid();
      output(item.output); caller(item.caller);
    }
    const key = nativeResultKey(item as NativeSavedResult);
    if (seen.has(key)) injectionError("duplicate_injection", "Each saved result or approval must occur exactly once.");
    seen.add(key);
  }
  return value as NativeSavedResult[];
}
/** Bind a client-owned call or approval to its type, caller and server-supplied identity. */
export function nativeToolRequirement(item: unknown): NativeToolRequirement | undefined {
  if (!record(item)) return;
  let type: NativeSavedResult["type"];
  let key: string;
  if (item.type === "mcp_approval_request") {
    if (!injectionId(item.id)) invalid();
    type = "mcp_approval_response"; key = JSON.stringify(["approval", item.id]);
  } else {
    if (item.type !== "function_call" && item.type !== "custom_tool_call") return;
    if (!injectionId(item.call_id) || (item.id !== undefined && !injectionId(item.id))) invalid();
    type = item.type === "function_call" ? "function_call_output" : "custom_tool_call_output";
    key = JSON.stringify(["call", item.call_id]);
  }
  const origin = caller(item.caller);
  // Retain only a bounded digest of provenance, never another copy of the call body.
  return { key, type, caller: origin, identity: injectionFingerprint({ type, id: item.id, name: item.name,
    server_label: item.server_label, arguments: item.arguments, input: item.input, caller: origin, agent: item.agent }) };
}
/** Approval decisions must be supplied by the caller; no default or synthetic approval exists. */
export function nativeResultMatches(item: NativeSavedResult, required: NativeToolRequirement): boolean {
  return nativeResultKey(item) === required.key && item.type === required.type
    && (item.type === "mcp_approval_response" || caller(item.caller) === required.caller);
}
/** Compare content rather than object identity; retain content-array order and caller identity. */
export function nativeResultFingerprint(item: NativeSavedResult): string {
  return injectionFingerprint(item.type === "mcp_approval_response"
    ? { type: item.type, approval_request_id: item.approval_request_id, approve: item.approve, reason: item.reason }
    : { type: item.type, call_id: item.call_id, output: item.output, caller: caller(item.caller) });
}
