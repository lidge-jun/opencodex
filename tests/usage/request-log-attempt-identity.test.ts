import { describe, expect, test } from "bun:test";
import {
  aggregateAttemptUsage,
  beginRequestAttempt,
  finishRequestAttempt,
  noteAttemptSend,
  sealRequestAttemptIdentity,
} from "../../src/server/request-log";

describe("request log attempt identity", () => {
  test("records ordered attempts with sealed identity, fresh estimates, and deduplicated recoveries", () => {
    const a = beginRequestAttempt(1, "provisional-a", "model-a", "openai-chat");
    // Identity is sealed before the physical send, which is the only point it may replace the
    // provisional provider: after a send that row's account is settled and its provider frozen.
    sealRequestAttemptIdentity(a, "chatgpt-pabcdef", "openai-responses", "pabcdef");
    noteAttemptSend(a, 100);
    noteAttemptSend(a, 120, "transient-5xx");
    noteAttemptSend(a, 120, "transient-5xx");
    finishRequestAttempt(a, 503, 12);

    const b = beginRequestAttempt(2, "prov-b", "model-b", "openai-chat");
    noteAttemptSend(b, undefined);
    finishRequestAttempt(b, 200, 8, {
      inputTokens: 10,
      outputTokens: 2,
      cachedInputTokens: 4,
      cacheReadInputTokens: 4,
    });

    expect(a).toMatchObject({
      ordinal: 1,
      provider: "chatgpt-pabcdef",
      accountLogLabel: "pabcdef",
      adapter: "openai-responses",
      status: 503,
      sendCount: 3,
      inputTokenEstimate: 120,
      recoveryKinds: ["transient-5xx"],
      usageStatus: "estimated",
      usage: { inputTokens: 120, outputTokens: 0, estimated: true },
      totalTokens: 120,
      errorCode: "server_is_overloaded",
    });
    expect(b).toMatchObject({ status: 200, sendCount: 1, usageStatus: "reported", totalTokens: 12 });

    expect(aggregateAttemptUsage([a, b])).toEqual({
      status: "estimated",
      totalTokens: 132,
      usage: {
        inputTokens: 130,
        outputTokens: 2,
        totalTokens: 132,
        cachedInputTokens: 4,
        cacheReadInputTokens: 4,
        estimated: true,
      },
    });
  });

  test("a combo leg refused before any send does not make the served row unreported", () => {
    // core-combo seals an input-admission refusal like this: no send, no usage.
    const refused = beginRequestAttempt(1, "first", "model-a", "openai-chat");
    finishRequestAttempt(refused, 400, 1);
    const served = beginRequestAttempt(2, "second", "model-b", "openai-chat");
    noteAttemptSend(served, undefined);
    finishRequestAttempt(served, 200, 8, { inputTokens: 10, outputTokens: 2 });

    expect(refused.usageStatus).toBe("unreported");
    expect(aggregateAttemptUsage([refused, served])).toEqual({
      status: "reported",
      totalTokens: 12,
      usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 },
    });
    // A leg that was sent and reported nothing still leaves the total unknown.
    const sentSilent = beginRequestAttempt(1, "first", "model-a", "openai-chat");
    noteAttemptSend(sentSilent, undefined);
    finishRequestAttempt(sentSilent, 502, 1);
    expect(aggregateAttemptUsage([sentSilent, served]).status).toBe("unreported");
  });

  test("cache reads sum across attempts that report them under different fields", () => {
    // An Anthropic leg reports both fields; an OpenAI-shaped leg only cachedInputTokens.
    const anthropic = beginRequestAttempt(1, "anthropic", "model-a", "anthropic");
    noteAttemptSend(anthropic, undefined);
    finishRequestAttempt(anthropic, 502, 1, { inputTokens: 100, outputTokens: 0, cachedInputTokens: 60, cacheReadInputTokens: 60 });
    const openai = beginRequestAttempt(2, "openai", "model-b", "openai-chat");
    noteAttemptSend(openai, undefined);
    finishRequestAttempt(openai, 200, 1, { inputTokens: 100, outputTokens: 5, cachedInputTokens: 40 });

    expect(aggregateAttemptUsage([anthropic, openai]).usage).toMatchObject({
      cachedInputTokens: 100,
      cacheReadInputTokens: 100,
    });
  });
});
