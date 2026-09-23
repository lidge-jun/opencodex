import { expect, test } from "bun:test";
import type { TFn, TKey } from "../src/i18n/shared";
import { modelTitle, type ModelTitleEntry } from "../src/pages/logs-model-title";

const labels: Partial<Record<TKey, string>> = {
  "logs.modelTooltip.model": "模型",
  "logs.modelTooltip.resolvedModel": "解析后模型",
  "logs.modelTooltip.servedModel": "实际服务模型",
  "logs.modelTooltip.wireModel": "线上模型",
  "logs.modelRerouteTitle": "上游提供的模型与发送的模型不同",
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

test("model diagnostics surface the upstream-served model when it differs from the wire model", () => {
  expect(modelTitle(entry({ model: "client-model", resolvedModel: "resolved-model", wireModel: "wire-model", servedModel: "served-model" }), t)).toBe(
    "上游提供的模型与发送的模型不同 · 模型=client-model · 解析后模型=resolved-model · 实际服务模型=served-model · 线上模型=wire-model",
  );
  expect(modelTitle(entry({ model: "client-model", servedModel: "served-model" }), t)).toBe(
    "上游提供的模型与发送的模型不同 · 模型=client-model · 实际服务模型=served-model",
  );
});

test("model diagnostics omit the reroute notice when served and wire models match", () => {
  expect(modelTitle(entry({ model: "client-model", wireModel: "wire-model", servedModel: "wire-model" }), t)).toBe(
    "模型=client-model · 实际服务模型=wire-model · 线上模型=wire-model",
  );
});
