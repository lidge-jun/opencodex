/**
 * Microsoft 365 Copilot refusals raised while collecting an answer, after the chat request was
 * already sent. They carry HTTP 413 because this adapter's buffers overflowed, but the provider
 * has processed the turn, so combo failover must not treat them as a pre-processing intake refusal
 * and send the turn to another target. Kept dependency-free so failover can read them.
 */
export const M365_RESPONSE_LIMIT_MESSAGES = {
  answer: "Microsoft 365 Copilot answer exceeded the buffer limit",
  reasoning: "Microsoft 365 Copilot reasoning exceeded the buffer limit",
  messages: "Microsoft 365 Copilot returned too many messages",
  frame: "Microsoft 365 Copilot frame buffer exceeded its limit",
} as const;
