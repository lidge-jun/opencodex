import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "../src/i18n/provider";
import { ProviderCapacityQuota } from "../src/components/provider-workspace/ProviderCapacityQuota";
import ProviderAccountQuota from "../src/components/provider-workspace/ProviderAccountQuota";
import { accountQuotaFromReport } from "../src/provider-workspace/report";
import { normalizeQuotaForPlan } from "../src/codex-quota-utils";
import { maxQuotaUtilisation } from "../src/components/QuotaBars";

const balance = { total: 350, used: 0, remaining: 350, frozen: 0, groups: [
  { kind: "plan_base", total: 100, used: 0, remaining: 100, frozen: 0 },
  { kind: "benefit", total: 250, used: 0, remaining: 250, frozen: 0 },
] };
const quota = () => accountQuotaFromReport({ quota: { updatedAt: Date.now(), workbuddyCredits: balance } })!;

test("shows 350 credits, both contributing balances and no dollar currency", () => {
  const html = renderToStaticMarkup(<LanguageProvider><ProviderCapacityQuota report={{ quota: quota() }} pending={false} /></LanguageProvider>);
  for (const text of ["350 credits", "100 credits", "250 credits", "Plan base credits", "Gift credits", "Used 0 / 350"]) expect(html).toContain(text);
  expect(html).not.toContain("US$"); expect(html).not.toContain("quotaUnsupported");
});

test("accounts view renders the balance and optional gift expiry", () => {
  const value = quota(); value.workbuddyCredits!.expiring = { amount: 250, at: Date.UTC(2026, 10, 1) };
  const html = renderToStaticMarkup(<LanguageProvider><ProviderAccountQuota quota={value} quotaMode="probe" /></LanguageProvider>);
  expect(html).toContain('data-quota-state="ready"');
  expect(html).toContain("350 credits"); expect(html).toContain("250 credits expire on");
});

test("display-only balance survives Free plan projection and never ranks as exhausted", () => {
  const value = quota(); value.workbuddyCredits = { ...value.workbuddyCredits!, used: 350, remaining: 0 };
  expect(normalizeQuotaForPlan(value, "Free")?.workbuddyCredits?.remaining).toBe(0);
  expect(maxQuotaUtilisation(value)).toBe(-1);
  const html = renderToStaticMarkup(<LanguageProvider><ProviderAccountQuota quota={value} quotaMode="probe" /></LanguageProvider>);
  expect(html).toContain("0 credits"); expect(html).toContain("100% used");
});

test("malformed balances and unsafe dates cannot break the quota panel", () => {
  expect(accountQuotaFromReport({ quota: { workbuddyCredits: { ...balance, remaining: NaN } } })).toBeNull();
  const value = accountQuotaFromReport({ quota: { workbuddyCredits: { ...balance, expiring: { amount: 250, at: 1e20 } } } });
  expect(value?.workbuddyCredits?.expiring).toBeUndefined();
  const html = renderToStaticMarkup(<LanguageProvider><ProviderCapacityQuota report={{ quota: value }} pending={false} /></LanguageProvider>);
  expect(html).toContain("350 credits"); expect(html).not.toContain("expire on");
});
