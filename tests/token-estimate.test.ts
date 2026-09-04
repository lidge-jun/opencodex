import { describe, expect, test } from "bun:test";
import { capEstimateAtContextWindow, charsPerToken, estimateTokens } from "../src/lib/token-estimate";

describe("script-segmented ratio", () => {
  const korean = "한국어 텍스트는 토큰 밀도가 높아서 영어 기준 추정이 과소계산됩니다 ".repeat(10);
  const english = "English text estimates fine at the default four chars per token ratio ".repeat(10);
  const cjkOf = (s: string) => [...s].filter(c => /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F\u4E00-\u9FFF\u3400-\u4DBF\u3040-\u30FF]/.test(c)).length;
  const expected = (s: string, latin: number) => {
    const cjk = cjkOf(s);
    return Math.ceil((s.length - cjk) / latin + cjk / 1.5);
  };

  test("CJK characters are counted at their own denser ratio, not the model ratio", () => {
    expect(estimateTokens(korean, "gpt-5.6-sol")).toBe(expected(korean, 4));
    expect(estimateTokens(korean, "claude-sonnet-4-6")).toBe(expected(korean, 2.8));
  });

  test("pure-Latin text uses the model ratio alone", () => {
    expect(estimateTokens(english, "gpt-5.6-sol")).toBe(Math.ceil(english.length / 4));
    expect(estimateTokens(english, "claude-sonnet-4-6")).toBe(Math.ceil(english.length / 2.8));
  });

  test("Korean costs about twice a Latin character", () => {
    const ko = "한".repeat(300);
    const en = "a".repeat(300);
    const ratio = estimateTokens(ko, "claude-sonnet-4-6") / estimateTokens(en, "claude-sonnet-4-6");
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(2.5);
  });

  // The previous model switched divisor at a 30% sampled CJK share, so a blob at 29% and one at
  // 31% differed by ~40% in estimate. Real agent traffic sits inside that band, which is exactly
  // where the cliff never fired and the undercount was worst.
  test("no cliff: the estimate is continuous across the old 30% threshold", () => {
    const at = (share: number) => {
      const total = 2000;
      const cjk = Math.round(total * share);
      return estimateTokens("한".repeat(cjk) + "a".repeat(total - cjk), "claude-sonnet-4-6");
    };
    const below = at(0.29);
    const above = at(0.31);
    // A 2-point change in composition must move the estimate by only a few percent.
    expect(Math.abs(above - below) / below).toBeLessThan(0.05);
    // ...and it must still be monotonically increasing in CJK share.
    expect(above).toBeGreaterThan(below);
  });

  // Regression for the sampling bug documented in server/responses/input-admission.ts: the old
  // stride sampler could read a 1.6%-CJK payload as 100% CJK. An exact count cannot.
  test("a mostly-Latin blob with periodic CJK is not counted as CJK-heavy", () => {
    const record = "id=0001,name=widget,qty=12,note=".padEnd(63, "x") + "한";
    const blob = record.repeat(400);
    const cjk = cjkOf(blob);
    expect(cjk / blob.length).toBeLessThan(0.02);
    expect(estimateTokens(blob, "claude-sonnet-4-6")).toBe(expected(blob, 2.8));
  });
});

describe("token-estimate sidecar", () => {
  test("empty string is 0 tokens", () => {
    expect(estimateTokens("", "claude-opus-4.8")).toBe(0);
  });

  test("kiro text models use the 2.8 Latin ratio", () => {
    for (const m of ["kiro-auto", "claude-opus-4.8", "claude-opus-4.5", "deepseek-3.2", "minimax-m2.5", "minimax-m2.1", "glm-5", "qwen3-coder-next"]) {
      expect(charsPerToken(m)).toBe(2.8);
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

  test("estimate scales with length (ceil(len/2.8))", () => {
    // 28 chars / 2.8 = 10 tokens
    expect(estimateTokens("x".repeat(28), "claude-opus-4.8")).toBe(10);
    // 29 chars / 2.8 = 10.36 -> ceil 11
    expect(estimateTokens("x".repeat(29), "claude-opus-4.8")).toBe(11);
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

describe("context-window cap (codex-router PR #140)", () => {
  const GPT56_SOL_WINDOW = 272_000;
  const DEEPSEEK_WINDOW = 128_000;
  // gpt-5.6-sol uses the generic 4-char ratio: 1.2M chars ~= 300k tokens, far over 272k.
  const OVER_WINDOW_TEXT = "x".repeat(1_200_000);

  test("estimate is capped at the model's context window", () => {
    expect(estimateTokens(OVER_WINDOW_TEXT, "gpt-5.6-sol", GPT56_SOL_WINDOW)).toBe(GPT56_SOL_WINDOW);
    expect(estimateTokens(OVER_WINDOW_TEXT, "gpt-5.6-sol", DEEPSEEK_WINDOW)).toBe(DEEPSEEK_WINDOW);
  });

  test("below-window estimates are unchanged", () => {
    const text = "x".repeat(100_000); // ~28.5k tokens at the kiro ratio
    const plain = estimateTokens(text, "gpt-5.6-sol");
    expect(plain).toBeLessThan(GPT56_SOL_WINDOW);
    expect(estimateTokens(text, "gpt-5.6-sol", GPT56_SOL_WINDOW)).toBe(plain);
  });

  test("only a positive integer window caps (unknown window leaves the estimate untouched)", () => {
    const text = "x".repeat(100_000);
    const plain = estimateTokens(text, "gpt-5.6-sol");
    for (const window of [undefined, 0, -1, 1.5, Number.NaN]) {
      expect(estimateTokens(text, "gpt-5.6-sol", window)).toBe(plain);
    }
  });

  test("the min-1 floor survives the cap for tiny inputs", () => {
    expect(estimateTokens("a", "claude-opus-4.8", 1)).toBe(1);
    expect(estimateTokens("a", "claude-opus-4.8", GPT56_SOL_WINDOW)).toBe(1);
  });

  test("capEstimateAtContextWindow caps only at positive integer windows", () => {
    expect(capEstimateAtContextWindow(300_000, GPT56_SOL_WINDOW)).toBe(GPT56_SOL_WINDOW);
    expect(capEstimateAtContextWindow(100_000, GPT56_SOL_WINDOW)).toBe(100_000);
    expect(capEstimateAtContextWindow(300_000, undefined)).toBe(300_000);
    expect(capEstimateAtContextWindow(300_000, 0)).toBe(300_000);
  });
});
