import { expect, test } from "bun:test";
import {
  mergeSidecarSetting,
  parsePositiveInteger,
  parseVisionTimeoutMs,
  visionEnabledPatch,
  visionMaxDescriptionsPatch,
  visionReasoningPatch,
  visionTimeoutPatch,
  VISION_MAX_DESCRIPTIONS_DEFAULT,
  VISION_TIMEOUT_MS_DEFAULT,
  VISION_TIMEOUT_MS_MAX,
  VISION_TIMEOUT_MS_MIN,
  type SidecarSetting,
} from "../src/pages/dashboard-shared";

const current: SidecarSetting = {
  model: "gpt-5.6-luna",
  backend: "openai",
  reasoning: "medium",
  enabled: true,
  maxDescriptionsPerTurn: 8,
  timeoutMs: 45_000,
};

test("vision control patches send only the edited field", () => {
  expect(visionEnabledPatch(false)).toEqual({ vision: { enabled: false } });
  expect(visionMaxDescriptionsPatch(4)).toEqual({ vision: { maxDescriptionsPerTurn: 4 } });
  expect(visionTimeoutPatch(12_000)).toEqual({ vision: { timeoutMs: 12_000 } });
  expect(visionReasoningPatch("high")).toEqual({ vision: { reasoning: "high" } });
});

test("partial merges keep model, backend, reasoning, timeout, and limit", () => {
  expect(mergeSidecarSetting(current, { enabled: false })).toEqual({ ...current, enabled: false });
  expect(mergeSidecarSetting({ ...current, enabled: false }, { enabled: true })).toEqual(current);
  expect(mergeSidecarSetting(current, { maxDescriptionsPerTurn: 3 })).toEqual({
    ...current,
    maxDescriptionsPerTurn: 3,
  });
  expect(mergeSidecarSetting(current, { timeoutMs: 12_000 })).toEqual({ ...current, timeoutMs: 12_000 });
  expect(mergeSidecarSetting(current, { reasoning: "high" })).toEqual({ ...current, reasoning: "high" });
  expect(mergeSidecarSetting(current, { streamRoutedModelOutput: true })).toEqual({
    ...current,
    streamRoutedModelOutput: true,
  });
});

test("timeout and description parsers reject invalid and out-of-range input", () => {
  expect(parsePositiveInteger("8")).toBe(8);
  expect(parsePositiveInteger(String(VISION_MAX_DESCRIPTIONS_DEFAULT))).toBe(8);
  expect(parsePositiveInteger("0")).toBeUndefined();
  expect(parsePositiveInteger("-1")).toBeUndefined();
  expect(parsePositiveInteger("1.5")).toBeUndefined();
  expect(parsePositiveInteger("")).toBeUndefined();
  expect(parsePositiveInteger("8abc")).toBeUndefined();

  expect(parseVisionTimeoutMs(String(VISION_TIMEOUT_MS_DEFAULT))).toBe(45_000);
  expect(parseVisionTimeoutMs(String(VISION_TIMEOUT_MS_MIN))).toBe(VISION_TIMEOUT_MS_MIN);
  expect(parseVisionTimeoutMs(String(VISION_TIMEOUT_MS_MAX))).toBe(VISION_TIMEOUT_MS_MAX);
  expect(parseVisionTimeoutMs("0")).toBeUndefined();
  expect(parseVisionTimeoutMs("45000.2")).toBeUndefined();
  expect(parseVisionTimeoutMs(String(VISION_TIMEOUT_MS_MAX + 1))).toBeUndefined();
});
