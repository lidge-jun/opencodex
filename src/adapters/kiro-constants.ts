export const KIRO_COMPLETION_TOOL_NAME = "codex_kiro_final_answer";
export const KIRO_CONTINUATION_MESSAGE = "[system: conversation continues]";
export const KIRO_COMPLETION_RETRY_MESSAGE =
  `[system: The preceding assistant output did not explicitly complete the turn. If the task is complete, call ${KIRO_COMPLETION_TOOL_NAME} now with the complete final answer. Otherwise issue the next real tool call now. Do not ask the user for another task or emit another progress-only message.]`;

export const KIRO_COMPLETION_INSTRUCTIONS =
  `When tools are available, ordinary assistant text is mid-task commentary and does not end the turn. Continue using tools after progress updates. When the task is fully complete and no more tool calls are needed, call ${KIRO_COMPLETION_TOOL_NAME} exactly once with the complete user-facing final answer in \`answer\`. Do not provide the final answer as ordinary assistant text.`;

export type KiroCompletionMode = "disabled" | "required" | "text_fallback";

/** Bound proxy-authored prompt additions independently of caller-owned instructions/history. */
export const MAX_KIRO_INJECTED_INSTRUCTION_CHARS = 16_384;
