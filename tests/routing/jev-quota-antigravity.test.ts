import { afterEach, beforeEach, expect, test } from "bun:test";
import { activateJevQuotaEvidence, deactivateJevQuotaEvidence } from "../helpers/jev-quota-activation";
import { jevQuotaSignalForTarget } from "../../src/combos/jev-quota";
import { keyReport, publishCollectedDecisionQuota } from "../../src/providers/quota/report-cache";
import { antigravityDecisionWindows } from "../../src/providers/quota-decision-publication";
import { invalidateDecisionKeyQuotas, publishDecisionKeyQuota, readLoadedDecisionKeyQuota } from "../../src/providers/quota-decision-snapshot";
import { createTempHome, type TempHome } from "../helpers/temp-home";
import type { OcxConfig } from "../../src/types";

const now = 2_000_000_000_000;
const reset = now + 3_600_000;
/** Shape produced by parseAntigravityQuotaSummary: family counters plus display-only per-model rows. */
const quota = {
  updatedAt: now,
  customWindows: [
    { label: "Gem", percent: 36, resetAt: reset },
    { label: "Gem (Weekly)", percent: 22, resetAt: reset },
    { label: "Cla", percent: 0, resetAt: reset },
    { label: "Cla (Weekly)", percent: 100, resetAt: reset },
    { label: "gemini-3.8-flash · tier", modelId: "gemini-3.8-flash", percent: 99 },
    { label: "Argon", modelId: "argon", percent: 95 },
  ],
};
let home: TempHome;
let config: OcxConfig;
beforeEach(() => {
  home = createTempHome("ocx-jq-ag-"); activateJevQuotaEvidence(); invalidateDecisionKeyQuotas();
  config = { port: 0, defaultProvider: "google-antigravity", providers: { "google-antigravity": { adapter: "google-antigravity", baseUrl: "https://daily-cloudcode-pa.googleapis.com", authMode: "oauth" } } };
});
afterEach(() => { deactivateJevQuotaEvidence(); invalidateDecisionKeyQuotas(); home.remove(); });

test("only family buckets become decision windows; per-model and Argon rows stay display-only", () => {
  expect(antigravityDecisionWindows(quota).map(row => [row.family, row.window, row.percent])).toEqual([
    ["gem", "5h", 36], ["gem", "weekly", 22], ["cla", "5h", 0], ["cla", "weekly", 100],
  ]);
});

test("collected OAuth Antigravity report reaches JEV and each model reads only its own family", () => {
  const report = keyReport("google-antigravity", "google-antigravity:retrieveUserQuotaSummary", quota, config.providers["google-antigravity"]!, "")!;
  publishCollectedDecisionQuota([report], config);
  expect(jevQuotaSignalForTarget(config, "google-antigravity", "gemini-3.8-flash", now)).toMatchObject({ tier: "healthy", usedPercent: 36, window: "5h" });
  // Claude weekly is spent; the Gemini counters must not mask or inherit it.
  expect(jevQuotaSignalForTarget(config, "google-antigravity", "claude-sonnet-5-5", now)).toMatchObject({ tier: "nearly_exhausted", usedPercent: 100, window: "weekly" });
  expect(jevQuotaSignalForTarget(config, "google-antigravity", "unclassified-model", now).tier).toBe("unknown");
});

test("OAuth evidence stays limited to Antigravity and to a sole enabled account", () => {
  const window = { window: "weekly" as const, percent: 90, observedAt: now };
  const other = { ...config.providers["google-antigravity"]!, adapter: "openai-chat" as const };
  publishDecisionKeyQuota("some-oauth-provider", other, [window]);
  expect(readLoadedDecisionKeyQuota("some-oauth-provider", other)).toBeUndefined();
  const row = config.providers["google-antigravity"]!;
  publishDecisionKeyQuota("google-antigravity", row, [window]);
  expect(readLoadedDecisionKeyQuota("google-antigravity", row)).toHaveLength(1);
  expect(readLoadedDecisionKeyQuota("google-antigravity", { ...row, disabled: true })).toBeUndefined();
});

test("a rotated base URL invalidates published Antigravity evidence", () => {
  const row = config.providers["google-antigravity"]!;
  publishDecisionKeyQuota("google-antigravity", row, [{ window: "5h", percent: 50, observedAt: now, family: "gem" }]);
  expect(readLoadedDecisionKeyQuota("google-antigravity", { ...row, baseUrl: "https://other.example.test" })).toBeUndefined();
});
