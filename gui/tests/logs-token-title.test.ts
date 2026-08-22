import { expect, test } from "bun:test";
import type { TFn } from "../src/i18n/shared";
import { tokensTitle } from "../src/pages/logs-token-title";

const labels: Record<string, string> = {
  "logs.tokens.input": "输入",
  "logs.tokens.output": "输出",
  "logs.tokens.cacheRead": "缓存命中 (c)",
  "logs.tokens.cacheWrite": "缓存写入 (w)",
  "logs.tokens.reasoning": "推理",
};

const t = ((key: string) => labels[key] ?? key) as TFn;

test("token diagnostics use one Unicode middle dot between localized fields", () => {
  expect(tokensTitle({
    provider: "openai",
    usage: {
      inputTokens: 59_375,
      outputTokens: 553,
      cacheReadInputTokens: 54_272,
      cacheCreationInputTokens: 0,
      reasoningOutputTokens: 237,
    },
  }, t)).toBe(
    "输入=59375 · 输出=553 · 缓存命中 (c)=54272 · 缓存写入 (w)=0 · 推理=237",
  );
});

test("token diagnostics do not include an extra Latin capital A with circumflex", () => {
  expect(tokensTitle({
    provider: "openai",
    usage: { inputTokens: 1, outputTokens: 2 },
  }, t)).not.toContain("\u00C2");
});
