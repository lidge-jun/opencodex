import { expect, test } from "bun:test";
import { accountQuotaFromReport } from "../src/provider-workspace/report";
import { maxQuotaUtilisation } from "../src/components/QuotaBars";

test("provider quota projection preserves bounded exact Antigravity model IDs", () => {
  expect(accountQuotaFromReport({
    updatedAt: 123,
    quota: {
      updatedAt: 123,
      customWindows: [
        { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 24 },
        { label: "legacy", modelId: "x".repeat(129), percent: 12 },
      ],
    },
  })?.customWindows).toEqual([
    { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 24 },
    { label: "legacy", percent: 12 },
  ]);
});

test("model diagnostic bars do not change provider urgency sorting", () => {
  expect(maxQuotaUtilisation({
    updatedAt: 123,
    customWindows: [
      { label: "Gem", percent: 36 },
      { label: "gemini-3.8-flash-high", modelId: "gemini-3.8-flash-high", percent: 100 },
    ],
  })).toBe(36);
});
