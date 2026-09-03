import { expect, test } from "bun:test";
import { modelPickerOrder, modelPickerOrderMode } from "../src/model-picker-order";

const models = ["zeta/beta", "alpha/zeta", "alpha/alpha"];

test("orders routed picker models by model id or provider", () => {
  expect(modelPickerOrder("alphabetical", models)).toEqual(["alpha/alpha", "zeta/beta", "alpha/zeta"]);
  expect(modelPickerOrder("provider", models)).toEqual(["alpha/alpha", "alpha/zeta", "zeta/beta"]);
});

test("orders most-used models with a deterministic provider fallback", () => {
  expect(modelPickerOrder("most-used", models, [
    { provider: "alpha", model: "zeta", requests: 8 },
    { provider: "zeta", model: "beta", requests: 8 },
  ])).toEqual(["alpha/zeta", "zeta/beta", "alpha/alpha"]);
});

test("counts a resolved fallback only when the requested model is not in the picker", () => {
  expect(modelPickerOrder("most-used", models, [
    { provider: "alpha", model: "zeta", resolvedModel: "alpha", requests: 8 },
    { provider: "zeta", model: "unavailable", resolvedModel: "beta", requests: 3 },
  ])).toEqual(["alpha/zeta", "zeta/beta", "alpha/alpha"]);
});

test("recognizes default and deterministic saved order", () => {
  expect(modelPickerOrderMode(models, [])).toBe("default");
  expect(modelPickerOrderMode(models, ["alpha/alpha", "alpha/zeta", "zeta/beta"])).toBe("provider");
  expect(modelPickerOrderMode(models, ["zeta/beta", "alpha/alpha", "alpha/zeta"])).toBe("custom");
});
