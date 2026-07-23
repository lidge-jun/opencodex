import { describe, expect, test } from "bun:test";
import { usageFromResponsesPayload } from "../src/server";
import { applyResponseLogMetadata, type RequestLogContext } from "../src/server/request-log";

describe("usageFromResponsesPayload", () => {
  test("bridge-reported usage wins over re-parsed wire payload (provenance guard)", () => {
    // The bridge always emits zero-default detail objects for strict clients; when
    // onUsage already recorded the raw adapter usage, SSE/JSON re-parsing must not
    // overwrite it with synthetic zeros (cache_detail_missing suppression).
    const logCtx: RequestLogContext = { model: "m", provider: "p", usageFromBridge: true };
    logCtx.usage = { inputTokens: 10, outputTokens: 5 };
    applyResponseLogMetadata(logCtx, {
      response: {
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    });
    expect(logCtx.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    expect(logCtx.usage.cachedInputTokens).toBeUndefined();

    // Without the bridge flag (native passthrough), wire parsing still applies.
    const passthroughCtx: RequestLogContext = { model: "m", provider: "p" };
    applyResponseLogMetadata(passthroughCtx, {
      response: { usage: { input_tokens: 4, output_tokens: 2, input_tokens_details: { cached_tokens: 1 } } },
    });
    expect(passthroughCtx.usage).toMatchObject({ inputTokens: 4, cachedInputTokens: 1 });
  });

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

  test("parses the standard Responses shape with cached, cache-write, and reasoning details", () => {
    const usage = usageFromResponsesPayload({
      input_tokens: 100,
      output_tokens: 23,
      total_tokens: 150,
      input_tokens_details: { cached_tokens: 7, cache_write_tokens: 3 },
      output_tokens_details: { reasoning_tokens: 5 },
    });
    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 23,
      totalTokens: 150,
      cachedInputTokens: 7,
      cacheReadInputTokens: 7,
      cacheCreationInputTokens: 3,
      reasoningOutputTokens: 5,
    });
  });

  test("parses the ChatCompletions shape and maps prompt/completion to input/output", () => {
    const usage = usageFromResponsesPayload({
      prompt_tokens: 42,
      completion_tokens: 7,
      total_tokens: 60,
      prompt_tokens_details: { cached_tokens: 11, cache_write_tokens: 2 },
      completion_tokens_details: { reasoning_tokens: 3 },
    });
    expect(usage).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      totalTokens: 60,
      cachedInputTokens: 11,
      cacheReadInputTokens: 11,
      cacheCreationInputTokens: 2,
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
