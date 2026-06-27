import { describe, expect, test } from "bun:test";
import { usageFromResponsesPayload } from "../src/server";

describe("usageFromResponsesPayload", () => {
  test("returns undefined for null / wrong types / missing token pairs", () => {
    expect(usageFromResponsesPayload(undefined)).toBeUndefined();
    expect(usageFromResponsesPayload(null)).toBeUndefined();
    expect(usageFromResponsesPayload("not-an-object")).toBeUndefined();
    expect(usageFromResponsesPayload({})).toBeUndefined();
    expect(usageFromResponsesPayload({ input_tokens: "10", output_tokens: 5 })).toBeUndefined();
    expect(usageFromResponsesPayload({ input_tokens: 10 })).toBeUndefined();
    expect(usageFromResponsesPayload({ prompt_tokens: "1", completion_tokens: 2 })).toBeUndefined();
    expect(usageFromResponsesPayload({ prompt_tokens: 1 })).toBeUndefined();
  });

  test("parses the standard Responses shape with cached + reasoning details", () => {
    const usage = usageFromResponsesPayload({
      input_tokens: 100,
      output_tokens: 23,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens_details: { reasoning_tokens: 5 },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 23,
      cachedInputTokens: 7,
      reasoningOutputTokens: 5,
    });
  });

  test("parses the ChatCompletions shape and maps prompt/completion to input/output", () => {
    const usage = usageFromResponsesPayload({
      prompt_tokens: 42,
      completion_tokens: 7,
      prompt_tokens_details: { cached_tokens: 11 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(usage).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      cachedInputTokens: 11,
      reasoningOutputTokens: 3,
    });
  });

  test("ChatCompletions shape omits cached / reasoning when missing", () => {
    expect(usageFromResponsesPayload({ prompt_tokens: 5, completion_tokens: 2 })).toEqual({
      inputTokens: 5,
      outputTokens: 2,
    });
  });

  test("prefers Responses shape when both shapes coexist", () => {
    const usage = usageFromResponsesPayload({
      input_tokens: 1,
      output_tokens: 2,
      prompt_tokens: 999,
      completion_tokens: 999,
    });
    expect(usage).toEqual({ inputTokens: 1, outputTokens: 2 });
  });
});
