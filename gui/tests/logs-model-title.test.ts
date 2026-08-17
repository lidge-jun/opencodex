import { expect, test } from "bun:test";
import { modelTitle, type ModelTitleEntry } from "../src/pages/logs-model-title";

function entry(fields: Partial<ModelTitleEntry> = {}): ModelTitleEntry {
  return {
    model: "gpt-5.6-sol",
    ...fields,
  };
}

test("model diagnostics use one Unicode middle dot between fields", () => {
  expect(modelTitle(entry({
    resolvedModel: "gpt-5.6-sol",
    requestedServiceTier: "priority",
    configuredServiceTier: "fast",
    responseServiceTier: "default",
    modelSupportsServiceTier: true,
  }))).toBe(
    "model=gpt-5.6-sol · resolved=gpt-5.6-sol · requestedTier=priority · configuredTier=fast · responseTier=default · supportsTier=true",
  );
});

test("model diagnostics do not include an extra Latin capital A with circumflex", () => {
  expect(modelTitle(entry({ resolvedModel: "gpt-5.6-sol" }))).not.toContain("\u00C2");
});
