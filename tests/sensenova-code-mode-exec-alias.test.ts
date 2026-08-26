import { describe, expect, test } from "bun:test";
import { bridgeToResponsesSSE } from "../src/bridge";
import type { AdapterEvent } from "../src/adapters/types";

describe("SenseNova code mode exec_command alias", () => {
  test("synthesizes code-mode exec script when bare exec_command is called", async () => {
    const events: AdapterEvent[] = [
      { type: "tool_call_start", itemId: "fc_1", callId: "call_1", name: "exec_command" },
      { type: "tool_call_delta", callId: "call_1", delta: JSON.stringify({ cmd: "pwd" }) },
      { type: "tool_call_end", callId: "call_1" },
      { type: "done", finishReason: "tool_calls" },
    ];

    const toolNsMap = new Map([
      ["exec_command", { namespace: "functions", name: "exec", freeform: true as const, codeModeExecCommand: true as const }],
    ]);

    const emitted: any[] = [];
    async function* gen() {
      for (const e of events) yield e;
    }

    const stream = bridgeToResponsesSSE(gen(), "sensenova/sensechat-5", toolNsMap);
    for await (const chunk of stream) {
      const lines = chunk.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && line !== "data: [DONE]") {
          emitted.push(JSON.parse(line.slice(6)));
        }
      }
    }

    const customDone = emitted.find(e => e.type === "response.custom_tool_call_input.done");
    expect(customDone).toBeDefined();
    expect(customDone.input).toContain("tools.exec_command");
    expect(customDone.input).toContain("pwd");
  });
});
