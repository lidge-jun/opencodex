import { describe, expect, test } from "bun:test";
import { beginInferenceAttempt } from "../../src/server/inference/attempt";
import type { RequestLogContext } from "../../src/server/request-log";

describe("beginInferenceAttempt", () => {
  test("opens the next ordinal as the active attempt and appends it to the request", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const first = beginInferenceAttempt(logCtx, { provider: "a", model: "m1", adapter: "openai-chat" });
    expect(first.attempt.ordinal).toBe(1);
    expect(logCtx.activeAttempt).toBe(first.attempt);
    expect(logCtx.activeAttemptStartedAt).toBe(first.startedAt);
    expect(logCtx.attempts).toEqual([first.attempt]);

    const second = beginInferenceAttempt(logCtx, { provider: "b", model: "m2", adapter: "openai-responses" });
    expect(second.attempt).toMatchObject({ ordinal: 2, provider: "b", model: "m2", adapter: "openai-responses" });
    expect(logCtx.activeAttempt).toBe(second.attempt);
    expect(logCtx.attempts).toEqual([first.attempt, second.attempt]);
  });

  test("seal stamps the target identity and only a Codex usage label", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const handle = beginInferenceAttempt(logCtx, { provider: "a", model: "m1", adapter: "openai-chat" });
    handle.attempt.adapter = "other";
    handle.seal(undefined);
    expect(handle.attempt.adapter).toBe("openai-chat");
    expect(handle.attempt.provider).toBe("a");
    expect(handle.attempt.accountLogLabel).toBeUndefined();
  });

  test("finish closes the row with status, a non-negative duration and the given usage", () => {
    const logCtx: RequestLogContext = { model: "m", provider: "p" };
    const handle = beginInferenceAttempt(logCtx, { provider: "a", model: "m1", adapter: "openai-chat" });
    const finished = handle.finish(502, { inputTokens: 3, outputTokens: 4 });
    expect(finished).toBe(handle.attempt);
    expect(handle.attempt.status).toBe(502);
    expect(handle.attempt.durationMs).toBeGreaterThanOrEqual(0);
    expect(handle.attempt.usage?.inputTokens).toBe(3);
    expect(handle.attempt.errorCode).toBeDefined();
  });
});
