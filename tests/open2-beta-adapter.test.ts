import { describe, expect, test } from "bun:test";
import { mapOpen2Event, open2Messages, open2ReasoningEffort } from "../src/adapters/open2-beta";
import type { OcxParsedRequest, OcxProviderConfig } from "../src/types";

const provider: OcxProviderConfig = {
  adapter: "open2-beta",
  baseUrl: "https://open2-beta.upstage.ai",
  reasoningEfforts: ["medium", "high", "max"],
  reasoningEffortMap: {
    none: "none",
    minimal: "medium",
    low: "medium",
    medium: "medium",
    high: "high",
    xhigh: "high",
    max: "max",
  },
};

function parsedRequest(): OcxParsedRequest {
  return {
    modelId: "solar-open2",
    stream: true,
    context: {
      systemPrompt: ["Be concise."],
      messages: [
        { role: "user", content: "hello", timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 },
        { role: "toolResult", toolCallId: "call_1", toolName: "shell", content: "ok", isError: false, timestamp: 3 },
      ],
    },
    options: {},
  };
}

describe("open2-beta adapter", () => {
  test("converts Codex history to Open2 user/assistant messages", () => {
    expect(open2Messages(parsedRequest())).toEqual([
      { role: "user", content: "[System]\nBe concise.\n\nhello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "[Tool result: shell]\nok" },
    ]);
  });

  test("maps text, thinking, usage, and completion events", () => {
    expect(mapOpen2Event({ type: "delta", content: "hello" })).toEqual([{ type: "text_delta", text: "hello" }]);
    expect(mapOpen2Event({ type: "thinking_delta", content: "hmm" })).toEqual([{ type: "thinking_delta", thinking: "hmm" }]);
    expect(mapOpen2Event({
      type: "complete",
      data: {
        usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14, cached_input_tokens: 3 },
        stop_reason: "complete",
      },
    })).toEqual([{
      type: "done",
      usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: 3 },
      stopReason: "complete",
      endTurn: true,
    }]);
  });

  test("normalizes Codex reasoning levels to the four Open2 beta choices", () => {
    const parsed = parsedRequest();
    expect(open2ReasoningEffort(parsed, provider)).toBe("medium");
    for (const [input, output] of [
      ["none", "none"],
      ["minimal", "medium"],
      ["low", "medium"],
      ["medium", "medium"],
      ["high", "high"],
      ["xhigh", "high"],
      ["max", "max"],
    ] as const) {
      parsed.options.reasoning = input;
      expect(open2ReasoningEffort(parsed, provider)).toBe(output);
    }
  });
});
