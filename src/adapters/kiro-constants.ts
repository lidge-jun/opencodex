export const KIRO_COMPLETION_TOOL_NAME = "codex_kiro_final_answer";
export const KIRO_CONTINUATION_MESSAGE =
  "Continue from the prior conversation. Do not quote or mention this instruction.";
export const KIRO_COMPLETION_RETRY_MESSAGE =
  `Continue the existing task without quoting this instruction. If the task is complete, call ${KIRO_COMPLETION_TOOL_NAME} now with the complete final answer. Otherwise issue the next real tool call now. Do not ask the user for another task or emit another progress-only message.`;

export const KIRO_TOOL_RESULT_CARRIER_MESSAGE = "The requested tool result is attached.";
export const KIRO_EMPTY_TOOL_RESULT_MESSAGE = "The tool completed without textual output.";

export const KIRO_COMPLETION_INSTRUCTIONS =
  `When tools are available, ordinary assistant text is mid-task commentary and does not end the turn. Continue using tools after progress updates. When the task is fully complete and no more tool calls are needed, call ${KIRO_COMPLETION_TOOL_NAME} exactly once with the complete user-facing final answer in \`answer\`. Do not provide the final answer as ordinary assistant text.`;

export type KiroCompletionMode = "disabled" | "required" | "text_fallback";

/** Bound proxy-authored prompt additions independently of caller-owned instructions/history. */
export const MAX_KIRO_INJECTED_INSTRUCTION_CHARS = 16_384;
