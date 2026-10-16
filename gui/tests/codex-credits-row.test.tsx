import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import CodexCreditsRow from "../src/components/CodexCreditsRow";
import QuotaBars from "../src/components/QuotaBars";
import { CodexAccountPoolMainCard } from "../src/components/codex-account-pool-main-card";
import { CodexAccountPoolCards } from "../src/components/codex-account-pool-cards";
import type { CodexCredits, CodexAccountEntry } from "../src/hooks/useCodexAccountPool";
import { en } from "../src/i18n/en";
import { I18nContext, interpolate, type TFn } from "../src/i18n/shared";
const t: TFn = (key, vars) => interpolate(en[key], vars);
function render(node: ReactNode) {
  return renderToStaticMarkup(<I18nContext.Provider value={{ t, locale: "en", setLocale: () => {} }}>{node}</I18nContext.Provider>);
}
function row(credits?: CodexCredits, locale: "en" | "de" = "en") {
  return render(<CodexCreditsRow credits={credits} t={t} locale={locale} />);
}
test.each([
  [{ balance: "62500" }, "62,500", "1"],
  [{ balance: "62498.725" }, "62,498.73", "1"],
  [{ balance: "0" }, "0", "0"],
  [{ balance: "0.001" }, "0", "1"],
  [{ unlimited: true }, "Unlimited", "1"],
  [{ unlimited: true, balance: "10" }, "Unlimited", "1"],
  [{ overageLimitReached: true }, "Overage limit reached", "0"],
  [{ overageLimitReached: true, unlimited: true, balance: "62500" }, "62,500 · Overage limit reached", "0"],
] satisfies [CodexCredits, string, string][])("credits status %j", (credits, value, scale) => {
  const html = row(credits);
  expect(html).toContain(`class="quota-val">${value}</span>`);
  expect(html).toContain(`--bar-scale:${scale}`);
  expect(html).toContain('class="quota-reset-label">remaining</span>');
  expect(html).not.toContain("%");
  expect(html).not.toContain("progressbar");
  expect(html).not.toContain("codex-account-quota-slot");
});
test.each([undefined, {}, { hasCredits: true }, { unlimited: false }, { balance: "invalid" }])("unusable credits render nothing: %j", credits => {
  expect(row(credits)).toBe("");
});
test("balance uses the current locale and two fractional digits", () => {
  expect(row({ balance: "62498.725" }, "de")).toContain("62.498,73");
});
test("message ranges live in the tooltip, including one-sided observations", () => {
  expect(row({ balance: "5", approxLocalMessages: [1000, 2000], approxCloudMessages: [50, 100] }))
    .toContain('title="Approx. messages: local 1,000–2,000 · cloud 50–100"');
  expect(row({ unlimited: true, approxLocalMessages: [1, 2] })).toContain("local 1–2 · cloud —");
  expect(row({ balance: "5" })).not.toContain("title=");
});
const creditsNode = <CodexCreditsRow credits={{ balance: "62500" }} t={t} locale="en" />;
const quota = { fiveHourPercent: 10, weeklyPercent: 20, monthlyPercent: 30, customWindows: [{ label: "Custom", percent: 40 }], updatedAt: 1 };
function quotaHtml(overrides: Partial<Parameters<typeof QuotaBars>[0]> = {}) {
  return render(<QuotaBars quota={quota} t={t} threshold={80} afterWeekly={creditsNode} {...overrides} />);
}
test("compact order is Week → Credits → Monthly/custom in a single slot", () => {
  const html = quotaHtml();
  const labels = [...html.matchAll(/class="quota-label"[^>]*>(.*?)<\/span>/g)].map(match => match[1]);
  expect(labels).toEqual([en["codexAuth.fiveHour"], en["codexAuth.weekly"], "Credits", en["codexAuth.monthly"], "Custom"]);
  expect(html.match(/codex-account-quota-slot/g)?.length).toBe(1);
});
test("no Week appends credits after the last quota row", () => {
  const html = quotaHtml({ quota: { monthlyPercent: 30, updatedAt: 1 } });
  expect(html.indexOf(en["codexAuth.monthly"])).toBeLessThan(html.indexOf("Credits"));
});
test("no quota renders credits alone when ready", () => {
  const html = quotaHtml({ quota: null });
  expect(html).toContain("62,500");
  expect(html).not.toContain("skeleton");
});
test("stacked layout ignores the slot, including empty quota", () => {
  expect(quotaHtml({ layout: "stacked" })).not.toContain("Credits");
  expect(quotaHtml({ layout: "stacked", quota: null })).toBe("");
});
const account: CodexAccountEntry = {
  id: "fixture", email: "fixture@example.test", isMain: true, paused: false, priority: 0,
  autoSwitchThresholdOverride: null, hasCredential: true, quota: null, credits: { balance: "62500" },
  quotaAutoRefresh: { fiveHourAvailable: false, weeklyAvailable: false, fiveHourEnabled: false, weeklyEnabled: false },
};
const common = {
  accountModeState: null, threshold: 80, switchActionLabel: "switch", onSwitch: () => {}, onTogglePause: () => {},
  pauseUpdatingId: null, pauseBusy: false, onPriorityChange: () => {}, priorityUpdatingId: null,
  onAutoSwitchThresholdChange: async () => true, autoSwitchDisabled: false, switchingId: null, onUnpin: () => {}, onOpenReset: () => {},
};
test.each(["main", "pool"])("%s card gates the DTO on visibility and handles credits-only accounts", kind => {
  const card = (visible?: boolean, loading = false, credits = account.credits) => kind === "main"
    ? <CodexAccountPoolMainCard {...common} t={t} main={{ ...account, credits }} isMainActive creditsVisible={visible} loading={loading} />
    : <CodexAccountPoolCards {...common} pool={[{ ...account, credits, isMain: false }]} activeId={null} onReauth={() => {}} onEditAlias={() => {}} onRemove={() => {}} creditsVisible={visible} loading={loading} />;
  expect(render(card(true))).toContain("62,500");
  expect(render(card(true))).not.toContain("quota-compact--pending");
  expect(render(card(false))).not.toContain("quota-row--codex-credits");
  expect(render(card())).not.toContain("quota-row--codex-credits");
  expect(render(card(true, true))).toContain("quota-compact--pending");
  const absent = { ...account, credits: undefined };
  const html = kind === "main"
    ? render(<CodexAccountPoolMainCard {...common} t={t} main={absent} isMainActive creditsVisible />)
    : render(<CodexAccountPoolCards {...common} pool={[absent]} activeId={null} onReauth={() => {}} onEditAlias={() => {}} onRemove={() => {}} creditsVisible />);
  expect(html).not.toContain("quota-row--codex-credits");
  expect(html).toContain("quota-compact--pending");
});
