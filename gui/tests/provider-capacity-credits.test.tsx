import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderCapacityQuota } from "../src/components/provider-workspace/ProviderCapacityQuota";
import { LanguageProvider } from "../src/i18n/provider";

const PERIOD_END = Date.UTC(2026, 7, 26);

function renderCredits(expiresAt?: number): string {
  return renderToStaticMarkup(
    <LanguageProvider>
      <ProviderCapacityQuota
        pending={false}
        report={{
          updatedAt: 123,
          quota: {
            creditsUsd: {
              used: 12.5,
              limit: 50,
              remaining: 37.5,
              percent: 25,
              ...(expiresAt === undefined ? {} : { expiresAt }),
            },
          },
        }}
      />
    </LanguageProvider>,
  );
}

test("credits without an expiry render the balance and no billing-period line", () => {
  const markup = renderCredits();
  expect(markup).toContain("Credits balance");
  expect(markup).toContain("US$37.50");
  expect(markup).not.toContain("Billing period ends");
});

test("credits with an expiry render the localized billing-period end date", () => {
  const markup = renderCredits(PERIOD_END);
  expect(markup).toContain("Credits balance");
  expect(markup).toContain("Billing period ends 26 Aug 2026");
});

// Rendering is the failure point, not just the value: Intl.DateTimeFormat.format() throws a
// RangeError on a time value outside ±8.64e15 ms, so an unrepresentable expiry took down the
// whole capacity panel rather than showing a wrong date.
test("credits with an unrepresentable expiry still render the balance", () => {
  const markup = renderCredits(1e20);
  expect(markup).toContain("Credits balance");
  expect(markup).toContain("US$37.50");
  expect(markup).not.toContain("Billing period ends");
});
