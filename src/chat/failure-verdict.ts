import type { ClientErrorContract } from "../lib/client-error-body";
import { isCyberPolicyMessage, isTerminalRefusalCode } from "../lib/errors";
export interface FailureVerdict { status: number; type: string; code: string | null; message: string }
/** Passed explicitly through producer, lifetime wrappers and collector for one response. */
export interface FailureVerdictSink { verdict?: FailureVerdict; contract?: ClientErrorContract; proxyAuthored?: boolean }
export function legacyStreamErrorStatus(message: string): number {
  const lower = message.toLowerCase();
  if (isCyberPolicyMessage(lower)) return 400;
  if (lower.includes("truncated")) return 502;
  if (lower.includes("rate") || lower.includes("429")) return 429;
  if (lower.includes("unauthor") || lower.includes("401") || lower.includes("api key")) return 401;
  if (lower.includes("not found") || lower.includes("404")) return 404;
  if (lower.includes("invalid") || lower.includes("400")) return 400;
  return 502;
}
export function legacyFailureVerdict(payload: Record<string, unknown>): FailureVerdict {
  const error = payload.error as { message: string; type: string; code: string | null };
  const { message, code } = error;
  return { message, code, type: code === "translation_buffer_limit" ? "upstream_error" : error.type,
    status: code === "translation_buffer_limit" ? 502 : isTerminalRefusalCode(code) || isCyberPolicyMessage(message) ? 400 : legacyStreamErrorStatus(message) };
}
