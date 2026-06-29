import { redactSecretString } from "../redact";

const REASON_KEYS = ["finish_reason", "finishReason", "stop_reason", "stopReason", "completionReason", "reason"];
const TRUNCATION_PATTERN = /length|max[_-]?tokens?|truncat|incomplete|context_length/i;

function safeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function kiroTruncationReason(parsed: Record<string, unknown>): string | undefined {
  if (parsed.truncated === true) return "truncated";
  for (const key of REASON_KEYS) {
    const value = safeString(parsed[key]);
    if (value && TRUNCATION_PATTERN.test(value)) return value;
  }
  return undefined;
}

export function isCompleteKiroToolInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed) return true;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed !== null && typeof parsed === "object";
  } catch {
    return false;
  }
}

export function kiroTruncationErrorMessage(reason?: string): string {
  const suffix = reason ? ` (${redactSecretString(reason).slice(0, 160)})` : "";
  return `Kiro response truncated upstream before the tool call completed${suffix}`;
}
