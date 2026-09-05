import { expect, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { accountQuotaFromReport, currentAccountQuotaReport, type ProviderQuotaReportView } from "../src/provider-workspace/report";
import ProviderAccountQuota from "../src/components/provider-workspace/ProviderAccountQuota";
import ProviderCurrentQuota from "../src/components/provider-workspace/ProviderCurrentQuota";
import ProviderOverview from "../src/components/provider-workspace/ProviderOverview";
import ProviderUsage from "../src/components/provider-workspace/ProviderUsage";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const item: WorkspaceItem = { name: "openai", adapter: "openai-responses", authMode: "forward", baseUrl: "https://chatgpt.com/backend-api/codex" };
const observedAt = Date.UTC(2026, 8, 5);
function poolReport(current: unknown = { weeklyPercent: 70, updatedAt: observedAt }): ProviderQuotaReportView {
  return {
    quota: { weeklyPercent: 20, updatedAt: observedAt + 60000 }, updatedAt: observedAt + 60000,
    aggregation: { kind: "capacity-weighted-v1", scope: "routable-known", presentation: "aggregate",
      excludedAccounts: 0, unknownPlanAccounts: 0, incomplete: false,
      currentAccount: { plan: "pro", quota: current },
    },
  };
}
const render = (node: ReactNode) => renderToStaticMarkup(<LanguageProvider>{node}</LanguageProvider>);

test("current quota projection uses the account measurement and timestamp, never the aggregate", () => {
  const projected = currentAccountQuotaReport(poolReport());
  expect(accountQuotaFromReport(projected)?.weeklyPercent).toBe(70);
  expect(projected?.updatedAt).toBe(observedAt);
  expect(projected?.aggregation).toBeUndefined();
  const markup = render(<ProviderCurrentQuota report={poolReport()} />);
  expect(markup).toContain("Current account usage");
  expect(markup).toContain("70% used");
  expect(markup).not.toContain("20% used");
  expect(markup).not.toContain("Configured-weight pool estimate");
});

test("missing or malformed pool current data stays unknown instead of falling back to total capacity", () => {
  for (const report of [poolReport(null), { quota: { weeklyPercent: 20 }, aggregation: { unexpected: true } }]) {
    expect(accountQuotaFromReport(currentAccountQuotaReport(report))).toBeNull();
    const markup = render(<ProviderCurrentQuota report={report} />);
    expect(markup).toContain("No quota data for this provider.");
    expect(markup).not.toContain("20% used");
  }
});

test("Overview and Usage place the same current-account section after usage statistics", () => {
  const overview = render(<ProviderOverview item={item} usageTotals={{ requests: 12, totalTokens: 100 }} quotaReport={poolReport()} />);
  const usage = render(<ProviderUsage item={item} usageTotals={{ requests: 12, totalTokens: 100 }} quotaReport={poolReport()} />);
  for (const markup of [overview, usage]) {
    expect(markup).toContain("Current account usage");
    expect(markup).toContain("70% used");
    expect(markup).not.toContain("20% used");
  }
  expect(overview.indexOf('pws-overview-sidebar')).toBeLessThan(overview.indexOf('aria-label="Current account usage"'));
  expect(usage.indexOf('pws-usage-metrics')).toBeLessThan(usage.indexOf('aria-label="Current account usage"'));
});

test("an unobserved active passive row cannot inherit the previous account report", () => {
  const markup = render(<ProviderCurrentQuota
    report={{ observed: true, quota: { weeklyPercent: 75, updatedAt: observedAt } }}
    reading={{ quotaMode: "passive" }}
  />);
  expect(markup).toContain('data-quota-state="unobserved"');
  expect(markup).toContain("No usage observation yet.");
  expect(markup).not.toContain("75%");
});

test("known current-account state overrides stale provider quota", () => {
  const report = { quota: { weeklyPercent: 75, updatedAt: observedAt } };
  for (const quotaMode of ["probe", "unsupported"] as const) {
    const markup = render(<ProviderCurrentQuota report={report} reading={{ quotaMode }} />);
    expect(markup).not.toContain("75%");
  }
});

test("all-account and current sections preserve zero and credit-only readings", () => {
  const quota = { creditsUsd: { used: 12.5, limit: 50, remaining: 37.5, percent: 25 }, updatedAt: observedAt };
  const views = [
    <ProviderAccountQuota quotaMode="probe" quota={quota} />,
    <ProviderCurrentQuota reading={{ quotaMode: "probe", quota }} />,
    <ProviderOverview item={item} currentQuotaReading={{ quotaMode: "probe", quota }} />,
    <ProviderUsage item={item} currentQuotaReading={{ quotaMode: "probe", quota }} />,
  ];
  for (const view of views) expect(render(view)).toContain("US$37.50");
  const zero = render(<ProviderAccountQuota quotaMode="probe" quota={{ weeklyPercent: 0, updatedAt: observedAt }} />);
  expect(zero).toContain("0% used");
  expect(zero).toContain('data-quota-state="ready"');
});

test("unsupported, passive unobserved, explicit loading and failed last-good are distinct", () => {
  const quota = { weeklyPercent: 12, updatedAt: observedAt };
  const unsupported = render(<ProviderCurrentQuota reading={{ quotaMode: "unsupported", quota }} onRefreshQuota={async () => true} />);
  expect(unsupported).toContain("Quota lookup is not supported for this account.");
  expect(unsupported).not.toContain("12%");
  expect(unsupported).not.toContain("Refresh quotas");
  expect(render(<ProviderAccountQuota quotaMode="passive" quotaPending />)).toContain('data-quota-state="unobserved"');
  expect(render(<ProviderAccountQuota quotaMode="probe" quotaPending />)).toContain('data-quota-state="pending"');
  const failed = render(<ProviderAccountQuota quotaMode="probe" quota={quota} quotaUnavailable />);
  expect(failed).toContain('data-quota-state="unavailable"');
  expect(failed).toContain("12% used");
  expect(failed).toContain("Quota updated");
});
