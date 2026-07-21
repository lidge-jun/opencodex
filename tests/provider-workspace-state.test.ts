import { describe, expect, test } from "bun:test";
import {
  accountQuotaFromReport,
  filterModels,
  formatQuotaSourceLabel,
} from "../gui/src/provider-workspace/report";

describe("workspace detail derived states (WP090)", () => {
  describe("filterModels", () => {
    test("empty base with no default yields an empty list", () => {
      expect(filterModels([], undefined, "")).toEqual([]);
      expect(filterModels([], undefined, "gpt")).toEqual([]);
    });

    test("empty base falls back to the default model as a single row", () => {
      expect(filterModels([], "gpt-5.6-sol", "")).toEqual(["gpt-5.6-sol"]);
      expect(filterModels([], "gpt-5.6-sol", "sol")).toEqual(["gpt-5.6-sol"]);
      expect(filterModels([], "gpt-5.6-sol", "claude")).toEqual([]);
    });

    test("empty base falls back to configured models before the default model", () => {
      expect(filterModels([], "ignored-default", "", ["claude-sonnet-5", "claude-opus-4-8"]))
        .toEqual(["claude-sonnet-5", "claude-opus-4-8"]);
      expect(filterModels([], "ignored-default", "opus", ["claude-sonnet-5", "claude-opus-4-8"]))
        .toEqual(["claude-opus-4-8"]);
    });

    test("query filters case-insensitively on substrings; live models win over the fallback", () => {
      const base = ["gpt-5.6-sol", "gpt-5.6-terra", "claude-fable-5"];
      expect(filterModels(base, "ignored-fallback", "")).toEqual(base);
      expect(filterModels(base, undefined, "GPT")).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
      expect(filterModels(base, undefined, "fable")).toEqual(["claude-fable-5"]);
      expect(filterModels(base, undefined, "  sol  ")).toEqual(["gpt-5.6-sol"]);
      expect(filterModels(base, undefined, "nope")).toEqual([]);
    });
  });

  describe("accountQuotaFromReport (quota-unavailable paths)", () => {
    test("missing, malformed, and signal-free reports are null", () => {
      expect(accountQuotaFromReport(undefined)).toBeNull();
      expect(accountQuotaFromReport({})).toBeNull();
      expect(accountQuotaFromReport({ quota: null })).toBeNull();
      expect(accountQuotaFromReport({ quota: "junk" })).toBeNull();
      expect(accountQuotaFromReport({ quota: [] })).toBeNull();
      // An object with no numeric window at all carries no signal.
      expect(accountQuotaFromReport({ quota: { updatedAt: 5 } })).toBeNull();
      expect(accountQuotaFromReport({ quota: { weeklyPercent: "40" } })).toBeNull();
    });

    test("valid windows survive with numbers narrowed and junk custom rows dropped", () => {
      const quota = accountQuotaFromReport({
        updatedAt: 111,
        quota: {
          weeklyPercent: 40,
          weeklyResetAt: 999,
          monthlyPercent: "not-a-number",
          customWindows: [
            { label: "5h", percent: 10 },
            { label: 42, percent: 10 },
            { label: "broken", percent: "x" },
            "junk",
          ],
        },
      });
      expect(quota).toEqual({
        weeklyPercent: 40,
        weeklyResetAt: 999,
        customWindows: [{ label: "5h", percent: 10 }],
        updatedAt: 111,
      });
    });

    test("quota updatedAt wins over the report timestamp; report fills the gap", () => {
      expect(accountQuotaFromReport({ updatedAt: 1, quota: { monthlyPercent: 5, updatedAt: 2 } })?.updatedAt).toBe(2);
      expect(accountQuotaFromReport({ updatedAt: 1, quota: { monthlyPercent: 5 } })?.updatedAt).toBe(1);
    });
  });

  describe("formatQuotaSourceLabel (missing-usage metadata)", () => {
    test("empty and plain sources pass through; provider:path prettifies", () => {
      expect(formatQuotaSourceLabel(undefined)).toBe("");
      expect(formatQuotaSourceLabel("   ")).toBe("");
      expect(formatQuotaSourceLabel("anthropic")).toBe("anthropic");
      expect(formatQuotaSourceLabel("cursor:period-usage")).toBe("cursor · period usage");
      expect(formatQuotaSourceLabel("anthropic:oauth-usage")).toBe("anthropic · oauth usage");
    });
  });
});
