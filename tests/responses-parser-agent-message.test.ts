import { describe, expect, test } from "bun:test";
import { parseRequest } from "../src/responses/parser";

describe("Responses parser agent_message boundaries", () => {
  test("keeps agent_message between separate assistant reasoning turns", () => {
    const parsed = parseRequest({
      model: "claude-fable-5",
      stream: true,
      input: [
        {
          type: "reasoning",
          id: "rs_before_agent",
          summary: [
            {
              type: "summary_text",
              text: "reasoning before the sub-agent response",
            },
          ],
          encrypted_content: "opaque-signature-before",
        },
        {
          type: "agent_message",
          author: "probe_all",
          recipient: "root",
          content: [
            {
              type: "input_text",
              text: "sub-agent result",
            },
          ],
        },
        {
          type: "reasoning",
          id: "rs_after_agent",
          summary: [
            {
              type: "summary_text",
              text: "reasoning after the sub-agent response",
            },
          ],
          encrypted_content: "opaque-signature-after",
        },
        {
          type: "function_call",
          id: "fc_after_agent",
          call_id: "call_after_agent",
          name: "shell_command",
          arguments: JSON.stringify({ command: "echo ok" }),
        },
        {
          type: "function_call_output",
          call_id: "call_after_agent",
          output: "ok",
        },
      ],
    });

    const messages = parsed.context.messages;

    expect(messages.map((message) => message.role)).toEqual([
      "assistant",
      "user",
      "assistant",
      "toolResult",
    ]);

    const firstAssistant = messages[0];
    if (!firstAssistant || firstAssistant.role !== "assistant") {
      throw new Error("expected the first parsed message to be assistant");
    }

    expect(firstAssistant.content).toHaveLength(1);
    expect(firstAssistant.content[0]).toMatchObject({
      type: "thinking",
      thinking: "reasoning before the sub-agent response",
      itemId: "rs_before_agent",
    });

    expect(messages[1]).toMatchObject({
      role: "user",
      content: "sub-agent result",
    });

    const secondAssistant = messages[2];
    if (!secondAssistant || secondAssistant.role !== "assistant") {
      throw new Error("expected the third parsed message to be assistant");
    }

    expect(secondAssistant.content).toHaveLength(2);
    expect(secondAssistant.content[0]).toMatchObject({
      type: "thinking",
      thinking: "reasoning after the sub-agent response",
      itemId: "rs_after_agent",
    });
    expect(secondAssistant.content[1]).toMatchObject({
      type: "toolCall",
      id: "call_after_agent",
      name: "shell_command",
      arguments: { command: "echo ok" },
      thoughtSignature: "fc_after_agent",
    });

    expect(messages[3]).toMatchObject({
      role: "toolResult",
      toolCallId: "call_after_agent",
      toolName: "shell_command",
      content: "ok",
      isError: false,
    });
  });
});
