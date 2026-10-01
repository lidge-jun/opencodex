/**
 * The synthetic `advisor` tool injected into routed worker turns.
 *
 * Mirrors src/web-search/synthetic-tool.ts: the proxy OWNS this tool — the worker only expresses
 * "I want to consult the expert" (optionally with a focus), and OpenCodex builds everything else
 * (task context, conversation, tool catalog, identities) itself. The worker never passes a
 * transcript, provider, model, or files.
 */
import type { OcxTool } from "../types";

export const ADVISOR_TOOL_NAME = "advisor";

export function buildAdvisorTool(): OcxTool {
  return {
    name: ADVISOR_TOOL_NAME,
    description:
      "Consult an independent expert advisor model about the current task. The advisor receives a "
      + "summary of what you have done so far (task, conversation, tool results) and returns "
      + "strategic advice, critique, root-cause reasoning, or alternative approaches. Use it when "
      + "you are stuck, before starting substantive implementation on a hard task, or when you want "
      + "a second opinion on a plan or diagnosis. The advisor cannot execute tools or edit files; "
      + "you remain responsible for all execution. Optionally pass a short `question` to focus the "
      + "consultation.",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string", description: "Optional short focus question for the advisor." },
      },
      required: [],
    },
    advisor: true,
  };
}
