/**
 * The synthetic `advisor` tool injected into routed worker turns.
 *
 * Mirrors src/web-search/synthetic-tool.ts: the proxy OWNS this tool — the worker only expresses
 * "I want to consult the expert" with an optional focus, or a required standalone question in
 * question-only mode. OpenCodex attaches task context only in the default context mode.
 * The worker never selects the advisor provider or model through this tool.
 */
import type { OcxTool } from "../types";
import type { AdvisorContextMode } from "./settings";
import { MAX_ADVISOR_QUESTION_CHARACTERS } from "../server/responses/advisor-question";

export const ADVISOR_TOOL_NAME = "advisor";

export function buildAdvisorTool(contextMode: AdvisorContextMode = "context"): OcxTool {
  const questionOnly = contextMode === "question-only";
  return {
    name: ADVISOR_TOOL_NAME,
    description: questionOnly
      ? "Consult an independent expert advisor using only your question. No conversation history, "
        + "task, tool results, files or tool catalog is attached automatically. Write a concise, "
        + `self-contained question with the essential background and relevant evidence (up to ${MAX_ADVISOR_QUESTION_CHARACTERS} `
        + "characters). The advisor cannot execute tools or edit files; you remain responsible for execution."
      : "Consult an independent expert advisor model about the current task. The advisor receives a "
      + "summary of what you have done so far (task, conversation, tool results) and returns "
      + "strategic advice, critique, root-cause reasoning, or alternative approaches. Use it when "
      + "you are stuck, before starting substantive implementation on a hard task, or when you want "
      + "a second opinion on a plan or diagnosis. The advisor cannot execute tools or edit files; "
      + "you remain responsible for all execution. Optionally pass a short `question` to focus the "
      + "consultation.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          // Enforce bounds in the runtime; Google's reject-lossy policy refuses schema size constraints.
          description: questionOnly
            ? `Required self-contained question, including only the necessary background and evidence. Maximum ${MAX_ADVISOR_QUESTION_CHARACTERS} characters.`
            : "Optional short focus question for the advisor.",
        },
      },
      required: questionOnly ? ["question"] : [],
    },
    advisor: true,
  };
}
