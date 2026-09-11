import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { buildProviderPayload } from "../src/provider-payload";
import ZcodeUsageNotices from "../src/components/ZcodeUsageNotices";
import { LanguageProvider } from "../src/i18n/provider";
import { CAMPAIGN_END, CAMPAIGN_START, formatZcodeLocalTime, zcodeUsageSchedule, zcodeUsageScope } from "../src/zcode-usage-schedule";
const at = (value: string) => zcodeUsageSchedule(Date.parse(value + "+08:00"));

describe("ZCode official schedule advisories", () => {
  test("Desktop provider creation preserves local auth instead of requesting an API key", () => {
    expect(buildProviderPayload({ name: "zcode", adapter: "zcode", baseUrl: "https://zcode.z.ai", authMode: "local", apiKey: "", defaultModel: "" })).toEqual({ adapter: "zcode", baseUrl: "https://zcode.z.ai", authMode: "local" });
  });
  test("peak boundaries are half-open Singapore weekdays", () => {
    expect(at("2026-09-11T13:59:59").peak).toBe(false);
    expect(at("2026-09-11T14:00:00").peak).toBe(true);
    expect(at("2026-09-11T17:59:59").peak).toBe(true);
    expect(at("2026-09-11T18:00:00").peak).toBe(false);
    expect(at("2026-09-12T15:00:00").peak).toBe(false);
    expect(at("2026-09-13T15:00:00").peak).toBe(false);
    expect(at("2026-09-11T18:00:00").rateChangesAt).toBe(Date.parse("2026-09-14T14:00:00+08:00"));
  });
  test("daily Flash window crosses midnight and includes weekends", () => {
    expect(at("2026-09-11T22:59:59").flashActive).toBe(false);
    expect(at("2026-09-11T23:00:00").flashActive).toBe(true);
    expect(at("2026-09-12T08:59:59").flashActive).toBe(true);
    expect(at("2026-09-12T09:00:00").flashActive).toBe(false);
    expect(at("2026-09-12T09:00:00").flashStart).toBe(Date.parse("2026-09-12T23:00:00+08:00"));
  });
  test("campaign expires without extending the undocumented final night", () => {
    expect(zcodeUsageSchedule(CAMPAIGN_START - 1).campaign).toBe(false);
    expect(zcodeUsageSchedule(CAMPAIGN_START).campaign).toBe(true);
    expect(at("2026-09-20T23:30:00").flashEnd).toBe(CAMPAIGN_END);
    expect(zcodeUsageSchedule(CAMPAIGN_END - 1).flashActive).toBe(true);
    expect(zcodeUsageSchedule(CAMPAIGN_END).flashActive).toBe(false);
    expect(at("2027-09-11T23:30:00").campaign).toBe(false);
    expect(() => zcodeUsageSchedule(NaN)).toThrow();
  });
  test("local rendering converts date rollover and DST without changing eligibility", () => {
    const instant = Date.parse("2026-09-11T23:00:00+08:00");
    expect(formatZcodeLocalTime(instant, "en-GB", "America/Argentina/Buenos_Aires")).toContain("12:00");
    expect(formatZcodeLocalTime(instant, "en-GB", "America/Los_Angeles")).toContain("08:00");
    expect(formatZcodeLocalTime(Date.parse("2026-11-01T09:00:00Z"), "en-GB", "America/Los_Angeles")).toContain("01:00");
    expect(formatZcodeLocalTime(Date.parse("2026-09-11T09:00:00+08:00"), "en-GB", "America/Argentina/Buenos_Aires")).toContain("10 Sept");
  });
  test("never treats provider names, general API or lookalike endpoints as ZCode", () => {
    expect(zcodeUsageScope({ adapter: "zcode", baseUrl: "" })).toBe("zcode");
    expect(zcodeUsageScope({ adapter: "zcode", baseUrl: "", disabled: true })).toBeUndefined();
    expect(zcodeUsageScope({ adapter: "openai", baseUrl: "https://api.z.ai/api/coding/paas/v4" })).toBe("coding-plan");
    for (const baseUrl of ["https://api.z.ai/api/paas/v4", "https://api.z.ai.evil/api/coding/paas/v4", "http://api.z.ai/api/coding/paas/v4", "https://api.z.ai@evil/api/coding/paas/v4"])
      expect(zcodeUsageScope({ adapter: "openai", baseUrl })).toBeUndefined();
  });
  test("free window is conditional, not a verified balance or billing result", () => {
    const original = Date.now;
    Date.now = () => Date.parse("2026-09-11T23:30:00+08:00");
    try {
      const render = (viaZcode: boolean) => renderToStaticMarkup(createElement(LanguageProvider, null, createElement(ZcodeUsageNotices, { viaZcode })));
      expect(render(true)).toContain("free window active");
      expect(render(true)).toContain("Balance and eligibility are not verified");
      expect(render(false)).not.toContain("free window active");
      Date.now = () => CAMPAIGN_END;
      expect(render(true)).not.toContain("free window active");
      expect(render(true)).not.toContain("Next GLM-5.3-Flash free window");
    } finally { Date.now = original; }
  });
});
