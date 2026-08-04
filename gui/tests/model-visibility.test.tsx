import { expect, test } from "bun:test";
import { modelVisible, parseSelectedModels, shouldApplyLoadGeneration } from "../src/model-visibility";

test("final visibility helpers normalize selections and stale generations", () => {
  expect([modelVisible({ proxy: ["a"] }, "proxy", "a", false, false), modelVisible({ proxy: ["a"] }, "proxy", "b", false, false), modelVisible({ openai: ["other"] }, "openai", "gpt-5.6-sol", true, true)]).toEqual([true, false, false]);
  expect(parseSelectedModels({ selected: { proxy: ["a", "a", "b"] } })).toEqual({ proxy: ["a", "b"] });
  expect(() => parseSelectedModels({ selected: { proxy: "a" } })).toThrow();
  expect(shouldApplyLoadGeneration(4, 5)).toBe(false);
});
