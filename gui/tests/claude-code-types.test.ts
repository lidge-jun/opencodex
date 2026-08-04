import { expect, test } from "bun:test";
import { formatCompactWindow } from "../src/pages/claude-code-types";

test("formatCompactWindow uses k below 1M and exact millions at/above 1M", () => {
  expect(formatCompactWindow(350_000, "en")).toBe("350k");
  expect(formatCompactWindow(1_000_000, "en")).toBe("1M");
  expect(formatCompactWindow(2_000_000, "en")).toBe("2M");
  expect(formatCompactWindow(1_500_000, "en")).toBe("1.5M");
  // Off-ladder values that would round to a colliding "1M" keep a distinct k label.
  expect(formatCompactWindow(1_040_000, "en")).toBe("1040k");
});
