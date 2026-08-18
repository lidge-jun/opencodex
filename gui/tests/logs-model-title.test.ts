import { expect, test } from "bun:test";
import type { TFn, TKey } from "../src/i18n/shared";
import { modelTitle, type ModelTitleEntry } from "../src/pages/logs-model-title";

const labels: Partial<Record<TKey, string>> = {
  "logs.modelTooltip.model": "模型",
  "logs.modelTooltip.resolvedModel": "解析后模型",
  "logs.modelTooltip.requestedTier": "请求层级",
  "logs.modelTooltip.configuredTier": "配置层级",
  "logs.modelTooltip.responseTier": "响应层级",
  "logs.modelTooltip.supportsTier": "支持层级",
};

const t: TFn = key => labels[key] ?? key;

function entry(fields: Partial<ModelTitleEntry> = {}): ModelTitleEntry {
  return {
    model: "gpt-5.6-sol",
    ...fields,
  };
}

test("model diagnostics localize every label and use one Unicode middle dot between fields", () => {
  expect(modelTitle(entry({
    resolvedModel: "gpt-5.6-sol",
    requestedServiceTier: "priority",
    configuredServiceTier: "fast",
    responseServiceTier: "default",
    modelSupportsServiceTier: true,
  }), t)).toBe(
    "模型=gpt-5.6-sol · 解析后模型=gpt-5.6-sol · 请求层级=priority · 配置层级=fast · 响应层级=default · 支持层级=true",
  );
});

test("model diagnostics do not include an extra Latin capital A with circumflex", () => {
  expect(modelTitle(entry({ resolvedModel: "gpt-5.6-sol" }), t)).not.toContain("\u00C2");
});
