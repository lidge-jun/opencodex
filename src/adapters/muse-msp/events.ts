import { namespacedToolName, type AdapterEvent } from "../../types";
import { MuseMspError } from "./connection";

/** Translate an admitted captured call into the existing Responses bridge event contract. */
export function museToolCallEvents(call: {
  clientCallId: string; name: string; namespace?: string; freeform?: true; arguments: string;
}): AdapterEvent[] {
  if (!call || typeof call.clientCallId !== "string" || !/^msp_[0-9a-f]{48}$/.test(call.clientCallId) ||
      typeof call.name !== "string" || !call.name || Buffer.byteLength(call.name) > 512 ||
      (call.namespace !== undefined && (typeof call.namespace !== "string" || !call.namespace || Buffer.byteLength(call.namespace) > 512)) ||
      typeof call.arguments !== "string" || Buffer.byteLength(call.arguments) > 256 * 1024) throw new MuseMspError("invalid_capture_call");
  let args: unknown;
  try { args = JSON.parse(call.arguments); } catch { throw new MuseMspError("invalid_capture_call"); }
  if (!args || typeof args !== "object" || Array.isArray(args) ||
      (call.freeform && (Object.keys(args).length !== 1 || typeof (args as Record<string, unknown>).input !== "string"))) {
    throw new MuseMspError("invalid_capture_call");
  }
  return [
    { type: "tool_call_start", id: call.clientCallId, name: namespacedToolName(call.namespace, call.name) },
    { type: "tool_call_delta", arguments: call.arguments },
    { type: "tool_call_end" },
  ];
}
