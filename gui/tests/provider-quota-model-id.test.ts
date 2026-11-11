import { buildQuotaSummary } from "../src/quota-summary";
import { quotaWindows } from "../src/pages/tray-data";
import { expect, test } from "bun:test";
import { accountQuotaFromReport } from "../src/provider-workspace/report";
import { buildQuotaRows, maxQuotaUtilisation } from "../src/components/QuotaBars";

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

test("diagnostic labels cannot suppress subscription credit urgency", () => {
  expect(maxQuotaUtilisation({
    updatedAt: 123,
    customWindows: [{ label: "Total subscription credits", modelId: "Total subscription credits", percent: 0 }],
    creditsUsd: { used: 90, limit: 100, remaining: 10, percent: 90 },
  })).toBe(90);
});


test("summary preserves model diagnostics without selecting them for headline or severity", () => {
  const quota = { updatedAt: 123, customWindows: [
    { label: "aux", modelId: "aux", percent: 100 },
    { label: "Gem", percent: 20 },
  ] };
  const windows = quotaWindows(quota);
  const rows = buildQuotaSummary({ google: { updatedAt: 123, quota } }, id => id);
  expect(rows[0]?.headline.label).toBe("Gem");
  expect(windows[0]).toMatchObject({ modelId: "aux", percent: 100 });
  expect(rows[0]?.severity).toBe("normal");
  expect(rows[0]?.windows[0]).toMatchObject({ modelId: "aux", percent: 100, severity: "normal" });
  expect(buildQuotaSummary({ google: { updatedAt: 123, quota: { ...quota, customWindows: [quota.customWindows[0]!] } } }, id => id)).toEqual([]);
});

test("quota bars have unique stable identities for repeated labels", () => {
  const customWindows = [
    { label: "same", modelId: "aux", percent: 10, resetAt: 123 },
    { label: "same", modelId: "aux", percent: 20, resetAt: 456 },
    { label: "same", modelId: "other", percent: 30 },
  ];
  const t = ((key: string) => key) as Parameters<typeof buildQuotaRows>[2];
  const rows = buildQuotaRows({ updatedAt: 123, customWindows }, null, t);
  expect(rows).toHaveLength(3);
  expect(new Set(rows.map(row => row.id)).size).toBe(3);
  const reversed = buildQuotaRows({ updatedAt: 123, customWindows: [...customWindows].reverse() }, null, t);
  expect(reversed.map(row => row.id)).toEqual(rows.map(row => row.id).reverse());
  const repeated = buildQuotaRows({ updatedAt: 123, customWindows: [...customWindows, customWindows[0]!] }, null, t);
  expect(new Set(repeated.map(row => row.id)).size).toBe(4);
  const refreshed = buildQuotaRows({ updatedAt: 456, customWindows: customWindows.map(row => ({ ...row, percent: 99 })) }, null, t);
  expect(refreshed.map(row => row.id)).toEqual(rows.map(row => row.id));
});
const inactiveFableReport = { updatedAt: 123, quota: { updatedAt: 123, fiveHourPercent: 35, weeklyPercent: 91,
  displayWindows: [{ label: "Fable", scope: "model", percent: 4, resetAt: 456, weeklyAllowancePercent: 50 }] } };

test("display-only rows stay out of customWindows and keep their weekly share", () => {
  const quota = accountQuotaFromReport({
    updatedAt: 123,
    quota: {
      updatedAt: 123,
      weeklyPercent: 69,
      customWindows: [{ label: "Opus", percent: 40, weeklyAllowancePercent: 60 }],
      displayWindows: [{ label: "Fable", percent: 0, resetAt: 456, weeklyAllowancePercent: 50 }, { label: "Opus", percent: 10 }],
    },
  });
  expect(quota?.customWindows).toEqual([{ label: "Opus", percent: 40, weeklyAllowancePercent: 60 }]);
  // A routed row with the same label comes from a later rate-limit observation, so it wins.
  expect(quota?.displayWindows).toEqual([{ label: "Fable", percent: 0, resetAt: 456, weeklyAllowancePercent: 50 }]);
  expect(accountQuotaFromReport({ quota: { updatedAt: 1, displayWindows: [{ label: "Fable", percent: 4 }] } })?.displayWindows)
    .toEqual([{ label: "Fable", percent: 4 }]);
});

test("a display-only row never becomes a summary headline, a summary or tray row, or urgency", () => {
  expect(buildQuotaSummary({ anthropic: { updatedAt: 123, quota: { updatedAt: 123, displayWindows: [{ label: "Fable", percent: 55 }] } } }, id => id))
    .toEqual([]);
  const report = { updatedAt: 123, quota: { updatedAt: 123, weeklyPercent: 20, displayWindows: [{ label: "Fable", percent: 95 }] } };
  const [row] = buildQuotaSummary({ anthropic: report }, id => id);
  expect(row?.headline.id).toBe("quota.weeklyLimit");
  expect(row?.severity).toBe("normal");
  expect(row?.windows.map(window => window.id)).toEqual(["quota.weeklyLimit"]);
  const projected = accountQuotaFromReport(report)!;
  expect(quotaWindows(projected).map(window => window.id)).toEqual(["quota.weeklyLimit"]);
  expect(maxQuotaUtilisation(projected)).toBe(20);
});

test("account bars list display-only Fable after routed rows, marked not in effect, with its weekly share", () => {
  const t = ((key: string) => key) as Parameters<typeof buildQuotaRows>[2];
  const rows = buildQuotaRows(accountQuotaFromReport(inactiveFableReport), null, t);
  expect(rows.map(row => [row.label, row.percent, row.resetAt, row.notInEffect === true, row.weeklyAllowancePercent])).toEqual([
    ["codexAuth.fiveHour", 35, undefined, false, undefined],
    ["codexAuth.weekly", 91, undefined, false, undefined],
    ["Fable", 4, 456, true, 50],
  ]);
  const routed = buildQuotaRows({ updatedAt: 1, customWindows: [{ label: "Fable", percent: 60, weeklyAllowancePercent: 50 }] }, null, t);
  expect(routed.map(row => [row.label, row.percent, row.notInEffect === true, row.weeklyAllowancePercent])).toEqual([["Fable", 60, false, 50]]);
});
