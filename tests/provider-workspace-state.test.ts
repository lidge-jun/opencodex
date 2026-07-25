import { describe, expect, test } from "bun:test";
import {
  accountQuotaFromReport,
  filterModels,
  formatQuotaSourceLabel,
} from "../gui/src/provider-workspace/report";

describe("workspace detail derived states (WP090)", () => {
  describe("filterModels", () => {
    test("empty base with no default yields an empty list", () => {
      expect(filterModels([], undefined, "", undefined, [], false)).toEqual([]);
      expect(filterModels([], undefined, "gpt", undefined, [], false)).toEqual([]);
    });

    test("empty base falls back to the default model as a single row", () => {
      expect(filterModels([], "gpt-5.6-sol", "", undefined, [], false)).toEqual(["gpt-5.6-sol"]);
      expect(filterModels([], "gpt-5.6-sol", "sol", undefined, [], false)).toEqual(["gpt-5.6-sol"]);
      expect(filterModels([], "gpt-5.6-sol", "claude", undefined, [], false)).toEqual([]);
    });

    test("empty base falls back to configured models before the default model", () => {
      expect(filterModels([], "ignored-default", "", ["claude-sonnet-5", "claude-opus-4-8"], [], false))
        .toEqual(["claude-sonnet-5", "claude-opus-4-8"]);
      expect(filterModels([], "ignored-default", "opus", ["claude-sonnet-5", "claude-opus-4-8"], [], false))
        .toEqual(["claude-opus-4-8"]);
    });

    test("query filters case-insensitively on substrings; live models win over the fallback", () => {
      const base = ["gpt-5.6-sol", "gpt-5.6-terra", "claude-fable-5"];
      expect(filterModels(base, "ignored-fallback", "", undefined, [], true)).toEqual(base);
      expect(filterModels(base, undefined, "GPT", undefined, [], true)).toEqual(["gpt-5.6-sol", "gpt-5.6-terra"]);
      expect(filterModels(base, undefined, "fable", undefined, [], true)).toEqual(["claude-fable-5"]);
      expect(filterModels(base, undefined, "  sol  ", undefined, [], true)).toEqual(["gpt-5.6-sol"]);
      expect(filterModels(base, undefined, "nope", undefined, [], true)).toEqual([]);
    });

    test("custom-only catalog rows do not suppress configured fallback models", () => {
      // No live rows: the configured fallback stays authoritative and the custom row is appended.
      expect(filterModels(
        ["claude-opus-5.1-custom"],
        "ignored-default",
        "",
        ["claude-opus-5"],
        ["claude-opus-5.1-custom"],
        false,
      )).toEqual(["claude-opus-5", "claude-opus-5.1-custom"]);
      expect(filterModels(
        ["live-model", "claude-opus-5.1-custom"],
        "ignored-default",
        "",
        ["configured-fallback"],
        ["claude-opus-5.1-custom"],
        true,
      )).toEqual(["live-model", "claude-opus-5.1-custom"]);
    });

    test("a custom id that also appears in live discovery keeps the live catalog authoritative", () => {
      // The provenance regression: subtracting custom ids from `base` used to leave nothing, so an
      // overlapping id made a real live catalog look custom-only and wrongly resurrected the
      // configured fallback. The server-reported flag settles it instead.
      expect(filterModels(
        ["overlap-model"],
        "ignored-default",
        "",
        ["configured-fallback"],
        ["overlap-model"],
        true,
      )).toEqual(["overlap-model"]);
      // Same inputs, but discovery genuinely returned nothing: the fallback must come back.
      expect(filterModels(
        ["overlap-model"],
        "ignored-default",
        "",
        ["configured-fallback"],
        ["overlap-model"],
        false,
      )).toEqual(["configured-fallback", "overlap-model"]);
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
