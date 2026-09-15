import { readBoundedResponseBody } from "../../lib/bounded-body";
import { redactSecretString } from "../../lib/redact";
import { isCyberPolicyMessage, isCyberPolicyCode } from "../../lib/errors";
import { isTranslatorBudgetExceededError } from "../../lib/translator-budget";
import { formatErrorResponse } from "../../bridge";
import {
  UnsupportedContentEncodingError,
  DecompressedBodyTooLargeError,
  describeInboundBodyRefusal,
} from "../request-decompress";
import { comboCooldownRetryAfterSeconds } from "../../combos";
import type { AgentTaskRecoveryFailureReason } from "./agent-task-recovery";

/**
 * Materialize an upstream error body only when the bounded reader observed a complete,
 * display-safe payload. Partial timeout and over-limit prefixes are attacker-controlled,
 * so callers keep their existing status-only fallback instead.
 */
export async function readDisplaySafeErrorText(
  response: Response,
  signal: AbortSignal,
  fallback: string,
): Promise<string> {
  try {
    const body = await readBoundedResponseBody(response, { signal });
    return body.displaySafe ? body.text : fallback;
  } catch {
    // Preserve the former Response.text().catch(fallback) contract. Request-abort
    // classification remains owned by the surrounding response pipeline.
    return fallback;
  }
}


export interface NormalizedUpstreamErrorText {
  safeText: string;
  message?: string;
  type?: string;
  code?: string;
  cyberPolicy: boolean;
}


/**
 * Extract the structured provider error envelope without making `error.type` authoritative.
 * Policy identity comes from the dedicated code (or the legacy message fallback); a credible
 * upstream type is only carried through so callers do not erase provider diagnostics.
 */
export function normalizeUpstreamErrorText(text: string, fallback: string): NormalizedUpstreamErrorText {
  const safeText = redactSecretString(text).slice(0, 500).trim() || fallback;
  let message: string | undefined;
  let type: string | undefined;
  let code: string | undefined;
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const response = parsed.response && typeof parsed.response === "object" && !Array.isArray(parsed.response)
      ? parsed.response as Record<string, unknown>
      : undefined;
    const candidates = [parsed.error, response?.error, response?.last_error, parsed.last_error, parsed];
    const source = candidates.find((candidate): candidate is Record<string, unknown> => {
      if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
      const record = candidate as Record<string, unknown>;
      return [record.message, record.type, record.code].some(value => typeof value === "string");
    });
    if (!source) return { safeText, cyberPolicy: isCyberPolicyMessage(safeText) };
    if (typeof source.message === "string" && source.message.trim()) {
      message = redactSecretString(source.message.trim()).slice(0, 500);
    }
    if (typeof source.type === "string" && source.type.trim()) type = source.type.trim();
    if (typeof source.code === "string" && source.code.trim()) code = source.code.trim();
  } catch {
    /* non-JSON upstream body — retain the bounded display-safe text */
  }
  const cyberPolicy = isCyberPolicyCode(code) || isCyberPolicyMessage(message ?? safeText);
  return { safeText, message, type, code, cyberPolicy };
}




export function decodeRequestErrorResponse(err: unknown, label: string): Response {
  if (isTranslatorBudgetExceededError(err)) {
    return formatErrorResponse(413, "request_too_large", "request translation buffer exceeded the safe limit", {
      code: "translation_buffer_limit",
    });
  }
  if (err instanceof UnsupportedContentEncodingError) {
    return formatErrorResponse(415, "invalid_request_error", err.message);
  }
  if (err instanceof DecompressedBodyTooLargeError) {
    return formatErrorResponse(413, "inbound_body_too_large", describeInboundBodyRefusal(err));
  }
  console.warn(`[${label}] request body decode/parse failed: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  return formatErrorResponse(400, "invalid_request_error", "Invalid JSON body");
}




export function comboUnavailableResponse(
  message: string,
  options?: { retryAfter?: string | null },
): Response {
  const headers = new Headers({ "Content-Type": "application/json" });
  const retryAfter = options?.retryAfter?.trim();
  if (retryAfter && retryAfter.length > 0 && retryAfter.length <= 128) {
    headers.set("Retry-After", retryAfter);
  }
  return new Response(
    JSON.stringify({
      error: { message, type: "server_error", code: "combo_unavailable" },
    }),
    { status: 503, headers },
  );
}


export function comboUnavailable(comboId: string, now = Date.now()): Response {
  return comboUnavailableResponse(`No available targets for combo: ${comboId}`, {
    retryAfter: comboCooldownRetryAfterSeconds(comboId, now),
  });
}




/**
 * Build the 499 JSON error the proxy returns when the client disconnects before the
 * response completes (`client_cancelled`).
 */
export function clientCancelledResponse(): Response {
  return formatErrorResponse(499, "client_cancelled", "Client cancelled request");
}


export const UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE =
  "Routed V2 worker task is encrypted for the native ChatGPT backend and cannot be read by the selected provider. Use plaintext V2 agent-message delivery or select a native ChatGPT model.";


export function unreadableEncryptedAgentTaskResponse(reason?: AgentTaskRecoveryFailureReason): Response {
  return new Response(
    JSON.stringify({
      error: {
        message: UNREADABLE_ENCRYPTED_AGENT_TASK_MESSAGE,
        type: "invalid_request_error",
        code: "unreadable_encrypted_agent_task",
        ...(reason === undefined ? {} : { recovery_reason: reason }),
      },
    }),
    { status: 400, headers: { "Content-Type": "application/json" } },
  );
}
