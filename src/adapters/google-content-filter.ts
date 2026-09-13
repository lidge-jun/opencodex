import type { AdapterEvent, OcxUsage } from "../types";

const FILTERED_FINISH_REASONS = new Set([
  "SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII",
  "IMAGE_SAFETY", "IMAGE_PROHIBITED_CONTENT", "IMAGE_RECITATION",
]);
const BLOCKED_PROMPT_REASONS = new Set([
  "SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "IMAGE_SAFETY", "JAILBREAK", "OTHER",
]);

// Observed CCA refusal copy: only classify this exact standalone message on missing-terminal
// EOF. Mentions, quotations, longer answers and normally completed responses must not match.
const TEXT_POLICY_REFUSAL = "The prompt could not be submitted. The prompt contains sensitive words that violate Google's [Generative AI Prohibited Use policy](https://policies.google.com/terms/generative-ai/use-policy). Try rephrasing the prompt. If you think this was an error, [send feedback](https://ai.google.dev/gemini-api/docs/troubleshooting).";

export function googleTextPolicyRefusalEvent(text: string, usage?: OcxUsage): Extract<AdapterEvent, { type: "error" }> | undefined {
  if (text.trim().replace(/\s+/g, " ") !== TEXT_POLICY_REFUSAL) return undefined;
  return {
    type: "error", status: 400, errorType: "invalid_request_error", code: "invalid_prompt",
    retryable: false,
    message: "Google/Antigravity content_filter: upstream returned a standalone content-policy refusal and closed without a completion signal. No structured filter category was provided. Review the request against the provider's content policy before trying again.",
    ...(usage ? { usage } : {}),
  };
}

/** A provider policy stop is terminal, not a transient disconnect to retry across accounts. */
export function googleContentFilterEvent(
  reason: unknown,
  source: "finishReason" | "promptFeedback.blockReason",
  usage?: OcxUsage,
): Extract<AdapterEvent, { type: "error" }> | undefined {
  const allowed = source === "finishReason" ? FILTERED_FINISH_REASONS : BLOCKED_PROMPT_REASONS;
  if (typeof reason !== "string" || !allowed.has(reason)) return undefined;
  // Only known enums reach logs/UI. Never copy finishMessage, prompt text, or generated content.
  return {
    type: "error",
    status: 400,
    errorType: "invalid_request_error",
    // Codex 0.153.4 treats unknown SSE error codes as retryable even when retryable=false.
    // invalid_prompt is its supported terminal content-policy code; preserve Google's enum
    // in the message so this normalization never hides the upstream reason.
    code: "invalid_prompt",
    retryable: false,
    message: `Google/Antigravity content_filter: blocked this response (${source}=${reason}). The response was not completed. Review the request against the provider's content policy before trying again.`,
    ...(usage ? { usage } : {}),
  };
}
