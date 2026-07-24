import { describe, expect, test } from "bun:test";
import { charsPerToken, estimateTokens } from "../src/lib/token-estimate";

describe("CJK-aware ratio (devlog 260712 B3)", () => {
  const korean = "한국어 텍스트는 토큰 밀도가 높아서 영어 기준 추정이 과소계산됩니다 ".repeat(10);
  const english = "English text estimates fine at the default four chars per token ratio ".repeat(10);

  test("CJK-heavy text clamps DOWN to 2.5 chars/token (more tokens than English ratio)", () => {
    expect(estimateTokens(korean, "gpt-5.6-sol")).toBe(Math.ceil(korean.length / 2.5));
  });

  test("Claude-shaped models clamp min(3.5, 2.5) -> 2.5 for CJK; keep 3.5 for English (audit R2#7)", () => {
    expect(estimateTokens(korean, "claude-sonnet-4-6")).toBe(Math.ceil(korean.length / 2.5));
    expect(estimateTokens(english, "claude-sonnet-4-6")).toBe(Math.ceil(english.length / 3.5));
  });

  test("English text keeps the model ratio (no CJK trigger)", () => {
    expect(estimateTokens(english, "gpt-5.6-sol")).toBe(Math.ceil(english.length / 4));
  });
});

describe("token-estimate sidecar", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("", "claude-opus-4.8")).toBe(0);
  });

  test("kiro text models use the 3.5 ratio", () => {
    for (const m of ["kiro-auto", "claude-opus-4.8", "claude-opus-4.5", "deepseek-3.2", "minimax-m2.5", "minimax-m2.1", "glm-5", "qwen3-coder-next", "grok-4.5", "xai/grok-4.5"]) {
      expect(charsPerToken(m)).toBe(3.5);
    }
  });

  test("unknown / undefined model falls back to 4 chars/token", () => {
    expect(charsPerToken(undefined)).toBe(4);
    expect(charsPerToken("gpt-5")).toBe(4);
  });

  test("ceil + min-1: any non-empty text is at least 1 token", () => {
    expect(estimateTokens("a", "claude-opus-4.8")).toBe(1);
    expect(estimateTokens("ab", "claude-opus-4.8")).toBe(1);
  });

  test("estimate scales with length (ceil(len/3.5))", () => {
    // 35 chars / 3.5 = 10 tokens
    expect(estimateTokens("x".repeat(35), "claude-opus-4.8")).toBe(10);
    // 36 chars / 3.5 = 10.28 -> ceil 11
    expect(estimateTokens("x".repeat(36), "claude-opus-4.8")).toBe(11);
  });

  test("lower ratio (kiro) yields more tokens than generic for same text (fail-safe over-count)", () => {
    const text = "x".repeat(400);
    expect(estimateTokens(text, "claude-opus-4.8")).toBeGreaterThan(estimateTokens(text, "gpt-5"));
  });

  test("monotonic: longer text never estimates fewer tokens", () => {
    let prev = 0;
    for (const n of [0, 1, 10, 100, 1000]) {
      const t = estimateTokens("x".repeat(n), "claude-opus-4.8");
      expect(t).toBeGreaterThanOrEqual(prev);
      prev = t;
    }
  });
});
