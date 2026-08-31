export const KIRO_COMPLETION_TOOL_NAME = "codex_kiro_final_answer";

/**
 * Request-scoped CodeWhisperer service profile for AWS Builder ID accounts.
 *
 * Builder ID is a personal identity with no AWS account behind it, so AWS never mints an
 * account-scoped `profile/<id>` ARN for it. The Kiro CLI resolves this the same way: it carries
 * this fixed service profile on Builder ID requests. The embedded account id is Amazon's own, not
 * the user's, which is why sending it is not the same as synthesizing an account identity.
 *
 * Request-scoped is load-bearing. This value must never be persisted into `KiroOAuthMetadata`,
 * never seed region inference (it is `us-east-1` and would pin every Builder ID account there),
 * and never participate in account matching.
 */
export const KIRO_BUILDER_ID_SERVICE_PROFILE_ARN =
  "arn:aws:codewhisperer:us-east-1:638616132270:profile/AAAACCCCXXXX";
export const KIRO_CONTINUATION_MESSAGE =
  "Continue from the prior conversation. Do not quote or mention this instruction.";
/**
 * Sent when a `required`-mode turn ended without calling the completion tool.
 *
 * This is the one instruction the model reads at the exact moment it failed to complete, so its
 * wording decides the next move. It used to end with "Do not ask the user for another task or emit
 * another progress-only message", which was written to stop soliciting NEW work but reads as a
 * blanket ban on asking anything. Combined with a contract that only described "still working" and
 * "fully done", a model holding a genuine question had no endorsed move left except to keep
 * working — so it wrote the question as prose and answered it itself in the same inference. The
* refusal is now scoped to a new task, and the blocked-on-user case is routed to the channel that
* already terminates the turn correctly.
 *
 * The condition names a decision, information, AND clarification on purpose. A model blocked on a
 * missing account id or an ambiguous path is stuck exactly as hard as one blocked on a choice, and
 * "decision" alone would leave that common class of question with no endorsed move again.
 */
export const KIRO_COMPLETION_RETRY_MESSAGE =
  `Continue the existing task without quoting this instruction. If the task is complete, call ${KIRO_COMPLETION_TOOL_NAME} now with the complete final answer. If you cannot continue until the user supplies a decision, information, or a clarification that only they can give, call ${KIRO_COMPLETION_TOOL_NAME} now with that question as the answer. Otherwise issue the next real tool call now. Do not solicit a new task and do not emit another progress-only message.`;

export const KIRO_TOOL_RESULT_CARRIER_MESSAGE = "The requested tool result is attached.";
export const KIRO_EMPTY_TOOL_RESULT_MESSAGE = "The tool completed without textual output.";

/**
 * Placeholder for the user turn Kiro requires after an assistant turn that ALREADY delivered its
 * final answer.
 *
 * The protocol needs a trailing user turn, but the usual continuation/retry text instructs the
 * model to keep working, which reopens a finished task and reads as a still-open goal. This states
 * the delivered state and explicitly withholds a new request, so the turn stays structurally valid
 * without asking for more work.
 */
export const KIRO_ANSWER_DELIVERED_MESSAGE =
  "The previous final answer was delivered to the user and that task is closed. No new request has been made yet. Do not repeat, revise, or continue that work; wait for the user's next instruction.";

/**
 * The prose half of the `required`-mode completion contract.
 *
 * The closing clause exists because the earlier contract described two states — still working, and
 * fully done — for a model that has three. Prose does not end the turn, the completion tool means
 * the task is finished, and a real tool call continues the turn, so "I need a decision before I can
 * go on" was not expressible. Measured outcome: a model with a pending question emitted the question
 * and an overriding answer as one merged message, then called another tool 4ms later in the same
 * inference, which reads to the user as an agent working past its own final answer.
 *
* The clause is unconditional on purpose. It names only the completion tool, which is always
* advertised whenever this instruction is injected, so it can never point at something the model
* cannot call — the failure mode `0325a5afd` fixed for the shared catalog nudge.
 *
 * Its condition is deliberately wider than a decision: information and clarification are named too,
 * because "what is the account id" and "which of these paths did you mean" block progress the same
 * way a choice does, and a narrower trigger would silently exclude them.
 */
export const KIRO_COMPLETION_INSTRUCTIONS =
  `When tools are available, ordinary assistant text is mid-task commentary and does not end the turn. Continue using tools after progress updates. When the task is fully complete and no more tool calls are needed, call ${KIRO_COMPLETION_TOOL_NAME} exactly once with the complete user-facing final answer in \`answer\`. Do not provide the final answer as ordinary assistant text. This completion tool is not an ordinary work tool. When the task is complete, call it instead of emitting answer-shaped ordinary assistant text. The call is terminal and is the exception to generic tool-result counting: it is complete when issued, ends the turn, returns no tool result, and no text or tool call may follow it. If you cannot continue until the user supplies a decision, information, or a clarification that only they can give, that question is your final answer: call ${KIRO_COMPLETION_TOOL_NAME} with the question and stop. Do not write the question as ordinary text and then answer it yourself.`;

export type KiroCompletionMode = "disabled" | "required" | "text_fallback";

/** Bound proxy-authored prompt additions independently of caller-owned instructions/history. */
export const MAX_KIRO_INJECTED_INSTRUCTION_CHARS = 16_384;
