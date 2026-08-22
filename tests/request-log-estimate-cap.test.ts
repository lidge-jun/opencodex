import { describe, expect, test } from "bun:test";
import {
  beginRequestAttempt,
  finishRequestAttempt,
  noteAttemptSend,
} from "../src/server/request-log";

/**
 * The token-estimate context-window cap (codex-router PR #140) in the request log:
 * the ESTIMATE field is bounded by the routed model's context window, while the combined
 * inputTokens field keeps its max(reported, estimate) behavior. Provider-reported positive
 * counts are never reduced by the cap.
 */
describe("request log token-estimate context-window cap (codex-router PR #140)", () => {
  const DEEPSEEK_WINDOW = 128_000; // KIRO_MODEL_CONTEXT_WINDOWS["deepseek-3.2"]
  const CURSOR_CLAUDE_WINDOW = 200_000; // inferCursorContextWindow("claude-4.6-opus-high")

  test("the estimate is capped at the kiro model's context window", () => {
    const attempt = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(attempt, 200_000);
    finishRequestAttempt(attempt, 200, 10);
    expect(attempt.inputTokenEstimate).toBe(DEEPSEEK_WINDOW);
    expect(attempt.usage).toEqual({ inputTokens: DEEPSEEK_WINDOW, outputTokens: 0, estimated: true });
  });

  test("below-window estimates pass through unchanged", () => {
    const attempt = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(attempt, 100_000);
    finishRequestAttempt(attempt, 200, 10);
    expect(attempt.inputTokenEstimate).toBe(100_000);
    expect(attempt.usage?.inputTokens).toBe(100_000);
  });

  test("capping adapter-estimated input recomputes an explicit total", () => {
    const attempt = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    finishRequestAttempt(attempt, 200, 10, {
      inputTokens: 200_000,
      outputTokens: 4,
      totalTokens: 200_004,
      estimated: true,
    });
    expect(attempt.usage).toEqual({
      inputTokens: DEEPSEEK_WINDOW,
      outputTokens: 4,
      totalTokens: DEEPSEEK_WINDOW + 4,
      estimated: true,
    });
    expect(attempt.totalTokens).toBe(DEEPSEEK_WINDOW + 4);
  });

  test("combining a local estimate recomputes the nested and outer totals", () => {
    const attempt = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(attempt, 200_000);
    finishRequestAttempt(attempt, 200, 10, {
      inputTokens: 50,
      outputTokens: 4,
      totalTokens: 54,
    });
    expect(attempt.usage).toEqual({
      inputTokens: DEEPSEEK_WINDOW,
      outputTokens: 4,
      totalTokens: DEEPSEEK_WINDOW + 4,
      estimated: true,
    });
    expect(attempt.totalTokens).toBe(DEEPSEEK_WINDOW + 4);
  });

  test("caps an estimated Cursor checkpoint without double-adding output", () => {
    const attempt = beginRequestAttempt(1, "cursor", "claude-4.6-opus-high", "cursor");
    finishRequestAttempt(attempt, 200, 10, {
      inputTokens: 499_994,
      outputTokens: 6,
      totalTokens: 500_000,
      estimated: true,
    });
    expect(attempt.usage).toEqual({
      inputTokens: CURSOR_CLAUDE_WINDOW,
      outputTokens: 6,
      totalTokens: CURSOR_CLAUDE_WINDOW + 6,
      estimated: true,
    });
    expect(attempt.totalTokens).toBe(CURSOR_CLAUDE_WINDOW + 6);
  });

  test("a positive provider-reported input count is never reduced by the cap", () => {
    const attempt = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(attempt, 200_000); // estimate would exceed the window
    finishRequestAttempt(attempt, 200, 10, { inputTokens: 150_000, outputTokens: 500 });
    // combined = max(reported 150k, capped estimate 128k) = 150k: the reported count wins.
    expect(attempt.usage?.inputTokens).toBe(150_000);
  });

  test("a missing report substitutes the capped estimate (the ESTIMATE field)", () => {
    const attempt = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(attempt, 200_000);
    finishRequestAttempt(attempt, 200, 10);
    // No usage at all: the fallback inputTokens IS the capped estimate — never above the window.
    expect(attempt.usage?.inputTokens).toBe(DEEPSEEK_WINDOW);
    expect(attempt.usage?.estimated).toBe(true);
    expect(attempt.usageStatus).toBe("estimated");
  });

  test("the ESTIMATE field vs the combined inputTokens field distinction is preserved", () => {
    // Reported zero: combined max(0, capped estimate) equals the capped estimate.
    const zero = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(zero, 200_000);
    finishRequestAttempt(zero, 200, 10, { inputTokens: 0, outputTokens: 5 });
    expect(zero.usage?.inputTokens).toBe(DEEPSEEK_WINDOW);

    // Reported positive above the capped estimate: combined keeps the reported count.
    const positive = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(positive, 200_000);
    finishRequestAttempt(positive, 200, 10, { inputTokens: 200_000, outputTokens: 5 });
    expect(positive.usage?.inputTokens).toBe(200_000);

    // Reported positive below the capped estimate: combined takes the capped estimate.
    const middle = beginRequestAttempt(1, "kiro", "deepseek-3.2", "kiro");
    noteAttemptSend(middle, 100_000);
    finishRequestAttempt(middle, 200, 10, { inputTokens: 50_000, outputTokens: 5 });
    expect(middle.usage?.inputTokens).toBe(100_000);
  });

  test("cursor adapter uses the cursor window inference", () => {
    const attempt = beginRequestAttempt(1, "cursor", "claude-4.6-opus-high", "cursor");
    noteAttemptSend(attempt, 500_000);
    finishRequestAttempt(attempt, 200, 10);
    expect(attempt.inputTokenEstimate).toBe(CURSOR_CLAUDE_WINDOW);
  });

  test("unknown adapters stay uncapped (a window is never invented)", () => {
    const attempt = beginRequestAttempt(1, "anthropic", "claude-sonnet-4-6", "anthropic");
    noteAttemptSend(attempt, 500_000);
    finishRequestAttempt(attempt, 200, 10);
    expect(attempt.inputTokenEstimate).toBe(500_000);
  });

  test("without a window the existing max(reported, estimate) behavior is unchanged", () => {
    const attempt = beginRequestAttempt(1, "anthropic", "claude-sonnet-4-6", "anthropic");
    noteAttemptSend(attempt, 500_000);
    finishRequestAttempt(attempt, 200, 10, { inputTokens: 100_000, outputTokens: 5 });
    expect(attempt.usage?.inputTokens).toBe(500_000);
  });

  test("kiro auto has no fixed window and is never guessed", () => {
    const attempt = beginRequestAttempt(1, "kiro", "kiro-auto", "kiro");
    noteAttemptSend(attempt, 500_000);
    finishRequestAttempt(attempt, 200, 10);
    expect(attempt.inputTokenEstimate).toBe(500_000);
  });
});
