/**
 * Provider-opaque tool-call metadata across the Responses boundary (issue #1735).
 *
 * Gemini issues a `thoughtSignature` on the exact part that carries a function call, and the
 * next request is only valid if that signature comes back on the part rebuilt from that same
 * call. Every synthetic loop in this proxy (web search, images, continuation replay) tears a
 * tool call down into id/name/arguments and builds a fresh one, which silently dropped the
 * signature and left only the same-process replay cache to paper over it. History replay and
 * `previous_response_id` had no cache to fall back on.
 *
 * This module is the single seam where that metadata crosses into and out of the Responses
 * wire, so a loop that rebuilds a call only has to carry one field instead of knowing about
 * any provider. Values are treated as opaque: never parsed, merged, re-encoded, or synthesized.
 */
import type { OcxProviderOpaqueToolCallMetadata } from "../types";

/** Wire shape: `extra_content.google.thought_signature` on a Responses function_call item. */
interface ResponsesExtraContent {
  google?: { thought_signature?: unknown };
}

function isObj(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Same ceiling the Antigravity replay cache already enforces on a stored signature. An opaque
 * token this large is not a real signature, and accepting it would let a caller push unbounded
 * state through history replay.
 */
const MAX_SIGNATURE_BYTES = 64 * 1024;

export function isCarryableSignature(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0) return false;
  // Cheap length pre-check: UTF-8 is at most 3 bytes per UTF-16 code unit for the BMP, so this
  // skips the encode for the overwhelmingly common short case.
  if (value.length <= MAX_SIGNATURE_BYTES / 3) return true;
  return Buffer.byteLength(value, "utf8") <= MAX_SIGNATURE_BYTES;
}

/** Read provider metadata off an inbound Responses function_call item. */
export function providerMetadataFromResponsesFunctionCall(
  item: { extra_content?: unknown } | undefined,
): OcxProviderOpaqueToolCallMetadata | undefined {
  const extra = item?.extra_content;
  if (!isObj(extra)) return undefined;
  const google = (extra as ResponsesExtraContent).google;
  if (!isObj(google)) return undefined;
  const signature = google.thought_signature;
  if (!isCarryableSignature(signature)) return undefined;
  return { google: { thoughtSignature: signature } };
}

/** Serialize provider metadata onto an outbound Responses function_call item. */
export function responsesExtraContentFromProviderMetadata(
  metadata: OcxProviderOpaqueToolCallMetadata | undefined,
): { extra_content: { google: { thought_signature: string } } } | undefined {
  const signature = metadata?.google?.thoughtSignature;
  if (!isCarryableSignature(signature)) return undefined;
  return { extra_content: { google: { thought_signature: signature } } };
}

/**
 * Copy metadata for a rebuilt tool call. A signature belongs to one specific part, so a loop
 * that fans one model response into several calls must copy per call and never share or merge.
 */
export function cloneProviderOpaqueToolCallMetadata(
  metadata: OcxProviderOpaqueToolCallMetadata | undefined,
): OcxProviderOpaqueToolCallMetadata | undefined {
  const signature = metadata?.google?.thoughtSignature;
  if (!isCarryableSignature(signature)) return undefined;
  return { google: { thoughtSignature: signature } };
}
