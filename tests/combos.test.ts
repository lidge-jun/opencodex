import { describe, expect, test } from "bun:test";
import {
  comboModelId,
  isValidComboId,
  parseComboModelId,
  targetKey,
} from "../src/combos";

describe("combo namespace primitives", () => {
  test("parses and formats combo model ids", () => {
    expect(parseComboModelId("combo/free")).toBe("free");
    expect(parseComboModelId("combo/  free  ")).toBe("free");
    expect(parseComboModelId("combo/")).toBeNull();
    expect(parseComboModelId("nvidia/free")).toBeNull();
    expect(comboModelId("free")).toBe("combo/free");
  });

  test("checks source combo ids and target keys", () => {
    expect(isValidComboId("free.v1_2-x")).toBe(true);
    expect(isValidComboId("-free")).toBe(false);
    expect(targetKey({ provider: "a", model: "m1" })).toBe("a/m1");
  });
});
