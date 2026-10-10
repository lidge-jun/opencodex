import { describe, expect, test } from "bun:test";
import { comboRequestedEffortLabel } from "../../src/server/responses/combo-requested-effort";

describe("Combo requested effort labels", () => {
  test.each([
    ["high", "xhigh", "xhigh", "high->xhigh"],
    ["high", "low", "low", "high->low"],
    ["none", "high", "high", "none->high"],
    ["high", undefined, "xhigh", "high->xhigh"],
    ["high", "xhigh->medium", "xhigh", "high->xhigh->medium"],
    ["high", "xhigh->medium->low", "xhigh", "high->xhigh->medium->low"],
    ["high", "low->high", "low", "high->low->high"],
    ["high", "high", "high", "high"],
    ["high", "high->low", "high", "high->low"],
    ["high", "low->low", "low", "high->low"],
    ["high", "medium", undefined, "high"],
    ["high", undefined, undefined, "high"],
    ["high", "medium->low", undefined, "high->low"],
    ["high", "medium->low->none", null, "high->low->none"],
    ["high", undefined, null, "high"],
    [undefined, "xhigh", "xhigh", "xhigh"],
    [undefined, "xhigh->low", "xhigh", "xhigh->low"],
    [undefined, undefined, "xhigh", undefined],
  ] as const)("caller %s, child %s, forced %s produces %s", (original, child, forced, expected) => {
    expect(comboRequestedEffortLabel(original, child, forced)).toBe(expected);
  });
});
