import { describe, expect, test } from "bun:test";

import { latestToolResult } from "../../src/adapters/step-cli/projection";
import type { OcxParsedRequest } from "../../src/types";

function parsed(messages: unknown[]): OcxParsedRequest {
  return { modelId: "step-5-preview", context: { messages }, options: {} } as unknown as OcxParsedRequest;
}

describe("StepCode tool-result extraction", () => {
  test("reads a string tool result, which is what a Responses function_call_output becomes", () => {
    const result = latestToolResult(
      parsed([
        { role: "user", content: "go", timestamp: 0 },
        { role: "toolResult", toolCallId: "c1", toolName: "shell", content: "LIVE_BRIDGE_OK", isError: false, timestamp: 1 },
      ]),
    );
    // The call id travels with the result so the adapter can match it against the held call instead of
    // trusting the result's position in the transcript.
    expect(result).toEqual({ content: [{ type: "text", text: "LIVE_BRIDGE_OK" }], toolCallId: "c1" });
  });

  test("keeps the parts of a structured tool result separate", () => {
    const result = latestToolResult(
      parsed([
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "shell",
          content: [
            { type: "text", text: "first" },
            { type: "text", text: " second" },
          ],
          isError: false,
          timestamp: 1,
        },
      ]),
    );
    // Block boundaries are PRESERVED, not joined: StepCode maps each block 1:1, so concatenating
    // would erase the distinction between e.g. a tool's stdout and its stderr.
    expect(result?.content).toEqual([
      { type: "text", text: "first" },
      { type: "text", text: " second" },
    ]);
  });

  test("marks an errored tool result so the model is told the call failed", () => {
    const result = latestToolResult(
      parsed([{ role: "toolResult", toolCallId: "c1", toolName: "shell", content: "boom", isError: true, timestamp: 1 }]),
    );
    expect(result?.isError).toBe(true);
    expect(result?.toolCallId).toBe("c1");
  });

  test("takes the newest result when a turn carries several", () => {
    const result = latestToolResult(
      parsed([
        { role: "toolResult", toolCallId: "c1", toolName: "shell", content: "old", isError: false, timestamp: 1 },
        { role: "user", content: "and again", timestamp: 2 },
        { role: "toolResult", toolCallId: "c2", toolName: "shell", content: "new", isError: false, timestamp: 3 },
      ]),
    );
    expect(result?.content).toEqual([{ type: "text", text: "new" }]);
    expect(result?.toolCallId).toBe("c2");
  });

  test("returns undefined when this turn is not the answer to a captured call", () => {
    expect(latestToolResult(parsed([{ role: "user", content: "hello", timestamp: 0 }]))).toBeUndefined();
  });
});
